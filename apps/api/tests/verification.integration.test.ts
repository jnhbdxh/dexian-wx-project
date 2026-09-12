import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import type {
  SendVerificationCodeInput,
  SmsGateway,
} from "../src/integrations/sms/gateway.js";
import { hashToken } from "../src/lib/crypto.js";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const suffix = randomUUID();
const customerToken = `sms-customer-${suffix}`;
const uncertainCustomerToken = `sms-uncertain-customer-${suffix}`;
let app: Awaited<ReturnType<typeof buildApp>>;
let database: Database;
let customerId = "";
let uncertainCustomerId = "";
let sent: SendVerificationCodeInput | undefined;
let failDelivery = false;

const gateway: SmsGateway = {
  async sendVerificationCode(input) {
    sent = input;
    if (failDelivery) throw new Error("provider timeout");
    return { messageId: `message-${suffix}` };
  },
};

describe.runIf(hasDatabase)("phone verification", () => {
  beforeAll(async () => {
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      adminWebOrigin: "http://localhost:5173",
      databaseUrl: process.env.DATABASE_URL!,
      bookingTokenSecret: "test-booking-secret-at-least-32-characters",
      smsCodeSecret: "test-sms-secret-at-least-32-characters-long",
      secureCookies: false,
    };
    database = createDatabase(config);
    const customer = await database.pool.query<{ id: string }>(
      "INSERT INTO customers (display_name) VALUES ($1) RETURNING id",
      [`短信测试顾客-${suffix}`],
    );
    customerId = customer.rows[0]!.id;
    const uncertainCustomer = await database.pool.query<{ id: string }>(
      "INSERT INTO customers (display_name) VALUES ($1) RETURNING id",
      [`短信未知结果顾客-${suffix}`],
    );
    uncertainCustomerId = uncertainCustomer.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
       VALUES ($1, $2, $3), ($4, $5, $3)`,
      [
        customerId,
        hashToken(customerToken),
        new Date(Date.now() + 60_000),
        uncertainCustomerId,
        hashToken(uncertainCustomerToken),
      ],
    );
    app = await buildApp({
      config,
      database,
      logger: false,
      smsGateway: gateway,
    });
  });

  afterAll(async () => {
    await app?.close();
    if (database && customerId) {
      await database.pool.query(
        "DELETE FROM customer_phone_bindings WHERE customer_id = ANY($1::uuid[])",
        [[customerId, uncertainCustomerId]],
      );
      await database.pool.query(
        "DELETE FROM sms_verifications WHERE customer_id = ANY($1::uuid[])",
        [[customerId, uncertainCustomerId]],
      );
      await database.pool.query(
        "DELETE FROM customer_sessions WHERE customer_id = ANY($1::uuid[])",
        [[customerId, uncertainCustomerId]],
      );
      await database.pool.query(
        "DELETE FROM customers WHERE id = ANY($1::uuid[])",
        [[customerId, uncertainCustomerId]],
      );
    }
    await database?.pool.end();
  });

  it("sends, limits retries, and binds only after a correct code", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/customer/phone-verifications",
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { phone: "+86 138-0013-8000" },
    });
    expect(created.statusCode).toBe(202);
    expect(sent).toMatchObject({ phone: "13800138000", expiresInMinutes: 5 });
    expect(sent?.code).toMatch(/^\d{6}$/);
    const verificationId = created.json().verificationId as string;

    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/customer/phone-verifications",
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { phone: "13800138000" },
    });
    expect(repeated.statusCode).toBe(429);
    expect(repeated.json().code).toBe("SMS_SEND_TOO_FREQUENT");

    const wrong = await app.inject({
      method: "POST",
      url: `/api/v1/customer/phone-verifications/${verificationId}/confirm`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { code: sent!.code === "000000" ? "000001" : "000000" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({
      code: "VERIFICATION_CODE_INVALID",
      details: { attemptsRemaining: 4 },
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/customer/phone-verifications/${verificationId}/confirm`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { code: sent!.code },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ phone: "13800138000" });

    const reused = await app.inject({
      method: "POST",
      url: `/api/v1/customer/phone-verifications/${verificationId}/confirm`,
      headers: { authorization: `Bearer ${customerToken}` },
      payload: { code: sent!.code },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("VERIFICATION_ALREADY_USED");
  });

  it("allows confirmation when the provider result is unknown", async () => {
    failDelivery = true;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/customer/phone-verifications",
      headers: { authorization: `Bearer ${uncertainCustomerToken}` },
      payload: { phone: "13900139000" },
    });
    failDelivery = false;
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "SMS_DELIVERY_UNKNOWN",
      details: {
        verificationId: expect.any(String),
        expiresAt: expect.any(String),
        nextSendAt: expect.any(String),
      },
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/customer/phone-verifications/${response.json().details.verificationId}/confirm`,
      headers: { authorization: `Bearer ${uncertainCustomerToken}` },
      payload: { code: sent!.code },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().phone).toBe("13900139000");
  });
});
