import { createHash, randomUUID } from "node:crypto";

import type { WechatPayConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type {
  WechatPayGateway,
  WechatPaymentNotification,
  WechatPaymentParameters,
  WechatPayOrder,
} from "../../integrations/wechat/payment.js";
import { WechatPayRequestError } from "../../integrations/wechat/payment.js";
import { AppError } from "../../lib/app-error.js";

const LEASE_MILLISECONDS = 30_000;
const PREPAY_MILLISECONDS = 2 * 60 * 60 * 1_000;
const FIRST_CHECK_MILLISECONDS = 15_000;
const MAX_CHECK_ATTEMPTS = 20;

type PaymentState =
  | "created"
  | "processing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "manual_review";

interface PaymentSnapshot {
  paymentId: string;
  outTradeNo: string;
  amountCents: number;
  currency: string;
  payerOpenId: string;
  state: PaymentState;
  prepayId: string | null;
  prepayExpiresAt: Date | null;
  collectionDeadline: Date;
  nextCheckAt: Date | null;
  checkAttempts: number;
}

interface ClaimedPayment extends PaymentSnapshot {
  leaseToken: string;
  shouldQuery: boolean;
  legacyDeadlineUncertain?: boolean;
}

type PreparedPayment =
  | { kind: "ready"; payment: PaymentSnapshot }
  | { kind: "claimed"; payment: ClaimedPayment };

export interface WechatPaymentResult {
  paymentId: string;
  outTradeNo: string;
  state: "processing";
  amountCents: string;
  prepayExpiresAt: string;
  nextPollAt: string;
  paymentParameters: WechatPaymentParameters;
}

function paymentRequestHash(receptionId: string) {
  return createHash("sha256")
    .update(`wechat-payment:${receptionId}`)
    .digest("hex");
}

function nextCheckAt(attempts: number) {
  const seconds = Math.min(15 * 2 ** Math.min(attempts, 6), 15 * 60);
  return new Date(Date.now() + seconds * 1_000);
}

function channelError(error: unknown) {
  return {
    code:
      error instanceof WechatPayRequestError
        ? (error.channelCode ?? "REQUEST_FAILED")
        : "REQUEST_FAILED",
    message:
      error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
  };
}

function paymentResult(
  gateway: WechatPayGateway,
  payment: PaymentSnapshot,
): WechatPaymentResult {
  if (!payment.prepayId || !payment.prepayExpiresAt) {
    throw new Error("Payment prepay credential is unavailable");
  }
  return {
    paymentId: payment.paymentId,
    outTradeNo: payment.outTradeNo,
    state: "processing",
    amountCents: String(payment.amountCents),
    prepayExpiresAt: payment.prepayExpiresAt.toISOString(),
    nextPollAt: (
      payment.nextCheckAt ?? new Date(Date.now() + FIRST_CHECK_MILLISECONDS)
    ).toISOString(),
    paymentParameters: gateway.buildPaymentParameters(payment.prepayId),
  };
}

async function preparePayment(
  database: Database,
  config: WechatPayConfig,
  customerId: string,
  receptionId: string,
  idempotencyKey: string,
): Promise<PreparedPayment> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const hash = paymentRequestHash(receptionId);
    const insertedEvent = await client.query<{ id: string }>(
      `INSERT INTO business_events (
         actor_type, actor_id, operation_type, idempotency_key, request_hash
       ) VALUES ('customer', $1, 'payment.wechat.create', $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [customerId, idempotencyKey, hash],
    );
    let eventId = insertedEvent.rows[0]?.id;
    if (!eventId) {
      const existingEvent = await client.query<{
        id: string;
        request_hash: string;
      }>(
        `SELECT id, request_hash
           FROM business_events
          WHERE actor_type = 'customer'
            AND actor_id = $1
            AND operation_type = 'payment.wechat.create'
            AND idempotency_key = $2
          FOR UPDATE`,
        [customerId, idempotencyKey],
      );
      const event = existingEvent.rows[0];
      if (!event) throw new Error("Payment idempotency event disappeared");
      if (event.request_hash !== hash) {
        throw new AppError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "该提交标识已用于其他支付，请刷新后重试",
        );
      }
      eventId = event.id;
    }

    const receptionResult = await client.query<{
      store_id: string;
      quote_cents: number;
      state: string;
    }>(
      `SELECT store_id, quote_cents, state
         FROM receptions
        WHERE id = $1 AND customer_id = $2
        FOR UPDATE`,
      [receptionId, customerId],
    );
    const reception = receptionResult.rows[0];
    if (!reception) {
      throw new AppError(404, "RECEPTION_NOT_FOUND", "接待不存在");
    }
    if (reception.state !== "confirmed") {
      throw new AppError(409, "RECEPTION_NOT_CONFIRMED", "接待确认后才能支付", {
        currentState: reception.state,
      });
    }
    if (reception.quote_cents <= 0) {
      throw new AppError(409, "PAYMENT_NOT_REQUIRED", "该接待无需微信支付");
    }

    const timingResult = await client.query<{
      now: Date;
      service_end_at: Date | null;
    }>(
      `SELECT clock_timestamp() AS now, MAX(service_end_at) AS service_end_at
         FROM reception_guests
        WHERE reception_id = $1`,
      [receptionId],
    );
    const timing = timingResult.rows[0];
    if (!timing?.service_end_at) {
      throw new AppError(
        409,
        "RECEPTION_SERVICE_TIME_MISSING",
        "接待缺少服务结束时间，暂不能支付",
      );
    }
    const collectionDeadline = new Date(
      timing.service_end_at.getTime() + config.collectionGraceMinutes * 60_000,
    );
    const identityResult = await client.query<{ open_id: string }>(
      `SELECT open_id
         FROM wechat_identities
        WHERE customer_id = $1 AND app_id = $2
        LIMIT 1`,
      [customerId, config.appId],
    );
    const payerOpenId = identityResult.rows[0]?.open_id;
    if (!payerOpenId) {
      throw new AppError(
        409,
        "WECHAT_IDENTITY_REQUIRED",
        "当前账号未绑定该小程序微信身份，请重新登录",
      );
    }

    await client.query(
      `INSERT INTO orders (
         store_id, customer_id, reception_id, payable_cents, currency,
         quote_snapshot, collection_deadline
       ) VALUES ($1, $2, $3, $4, 'CNY', $5::jsonb, $6)
       ON CONFLICT (reception_id) DO NOTHING`,
      [
        reception.store_id,
        customerId,
        receptionId,
        reception.quote_cents,
        JSON.stringify({
          source: "reception",
          receptionId,
          quoteCents: String(reception.quote_cents),
          serviceEndAt: timing.service_end_at.toISOString(),
          collectionGraceMinutes: config.collectionGraceMinutes,
        }),
        collectionDeadline,
      ],
    );
    const orderResult = await client.query<{
      id: string;
      payable_cents: number;
      currency: string;
      collection_deadline: Date;
    }>(
      `SELECT id, payable_cents, currency, collection_deadline
         FROM orders
        WHERE reception_id = $1
        FOR UPDATE`,
      [receptionId],
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error("Failed to create payment order");
    if (
      order.payable_cents !== reception.quote_cents ||
      order.currency !== "CNY"
    ) {
      throw new AppError(
        409,
        "ORDER_QUOTE_MISMATCH",
        "订单快照与当前接待不一致，请联系门店处理",
      );
    }
    if (order.collection_deadline.getTime() < timing.now.getTime() + 60_000) {
      throw new AppError(
        409,
        "PAYMENT_WINDOW_CLOSED",
        "该接待已超过收款截止时间",
      );
    }
    const latestWechatDeadline =
      timing.now.getTime() + 15 * 24 * 60 * 60 * 1_000;
    if (order.collection_deadline.getTime() > latestWechatDeadline) {
      throw new AppError(
        409,
        "PAYMENT_WINDOW_NOT_OPEN",
        "距离服务时间较远，暂未开放支付",
        {
          availableAt: new Date(
            order.collection_deadline.getTime() - 15 * 24 * 60 * 60 * 1_000,
          ).toISOString(),
        },
      );
    }

    const existingResult = await client.query<{
      id: string;
      out_trade_no: string;
      amount_cents: number;
      currency: string;
      payer_open_id: string;
      prepay_id: string | null;
      prepay_expires_at: Date | null;
      next_check_at: Date | null;
      check_attempts: number;
      lease_until: Date | null;
      state: PaymentState;
    }>(
      `SELECT id, out_trade_no, amount_cents, currency, payer_open_id,
              prepay_id, prepay_expires_at, next_check_at, check_attempts,
              lease_until, state
         FROM payment_transactions
        WHERE order_id = $1 AND channel = 'wechat'
        FOR UPDATE`,
      [order.id],
    );
    const existing = existingResult.rows[0];
    if (existing?.state === "succeeded") {
      throw new AppError(409, "ORDER_ALREADY_PAID", "该订单已经支付成功");
    }
    if (existing?.state === "failed") {
      throw new AppError(
        409,
        "PAYMENT_CLOSED",
        "该支付单已关闭，请联系门店处理",
      );
    }
    if (existing?.state === "manual_review") {
      throw new AppError(
        409,
        "PAYMENT_REQUIRES_REVIEW",
        "支付状态需要人工复核，请联系门店处理",
      );
    }

    const paymentId = existing?.id ?? randomUUID();
    const outTradeNo = existing?.out_trade_no ?? paymentId.replaceAll("-", "");
    if (!existing) {
      await client.query(
        `INSERT INTO payment_transactions (
           id, order_id, channel, state, out_trade_no, amount_cents,
           currency, payer_open_id
         ) VALUES ($1, $2, 'wechat', 'created', $3, $4, 'CNY', $5)`,
        [paymentId, order.id, outTradeNo, order.payable_cents, payerOpenId],
      );
    } else if (
      existing.amount_cents !== order.payable_cents ||
      existing.currency !== order.currency ||
      existing.payer_open_id !== payerOpenId
    ) {
      throw new AppError(
        409,
        "PAYMENT_SNAPSHOT_MISMATCH",
        "支付快照与当前订单不一致，请联系门店处理",
      );
    }

    const snapshot: PaymentSnapshot = {
      paymentId,
      outTradeNo,
      amountCents: order.payable_cents,
      currency: order.currency,
      payerOpenId,
      state: existing?.state ?? "created",
      prepayId: existing?.prepay_id ?? null,
      prepayExpiresAt: existing?.prepay_expires_at ?? null,
      collectionDeadline: order.collection_deadline,
      nextCheckAt: existing?.next_check_at ?? null,
      checkAttempts: existing?.check_attempts ?? 0,
    };
    const prepayIsValid =
      snapshot.prepayId &&
      snapshot.prepayExpiresAt &&
      snapshot.prepayExpiresAt.getTime() > timing.now.getTime() + 30_000;
    if (prepayIsValid) {
      await client.query("COMMIT");
      return { kind: "ready", payment: snapshot };
    }
    if (
      existing?.lease_until &&
      existing.lease_until.getTime() > timing.now.getTime()
    ) {
      throw new AppError(
        409,
        "PAYMENT_REQUEST_IN_PROGRESS",
        "支付请求正在处理中，请稍后查询",
        {
          paymentId,
          nextPollAt: existing.lease_until.toISOString(),
        },
      );
    }

    const leaseToken = randomUUID();
    const leaseUntil = new Date(timing.now.getTime() + LEASE_MILLISECONDS);
    await client.query(
      `UPDATE payment_transactions
          SET lease_token = $2, lease_until = $3, updated_at = clock_timestamp()
        WHERE id = $1`,
      [paymentId, leaseToken, leaseUntil],
    );
    await client.query(
      `UPDATE business_events
          SET response = $2::jsonb
        WHERE id = $1`,
      [eventId, JSON.stringify({ paymentId, outTradeNo })],
    );
    await client.query("COMMIT");
    return {
      kind: "claimed",
      payment: {
        ...snapshot,
        leaseToken,
        shouldQuery: Boolean(existing),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertMatchingChannelOrder(
  config: WechatPayConfig,
  payment: PaymentSnapshot,
  order: WechatPayOrder,
) {
  if (
    order.appId !== config.appId ||
    order.merchantId !== config.merchantId ||
    order.outTradeNo !== payment.outTradeNo ||
    order.amountCents !== payment.amountCents ||
    order.currency !== payment.currency ||
    order.payerOpenId !== payment.payerOpenId
  ) {
    throw new AppError(
      409,
      "PAYMENT_CHANNEL_MISMATCH",
      "微信支付订单与本地快照不一致，需要人工复核",
    );
  }
}

async function updateClaimedPayment(
  database: Database,
  payment: ClaimedPayment,
  input: {
    state: PaymentState;
    nextCheckAt?: Date | null;
    checkAttempts?: number;
    prepayId?: string;
    prepayExpiresAt?: Date;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
) {
  await database.pool.query(
    `UPDATE payment_transactions
        SET state = $3,
            next_check_at = $4,
            check_attempts = COALESCE($5, check_attempts),
            prepay_id = COALESCE($6, prepay_id),
            prepay_expires_at = COALESCE($7, prepay_expires_at),
            last_error_code = $8,
            last_error_message = $9,
            lease_token = NULL,
            lease_until = NULL,
            updated_at = clock_timestamp()
      WHERE id = $1 AND lease_token = $2 AND state <> 'succeeded'`,
    [
      payment.paymentId,
      payment.leaseToken,
      input.state,
      input.nextCheckAt ?? null,
      input.checkAttempts ?? null,
      input.prepayId ?? null,
      input.prepayExpiresAt ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
    ],
  );
}

async function recordUnknown(
  database: Database,
  payment: ClaimedPayment,
  error: unknown,
) {
  const attempt = payment.checkAttempts + 1;
  const details = channelError(error);
  await updateClaimedPayment(database, payment, {
    state: attempt >= MAX_CHECK_ATTEMPTS ? "manual_review" : "unknown",
    nextCheckAt: attempt >= MAX_CHECK_ATTEMPTS ? null : nextCheckAt(attempt),
    checkAttempts: attempt,
    errorCode: details.code,
    errorMessage: details.message,
  });
}

async function recordChannelState(
  database: Database,
  payment: ClaimedPayment,
  state: PaymentState,
  description: string,
) {
  const attempt = payment.checkAttempts + 1;
  await updateClaimedPayment(database, payment, {
    state,
    nextCheckAt:
      state === "processing" || state === "unknown"
        ? nextCheckAt(attempt)
        : null,
    checkAttempts: attempt,
    errorCode: `WECHAT_${state.toUpperCase()}`,
    errorMessage: description.slice(0, 500),
  });
}

async function applySuccessfulQuery(
  database: Database,
  config: WechatPayConfig,
  payment: PaymentSnapshot,
  order: WechatPayOrder,
) {
  if (!order.transactionId || !order.successTime) {
    throw new AppError(
      409,
      "PAYMENT_CHANNEL_MISMATCH",
      "微信成功订单缺少流水号或成功时间，需要人工复核",
    );
  }
  await applyWechatPaymentNotification(
    database,
    config.appId,
    config.merchantId,
    {
      appId: order.appId,
      merchantId: order.merchantId,
      outTradeNo: order.outTradeNo,
      transactionId: order.transactionId,
      tradeState: order.tradeState,
      successTime: order.successTime,
      payerOpenId: order.payerOpenId,
      amountCents: order.amountCents,
      currency: order.currency,
    },
  );
}

async function inspectChannelOrder(
  database: Database,
  gateway: WechatPayGateway,
  config: WechatPayConfig,
  payment: ClaimedPayment,
): Promise<"missing" | "create" | "settled"> {
  const order = await gateway.queryPayment(payment.outTradeNo);
  if (!order) return "missing";
  try {
    assertMatchingChannelOrder(config, payment, order);
  } catch (error) {
    await recordChannelState(
      database,
      payment,
      "manual_review",
      error instanceof Error ? error.message : "Payment snapshot mismatch",
    );
    throw error;
  }

  if (order.tradeState === "SUCCESS") {
    try {
      await applySuccessfulQuery(database, config, payment, order);
    } catch (error) {
      await recordChannelState(
        database,
        payment,
        "manual_review",
        error instanceof Error ? error.message : "Invalid successful order",
      );
      throw error;
    }
    return "settled";
  }
  if (order.tradeState === "CLOSED") {
    await recordChannelState(
      database,
      payment,
      "failed",
      order.tradeStateDescription,
    );
    return "settled";
  }
  if (order.tradeState === "REFUND") {
    await recordChannelState(
      database,
      payment,
      "manual_review",
      order.tradeStateDescription,
    );
    return "settled";
  }
  if (order.tradeState === "NOTPAY") return "create";

  await recordChannelState(
    database,
    payment,
    "processing",
    order.tradeStateDescription,
  );
  return "settled";
}

export async function createWechatPayment(
  database: Database,
  gateway: WechatPayGateway,
  config: WechatPayConfig,
  customerId: string,
  receptionId: string,
  idempotencyKey: string,
) {
  const prepared = await preparePayment(
    database,
    config,
    customerId,
    receptionId,
    idempotencyKey,
  );
  if (prepared.kind === "ready") {
    return paymentResult(gateway, prepared.payment);
  }

  const payment = prepared.payment;
  try {
    if (payment.shouldQuery) {
      const action = await inspectChannelOrder(
        database,
        gateway,
        config,
        payment,
      );
      if (action === "settled") {
        const state = await getLocalPaymentState(database, payment.paymentId);
        if (state === "succeeded") {
          throw new AppError(409, "ORDER_ALREADY_PAID", "该订单已经支付成功");
        }
        if (state === "failed") {
          throw new AppError(
            409,
            "PAYMENT_CLOSED",
            "该支付单已关闭，请联系门店处理",
          );
        }
        if (state === "manual_review") {
          throw new AppError(
            409,
            "PAYMENT_REQUIRES_REVIEW",
            "支付状态需要人工复核，请联系门店处理",
          );
        }
        throw new AppError(
          409,
          "PAYMENT_REQUEST_IN_PROGRESS",
          "微信仍在处理该支付，请稍后查询",
          { paymentId: payment.paymentId },
        );
      }
      if (
        action === "missing" &&
        payment.collectionDeadline.getTime() < Date.now() + 60_000
      ) {
        await recordChannelState(
          database,
          payment,
          "failed",
          "微信查单确认订单不存在，且收款时间已截止",
        );
        throw new AppError(
          409,
          "PAYMENT_WINDOW_CLOSED",
          "该接待已超过收款截止时间",
        );
      }
    }

    if (payment.collectionDeadline.getTime() < Date.now() + 60_000) {
      await gateway.closePayment(payment.outTradeNo);
      await recordChannelState(database, payment, "failed", "收款时间已截止");
      throw new AppError(
        409,
        "PAYMENT_WINDOW_CLOSED",
        "该接待已超过收款截止时间",
      );
    }

    const channel = await gateway.createJsapiPayment({
      description: "得闲预约服务",
      outTradeNo: payment.outTradeNo,
      amountCents: payment.amountCents,
      payerOpenId: payment.payerOpenId,
      attach: payment.paymentId,
      timeExpire: payment.collectionDeadline.toISOString(),
    });
    const now = Date.now();
    const updated: PaymentSnapshot = {
      ...payment,
      state: "processing",
      prepayId: channel.prepayId,
      prepayExpiresAt: new Date(now + PREPAY_MILLISECONDS),
      nextCheckAt: new Date(now + FIRST_CHECK_MILLISECONDS),
    };
    await updateClaimedPayment(database, payment, {
      state: "processing",
      nextCheckAt: updated.nextCheckAt,
      prepayId: channel.prepayId,
      prepayExpiresAt: new Date(now + PREPAY_MILLISECONDS),
    });
    return paymentResult(gateway, updated);
  } catch (error) {
    if (error instanceof AppError) throw error;
    await recordUnknown(database, payment, error);
    throw new AppError(
      502,
      "WECHAT_PAY_RESULT_UNKNOWN",
      "微信支付结果暂不确定，请勿重复付款，稍后查询",
      { paymentId: payment.paymentId },
    );
  }
}

async function getLocalPaymentState(database: Database, paymentId: string) {
  const result = await database.pool.query<{ state: PaymentState }>(
    "SELECT state FROM payment_transactions WHERE id = $1",
    [paymentId],
  );
  return result.rows[0]?.state;
}

async function claimPaymentForReconciliation(
  database: Database,
  paymentId: string,
  force = false,
): Promise<ClaimedPayment | null> {
  const leaseToken = randomUUID();
  const result = await database.pool.query<{
    id: string;
    out_trade_no: string;
    amount_cents: number;
    currency: string;
    payer_open_id: string;
    state: PaymentState;
    prepay_id: string | null;
    prepay_expires_at: Date | null;
    collection_deadline: Date;
    next_check_at: Date | null;
    check_attempts: number;
    last_error_code: string | null;
  }>(
    `UPDATE payment_transactions AS payment
        SET lease_token = $2,
            lease_until = clock_timestamp() + interval '30 seconds',
            updated_at = clock_timestamp()
       FROM orders
      WHERE payment.id = $1
        AND orders.id = payment.order_id
        AND (
          payment.state IN ('created', 'processing', 'unknown')
          OR ($3 AND payment.state = 'manual_review')
        )
        AND (
          $3
          OR payment.next_check_at IS NULL
          OR payment.next_check_at <= clock_timestamp()
        )
        AND (payment.lease_until IS NULL OR payment.lease_until <= clock_timestamp())
      RETURNING payment.id, payment.out_trade_no, payment.amount_cents,
                payment.currency, payment.payer_open_id, payment.state,
                payment.prepay_id, payment.prepay_expires_at,
                orders.collection_deadline, payment.next_check_at,
                payment.check_attempts, payment.last_error_code`,
    [paymentId, leaseToken, force],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    paymentId: row.id,
    outTradeNo: row.out_trade_no,
    amountCents: row.amount_cents,
    currency: row.currency,
    payerOpenId: row.payer_open_id,
    state: row.state,
    prepayId: row.prepay_id,
    prepayExpiresAt: row.prepay_expires_at,
    collectionDeadline: row.collection_deadline,
    nextCheckAt: row.next_check_at,
    checkAttempts: row.check_attempts,
    leaseToken,
    shouldQuery: true,
    legacyDeadlineUncertain:
      row.last_error_code === "LEGACY_COLLECTION_DEADLINE_UNKNOWN",
  };
}

export async function reconcilePayment(
  database: Database,
  gateway: WechatPayGateway,
  config: WechatPayConfig,
  paymentId: string,
  force = false,
) {
  const payment = await claimPaymentForReconciliation(
    database,
    paymentId,
    force,
  );
  if (!payment) return false;
  try {
    const order = await gateway.queryPayment(payment.outTradeNo);
    if (order) {
      assertMatchingChannelOrder(config, payment, order);
      if (order.tradeState === "SUCCESS") {
        await applySuccessfulQuery(database, config, payment, order);
        return true;
      }
      if (order.tradeState === "CLOSED") {
        await recordChannelState(
          database,
          payment,
          "failed",
          order.tradeStateDescription,
        );
        return true;
      }
      if (order.tradeState === "REFUND") {
        await recordChannelState(
          database,
          payment,
          "manual_review",
          order.tradeStateDescription,
        );
        return true;
      }
    }

    if (payment.legacyDeadlineUncertain) {
      await updateClaimedPayment(database, payment, {
        state: "manual_review",
        nextCheckAt: null,
        checkAttempts: payment.checkAttempts + 1,
        errorCode: "LEGACY_COLLECTION_DEADLINE_UNKNOWN",
        errorMessage:
          "微信尚未返回终态；历史订单的收款宽限时间未确认，未执行自动关单",
      });
      return true;
    }

    if (!order && payment.collectionDeadline.getTime() <= Date.now()) {
      await recordChannelState(
        database,
        payment,
        "failed",
        "微信查单确认订单不存在，且收款时间已截止",
      );
      return true;
    }
    if (payment.collectionDeadline.getTime() <= Date.now()) {
      await gateway.closePayment(payment.outTradeNo);
      await recordChannelState(database, payment, "failed", "收款时间已截止");
      return true;
    }
    const description = order?.tradeStateDescription ?? "微信暂未查到该订单";
    await recordChannelState(database, payment, "processing", description);
    return true;
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "PAYMENT_CHANNEL_MISMATCH"
    ) {
      await recordChannelState(
        database,
        payment,
        "manual_review",
        error.message,
      );
      return true;
    }
    await recordUnknown(database, payment, error);
    return true;
  }
}

export interface PaymentReviewItem {
  paymentId: string;
  receptionId: string;
  outTradeNo: string;
  state: PaymentState;
  customerName: string;
  amountCents: string;
  collectionDeadline: string;
  checkAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  nextCheckAt: string | null;
  updatedAt: string;
}

interface PaymentReviewRow {
  id: string;
  reception_id: string;
  out_trade_no: string;
  state: PaymentState;
  customer_name: string | null;
  amount_cents: number;
  collection_deadline: Date;
  check_attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  next_check_at: Date | null;
  updated_at: Date;
}

function paymentReviewItem(row: PaymentReviewRow): PaymentReviewItem {
  return {
    paymentId: row.id,
    receptionId: row.reception_id,
    outTradeNo: row.out_trade_no,
    state: row.state,
    customerName: row.customer_name?.trim() || "微信顾客",
    amountCents: String(row.amount_cents),
    collectionDeadline: row.collection_deadline.toISOString(),
    checkAttempts: row.check_attempts,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    nextCheckAt: row.next_check_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function loadPaymentReviewQueue(
  database: Database,
  storeId: string,
  afterPaymentId?: string,
) {
  const result = await database.pool.query<PaymentReviewRow>(
    `SELECT payment.id, orders.reception_id, payment.out_trade_no,
            payment.state, customer.display_name AS customer_name,
            payment.amount_cents, orders.collection_deadline,
            payment.check_attempts, payment.last_error_code,
            payment.last_error_message, payment.next_check_at,
            payment.updated_at
       FROM payment_transactions AS payment
       JOIN orders ON orders.id = payment.order_id
       JOIN customers AS customer ON customer.id = orders.customer_id
      WHERE orders.store_id = $1
        AND payment.state IN ('unknown', 'manual_review')
        AND (
          $2::uuid IS NULL
          OR (payment.updated_at, payment.id) < (
            SELECT cursor.updated_at, cursor.id
              FROM payment_transactions AS cursor
             WHERE cursor.id = $2
          )
        )
      ORDER BY payment.updated_at DESC, payment.id DESC
      LIMIT 51`,
    [storeId, afterPaymentId ?? null],
  );
  const hasMore = result.rows.length > 50;
  const rows = result.rows.slice(0, 50);
  return {
    payments: rows.map(paymentReviewItem),
    nextCursor: hasMore ? rows.at(-1)!.id : null,
  };
}

export async function loadPaymentReviewItem(
  database: Database,
  storeId: string,
  paymentId: string,
) {
  const result = await database.pool.query<PaymentReviewRow>(
    `SELECT payment.id, orders.reception_id, payment.out_trade_no,
            payment.state, customer.display_name AS customer_name,
            payment.amount_cents, orders.collection_deadline,
            payment.check_attempts, payment.last_error_code,
            payment.last_error_message, payment.next_check_at,
            payment.updated_at
       FROM payment_transactions AS payment
       JOIN orders ON orders.id = payment.order_id
       JOIN customers AS customer ON customer.id = orders.customer_id
      WHERE orders.store_id = $1 AND payment.id = $2`,
    [storeId, paymentId],
  );
  const row = result.rows[0];
  return row ? paymentReviewItem(row) : undefined;
}

export async function reconcileDuePayments(
  database: Database,
  gateway: WechatPayGateway,
  config: WechatPayConfig,
  limit = 20,
) {
  const due = await database.pool.query<{ id: string }>(
    `SELECT id
       FROM payment_transactions
      WHERE state IN ('created', 'processing', 'unknown')
        AND (next_check_at IS NULL OR next_check_at <= clock_timestamp())
        AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      ORDER BY next_check_at NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  for (const payment of due.rows) {
    await reconcilePayment(database, gateway, config, payment.id);
  }
  return due.rowCount ?? 0;
}

async function loadPaymentStatus(
  database: Database,
  customerId: string,
  paymentId: string,
) {
  const result = await database.pool.query<{
    id: string;
    state: PaymentState;
    out_trade_no: string;
    amount_cents: number;
    succeeded_at: Date | null;
    next_check_at: Date | null;
  }>(
    `SELECT payment_transactions.id, payment_transactions.state,
            payment_transactions.out_trade_no,
            payment_transactions.amount_cents,
            payment_transactions.succeeded_at,
            payment_transactions.next_check_at
       FROM payment_transactions
       JOIN orders ON orders.id = payment_transactions.order_id
      WHERE payment_transactions.id = $1 AND orders.customer_id = $2`,
    [paymentId, customerId],
  );
  return result.rows[0];
}

export async function getPaymentStatus(
  database: Database,
  customerId: string,
  paymentId: string,
  gateway?: WechatPayGateway,
  config?: WechatPayConfig,
) {
  let payment = await loadPaymentStatus(database, customerId, paymentId);
  if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "支付记录不存在");
  if (
    gateway &&
    config &&
    (payment.state === "processing" || payment.state === "unknown") &&
    (!payment.next_check_at || payment.next_check_at.getTime() <= Date.now())
  ) {
    await reconcilePayment(database, gateway, config, paymentId);
    payment =
      (await loadPaymentStatus(database, customerId, paymentId)) ?? payment;
  }
  return {
    paymentId: payment.id,
    outTradeNo: payment.out_trade_no,
    state: payment.state,
    amountCents: String(payment.amount_cents),
    succeededAt: payment.succeeded_at?.toISOString() ?? null,
    nextPollAt: payment.next_check_at?.toISOString() ?? null,
    requiresManualReview: payment.state === "manual_review",
  };
}

export async function applyWechatPaymentNotification(
  database: Database,
  expectedAppId: string,
  expectedMerchantId: string,
  notification: WechatPaymentNotification,
) {
  if (
    notification.appId !== expectedAppId ||
    notification.merchantId !== expectedMerchantId
  ) {
    throw new AppError(400, "PAYMENT_MERCHANT_MISMATCH", "支付商户信息不匹配");
  }
  if (notification.tradeState !== "SUCCESS") {
    throw new AppError(400, "PAYMENT_STATE_INVALID", "支付通知状态不是成功");
  }

  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      state: string;
      amount_cents: number;
      currency: string;
      payer_open_id: string;
      channel_transaction_id: string | null;
    }>(
      `SELECT id, state, amount_cents, currency, payer_open_id,
              channel_transaction_id
         FROM payment_transactions
        WHERE out_trade_no = $1 AND channel = 'wechat'
        FOR UPDATE`,
      [notification.outTradeNo],
    );
    const payment = result.rows[0];
    if (!payment) {
      throw new AppError(404, "PAYMENT_NOT_FOUND", "商户支付单不存在");
    }
    if (
      payment.amount_cents !== notification.amountCents ||
      payment.currency !== notification.currency ||
      payment.payer_open_id !== notification.payerOpenId
    ) {
      throw new AppError(
        400,
        "PAYMENT_NOTIFICATION_MISMATCH",
        "支付通知与订单快照不一致",
      );
    }
    if (payment.state === "succeeded") {
      if (payment.channel_transaction_id !== notification.transactionId) {
        throw new AppError(
          409,
          "PAYMENT_TRANSACTION_MISMATCH",
          "支付渠道流水号与已入账记录不一致",
        );
      }
      await client.query("COMMIT");
      return;
    }

    const succeededAt = new Date(notification.successTime);
    if (Number.isNaN(succeededAt.getTime())) {
      throw new AppError(400, "PAYMENT_TIME_INVALID", "支付成功时间无效");
    }
    await client.query(
      `UPDATE payment_transactions
          SET state = 'succeeded', channel_transaction_id = $2,
              succeeded_at = $3, next_check_at = NULL,
              last_error_code = NULL, last_error_message = NULL,
              lease_token = NULL, lease_until = NULL,
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [payment.id, notification.transactionId, succeededAt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
