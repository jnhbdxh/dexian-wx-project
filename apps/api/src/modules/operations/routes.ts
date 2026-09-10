import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { Database } from "../../db/client.js";
import {
  findStaffSession,
  staffHasPermission,
  STAFF_SESSION_COOKIE,
} from "../auth/service.js";
import { RECEPTIONS_CONFIRM } from "../booking/routes.js";

export const OPERATIONS_OVERVIEW_READ = "operations.overview.read";

interface OperationsOptions {
  database: Database;
}

const ErrorResponse = Type.Object({
  code: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});

const StaffUserResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  storeId: Type.String({ format: "uuid" }),
  username: Type.String(),
  displayName: Type.String(),
});

const PendingGuestResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  clientGuestId: Type.String(),
  serviceItemName: Type.String(),
  therapistName: Type.String(),
  roomName: Type.String(),
  bedName: Type.String(),
  serviceStartAt: Type.String({ format: "date-time" }),
  serviceEndAt: Type.String({ format: "date-time" }),
  quoteCents: Type.String({ pattern: "^\\d+$" }),
});

const PendingConfirmationResponse = Type.Object({
  receptionId: Type.String({ format: "uuid" }),
  customerName: Type.String(),
  confirmationDeadline: Type.String({ format: "date-time" }),
  quoteCents: Type.String({ pattern: "^\\d+$" }),
  version: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: "date-time" }),
  guests: Type.Array(PendingGuestResponse),
});

interface PendingConfirmationRow {
  reception_id: string;
  customer_name: string | null;
  confirmation_deadline: Date;
  reception_quote_cents: number;
  reception_version: number;
  reception_created_at: Date;
  guest_id: string;
  client_guest_id: string;
  service_item_name: string;
  therapist_name: string;
  room_name: string;
  bed_name: string;
  service_start_at: Date;
  service_end_at: Date;
  guest_quote_cents: number;
}

async function loadPendingConfirmations(database: Database, storeId: string) {
  const nowResult = await database.pool.query<{ now: Date }>(
    "SELECT clock_timestamp() AS now",
  );
  const serverNow = nowResult.rows[0]!.now;
  const result = await database.pool.query<PendingConfirmationRow>(
    `WITH pending AS (
       SELECT id, customer_id, confirmation_deadline, quote_cents, version,
              created_at
         FROM receptions
        WHERE store_id = $1
          AND state = 'pending'
          AND confirmation_deadline > $2
        ORDER BY confirmation_deadline, created_at
        LIMIT 50
     )
     SELECT pending.id AS reception_id,
            customer.display_name AS customer_name,
            pending.confirmation_deadline,
            pending.quote_cents AS reception_quote_cents,
            pending.version AS reception_version,
            pending.created_at AS reception_created_at,
            guest.id AS guest_id,
            guest.client_guest_id,
            service.name AS service_item_name,
            therapist.name AS therapist_name,
            room.name AS room_name,
            bed.name AS bed_name,
            guest.service_start_at,
            guest.service_end_at,
            guest.quote_cents AS guest_quote_cents
       FROM pending
       JOIN customers AS customer ON customer.id = pending.customer_id
       JOIN reception_guests AS guest ON guest.reception_id = pending.id
       JOIN service_items AS service ON service.id = guest.service_item_id
       JOIN resources AS therapist ON therapist.id = guest.therapist_resource_id
       JOIN resources AS room ON room.id = guest.room_resource_id
       JOIN resources AS bed ON bed.id = guest.bed_resource_id
      ORDER BY pending.confirmation_deadline, pending.created_at,
               guest.service_start_at, guest.id`,
    [storeId, serverNow],
  );

  const pending = new Map<
    string,
    {
      receptionId: string;
      customerName: string;
      confirmationDeadline: string;
      quoteCents: string;
      version: number;
      createdAt: string;
      guests: Array<{
        id: string;
        clientGuestId: string;
        serviceItemName: string;
        therapistName: string;
        roomName: string;
        bedName: string;
        serviceStartAt: string;
        serviceEndAt: string;
        quoteCents: string;
      }>;
    }
  >();
  for (const row of result.rows) {
    let reception = pending.get(row.reception_id);
    if (!reception) {
      reception = {
        receptionId: row.reception_id,
        customerName: row.customer_name?.trim() || "微信顾客",
        confirmationDeadline: row.confirmation_deadline.toISOString(),
        quoteCents: String(row.reception_quote_cents),
        version: row.reception_version,
        createdAt: row.reception_created_at.toISOString(),
        guests: [],
      };
      pending.set(row.reception_id, reception);
    }
    reception.guests.push({
      id: row.guest_id,
      clientGuestId: row.client_guest_id,
      serviceItemName: row.service_item_name,
      therapistName: row.therapist_name,
      roomName: row.room_name,
      bedName: row.bed_name,
      serviceStartAt: row.service_start_at.toISOString(),
      serviceEndAt: row.service_end_at.toISOString(),
      quoteCents: String(row.guest_quote_cents),
    });
  }

  return {
    serverNow: serverNow.toISOString(),
    pendingConfirmations: [...pending.values()],
  };
}

export const operationsRoutes: FastifyPluginAsyncTypebox<
  OperationsOptions
> = async (app, options) => {
  app.get(
    "/api/v1/admin/operations/overview",
    {
      schema: {
        response: {
          200: Type.Object({
            user: StaffUserResponse,
            overview: Type.Object({
              stage: Type.Literal("booking-confirmation"),
              serverNow: Type.String({ format: "date-time" }),
              canConfirmReceptions: Type.Boolean(),
              pendingConfirmations: Type.Array(PendingConfirmationResponse),
            }),
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

      const allowed = await staffHasPermission(
        options.database,
        session.staffUserId,
        session.storeId,
        OPERATIONS_OVERVIEW_READ,
      );
      if (!allowed) {
        return reply.code(403).send({
          code: "PERMISSION_DENIED",
          message: "当前账号无权查看今日工作台，请联系店长分配权限",
          requestId: request.id,
          details: { requiredPermission: OPERATIONS_OVERVIEW_READ },
        });
      }

      const [confirmationPermission, confirmationQueue] = await Promise.all([
        staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          RECEPTIONS_CONFIRM,
        ),
        loadPendingConfirmations(options.database, session.storeId),
      ]);

      return {
        user: {
          id: session.staffUserId,
          storeId: session.storeId,
          username: session.username,
          displayName: session.displayName,
        },
        overview: {
          stage: "booking-confirmation" as const,
          serverNow: confirmationQueue.serverNow,
          canConfirmReceptions: confirmationPermission,
          pendingConfirmations: confirmationQueue.pendingConfirmations,
        },
      };
    },
  );
};
