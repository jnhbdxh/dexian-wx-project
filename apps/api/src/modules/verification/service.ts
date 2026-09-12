import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { Database } from "../../db/client.js";
import type { SmsGateway } from "../../integrations/sms/gateway.js";
import { AppError } from "../../lib/app-error.js";

const CODE_TTL_MS = 5 * 60_000;
const SEND_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;

export function normalizeChinaPhone(value: string) {
  let phone = value.replace(/[\s-]/g, "");
  if (phone.startsWith("+86")) phone = phone.slice(3);
  else if (phone.startsWith("86") && phone.length === 13)
    phone = phone.slice(2);
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new AppError(400, "PHONE_INVALID", "请输入有效的中国大陆手机号");
  }
  return phone;
}

export function hashVerificationCode(
  secret: string,
  verificationId: string,
  code: string,
) {
  return createHmac("sha256", secret)
    .update(`${verificationId}:${code}`)
    .digest();
}

function safeCodeMatch(actual: Buffer, expectedHex: string) {
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function sendPhoneVerification(
  database: Database,
  gateway: SmsGateway,
  secret: string,
  customerId: string,
  rawPhone: string,
) {
  const phone = normalizeChinaPhone(rawPhone);
  const verificationId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const client = await database.pool.connect();
  let expiresAt: Date;
  let nextSendAt: Date;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      customerId,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [phone]);
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const now = nowResult.rows[0]!.now;
    const latest = await client.query<{ next_send_at: Date }>(
      `SELECT next_send_at
         FROM sms_verifications
        WHERE customer_id = $1 OR phone = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [customerId, phone],
    );
    const blockedUntil = latest.rows[0]?.next_send_at;
    if (blockedUntil && blockedUntil > now) {
      throw new AppError(
        429,
        "SMS_SEND_TOO_FREQUENT",
        "验证码发送过于频繁，请稍后再试",
        {
          retryAfterSeconds: Math.ceil(
            (blockedUntil.getTime() - now.getTime()) / 1_000,
          ),
        },
      );
    }
    const hourly = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sms_verifications
        WHERE (customer_id = $1 OR phone = $2)
          AND created_at > $3`,
      [customerId, phone, new Date(now.getTime() - 60 * 60_000)],
    );
    if (Number(hourly.rows[0]?.count ?? 0) >= MAX_SENDS_PER_HOUR) {
      throw new AppError(
        429,
        "SMS_HOURLY_LIMIT_REACHED",
        "验证码发送次数已达上限，请一小时后再试",
      );
    }

    expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    nextSendAt = new Date(now.getTime() + SEND_COOLDOWN_MS);
    await client.query(
      `INSERT INTO sms_verifications (
         id, customer_id, phone, purpose, code_hash, attempts_remaining,
         expires_at, next_send_at
       ) VALUES ($1, $2, $3, 'bind_phone', $4, $5, $6, $7)`,
      [
        verificationId,
        customerId,
        phone,
        hashVerificationCode(secret, verificationId, code).toString("hex"),
        MAX_ATTEMPTS,
        expiresAt,
        nextSendAt,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    const delivery = await gateway.sendVerificationCode({
      phone,
      code,
      expiresInMinutes: CODE_TTL_MS / 60_000,
    });
    await database.pool.query(
      `UPDATE sms_verifications
          SET provider_message_id = $2, updated_at = clock_timestamp()
        WHERE id = $1`,
      [verificationId, delivery.messageId],
    );
  } catch {
    throw new AppError(
      503,
      "SMS_DELIVERY_UNKNOWN",
      "短信发送结果暂不确定；若已收到验证码，可继续提交验证",
      {
        verificationId,
        expiresAt: expiresAt.toISOString(),
        nextSendAt: nextSendAt.toISOString(),
      },
    );
  }

  return { verificationId, expiresAt, nextSendAt, code };
}

export async function confirmPhoneVerification(
  database: Database,
  secret: string,
  customerId: string,
  verificationId: string,
  code: string,
) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      phone: string;
      code_hash: string;
      attempts_remaining: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT phone, code_hash, attempts_remaining, expires_at, consumed_at
         FROM sms_verifications
        WHERE id = $1 AND customer_id = $2 AND purpose = 'bind_phone'
        FOR UPDATE`,
      [verificationId, customerId],
    );
    const verification = result.rows[0];
    if (!verification) {
      throw new AppError(404, "VERIFICATION_NOT_FOUND", "验证码记录不存在");
    }
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const now = nowResult.rows[0]!.now;
    if (verification.consumed_at) {
      throw new AppError(409, "VERIFICATION_ALREADY_USED", "该验证码已使用");
    }
    if (verification.expires_at <= now) {
      throw new AppError(
        410,
        "VERIFICATION_EXPIRED",
        "验证码已过期，请重新获取",
      );
    }
    if (verification.attempts_remaining === 0) {
      throw new AppError(
        429,
        "VERIFICATION_ATTEMPTS_EXHAUSTED",
        "验证码错误次数过多，请重新获取",
      );
    }

    const actual = hashVerificationCode(secret, verificationId, code);
    if (!safeCodeMatch(actual, verification.code_hash)) {
      const attemptsRemaining = verification.attempts_remaining - 1;
      await client.query(
        `UPDATE sms_verifications
            SET attempts_remaining = $2, updated_at = $3
          WHERE id = $1`,
        [verificationId, attemptsRemaining, now],
      );
      await client.query("COMMIT");
      throw new AppError(400, "VERIFICATION_CODE_INVALID", "验证码不正确", {
        attemptsRemaining,
      });
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      customerId,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      verification.phone,
    ]);
    const occupied = await client.query<{ customer_id: string }>(
      `SELECT customer_id
         FROM customer_phone_bindings
        WHERE phone = $1 AND revoked_at IS NULL
        FOR UPDATE`,
      [verification.phone],
    );
    if (occupied.rows[0] && occupied.rows[0].customer_id !== customerId) {
      throw new AppError(
        409,
        "PHONE_ALREADY_BOUND",
        "该手机号已绑定其他账号，请联系门店处理",
      );
    }

    await client.query(
      `UPDATE customer_phone_bindings
          SET revoked_at = $2, updated_at = $2
        WHERE customer_id = $1 AND revoked_at IS NULL`,
      [customerId, now],
    );
    const binding = await client.query<{ id: string; verified_at: Date }>(
      `INSERT INTO customer_phone_bindings (
         customer_id, phone, verification_id, verified_at
       ) VALUES ($1, $2, $3, $4)
       RETURNING id, verified_at`,
      [customerId, verification.phone, verificationId, now],
    );
    await client.query(
      `UPDATE sms_verifications
          SET consumed_at = $2, updated_at = $2
        WHERE id = $1`,
      [verificationId, now],
    );
    await client.query("COMMIT");
    return {
      bindingId: binding.rows[0]!.id,
      phone: verification.phone,
      verifiedAt: binding.rows[0]!.verified_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
