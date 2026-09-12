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
import {
  getBookingPolicyRevision,
  getBookingPolicyWorkspace,
  getBookingStartOptions,
  listBookingPolicyVersions,
  previewBookingPolicy,
  publishBookingPolicy,
  saveBookingPolicyDraft,
  setFirstPolicyActivationPause,
} from "./service.js";

export const BOOKING_POLICY_READ = "booking.policy.read";
export const BOOKING_POLICY_WRITE = "booking.policy.write";
export const BOOKING_POLICY_PUBLISH = "booking.policy.publish";

interface BookingPolicyOptions {
  config: AppConfig;
  database: Database;
}

const Uuid = Type.String({ format: "uuid" });
const NullableVersion = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);
const Interval = Type.Object(
  {
    startMinute: Type.Integer({ minimum: 0, maximum: 1_439 }),
    endMinute: Type.Integer({ minimum: 0, maximum: 1_439 }),
    endDayOffset: Type.Union([Type.Literal(0), Type.Literal(1)]),
  },
  { additionalProperties: false },
);
const WeeklyRules = Type.Array(
  Type.Object(
    {
      weekday: Type.Integer({ minimum: 0, maximum: 6 }),
      intervals: Type.Array(Interval, { maxItems: 8 }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 7 },
);
const DateExceptions = Type.Array(
  Type.Object(
    {
      serviceDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      kind: Type.Union([Type.Literal("closed"), Type.Literal("replace")]),
      intervals: Type.Array(Interval, { maxItems: 8 }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 366 },
);
const PolicyPayloadV1 = Type.Object(
  {
    maxAdvanceDays: Type.Integer({ minimum: 0, maximum: 365 }),
    minimumLeadMinutes: Type.Integer({ minimum: 0, maximum: 43_200 }),
    startGridMinutes: Type.Integer({ minimum: 1, maximum: 1_440 }),
    weeklyRules: WeeklyRules,
    dateExceptions: DateExceptions,
  },
  { additionalProperties: false },
);
const PolicyPayloadV2 = Type.Object(
  {
    version: Type.Literal(2),
    maxAdvanceDays: Type.Integer({ minimum: 0, maximum: 365 }),
    minimumLeadMinutes: Type.Integer({ minimum: 0, maximum: 43_200 }),
    startGridMinutes: Type.Integer({ minimum: 1, maximum: 1_440 }),
    onlineHoldMinutes: Type.Integer({ minimum: 1, maximum: 43_200 }),
    onsiteHoldMinutes: Type.Integer({ minimum: 1, maximum: 43_200 }),
    weeklyRules: WeeklyRules,
    dateExceptions: DateExceptions,
    processingWeeklyRules: WeeklyRules,
    processingDateExceptions: DateExceptions,
  },
  { additionalProperties: false },
);
const PolicyPayload = Type.Union([PolicyPayloadV2, PolicyPayloadV1]);
const Revision = Type.Object({
  id: Uuid,
  kind: Type.Union([Type.Literal("draft"), Type.Literal("published")]),
  sourceDraftRevisionId: Type.Union([Uuid, Type.Null()]),
  publishedVersion: NullableVersion,
  basePublishedVersion: NullableVersion,
  payload: PolicyPayload,
  createdByStaffId: Uuid,
  createdByName: Type.String(),
  changeReason: Type.Union([Type.String(), Type.Null()]),
  publishedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
});
const PolicyUser = Type.Object({
  id: Uuid,
  storeId: Uuid,
  username: Type.String(),
  displayName: Type.String(),
});
const IdentityBody = {
  initiatingStaffUserId: Uuid,
  initiatingStoreId: Uuid,
};
const Impact = Type.Object({
  receptionId: Uuid,
  guestId: Uuid,
  state: Type.Union([Type.Literal("pending"), Type.Literal("confirmed")]),
  customerName: Type.String(),
  serviceItemName: Type.String(),
  serviceStartAt: Type.String({ format: "date-time" }),
  serviceEndAt: Type.String({ format: "date-time" }),
  reasonCode: Type.Union([
    Type.Literal("OUTSIDE_BUSINESS_HOURS"),
    Type.Literal("CLOSED_BY_DATE_EXCEPTION"),
    Type.Literal("TRUNCATED_BY_DATE_EXCEPTION"),
  ]),
});
const PolicyChange = Type.Object({
  field: Type.Union([
    Type.Literal("maxAdvanceDays"),
    Type.Literal("minimumLeadMinutes"),
    Type.Literal("startGridMinutes"),
    Type.Literal("onlineHoldMinutes"),
    Type.Literal("onsiteHoldMinutes"),
    Type.Literal("weeklyRules"),
    Type.Literal("dateExceptions"),
    Type.Literal("processingWeeklyRules"),
    Type.Literal("processingDateExceptions"),
  ]),
  label: Type.String(),
  previous: Type.String(),
  next: Type.String(),
});
const ExpandedDay = Type.Object({
  serviceDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  sources: Type.Array(
    Type.Union([
      Type.Literal("weekly"),
      Type.Literal("previous_day_carry"),
      Type.Literal("date_exception"),
    ]),
  ),
  intervals: Type.Array(
    Type.Object({
      startAt: Type.String({ format: "date-time" }),
      endAt: Type.String({ format: "date-time" }),
    }),
  ),
  processingStatus: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  processingSources: Type.Array(
    Type.Union([
      Type.Literal("weekly"),
      Type.Literal("previous_day_carry"),
      Type.Literal("date_exception"),
    ]),
  ),
  processingIntervals: Type.Array(
    Type.Object({
      startAt: Type.String({ format: "date-time" }),
      endAt: Type.String({ format: "date-time" }),
    }),
  ),
  effectiveProcessingIntervals: Type.Array(
    Type.Object({
      startAt: Type.String({ format: "date-time" }),
      endAt: Type.String({ format: "date-time" }),
    }),
  ),
});

function readIdempotencyKey(value: string | string[] | undefined) {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "请提供有效的 Idempotency-Key",
    );
  }
  return value;
}

async function requireStaff(
  options: BookingPolicyOptions,
  cookies: Record<string, string | undefined>,
  csrfHeader: string | string[] | undefined,
  permission: string,
  write: boolean,
) {
  const token = cookies[STAFF_SESSION_COOKIE];
  const session = token
    ? await findStaffSession(options.database, token)
    : undefined;
  if (!session) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  if (write) {
    if (
      typeof csrfHeader !== "string" ||
      cookies[STAFF_CSRF_COOKIE] !== csrfHeader ||
      hashToken(csrfHeader) !== session.csrfTokenHash
    ) {
      throw new AppError(403, "CSRF_INVALID", "页面状态已失效，请刷新后重试");
    }
  }
  if (
    !(await staffHasPermission(
      options.database,
      session.staffUserId,
      session.storeId,
      permission,
    ))
  ) {
    throw new AppError(
      403,
      "PERMISSION_DENIED",
      "当前账号无权执行此预约政策操作",
      {
        requiredPermission: permission,
      },
    );
  }
  return session;
}

function requireOriginalIdentity(
  session: { staffUserId: string; storeId: string },
  input: { initiatingStaffUserId: string; initiatingStoreId: string },
) {
  if (
    input.initiatingStaffUserId !== session.staffUserId ||
    input.initiatingStoreId !== session.storeId
  ) {
    throw new AppError(
      409,
      "BOOKING_POLICY_IDENTITY_CHANGED",
      "当前登录员工或门店已变化，请切回原账号后继续核实",
    );
  }
}

export const bookingPolicyRoutes: FastifyPluginAsyncTypebox<
  BookingPolicyOptions
> = async (app, options) => {
  app.get(
    "/api/v1/booking/start-options",
    {
      schema: {
        querystring: Type.Object({
          storeId: Uuid,
          serviceDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
          serviceItemId: Type.Optional(Uuid),
        }),
      },
    },
    async (request) =>
      getBookingStartOptions(
        options.database,
        request.query.storeId,
        request.query.serviceDate,
        request.query.serviceItemId,
      ),
  );

  app.get(
    "/api/v1/admin/booking-policy",
    {
      schema: {
        response: {
          200: Type.Object({
            user: PolicyUser,
            canEdit: Type.Boolean(),
            canPublish: Type.Boolean(),
            serverNow: Type.String({ format: "date-time" }),
            store: Type.Object({
              id: Uuid,
              name: Type.String(),
              timeZone: Type.String(),
              bookingCreationMode: Type.Union([
                Type.Literal("legacy"),
                Type.Literal("paused_for_policy_activation"),
                Type.Literal("policy_enforced"),
              ]),
            }),
            published: Type.Union([Revision, Type.Null()]),
            latestDraft: Type.Union([Revision, Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const session = await requireStaff(
        options,
        request.cookies,
        request.headers["x-csrf-token"],
        BOOKING_POLICY_READ,
        false,
      );
      const [workspace, canEdit, canPublish] = await Promise.all([
        getBookingPolicyWorkspace(options.database, session.storeId),
        staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          BOOKING_POLICY_WRITE,
        ),
        staffHasPermission(
          options.database,
          session.staffUserId,
          session.storeId,
          BOOKING_POLICY_PUBLISH,
        ),
      ]);
      return {
        user: {
          id: session.staffUserId,
          storeId: session.storeId,
          username: session.username,
          displayName: session.displayName,
        },
        canEdit,
        canPublish,
        ...workspace,
      };
    },
  );

  app.post(
    "/api/v1/admin/booking-policy/drafts",
    {
      schema: {
        body: Type.Object(
          {
            ...IdentityBody,
            basePublishedVersion: NullableVersion,
            payload: PolicyPayload,
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            draftRevisionId: Uuid,
            createdAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request, reply) => {
      const session = await requireStaff(
        options,
        request.cookies,
        request.headers["x-csrf-token"],
        BOOKING_POLICY_WRITE,
        true,
      );
      requireOriginalIdentity(session, request.body);
      const result = await saveBookingPolicyDraft(
        options.database,
        session.staffUserId,
        session.storeId,
        request.body,
        readIdempotencyKey(request.headers["idempotency-key"]),
      );
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/api/v1/admin/booking-policy/preview",
    {
      schema: {
        body: Type.Object(
          { draftRevisionId: Uuid },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            user: PolicyUser,
            evaluatedAt: Type.String({ format: "date-time" }),
            draftRevisionId: Uuid,
            basePublishedVersion: NullableVersion,
            currentPublishedVersion: NullableVersion,
            canPublish: Type.Boolean(),
            changes: Type.Array(PolicyChange),
            expandedDays: Type.Array(ExpandedDay),
            impacts: Type.Array(Impact),
          }),
        },
      },
    },
    async (request) => {
      const session = await requireStaff(
        options,
        request.cookies,
        request.headers["x-csrf-token"],
        BOOKING_POLICY_READ,
        true,
      );
      const preview = await previewBookingPolicy(
        options.database,
        session.storeId,
        request.body.draftRevisionId,
      );
      return {
        user: {
          id: session.staffUserId,
          storeId: session.storeId,
          username: session.username,
          displayName: session.displayName,
        },
        ...preview,
      };
    },
  );

  app.post(
    "/api/v1/admin/booking-policy/publish",
    {
      schema: {
        body: Type.Object(
          {
            ...IdentityBody,
            draftRevisionId: Uuid,
            basePublishedVersion: NullableVersion,
            changeReason: Type.String({ minLength: 1, maxLength: 500 }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({
            publishedRevisionId: Uuid,
            publishedVersion: Type.Integer({ minimum: 1 }),
            publishedAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      const session = await requireStaff(
        options,
        request.cookies,
        request.headers["x-csrf-token"],
        BOOKING_POLICY_PUBLISH,
        true,
      );
      requireOriginalIdentity(session, request.body);
      return publishBookingPolicy(
        options.database,
        session.staffUserId,
        session.storeId,
        request.body,
        readIdempotencyKey(request.headers["idempotency-key"]),
      );
    },
  );

  for (const [path, paused] of [
    ["/api/v1/admin/booking-policy/activation/pause", true],
    ["/api/v1/admin/booking-policy/activation/resume-legacy", false],
  ] as const) {
    app.post(
      path,
      {
        schema: {
          body: Type.Object(IdentityBody, { additionalProperties: false }),
          response: {
            200: Type.Object({
              bookingCreationMode: Type.Union([
                Type.Literal("legacy"),
                Type.Literal("paused_for_policy_activation"),
                Type.Literal("policy_enforced"),
              ]),
            }),
          },
        },
      },
      async (request) => {
        const session = await requireStaff(
          options,
          request.cookies,
          request.headers["x-csrf-token"],
          BOOKING_POLICY_PUBLISH,
          true,
        );
        requireOriginalIdentity(session, request.body);
        return setFirstPolicyActivationPause(
          options.database,
          session.staffUserId,
          session.storeId,
          request.body,
          readIdempotencyKey(request.headers["idempotency-key"]),
          paused,
        );
      },
    );
  }

  app.get(
    "/api/v1/admin/booking-policy/versions",
    {
      schema: {
        querystring: Type.Object({ after: Type.Optional(Uuid) }),
        response: {
          200: Type.Object({
            user: PolicyUser,
            items: Type.Array(Revision),
            nextCursor: Type.Union([Uuid, Type.Null()]),
          }),
        },
      },
    },
    async (request) => {
      const session = await requireStaff(
        options,
        request.cookies,
        request.headers["x-csrf-token"],
        BOOKING_POLICY_READ,
        false,
      );
      const versions = await listBookingPolicyVersions(
        options.database,
        session.storeId,
        request.query.after,
      );
      return {
        user: {
          id: session.staffUserId,
          storeId: session.storeId,
          username: session.username,
          displayName: session.displayName,
        },
        ...versions,
      };
    },
  );

  app.get(
    "/api/v1/admin/booking-policy/versions/:versionId",
    {
      schema: {
        params: Type.Object({ versionId: Uuid }),
        response: { 200: Revision },
      },
    },
    async (request) => {
      const session = await requireStaff(
        options,
        request.cookies,
        request.headers["x-csrf-token"],
        BOOKING_POLICY_READ,
        false,
      );
      return getBookingPolicyRevision(
        options.database,
        session.storeId,
        request.params.versionId,
        "published",
      );
    },
  );

  app.get(
    "/api/v1/admin/booking-policy/draft-revisions/:draftRevisionId",
    {
      schema: {
        params: Type.Object({ draftRevisionId: Uuid }),
        response: { 200: Revision },
      },
    },
    async (request) => {
      const session = await requireStaff(
        options,
        request.cookies,
        request.headers["x-csrf-token"],
        BOOKING_POLICY_READ,
        false,
      );
      return getBookingPolicyRevision(
        options.database,
        session.storeId,
        request.params.draftRevisionId,
        "draft",
      );
    },
  );
};
