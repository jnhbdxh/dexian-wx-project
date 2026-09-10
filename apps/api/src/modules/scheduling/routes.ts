import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import { hashToken } from "../../lib/crypto.js";
import {
  findStaffSession,
  staffHasPermission,
  STAFF_CSRF_COOKIE,
  STAFF_SESSION_COOKIE,
} from "../auth/service.js";
import { OPERATIONS_OVERVIEW_READ } from "../operations/routes.js";
import { createLeave, loadLeaveWorkbench } from "./service.js";

export const SCHEDULING_LEAVE_WRITE = "scheduling.leave.write";

interface SchedulingOptions {
  config: AppConfig;
  database: Database;
}

const Uuid = Type.String({ format: "uuid" });
const ReceptionReference = Type.Object({ receptionId: Uuid });
const ConflictReference = Type.Object({ conflictId: Uuid, receptionId: Uuid });
const ErrorResponse = Type.Object({
  code: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});
const ConflictGuest = Type.Object({
  id: Uuid,
  serviceItemName: Type.String(),
  therapistName: Type.String(),
  roomName: Type.String(),
  bedName: Type.String(),
  serviceStartAt: Type.String({ format: "date-time" }),
  serviceEndAt: Type.String({ format: "date-time" }),
});

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

export const schedulingRoutes: FastifyPluginAsyncTypebox<
  SchedulingOptions
> = async (app, options) => {
  app.get(
    "/api/v1/admin/scheduling/leave-workbench",
    {
      schema: {
        querystring: Type.Object({
          afterConflictId: Type.Optional(Uuid),
        }),
        response: {
          200: Type.Object({
            user: Type.Object({
              id: Uuid,
              storeId: Uuid,
              username: Type.String(),
              displayName: Type.String(),
            }),
            serverNow: Type.String({ format: "date-time" }),
            canCreateLeave: Type.Boolean(),
            therapists: Type.Array(
              Type.Object({ id: Uuid, name: Type.String() }),
            ),
            conflictTotal: Type.Integer({ minimum: 0 }),
            conflicts: Type.Array(
              Type.Object({
                conflictId: Uuid,
                receptionId: Uuid,
                detectedAt: Type.String({ format: "date-time" }),
                customerName: Type.String(),
                therapistId: Uuid,
                therapistName: Type.String(),
                leaveStartAt: Type.String({ format: "date-time" }),
                leaveEndAt: Type.String({ format: "date-time" }),
                reasonPrivate: Type.String(),
                guests: Type.Array(ConflictGuest),
              }),
            ),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[STAFF_SESSION_COOKIE];
      const session = token
        ? await findStaffSession(options.database, token)
        : undefined;
      if (!session) {
        return reply.code(401).send({
          code: "AUTH_REQUIRED",
          message: "请先登录",
          requestId: request.id,
          details: {},
        });
      }
      if (
        !(await staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          OPERATIONS_OVERVIEW_READ,
        ))
      ) {
        return reply.code(403).send({
          code: "PERMISSION_DENIED",
          message: "当前账号无权查看排班工作台，请联系店长分配权限",
          requestId: request.id,
          details: { requiredPermission: OPERATIONS_OVERVIEW_READ },
        });
      }

      const [canCreateLeave, workbench] = await Promise.all([
        staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          SCHEDULING_LEAVE_WRITE,
        ),
        loadLeaveWorkbench(
          options.database,
          session.storeId,
          request.query.afterConflictId,
        ),
      ]);
      return {
        user: {
          id: session.staffUserId,
          storeId: session.storeId,
          username: session.username,
          displayName: session.displayName,
        },
        ...workbench,
        canCreateLeave,
      };
    },
  );

  app.post(
    "/api/v1/admin/leaves",
    {
      schema: {
        body: Type.Object({
          therapistResourceId: Uuid,
          startAt: Type.String({ format: "date-time" }),
          endAt: Type.String({ format: "date-time" }),
          reasonPrivate: Type.String({ minLength: 1, maxLength: 500 }),
          initiatingStaffUserId: Uuid,
          initiatingStoreId: Uuid,
        }),
        response: {
          201: Type.Object({
            restrictionId: Uuid,
            state: Type.Literal("active"),
            invalidatedPendingCount: Type.Integer({ minimum: 0 }),
            affectedConfirmedCount: Type.Integer({ minimum: 0 }),
            invalidatedReceptions: Type.Array(ReceptionReference),
            conflicts: Type.Array(ConflictReference),
          }),
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[STAFF_SESSION_COOKIE];
      const session = token
        ? await findStaffSession(options.database, token)
        : undefined;
      if (!session) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
      if (
        typeof request.headers["x-csrf-token"] !== "string" ||
        request.cookies[STAFF_CSRF_COOKIE] !==
          request.headers["x-csrf-token"] ||
        hashToken(request.headers["x-csrf-token"]) !== session.csrfTokenHash
      ) {
        throw new AppError(403, "CSRF_INVALID", "页面状态已失效，请刷新后重试");
      }
      if (
        request.body.initiatingStaffUserId !== session.staffUserId ||
        request.body.initiatingStoreId !== session.storeId
      ) {
        throw new AppError(
          409,
          "LEAVE_REQUEST_IDENTITY_CHANGED",
          "当前登录员工或门店已变化，请切回原账号后继续核实",
        );
      }
      if (
        !(await staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          SCHEDULING_LEAVE_WRITE,
        ))
      ) {
        throw new AppError(
          403,
          "PERMISSION_DENIED",
          "当前账号无权登记请假，请联系店长分配权限",
          { requiredPermission: SCHEDULING_LEAVE_WRITE },
        );
      }

      const result = await createLeave(
        options.database,
        session.staffUserId,
        session.storeId,
        request.body,
        idempotencyKey(request.headers["idempotency-key"]),
      );
      return reply.code(201).send(result);
    },
  );
};
