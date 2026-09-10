import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import { hashToken } from "../../lib/crypto.js";
import {
  findCustomerSession,
  findStaffSession,
  staffHasPermission,
  STAFF_CSRF_COOKIE,
  STAFF_SESSION_COOKIE,
} from "../auth/service.js";
import {
  PublicCandidateAssignmentSchema,
  verifyBookingCandidate,
} from "./candidate.js";
import {
  confirmReception,
  createHoldReception,
  queryAvailability,
} from "./service.js";

export const RECEPTIONS_CONFIRM = "receptions.confirm";

interface BookingOptions {
  config: AppConfig;
  database: Database;
}

const Uuid = Type.String({ format: "uuid" });
const RequestedAssignment = Type.Object({
  clientGuestId: Type.String({ minLength: 1, maxLength: 64 }),
  serviceItemId: Uuid,
  therapistResourceId: Uuid,
  roomResourceId: Uuid,
  bedResourceId: Uuid,
  serviceStartAt: Type.String({ format: "date-time" }),
});

async function customerIdentity(
  database: Database,
  authorization: string | undefined,
) {
  const [scheme, token, extra] = authorization?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token || extra) {
    throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  }
  const identity = await findCustomerSession(database, token);
  if (!identity)
    throw new AppError(401, "AUTH_REQUIRED", "登录已失效，请重新登录");
  return identity;
}

function expectedVersion(ifMatch: string | string[] | undefined) {
  const match =
    typeof ifMatch === "string" ? /^"([1-9]\d*)"$/.exec(ifMatch) : null;
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw new AppError(
      400,
      "VERSION_REQUIRED",
      '请提供格式为 If-Match: "<version>" 的当前版本',
    );
  }
  return version;
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

export const bookingRoutes: FastifyPluginAsyncTypebox<BookingOptions> = async (
  app,
  options,
) => {
  app.post(
    "/api/v1/availability/queries",
    {
      schema: {
        body: Type.Object({
          storeId: Uuid,
          assignments: Type.Array(RequestedAssignment, {
            minItems: 1,
            maxItems: 8,
          }),
        }),
        response: {
          200: Type.Union([
            Type.Object({
              available: Type.Literal(false),
              reason: Type.String(),
            }),
            Type.Object({
              available: Type.Literal(true),
              candidateToken: Type.String(),
              expiresAt: Type.String({ format: "date-time" }),
              quoteCents: Type.String({ pattern: "^\\d+$" }),
              assignments: Type.Array(PublicCandidateAssignmentSchema),
            }),
          ]),
        },
      },
    },
    async (request) => {
      const identity = await customerIdentity(
        options.database,
        request.headers.authorization,
      );
      return queryAvailability(
        options.database,
        options.config,
        identity,
        request.body.storeId,
        request.body.assignments,
      );
    },
  );

  app.post(
    "/api/v1/receptions",
    {
      schema: {
        body: Type.Object({
          candidateToken: Type.String({ minLength: 32, maxLength: 32_768 }),
        }),
        response: {
          201: Type.Object({
            receptionId: Uuid,
            state: Type.Literal("pending"),
            confirmationDeadline: Type.String({ format: "date-time" }),
            quoteCents: Type.String({ pattern: "^\\d+$" }),
          }),
        },
      },
    },
    async (request, reply) => {
      const identity = await customerIdentity(
        options.database,
        request.headers.authorization,
      );
      const requestIdempotencyKey = idempotencyKey(
        request.headers["idempotency-key"],
      );
      const candidate = verifyBookingCandidate(
        request.body.candidateToken,
        options.config.bookingTokenSecret,
      );
      const result = await createHoldReception(
        options.database,
        identity,
        candidate,
        request.body.candidateToken,
        requestIdempotencyKey,
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/api/v1/admin/receptions/:receptionId/confirm",
    {
      schema: {
        params: Type.Object({ receptionId: Uuid }),
        response: {
          200: Type.Object({
            receptionId: Uuid,
            state: Type.Literal("confirmed"),
            version: Type.Integer({ minimum: 1 }),
            quoteCents: Type.String({ pattern: "^\\d+$" }),
          }),
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[STAFF_SESSION_COOKIE];
      const session = token
        ? await findStaffSession(options.database, token)
        : undefined;
      if (!session) {
        throw new AppError(401, "AUTH_REQUIRED", "请先登录");
      }
      if (
        typeof request.headers["x-csrf-token"] !== "string" ||
        request.cookies[STAFF_CSRF_COOKIE] !==
          request.headers["x-csrf-token"] ||
        hashToken(request.headers["x-csrf-token"]) !== session.csrfTokenHash
      ) {
        throw new AppError(403, "CSRF_INVALID", "页面状态已失效，请刷新后重试");
      }
      if (
        !(await staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          RECEPTIONS_CONFIRM,
        ))
      ) {
        throw new AppError(
          403,
          "PERMISSION_DENIED",
          "当前账号无权确认接待，请联系店长分配权限",
          { requiredPermission: RECEPTIONS_CONFIRM },
        );
      }

      const result = await confirmReception(
        options.database,
        session.staffUserId,
        session.storeId,
        request.params.receptionId,
        expectedVersion(request.headers["if-match"]),
        idempotencyKey(request.headers["idempotency-key"]),
      );
      return reply.send(result);
    },
  );
};
