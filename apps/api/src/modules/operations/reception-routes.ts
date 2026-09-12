import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import {
  findStaffSession,
  staffHasPermission,
  STAFF_SESSION_COOKIE,
} from "../auth/service.js";
import { RECEPTIONS_CONFIRM } from "../booking/routes.js";
import { PAYMENTS_REVIEW_READ } from "../payment/routes.js";
import { OPERATIONS_OVERVIEW_READ } from "./routes.js";
import { getAdminReception, listAdminReceptions } from "./receptions.js";
import { getResourceCalendar } from "./resource-calendar.js";

const Uuid = Type.String({ format: "uuid" });
const DateTime = Type.String({ format: "date-time" });
const Money = Type.String({ pattern: "^\\d+$" });
const State = Type.Union([
  Type.Literal("pending"),
  Type.Literal("confirmed"),
  Type.Literal("expired"),
  Type.Literal("invalidated"),
  Type.Literal("cancelled"),
]);
const ResourceType = Type.Union([
  Type.Literal("therapist"),
  Type.Literal("room"),
  Type.Literal("bed"),
  Type.Literal("equipment"),
]);
const RecordSchema = Type.Object({
  receptionId: Uuid,
  customerName: Type.String(),
  maskedPhone: Type.Union([Type.String(), Type.Null()]),
  state: State,
  confirmationDeadline: Type.Union([DateTime, Type.Null()]),
  quoteCents: Money,
  version: Type.Integer({ minimum: 1 }),
  createdAt: DateTime,
  serviceStartAt: DateTime,
  serviceEndAt: DateTime,
  guests: Type.Array(
    Type.Object({
      id: Uuid,
      serviceItemName: Type.String(),
      therapistName: Type.String(),
      roomName: Type.String(),
      bedName: Type.String(),
      serviceStartAt: DateTime,
      serviceEndAt: DateTime,
      quoteCents: Money,
    }),
  ),
  allocations: Type.Array(
    Type.Object({
      id: Uuid,
      guestId: Type.Union([Uuid, Type.Null()]),
      resourceId: Uuid,
      resourceName: Type.String(),
      resourceType: Type.String(),
      segmentKind: Type.String(),
      state: Type.String(),
      startAt: DateTime,
      endAt: DateTime,
    }),
  ),
  conflicts: Type.Array(
    Type.Object({
      id: Uuid,
      resourceName: Type.String(),
      kind: Type.String(),
      startAt: DateTime,
      endAt: DateTime,
    }),
  ),
  payments: Type.Union([
    Type.Null(),
    Type.Array(
      Type.Object({
        id: Uuid,
        state: Type.String(),
        amountCents: Money,
        collectionDeadline: DateTime,
      }),
    ),
  ]),
});
const Access = {
  user: Type.Object({
    id: Uuid,
    storeId: Uuid,
    username: Type.String(),
    displayName: Type.String(),
  }),
  canConfirm: Type.Boolean(),
  canReadPayments: Type.Boolean(),
};

export const adminReceptionRoutes: FastifyPluginAsyncTypebox<{
  database: Database;
}> = async (app, { database }) => {
  async function authorize(token: string | undefined) {
    const session = token ? await findStaffSession(database, token) : undefined;
    if (!session) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    if (
      !(await staffHasPermission(
        database,
        session.staffUserId,
        session.storeId,
        OPERATIONS_OVERVIEW_READ,
      ))
    ) {
      throw new AppError(
        403,
        "PERMISSION_DENIED",
        "当前账号无权查看接待，请联系店长分配工作台查看权限",
      );
    }
    const [canConfirm, canReadPayments] = await Promise.all([
      staffHasPermission(
        database,
        session.staffUserId,
        session.storeId,
        RECEPTIONS_CONFIRM,
      ),
      staffHasPermission(
        database,
        session.staffUserId,
        session.storeId,
        PAYMENTS_REVIEW_READ,
      ),
    ]);
    return {
      user: {
        id: session.staffUserId,
        storeId: session.storeId,
        username: session.username,
        displayName: session.displayName,
      },
      canConfirm,
      canReadPayments,
    };
  }
  app.get(
    "/api/v1/admin/resource-calendar",
    {
      schema: {
        querystring: Type.Object(
          {
            serviceDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            user: Access.user,
            serverNow: DateTime,
            serviceDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
            timeZone: Type.Literal("Asia/Shanghai"),
            resources: Type.Array(
              Type.Object({
                id: Uuid,
                parentResourceId: Type.Union([Uuid, Type.Null()]),
                name: Type.String(),
                resourceType: ResourceType,
                active: Type.Boolean(),
              }),
            ),
            shifts: Type.Array(
              Type.Object({
                id: Uuid,
                therapistResourceId: Uuid,
                startAt: DateTime,
                endAt: DateTime,
              }),
            ),
            restrictions: Type.Array(
              Type.Object({
                id: Uuid,
                resourceId: Type.Union([Uuid, Type.Null()]),
                resourceName: Type.Union([Type.String(), Type.Null()]),
                resourceType: Type.Union([ResourceType, Type.Null()]),
                kind: Type.Union([
                  Type.Literal("leave"),
                  Type.Literal("meal_break"),
                  Type.Literal("training"),
                  Type.Literal("store_closed"),
                  Type.Literal("equipment_fault"),
                  Type.Literal("other_unavailable"),
                ]),
                startAt: DateTime,
                endAt: DateTime,
              }),
            ),
            allocations: Type.Array(
              Type.Object({
                id: Uuid,
                resourceId: Uuid,
                receptionId: Uuid,
                guestId: Type.Union([Uuid, Type.Null()]),
                customerName: Type.String(),
                serviceItemName: Type.Union([Type.String(), Type.Null()]),
                receptionState: Type.Union([
                  Type.Literal("pending"),
                  Type.Literal("confirmed"),
                ]),
                confirmationDeadline: Type.Union([DateTime, Type.Null()]),
                segmentKind: Type.Union([
                  Type.Literal("prepare"),
                  Type.Literal("service"),
                  Type.Literal("cleanup"),
                  Type.Literal("rest"),
                ]),
                startAt: DateTime,
                endAt: DateTime,
                expiresAt: Type.Union([DateTime, Type.Null()]),
                hasConflict: Type.Boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const access = await authorize(request.cookies[STAFF_SESSION_COOKIE]);
      return {
        user: access.user,
        ...(await getResourceCalendar(
          database,
          access.user.storeId,
          request.query.serviceDate,
        )),
      };
    },
  );
  app.get(
    "/api/v1/admin/receptions",
    {
      schema: {
        querystring: Type.Object(
          {
            serviceDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
            state: Type.Optional(
              Type.Union([
                Type.Literal("pending"),
                Type.Literal("confirmed"),
                Type.Literal("expired"),
                Type.Literal("invalidated"),
                Type.Literal("cancelled"),
              ]),
            ),
            therapistId: Type.Optional(Uuid),
            receptionId: Type.Optional(Uuid),
            after: Type.Optional(Uuid),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            ...Access,
            serverNow: DateTime,
            total: Type.Integer({ minimum: 0 }),
            items: Type.Array(RecordSchema),
            nextCursor: Type.Union([Uuid, Type.Null()]),
            therapists: Type.Array(
              Type.Object({ id: Uuid, name: Type.String() }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const access = await authorize(request.cookies[STAFF_SESSION_COOKIE]);
      return {
        ...access,
        ...(await listAdminReceptions(
          database,
          access.user.storeId,
          request.query,
          access.canReadPayments,
        )),
      };
    },
  );
  app.get(
    "/api/v1/admin/receptions/:receptionId",
    {
      schema: {
        params: Type.Object({ receptionId: Uuid }),
        response: {
          200: Type.Object({
            ...Access,
            serverNow: DateTime,
            item: RecordSchema,
          }),
        },
      },
    },
    async (request) => {
      const access = await authorize(request.cookies[STAFF_SESSION_COOKIE]);
      return {
        ...access,
        ...(await getAdminReception(
          database,
          access.user.storeId,
          request.params.receptionId,
          access.canReadPayments,
        )),
      };
    },
  );
};
