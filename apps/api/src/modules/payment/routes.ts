import { Readable } from "node:stream";

import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { WechatPayGateway } from "../../integrations/wechat/payment.js";
import { AppError } from "../../lib/app-error.js";
import { hashToken } from "../../lib/crypto.js";
import {
  findStaffSession,
  requireCustomerSession,
  staffHasPermission,
  STAFF_CSRF_COOKIE,
  STAFF_SESSION_COOKIE,
} from "../auth/service.js";
import {
  applyWechatPaymentNotification,
  createWechatPayment,
  getPaymentStatus,
  loadPaymentReviewItem,
  loadPaymentReviewQueue,
  reconcilePayment,
} from "./service.js";

export const PAYMENTS_REVIEW_READ = "payments.review.read";
export const PAYMENTS_REVIEW_RECONCILE = "payments.review.reconcile";

interface PaymentOptions {
  config: AppConfig;
  database: Database;
  wechatPayGateway?: WechatPayGateway;
}

const Uuid = Type.String({ format: "uuid" });
const rawBodies = new WeakMap<object, string>();
const ErrorResponse = Type.Object({
  code: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});
const PaymentStateResponse = Type.Union([
  Type.Literal("created"),
  Type.Literal("processing"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("unknown"),
  Type.Literal("manual_review"),
]);
const PaymentReviewItemResponse = Type.Object({
  paymentId: Uuid,
  receptionId: Uuid,
  outTradeNo: Type.String(),
  state: PaymentStateResponse,
  customerName: Type.String(),
  amountCents: Type.String({ pattern: "^[1-9]\\d*$" }),
  collectionDeadline: Type.String({ format: "date-time" }),
  checkAttempts: Type.Integer({ minimum: 0 }),
  lastErrorCode: Type.Union([Type.String(), Type.Null()]),
  lastErrorMessage: Type.Union([Type.String(), Type.Null()]),
  nextCheckAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  updatedAt: Type.String({ format: "date-time" }),
});

async function requireStaffPermission(
  database: Database,
  request: {
    cookies: Record<string, string | undefined>;
  },
  permission: string,
) {
  const token = request.cookies[STAFF_SESSION_COOKIE];
  const session = token ? await findStaffSession(database, token) : undefined;
  if (!session) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  if (
    !(await staffHasPermission(
      database,
      session.staffUserId,
      session.storeId,
      permission,
    ))
  ) {
    throw new AppError(
      403,
      "PERMISSION_DENIED",
      "当前账号无权处理异常支付，请联系店长分配权限",
      { requiredPermission: permission },
    );
  }
  return session;
}

function idempotencyKey(value: string | string[] | undefined) {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "请提供有效的 Idempotency-Key",
    );
  }
  return value;
}

function requiredHeader(value: string | string[] | undefined, name: string) {
  if (typeof value !== "string" || !value) {
    throw new AppError(400, "WECHAT_PAY_HEADER_MISSING", `缺少 ${name} 请求头`);
  }
  return value;
}

export const paymentRoutes: FastifyPluginAsyncTypebox<PaymentOptions> = async (
  app,
  options,
) => {
  app.post(
    "/api/v1/payments/wechat",
    {
      schema: {
        body: Type.Object({ receptionId: Uuid }),
        response: {
          200: Type.Object({
            paymentId: Uuid,
            outTradeNo: Type.String(),
            state: Type.Literal("processing"),
            amountCents: Type.String({ pattern: "^[1-9]\\d*$" }),
            prepayExpiresAt: Type.String({ format: "date-time" }),
            nextPollAt: Type.String({ format: "date-time" }),
            paymentParameters: Type.Object({
              timeStamp: Type.String(),
              nonceStr: Type.String(),
              package: Type.String(),
              signType: Type.Literal("RSA"),
              paySign: Type.String(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const identity = await requireCustomerSession(
        options.database,
        request.headers.authorization,
      );
      if (!options.config.wechatPay || !options.wechatPayGateway) {
        throw new AppError(
          503,
          "WECHAT_PAY_NOT_CONFIGURED",
          "微信支付尚未配置，请联系管理员",
        );
      }
      return createWechatPayment(
        options.database,
        options.wechatPayGateway,
        options.config.wechatPay,
        identity.customerId,
        request.body.receptionId,
        idempotencyKey(request.headers["idempotency-key"]),
      );
    },
  );

  app.get(
    "/api/v1/payments/:paymentId",
    {
      schema: {
        params: Type.Object({ paymentId: Uuid }),
        response: {
          200: Type.Object({
            paymentId: Uuid,
            outTradeNo: Type.String(),
            state: PaymentStateResponse,
            amountCents: Type.String({ pattern: "^[1-9]\\d*$" }),
            succeededAt: Type.Union([
              Type.String({ format: "date-time" }),
              Type.Null(),
            ]),
            nextPollAt: Type.Union([
              Type.String({ format: "date-time" }),
              Type.Null(),
            ]),
            requiresManualReview: Type.Boolean(),
          }),
        },
      },
    },
    async (request) => {
      const identity = await requireCustomerSession(
        options.database,
        request.headers.authorization,
      );
      return getPaymentStatus(
        options.database,
        identity.customerId,
        request.params.paymentId,
        options.wechatPayGateway,
        options.config.wechatPay,
      );
    },
  );

  app.get(
    "/api/v1/admin/payments/review",
    {
      schema: {
        querystring: Type.Object({ afterPaymentId: Type.Optional(Uuid) }),
        response: {
          200: Type.Object({
            user: Type.Object({
              id: Uuid,
              storeId: Uuid,
              username: Type.String(),
              displayName: Type.String(),
            }),
            canReconcilePayments: Type.Boolean(),
            channelConfigured: Type.Boolean(),
            payments: Type.Array(PaymentReviewItemResponse),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const session = await requireStaffPermission(
        options.database,
        request,
        PAYMENTS_REVIEW_READ,
      );
      const [canReconcilePayments, queue] = await Promise.all([
        staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          PAYMENTS_REVIEW_RECONCILE,
        ),
        loadPaymentReviewQueue(
          options.database,
          session.storeId,
          request.query.afterPaymentId,
        ),
      ]);
      return {
        user: {
          id: session.staffUserId,
          storeId: session.storeId,
          username: session.username,
          displayName: session.displayName,
        },
        canReconcilePayments,
        channelConfigured: Boolean(
          options.config.wechatPay && options.wechatPayGateway,
        ),
        ...queue,
      };
    },
  );

  app.post(
    "/api/v1/admin/payments/:paymentId/reconcile",
    {
      schema: {
        params: Type.Object({ paymentId: Uuid }),
        response: {
          200: PaymentReviewItemResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          503: ErrorResponse,
        },
      },
    },
    async (request) => {
      const session = await requireStaffPermission(
        options.database,
        request,
        PAYMENTS_REVIEW_RECONCILE,
      );
      const csrfToken = request.headers["x-csrf-token"];
      if (
        typeof csrfToken !== "string" ||
        request.cookies[STAFF_CSRF_COOKIE] !== csrfToken ||
        hashToken(csrfToken) !== session.csrfTokenHash
      ) {
        throw new AppError(403, "CSRF_INVALID", "页面状态已失效，请刷新后重试");
      }
      const current = await loadPaymentReviewItem(
        options.database,
        session.storeId,
        request.params.paymentId,
      );
      if (!current) {
        throw new AppError(404, "PAYMENT_NOT_FOUND", "异常支付记录不存在");
      }
      if (current.state !== "unknown" && current.state !== "manual_review") {
        throw new AppError(
          409,
          "PAYMENT_NOT_REVIEWABLE",
          "该支付不在异常复核状态，请刷新列表",
        );
      }
      if (!options.config.wechatPay || !options.wechatPayGateway) {
        throw new AppError(
          503,
          "WECHAT_PAY_NOT_CONFIGURED",
          "微信支付尚未配置，暂时无法重新查单",
        );
      }
      const claimed = await reconcilePayment(
        options.database,
        options.wechatPayGateway,
        options.config.wechatPay,
        current.paymentId,
        true,
      );
      if (!claimed) {
        throw new AppError(
          409,
          "PAYMENT_RECONCILIATION_IN_PROGRESS",
          "另一名操作人员正在查单，请稍后刷新",
        );
      }
      const updated = await loadPaymentReviewItem(
        options.database,
        session.storeId,
        current.paymentId,
      );
      if (!updated) throw new Error("Payment disappeared after reconciliation");
      return updated;
    },
  );

  app.post(
    "/api/v1/payments/wechat/notify",
    {
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        rawBodies.set(request, body.toString("utf8"));
        return Readable.from([body]);
      },
      schema: {
        body: Type.Object(
          {
            id: Type.String(),
            create_time: Type.String(),
            event_type: Type.String(),
            resource_type: Type.String(),
            resource: Type.Object({
              algorithm: Type.String(),
              ciphertext: Type.String(),
              nonce: Type.String(),
              associated_data: Type.Optional(Type.String()),
              original_type: Type.String(),
            }),
            summary: Type.String(),
          },
          { additionalProperties: true },
        ),
        response: {
          204: Type.Null(),
          500: Type.Object({
            code: Type.Literal("FAIL"),
            message: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!options.config.wechatPay || !options.wechatPayGateway) {
        return reply
          .code(500)
          .send({ code: "FAIL", message: "微信支付未配置" });
      }
      try {
        const rawBody = rawBodies.get(request);
        if (!rawBody) throw new Error("Raw notification body is unavailable");
        const notification =
          options.wechatPayGateway.verifyAndDecryptNotification({
            body: rawBody,
            timestamp: requiredHeader(
              request.headers["wechatpay-timestamp"],
              "Wechatpay-Timestamp",
            ),
            nonce: requiredHeader(
              request.headers["wechatpay-nonce"],
              "Wechatpay-Nonce",
            ),
            signature: requiredHeader(
              request.headers["wechatpay-signature"],
              "Wechatpay-Signature",
            ),
            serial: requiredHeader(
              request.headers["wechatpay-serial"],
              "Wechatpay-Serial",
            ),
          });
        await applyWechatPaymentNotification(
          options.database,
          options.config.wechatPay.appId,
          options.config.wechatPay.merchantId,
          notification,
        );
        return reply.code(204).send(null);
      } catch (error) {
        request.log.error(
          { error },
          "Failed to process WeChat Pay notification",
        );
        return reply.code(500).send({ code: "FAIL", message: "处理失败" });
      } finally {
        rawBodies.delete(request);
      }
    },
  );
};
