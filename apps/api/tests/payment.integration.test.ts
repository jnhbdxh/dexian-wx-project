import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import {
  WechatMiniProgramRequestError,
  type WechatMiniProgramGateway,
} from "../src/integrations/wechat/miniprogram.js";
import type {
  WechatPayCreateInput,
  WechatPayGateway,
  WechatPaymentNotification,
  WechatPayOrder,
} from "../src/integrations/wechat/payment.js";
import { hashToken } from "../src/lib/crypto.js";
import {
  PAYMENTS_REVIEW_READ,
  PAYMENTS_REVIEW_RECONCILE,
} from "../src/modules/payment/routes.js";
import {
  reconcileDuePayments,
  reconcilePayment,
} from "../src/modules/payment/service.js";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const suffix = randomUUID();
const customerToken = `payment-customer-${suffix}`;
const staffToken = `payment-staff-${suffix}`;
const staffCsrf = `payment-csrf-${suffix}`;
const appId = "wx-test-app";
const merchantId = "1900000001";
const payConfig = {
  appId,
  merchantId,
  merchantCertificateSerial: "merchant-serial",
  merchantPrivateKeyPath: "unused",
  wechatPayPublicKeyId: "public-key-id",
  wechatPayPublicKeyPath: "unused",
  apiV3Key: "12345678901234567890123456789012",
  notifyUrl: "https://example.test/notify",
  apiBaseUrl: "https://api.mch.weixin.qq.com",
  collectionGraceMinutes: 120,
};
let app: Awaited<ReturnType<typeof buildApp>>;
let database: Database;
let customerId = "";
let storeId = "";
let receptionId = "";
let serviceItemId = "";
let therapistId = "";
let roomId = "";
let bedId = "";
let loginCustomerId = "";
let staffUserId = "";
let staffRoleId = "";
let createCalls: WechatPayCreateInput[] = [];
let notification: WechatPaymentNotification;
let queriedOrder: WechatPayOrder | null = null;
let createGate: Promise<void> | undefined;
let releaseCreate: (() => void) | undefined;
let signalCreateStarted: (() => void) | undefined;
let loginError: Error | undefined;
let closeError: Error | undefined;
const closeCalls: string[] = [];

const paymentParameters = {
  timeStamp: "1720000000",
  nonceStr: "nonce",
  package: "prepay_id=test-prepay",
  signType: "RSA" as const,
  paySign: "signature",
};

const gateway: WechatPayGateway = {
  async createJsapiPayment(input) {
    createCalls.push(input);
    signalCreateStarted?.();
    await createGate;
    return {
      prepayId: `test-prepay-${createCalls.length}`,
      paymentParameters,
    };
  },
  buildPaymentParameters: () => paymentParameters,
  queryPayment: async () => queriedOrder,
  async closePayment(outTradeNo) {
    closeCalls.push(outTradeNo);
    if (closeError) throw closeError;
  },
  verifyAndDecryptNotification: () => notification,
};
const miniProgramGateway: WechatMiniProgramGateway = {
  async exchangeCode() {
    if (loginError) throw loginError;
    return { openId: `login-open-id-${suffix}`, unionId: `union-${suffix}` };
  },
};

async function insertStoredPayment(
  state: "created" | "processing" | "unknown" | "manual_review",
  collectionDeadline: Date,
) {
  const reception = await database.pool.query<{ id: string }>(
    `INSERT INTO receptions (store_id, customer_id, state, quote_cents)
     VALUES ($1, $2, 'confirmed', 32800)
     RETURNING id`,
    [storeId, customerId],
  );
  const storedReceptionId = reception.rows[0]!.id;
  await database.pool.query(
    `INSERT INTO reception_guests (
       store_id, reception_id, client_guest_id, service_item_id,
       therapist_resource_id, room_resource_id, bed_resource_id,
       service_start_at, service_end_at, quote_cents,
       service_config_version, store_config_version,
       duration_minutes_snapshot, prepare_minutes_snapshot,
       therapist_cleanup_minutes_snapshot, facility_cleanup_minutes_snapshot,
       rest_minutes_snapshot, rule_snapshot
     ) VALUES (
       $1, $2, 'guest-1', $3, $4, $5, $6,
       $7, $8, 32800, 1, 1, 60, 0, 0, 0, 0, '{}'::jsonb
     )`,
    [
      storeId,
      storedReceptionId,
      serviceItemId,
      therapistId,
      roomId,
      bedId,
      new Date(collectionDeadline.getTime() - 3 * 60 * 60 * 1_000),
      new Date(collectionDeadline.getTime() - 2 * 60 * 60 * 1_000),
    ],
  );
  const order = await database.pool.query<{ id: string }>(
    `INSERT INTO orders (
       store_id, customer_id, reception_id, payable_cents, currency,
       quote_snapshot, collection_deadline
     ) VALUES ($1, $2, $3, 32800, 'CNY', '{}'::jsonb, $4)
     RETURNING id`,
    [storeId, customerId, storedReceptionId, collectionDeadline],
  );
  const paymentId = randomUUID();
  const outTradeNo = paymentId.replaceAll("-", "");
  await database.pool.query(
    `INSERT INTO payment_transactions (
       id, order_id, channel, state, out_trade_no, amount_cents,
       currency, payer_open_id
     ) VALUES ($1, $2, 'wechat', $3, $4, 32800, 'CNY', 'payer-open-id')`,
    [paymentId, order.rows[0]!.id, state, outTradeNo],
  );
  return { paymentId, outTradeNo, receptionId: storedReceptionId };
}

async function insertBarePayment(
  targetStoreId: string,
  targetCustomerId: string,
  state: "processing" | "unknown" | "manual_review",
) {
  const reception = await database.pool.query<{ id: string }>(
    `INSERT INTO receptions (store_id, customer_id, state, quote_cents)
     VALUES ($1, $2, 'confirmed', 32800)
     RETURNING id`,
    [targetStoreId, targetCustomerId],
  );
  const order = await database.pool.query<{ id: string }>(
    `INSERT INTO orders (
       store_id, customer_id, reception_id, payable_cents, currency,
       quote_snapshot, collection_deadline
     ) VALUES ($1, $2, $3, 32800, 'CNY', '{}'::jsonb, $4)
     RETURNING id`,
    [
      targetStoreId,
      targetCustomerId,
      reception.rows[0]!.id,
      new Date(Date.now() + 60 * 60 * 1_000),
    ],
  );
  const paymentId = randomUUID();
  const outTradeNo = paymentId.replaceAll("-", "");
  await database.pool.query(
    `INSERT INTO payment_transactions (
       id, order_id, channel, state, out_trade_no, amount_cents,
       currency, payer_open_id
     ) VALUES ($1, $2, 'wechat', $3, $4, 32800, 'CNY', 'payer-open-id')`,
    [paymentId, order.rows[0]!.id, state, outTradeNo],
  );
  return {
    paymentId,
    orderId: order.rows[0]!.id,
    receptionId: reception.rows[0]!.id,
  };
}

function staffCookie() {
  return `dexian_admin_session=${staffToken}; dexian_admin_csrf=${staffCsrf}`;
}

function queriedPayment(
  payment: { outTradeNo: string },
  tradeState: string,
): WechatPayOrder {
  return {
    appId,
    merchantId,
    outTradeNo: payment.outTradeNo,
    tradeState,
    tradeStateDescription: tradeState === "SUCCESS" ? "支付成功" : "未支付",
    ...(tradeState === "SUCCESS"
      ? {
          transactionId: `wx-${payment.outTradeNo}`,
          successTime: new Date().toISOString(),
        }
      : {}),
    payerOpenId: "payer-open-id",
    amountCents: 32800,
    currency: "CNY",
  };
}

describe.runIf(hasDatabase)("WeChat payment flow", () => {
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
      wechatMiniProgram: {
        appId,
        appSecret: "test-app-secret",
      },
      wechatPay: payConfig,
    };
    database = createDatabase(config);
    const store = await database.pool.query<{ id: string }>(
      "INSERT INTO stores (name) VALUES ($1) RETURNING id",
      [`支付测试门店-${suffix}`],
    );
    storeId = store.rows[0]!.id;
    const customer = await database.pool.query<{ id: string }>(
      "INSERT INTO customers (display_name) VALUES ($1) RETURNING id",
      [`支付测试顾客-${suffix}`],
    );
    customerId = customer.rows[0]!.id;
    const staff = await database.pool.query<{ id: string }>(
      `INSERT INTO staff_users (
         store_id, username, password_hash, display_name
       ) VALUES ($1, $2, 'unused', '支付值班员')
       RETURNING id`,
      [storeId, `payment-review-${suffix}`],
    );
    staffUserId = staff.rows[0]!.id;
    const role = await database.pool.query<{ id: string }>(
      `INSERT INTO roles (store_id, code, name)
       VALUES ($1, $2, '支付复核员')
       RETURNING id`,
      [storeId, `payment-review-${suffix}`],
    );
    staffRoleId = role.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO permissions (code, name) VALUES
         ($1, '查看异常支付'), ($2, '重新查询异常支付')
       ON CONFLICT (code) DO NOTHING`,
      [PAYMENTS_REVIEW_READ, PAYMENTS_REVIEW_RECONCILE],
    );
    await database.pool.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       VALUES ($1, $2), ($1, $3)`,
      [staffRoleId, PAYMENTS_REVIEW_READ, PAYMENTS_REVIEW_RECONCILE],
    );
    await database.pool.query(
      `INSERT INTO staff_role_assignments (staff_user_id, role_id)
       VALUES ($1, $2)`,
      [staffUserId, staffRoleId],
    );
    await database.pool.query(
      `INSERT INTO staff_sessions (
         staff_user_id, token_hash, csrf_token_hash, expires_at
       ) VALUES ($1, $2, $3, $4)`,
      [
        staffUserId,
        hashToken(staffToken),
        hashToken(staffCsrf),
        new Date(Date.now() + 60_000),
      ],
    );
    await database.pool.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [customerId, hashToken(customerToken), new Date(Date.now() + 60_000)],
    );
    await database.pool.query(
      `INSERT INTO wechat_identities (customer_id, app_id, open_id)
       VALUES ($1, $2, 'payer-open-id')`,
      [customerId, appId],
    );
    const reception = await database.pool.query<{ id: string }>(
      `INSERT INTO receptions (store_id, customer_id, state, quote_cents)
       VALUES ($1, $2, 'confirmed', 32800)
       RETURNING id`,
      [storeId, customerId],
    );
    receptionId = reception.rows[0]!.id;
    const serviceItem = await database.pool.query<{ id: string }>(
      `INSERT INTO service_items (
         store_id, name, duration_minutes, price_cents
       ) VALUES ($1, $2, 60, 32800)
       RETURNING id`,
      [storeId, `支付测试服务-${suffix}`],
    );
    serviceItemId = serviceItem.rows[0]!.id;
    const resources = await database.pool.query<{
      id: string;
      resource_type: "therapist" | "room";
    }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'therapist', $2), ($1, 'room', $3)
       RETURNING id, resource_type`,
      [storeId, `支付测试技师-${suffix}`, `支付测试房间-${suffix}`],
    );
    therapistId = resources.rows.find(
      (resource) => resource.resource_type === "therapist",
    )!.id;
    roomId = resources.rows.find(
      (resource) => resource.resource_type === "room",
    )!.id;
    const bed = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (
         store_id, resource_type, parent_resource_id, name
       ) VALUES ($1, 'bed', $2, $3)
       RETURNING id`,
      [storeId, roomId, `支付测试床位-${suffix}`],
    );
    bedId = bed.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO reception_guests (
         store_id, reception_id, client_guest_id, service_item_id,
         therapist_resource_id, room_resource_id, bed_resource_id,
         service_start_at, service_end_at, quote_cents,
         service_config_version, store_config_version,
         duration_minutes_snapshot, prepare_minutes_snapshot,
         therapist_cleanup_minutes_snapshot, facility_cleanup_minutes_snapshot,
         rest_minutes_snapshot, rule_snapshot
       ) VALUES (
         $1, $2, 'guest-1', $3, $4, $5, $6,
         $7, $8, 32800, 1, 1, 60, 0, 0, 0, 0, '{}'::jsonb
       )`,
      [
        storeId,
        receptionId,
        serviceItemId,
        therapistId,
        roomId,
        bedId,
        new Date(Date.now() + 60 * 60 * 1_000),
        new Date(Date.now() + 2 * 60 * 60 * 1_000),
      ],
    );
    notification = {
      appId,
      merchantId,
      outTradeNo: "",
      transactionId: `wx-transaction-${suffix}`,
      tradeState: "SUCCESS",
      successTime: new Date().toISOString(),
      payerOpenId: "payer-open-id",
      amountCents: 32800,
      currency: "CNY",
    };
    app = await buildApp({
      config,
      database,
      logger: false,
      wechatPayGateway: gateway,
      wechatMiniProgramGateway: miniProgramGateway,
    });
  });

  afterAll(async () => {
    await app?.close();
    if (database && customerId) {
      if (loginCustomerId) {
        await database.pool.query(
          "DELETE FROM login_audits WHERE actor_id = $1",
          [loginCustomerId],
        );
        await database.pool.query(
          "DELETE FROM customer_sessions WHERE customer_id = $1",
          [loginCustomerId],
        );
        await database.pool.query(
          "DELETE FROM wechat_identities WHERE customer_id = $1",
          [loginCustomerId],
        );
        await database.pool.query("DELETE FROM customers WHERE id = $1", [
          loginCustomerId,
        ]);
      }
      await database.pool.query(
        `DELETE FROM business_events
          WHERE actor_type = 'customer' AND actor_id = $1`,
        [customerId],
      );
      await database.pool.query(
        `DELETE FROM payment_transactions
          WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [customerId],
      );
      await database.pool.query("DELETE FROM orders WHERE customer_id = $1", [
        customerId,
      ]);
      await database.pool.query(
        "DELETE FROM reception_guests WHERE store_id = $1",
        [storeId],
      );
      await database.pool.query("DELETE FROM receptions WHERE store_id = $1", [
        storeId,
      ]);
      await database.pool.query(
        "DELETE FROM customer_sessions WHERE customer_id = $1",
        [customerId],
      );
      await database.pool.query(
        "DELETE FROM wechat_identities WHERE customer_id = $1",
        [customerId],
      );
      await database.pool.query("DELETE FROM customers WHERE id = $1", [
        customerId,
      ]);
      await database.pool.query("DELETE FROM service_items WHERE id = $1", [
        serviceItemId,
      ]);
      if (bedId) {
        await database.pool.query("DELETE FROM resources WHERE id = $1", [
          bedId,
        ]);
      }
      await database.pool.query(
        "DELETE FROM resources WHERE id = ANY($1::uuid[])",
        [[therapistId, roomId].filter(Boolean)],
      );
      await database.pool.query(
        "DELETE FROM staff_sessions WHERE staff_user_id = $1",
        [staffUserId],
      );
      await database.pool.query(
        "DELETE FROM staff_role_assignments WHERE staff_user_id = $1",
        [staffUserId],
      );
      await database.pool.query(
        "DELETE FROM role_permissions WHERE role_id = $1",
        [staffRoleId],
      );
      await database.pool.query("DELETE FROM roles WHERE id = $1", [
        staffRoleId,
      ]);
      await database.pool.query("DELETE FROM staff_users WHERE id = $1", [
        staffUserId,
      ]);
      await database.pool.query("DELETE FROM stores WHERE id = $1", [storeId]);
    }
    await database?.pool.end();
  });

  it("exchanges a Mini Program code for a customer session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/customer/auth/wechat-login",
      payload: { code: "temporary-code" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accessToken: expect.any(String),
      customerId: expect.any(String),
      expiresAt: expect.any(String),
    });
    loginCustomerId = response.json().customerId;

    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/customer/auth/wechat-login",
      payload: { code: "temporary-code-again" },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().customerId).toBe(loginCustomerId);

    const identity = await database.pool.query(
      `SELECT open_id, union_id
         FROM wechat_identities
        WHERE customer_id = $1 AND app_id = $2`,
      [loginCustomerId, appId],
    );
    expect(identity.rows).toEqual([
      {
        open_id: `login-open-id-${suffix}`,
        union_id: `union-${suffix}`,
      },
    ]);
  });

  it("distinguishes invalid login codes from upstream failures", async () => {
    loginError = new WechatMiniProgramRequestError(
      "credential",
      40029,
      "invalid code",
    );
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/customer/auth/wechat-login",
      payload: { code: "invalid-code" },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().code).toBe("WECHAT_LOGIN_FAILED");

    loginError = new WechatMiniProgramRequestError(
      "temporary",
      -1,
      "upstream busy",
    );
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/v1/customer/auth/wechat-login",
      payload: { code: "retry-later" },
    });
    loginError = undefined;
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().code).toBe("WECHAT_LOGIN_UNAVAILABLE");
    await database.pool.query(
      "DELETE FROM login_audits WHERE request_id = ANY($1::text[])",
      [[invalid.json().requestId, unavailable.json().requestId]],
    );
  });

  it("serializes creation, renews prepay, and converges through querying", async () => {
    const headers = {
      authorization: `Bearer ${customerToken}`,
      "idempotency-key": `payment-${suffix}`,
    };
    let createStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    signalCreateStarted = createStarted;
    const creating = app.inject({
      method: "POST",
      url: "/api/v1/payments/wechat",
      headers,
      payload: { receptionId },
    });
    await started;
    const concurrent = await app.inject({
      method: "POST",
      url: "/api/v1/payments/wechat",
      headers: {
        ...headers,
        "idempotency-key": `payment-concurrent-${suffix}`,
      },
      payload: { receptionId },
    });
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json().code).toBe("PAYMENT_REQUEST_IN_PROGRESS");
    releaseCreate?.();
    const created = await creating;
    createGate = undefined;
    signalCreateStarted = undefined;
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      state: "processing",
      amountCents: "32800",
      paymentParameters,
      prepayExpiresAt: expect.any(String),
      nextPollAt: expect.any(String),
    });
    expect(createCalls).toHaveLength(1);
    notification.outTradeNo = created.json().outTradeNo;

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/payments/wechat",
      headers,
      payload: { receptionId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      paymentId: created.json().paymentId,
      outTradeNo: created.json().outTradeNo,
      state: "processing",
    });
    expect(createCalls).toHaveLength(1);

    await database.pool.query(
      `UPDATE payment_transactions
          SET prepay_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [created.json().paymentId],
    );
    const renewed = await app.inject({
      method: "POST",
      url: "/api/v1/payments/wechat",
      headers: {
        ...headers,
        "idempotency-key": `payment-renew-${suffix}`,
      },
      payload: { receptionId },
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().paymentId).toBe(created.json().paymentId);
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]?.timeExpire).toEqual(expect.any(String));

    queriedOrder = {
      ...notification,
      tradeStateDescription: "支付成功",
    };
    await database.pool.query(
      `UPDATE payment_transactions
          SET next_check_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [created.json().paymentId],
    );
    const reconciled = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${created.json().paymentId}`,
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      state: "succeeded",
      requiresManualReview: false,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const callback = await app.inject({
        method: "POST",
        url: "/api/v1/payments/wechat/notify",
        headers: {
          "wechatpay-timestamp": "1720000000",
          "wechatpay-nonce": "nonce",
          "wechatpay-signature": "signature",
          "wechatpay-serial": "public-key-id",
        },
        payload: {
          id: `event-${attempt}`,
          create_time: new Date().toISOString(),
          event_type: "TRANSACTION.SUCCESS",
          resource_type: "encrypt-resource",
          resource: {
            algorithm: "AEAD_AES_256_GCM",
            ciphertext: "ciphertext",
            nonce: "resource-nonce",
            original_type: "transaction",
          },
          summary: "支付成功",
        },
      });
      expect(callback.statusCode).toBe(204);
    }

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${created.json().paymentId}`,
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      state: "succeeded",
      amountCents: "32800",
    });
    expect(status.json().succeededAt).toEqual(expect.any(String));
    queriedOrder = null;
  });

  it("lets the worker take over a created payment", async () => {
    const payment = await insertStoredPayment(
      "created",
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    queriedOrder = null;

    await reconcileDuePayments(database, gateway, payConfig);

    const stored = await database.pool.query(
      `SELECT state, next_check_at
         FROM payment_transactions
        WHERE id = $1`,
      [payment.paymentId],
    );
    expect(stored.rows[0]).toMatchObject({
      state: "processing",
      next_check_at: expect.any(Date),
    });
  });

  it("keeps a payment unknown when closing the WeChat order fails", async () => {
    const payment = await insertStoredPayment(
      "processing",
      new Date(Date.now() - 60_000),
    );
    queriedOrder = queriedPayment(payment, "NOTPAY");
    closeError = new Error("close timeout");

    await reconcilePayment(database, gateway, payConfig, payment.paymentId);
    closeError = undefined;
    queriedOrder = null;

    const stored = await database.pool.query<{ state: string }>(
      "SELECT state FROM payment_transactions WHERE id = $1",
      [payment.paymentId],
    );
    expect(stored.rows[0]?.state).toBe("unknown");
  });

  it("fails an expired payment when WeChat confirms the order is absent", async () => {
    const payment = await insertStoredPayment(
      "processing",
      new Date(Date.now() - 60_000),
    );
    const closeCallCount = closeCalls.length;
    queriedOrder = null;

    await reconcilePayment(database, gateway, payConfig, payment.paymentId);

    const stored = await database.pool.query<{ state: string }>(
      "SELECT state FROM payment_transactions WHERE id = $1",
      [payment.paymentId],
    );
    expect(stored.rows[0]?.state).toBe("failed");
    expect(closeCalls).toHaveLength(closeCallCount);
  });

  it("does not auto-close a legacy payment with an unknown collection deadline", async () => {
    const payment = await insertStoredPayment(
      "manual_review",
      new Date(Date.now() - 60_000),
    );
    await database.pool.query(
      `UPDATE payment_transactions
          SET last_error_code = 'LEGACY_COLLECTION_DEADLINE_UNKNOWN'
        WHERE id = $1`,
      [payment.paymentId],
    );
    const closeCallCount = closeCalls.length;
    queriedOrder = queriedPayment(payment, "NOTPAY");

    await reconcilePayment(
      database,
      gateway,
      payConfig,
      payment.paymentId,
      true,
    );
    queriedOrder = null;

    const stored = await database.pool.query<{
      state: string;
      last_error_code: string;
    }>(
      `SELECT state, last_error_code
         FROM payment_transactions
        WHERE id = $1`,
      [payment.paymentId],
    );
    expect(stored.rows[0]).toMatchObject({
      state: "manual_review",
      last_error_code: "LEGACY_COLLECTION_DEADLINE_UNKNOWN",
    });
    expect(closeCalls).toHaveLength(closeCallCount);
  });

  it("lists abnormal payments and lets an operator re-query one", async () => {
    const payment = await insertStoredPayment(
      "manual_review",
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    const cookie = staffCookie();
    const queue = await app.inject({
      method: "GET",
      url: "/api/v1/admin/payments/review",
      headers: { cookie },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toMatchObject({
      canReconcilePayments: true,
      channelConfigured: true,
      payments: expect.arrayContaining([
        expect.objectContaining({
          paymentId: payment.paymentId,
          state: "manual_review",
        }),
      ]),
    });

    queriedOrder = queriedPayment(payment, "SUCCESS");
    const reconciled = await app.inject({
      method: "POST",
      url: `/api/v1/admin/payments/${payment.paymentId}/reconcile`,
      headers: { cookie, "x-csrf-token": staffCsrf },
    });
    queriedOrder = null;
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().state).toBe("succeeded");
  });

  it("keeps another store's payment out of the review boundary", async () => {
    const otherStore = await database.pool.query<{ id: string }>(
      "INSERT INTO stores (name) VALUES ($1) RETURNING id",
      [`其他支付门店-${suffix}`],
    );
    const otherCustomer = await database.pool.query<{ id: string }>(
      "INSERT INTO customers (display_name) VALUES ($1) RETURNING id",
      [`其他支付顾客-${suffix}`],
    );
    const payment = await insertBarePayment(
      otherStore.rows[0]!.id,
      otherCustomer.rows[0]!.id,
      "manual_review",
    );
    try {
      const queue = await app.inject({
        method: "GET",
        url: "/api/v1/admin/payments/review",
        headers: { cookie: staffCookie() },
      });
      expect(queue.statusCode).toBe(200);
      expect(
        queue
          .json()
          .payments.some(
            (item: { paymentId: string }) =>
              item.paymentId === payment.paymentId,
          ),
      ).toBe(false);

      const reconciled = await app.inject({
        method: "POST",
        url: `/api/v1/admin/payments/${payment.paymentId}/reconcile`,
        headers: {
          cookie: staffCookie(),
          "x-csrf-token": staffCsrf,
        },
      });
      expect(reconciled.statusCode).toBe(404);
      expect(reconciled.json().code).toBe("PAYMENT_NOT_FOUND");
    } finally {
      await database.pool.query(
        "DELETE FROM payment_transactions WHERE id = $1",
        [payment.paymentId],
      );
      await database.pool.query("DELETE FROM orders WHERE id = $1", [
        payment.orderId,
      ]);
      await database.pool.query("DELETE FROM receptions WHERE id = $1", [
        payment.receptionId,
      ]);
      await database.pool.query("DELETE FROM customers WHERE id = $1", [
        otherCustomer.rows[0]!.id,
      ]);
      await database.pool.query("DELETE FROM stores WHERE id = $1", [
        otherStore.rows[0]!.id,
      ]);
    }
  });

  it("enforces review permissions and CSRF validation", async () => {
    const payment = await insertStoredPayment(
      "manual_review",
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    try {
      await database.pool.query(
        `DELETE FROM role_permissions
          WHERE role_id = $1 AND permission_code = $2`,
        [staffRoleId, PAYMENTS_REVIEW_READ],
      );
      const forbiddenList = await app.inject({
        method: "GET",
        url: "/api/v1/admin/payments/review",
        headers: { cookie: staffCookie() },
      });
      expect(forbiddenList.statusCode).toBe(403);
      expect(forbiddenList.json().code).toBe("PERMISSION_DENIED");

      await database.pool.query(
        `INSERT INTO role_permissions (role_id, permission_code)
         VALUES ($1, $2)`,
        [staffRoleId, PAYMENTS_REVIEW_READ],
      );
      await database.pool.query(
        `DELETE FROM role_permissions
          WHERE role_id = $1 AND permission_code = $2`,
        [staffRoleId, PAYMENTS_REVIEW_RECONCILE],
      );
      const forbiddenReconcile = await app.inject({
        method: "POST",
        url: `/api/v1/admin/payments/${payment.paymentId}/reconcile`,
        headers: {
          cookie: staffCookie(),
          "x-csrf-token": staffCsrf,
        },
      });
      expect(forbiddenReconcile.statusCode).toBe(403);
      expect(forbiddenReconcile.json().code).toBe("PERMISSION_DENIED");

      await database.pool.query(
        `INSERT INTO role_permissions (role_id, permission_code)
         VALUES ($1, $2)`,
        [staffRoleId, PAYMENTS_REVIEW_RECONCILE],
      );
      const invalidCsrf = await app.inject({
        method: "POST",
        url: `/api/v1/admin/payments/${payment.paymentId}/reconcile`,
        headers: {
          cookie: staffCookie(),
          "x-csrf-token": "invalid-csrf-token",
        },
      });
      expect(invalidCsrf.statusCode).toBe(403);
      expect(invalidCsrf.json().code).toBe("CSRF_INVALID");
    } finally {
      await database.pool.query(
        `INSERT INTO role_permissions (role_id, permission_code)
         VALUES ($1, $2), ($1, $3)
         ON CONFLICT DO NOTHING`,
        [staffRoleId, PAYMENTS_REVIEW_READ, PAYMENTS_REVIEW_RECONCILE],
      );
    }
  });

  it("rejects non-abnormal payments and an active reconciliation lease", async () => {
    const processing = await insertStoredPayment(
      "processing",
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    const nonAbnormal = await app.inject({
      method: "POST",
      url: `/api/v1/admin/payments/${processing.paymentId}/reconcile`,
      headers: { cookie: staffCookie(), "x-csrf-token": staffCsrf },
    });
    expect(nonAbnormal.statusCode).toBe(409);
    expect(nonAbnormal.json().code).toBe("PAYMENT_NOT_REVIEWABLE");

    const leased = await insertStoredPayment(
      "manual_review",
      new Date(Date.now() + 60 * 60 * 1_000),
    );
    await database.pool.query(
      `UPDATE payment_transactions
          SET lease_token = $2,
              lease_until = clock_timestamp() + interval '30 seconds'
        WHERE id = $1`,
      [leased.paymentId, randomUUID()],
    );
    const inProgress = await app.inject({
      method: "POST",
      url: `/api/v1/admin/payments/${leased.paymentId}/reconcile`,
      headers: { cookie: staffCookie(), "x-csrf-token": staffCsrf },
    });
    expect(inProgress.statusCode).toBe(409);
    expect(inProgress.json().code).toBe("PAYMENT_RECONCILIATION_IN_PROGRESS");
  });
});
