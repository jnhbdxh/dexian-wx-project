import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import {
  addServiceDays,
  effectiveProcessingInstants,
  isBookingPolicyV2,
  localMinuteToInstant,
  policyCoversInterval,
  isServiceDate,
  resolvePolicyDay,
  resolvedPolicyInstants,
  serviceDateInTimeZone,
  validateBookingPolicy,
  weekdayForServiceDate,
  type BookingPolicyPayload,
  type BookingPolicyPayloadV2,
  type PolicyCalendar,
} from "./domain.js";

export type BookingCreationMode =
  "legacy" | "paused_for_policy_activation" | "policy_enforced";

interface PolicyRow {
  id: string;
  store_id: string;
  kind: "draft" | "published";
  source_draft_revision_id: string | null;
  published_version: number | null;
  base_published_version: number | null;
  payload: BookingPolicyPayload;
  created_by_staff_id: string;
  created_by_name: string;
  change_reason: string | null;
  published_at: Date | null;
  created_at: Date;
}

interface StorePolicyRow {
  id: string;
  name: string;
  timezone: string;
  booking_config_version: number;
  booking_creation_mode: BookingCreationMode;
}

interface EventRow<T> {
  id: string;
  request_hash: string;
  response: T | StoredEventFailure | null;
}

interface StoredEventFailure {
  bookingPolicyFailure: {
    statusCode: number;
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export interface PolicyImpact {
  receptionId: string;
  guestId: string;
  state: "pending" | "confirmed";
  customerName: string;
  serviceItemName: string;
  serviceStartAt: string;
  serviceEndAt: string;
  reasonCode:
    | "OUTSIDE_BUSINESS_HOURS"
    | "CLOSED_BY_DATE_EXCEPTION"
    | "TRUNCATED_BY_DATE_EXCEPTION";
}

interface ImpactRow {
  reception_id: string;
  guest_id: string;
  state: "pending" | "confirmed";
  customer_name: string;
  service_item_name: string;
  service_start_at: Date;
  service_end_at: Date;
}

function canonicalRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalRequest(item)]),
    );
  }
  return value;
}

function normalizedRequest(value: unknown) {
  return JSON.stringify(canonicalRequest(value));
}

function hashRequest(value: unknown) {
  return createHash("sha256").update(normalizedRequest(value)).digest("hex");
}

function isStoredEventFailure(value: unknown): value is StoredEventFailure {
  return Boolean(
    value && typeof value === "object" && "bookingPolicyFailure" in value,
  );
}

async function reserveEvent<T>(
  client: PoolClient,
  staffUserId: string,
  operationType: string,
  idempotencyKey: string,
  requestPayload: unknown,
) {
  const requestHash = hashRequest(requestPayload);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO business_events (
       actor_type, actor_id, operation_type, idempotency_key,
       request_hash, request_payload
     ) VALUES ('staff', $1, $2, $3, $4, $5::jsonb)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      staffUserId,
      operationType,
      idempotencyKey,
      requestHash,
      normalizedRequest(requestPayload),
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id };

  const existing = await client.query<EventRow<T>>(
    `SELECT id, request_hash, response
       FROM business_events
      WHERE actor_type = 'staff' AND actor_id = $1
        AND operation_type = $2 AND idempotency_key = $3`,
    [staffUserId, operationType, idempotencyKey],
  );
  const event = existing.rows[0];
  if (!event) throw new Error("Idempotency event disappeared");
  if (event.request_hash !== requestHash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "该提交标识已用于其他预约政策操作，请使用原内容核实",
    );
  }
  if (isStoredEventFailure(event.response)) {
    const failure = event.response.bookingPolicyFailure;
    throw new AppError(
      failure.statusCode,
      failure.code,
      failure.message,
      failure.details,
    );
  }
  if (!event.response) {
    throw new AppError(
      409,
      "REQUEST_IN_PROGRESS",
      "预约政策操作正在处理中，请稍后使用原请求核实",
    );
  }
  return { id: event.id, response: event.response };
}

async function completeEvent(
  client: PoolClient,
  eventId: string,
  response: unknown,
) {
  await client.query(
    "UPDATE business_events SET response = $2::jsonb WHERE id = $1",
    [eventId, JSON.stringify(response)],
  );
}

async function completeEventFailure(
  client: PoolClient,
  eventId: string,
  error: AppError,
) {
  const response: StoredEventFailure = {
    bookingPolicyFailure: {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
  await completeEvent(client, eventId, response);
}

async function finishFailedPolicyOperation(
  client: PoolClient,
  eventId: string | undefined,
  operationStarted: boolean,
  error: unknown,
) {
  if (
    eventId &&
    operationStarted &&
    error instanceof AppError &&
    error.statusCode < 500
  ) {
    try {
      await client.query("ROLLBACK TO SAVEPOINT booking_policy_operation");
      await completeEventFailure(client, eventId, error);
      await client.query("COMMIT");
      return;
    } catch (persistenceError) {
      await client.query("ROLLBACK");
      throw persistenceError;
    }
  }
  await client.query("ROLLBACK");
}

function toRevision(row: PolicyRow) {
  return {
    id: row.id,
    kind: row.kind,
    sourceDraftRevisionId: row.source_draft_revision_id,
    publishedVersion: row.published_version,
    basePublishedVersion: row.base_published_version,
    payload: row.payload,
    createdByStaffId: row.created_by_staff_id,
    createdByName: row.created_by_name,
    changeReason: row.change_reason,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const REVISION_SELECT = `SELECT revision.id, revision.store_id, revision.kind,
  revision.source_draft_revision_id, revision.published_version,
  revision.base_published_version, revision.payload,
  revision.created_by_staff_id, staff.display_name AS created_by_name,
  revision.change_reason, revision.published_at, revision.created_at
  FROM booking_policy_revisions revision
  JOIN staff_users staff ON staff.store_id = revision.store_id
    AND staff.id = revision.created_by_staff_id`;

async function loadStore(client: PoolClient, storeId: string, lock = false) {
  const result = await client.query<StorePolicyRow>(
    `SELECT id, name, timezone, booking_config_version, booking_creation_mode
       FROM stores WHERE id = $1 AND active = true${lock ? " FOR UPDATE" : ""}`,
    [storeId],
  );
  return result.rows[0];
}

export async function loadPublishedPolicy(client: PoolClient, storeId: string) {
  const result = await client.query<PolicyRow>(
    `${REVISION_SELECT}
      WHERE revision.store_id = $1 AND revision.kind = 'published'
      ORDER BY revision.published_version DESC LIMIT 1`,
    [storeId],
  );
  return result.rows[0];
}

async function loadRevision(
  client: PoolClient,
  storeId: string,
  revisionId: string,
  kind?: "draft" | "published",
) {
  const result = await client.query<PolicyRow>(
    `${REVISION_SELECT}
      WHERE revision.store_id = $1 AND revision.id = $2
        ${kind ? "AND revision.kind = $3" : ""}`,
    kind ? [storeId, revisionId, kind] : [storeId, revisionId],
  );
  return result.rows[0];
}

export async function getBookingPolicyWorkspace(
  database: Database,
  storeId: string,
) {
  const client = await database.pool.connect();
  try {
    const store = await loadStore(client, storeId);
    if (!store)
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    const published = await loadPublishedPolicy(client, storeId);
    const draftResult = await client.query<PolicyRow>(
      `${REVISION_SELECT}
          WHERE revision.store_id = $1 AND revision.kind = 'draft'
          ORDER BY revision.created_at DESC, revision.id DESC LIMIT 1`,
      [storeId],
    );
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    return {
      serverNow: nowResult.rows[0]!.now.toISOString(),
      store: {
        id: store.id,
        name: store.name,
        timeZone: store.timezone,
        bookingCreationMode: store.booking_creation_mode,
      },
      published: published ? toRevision(published) : null,
      latestDraft: draftResult.rows[0] ? toRevision(draftResult.rows[0]) : null,
    };
  } finally {
    client.release();
  }
}

export interface SaveDraftInput {
  initiatingStaffUserId: string;
  initiatingStoreId: string;
  basePublishedVersion: number | null;
  payload: BookingPolicyPayload;
}

export async function saveBookingPolicyDraft(
  database: Database,
  staffUserId: string,
  storeId: string,
  input: SaveDraftInput,
  idempotencyKey: string,
) {
  const client = await database.pool.connect();
  let eventId: string | undefined;
  let operationStarted = false;
  try {
    await client.query("BEGIN");
    const event = await reserveEvent<{
      draftRevisionId: string;
      createdAt: string;
    }>(client, staffUserId, "booking_policy.draft.save", idempotencyKey, input);
    if (event.response) {
      await client.query("COMMIT");
      return event.response;
    }
    eventId = event.id;
    await client.query("SAVEPOINT booking_policy_operation");
    operationStarted = true;
    if (!isBookingPolicyV2(input.payload)) {
      throw new AppError(
        409,
        "BOOKING_POLICY_V2_REQUIRED",
        "请补全保留时长和前台处理日历后保存 V2 草稿",
      );
    }
    validateBookingPolicy(input.payload);
    const current = await loadPublishedPolicy(client, storeId);
    if ((current?.published_version ?? null) !== input.basePublishedVersion) {
      throw new AppError(
        409,
        "BOOKING_POLICY_BASE_VERSION_CHANGED",
        "当前发布版本已变化，请刷新后重新保存草稿",
        { currentPublishedVersion: current?.published_version ?? null },
      );
    }
    const inserted = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO booking_policy_revisions (
         store_id, kind, base_published_version, payload, created_by_staff_id
       ) VALUES ($1, 'draft', $2, $3::jsonb, $4)
       RETURNING id, created_at`,
      [
        storeId,
        input.basePublishedVersion,
        JSON.stringify(input.payload),
        staffUserId,
      ],
    );
    const response = {
      draftRevisionId: inserted.rows[0]!.id,
      createdAt: inserted.rows[0]!.created_at.toISOString(),
    };
    await completeEvent(client, event.id, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await finishFailedPolicyOperation(client, eventId, operationStarted, error);
    throw error;
  } finally {
    client.release();
  }
}

function impactReason(
  payload: BookingPolicyPayload,
  timeZone: string,
  startAt: Date,
  endAt: Date,
): PolicyImpact["reasonCode"] {
  const serviceDate = serviceDateInTimeZone(startAt, timeZone);
  const exception = payload.dateExceptions.find(
    (item) => item.serviceDate === serviceDate,
  );
  if (exception?.kind === "closed") return "CLOSED_BY_DATE_EXCEPTION";
  const ranges = resolvedPolicyInstants(payload, serviceDate, timeZone);
  if (
    ranges.some(
      (range) =>
        range.startAt <= startAt &&
        range.endAt > startAt &&
        range.endAt < endAt,
    )
  ) {
    return "TRUNCATED_BY_DATE_EXCEPTION";
  }
  return "OUTSIDE_BUSINESS_HOURS";
}

async function findPolicyImpacts(
  client: PoolClient,
  storeId: string,
  payload: BookingPolicyPayload,
  timeZone: string,
  now: Date,
) {
  const rows = await client.query<ImpactRow>(
    `SELECT reception.id AS reception_id, guest.id AS guest_id, reception.state,
      coalesce(nullif(trim(customer.display_name), ''), '未留姓名') AS customer_name,
      coalesce(guest.service_item_name_snapshot, service.name) AS service_item_name,
      guest.service_start_at, guest.service_end_at
      FROM receptions reception
      JOIN customers customer ON customer.id = reception.customer_id
      JOIN reception_guests guest ON guest.store_id = reception.store_id
        AND guest.reception_id = reception.id
      JOIN service_items service ON service.store_id = guest.store_id
        AND service.id = guest.service_item_id
      WHERE reception.store_id = $1 AND guest.service_end_at > $2
        AND (reception.state = 'confirmed' OR
          (reception.state = 'pending' AND reception.confirmation_deadline > $2))
      ORDER BY guest.service_start_at, reception.id, guest.id`,
    [storeId, now],
  );
  return rows.rows
    .filter(
      (row) =>
        !policyCoversInterval(
          payload,
          timeZone,
          row.service_start_at,
          row.service_end_at,
        ),
    )
    .map<PolicyImpact>((row) => ({
      receptionId: row.reception_id,
      guestId: row.guest_id,
      state: row.state,
      customerName: row.customer_name,
      serviceItemName: row.service_item_name,
      serviceStartAt: row.service_start_at.toISOString(),
      serviceEndAt: row.service_end_at.toISOString(),
      reasonCode: impactReason(
        payload,
        timeZone,
        row.service_start_at,
        row.service_end_at,
      ),
    }));
}

function minuteLabel(value: number) {
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

function intervalLabel(interval: {
  startMinute: number;
  endMinute: number;
  endDayOffset: 0 | 1;
}) {
  return `${minuteLabel(interval.startMinute)}–${
    interval.endDayOffset === 1 ? "次日 " : ""
  }${minuteLabel(interval.endMinute)}`;
}

function weeklyPolicyLabel(calendar: PolicyCalendar) {
  const weekdayLabels = [
    "周日",
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "周六",
  ];
  if (calendar.weeklyRules.length === 0) return "每周均不开放";
  return [...calendar.weeklyRules]
    .sort((left, right) => left.weekday - right.weekday)
    .map(
      (rule) =>
        `${weekdayLabels[rule.weekday]} ${
          rule.intervals.map(intervalLabel).join("、") || "不开放"
        }`,
    )
    .join("；");
}

function dateExceptionLabel(
  calendar: PolicyCalendar,
  closedLabel = "全天闭店",
) {
  if (calendar.dateExceptions.length === 0) return "无日期例外";
  return [...calendar.dateExceptions]
    .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate))
    .map((exception) =>
      exception.kind === "closed"
        ? `${exception.serviceDate} ${closedLabel}`
        : `${exception.serviceDate} 替代为 ${exception.intervals
            .map(intervalLabel)
            .join("、")}`,
    )
    .join("；");
}

function policyChanges(
  current: BookingPolicyPayload | null,
  next: BookingPolicyPayloadV2,
) {
  const currentV2 = current && isBookingPolicyV2(current) ? current : null;
  const values = [
    {
      field: "maxAdvanceDays" as const,
      label: "最远预约天数",
      previous: current ? `${current.maxAdvanceDays} 天` : "尚未发布",
      next: `${next.maxAdvanceDays} 天`,
      changed: current?.maxAdvanceDays !== next.maxAdvanceDays,
    },
    {
      field: "minimumLeadMinutes" as const,
      label: "最少提前时间",
      previous: current ? `${current.minimumLeadMinutes} 分钟` : "尚未发布",
      next: `${next.minimumLeadMinutes} 分钟`,
      changed: current?.minimumLeadMinutes !== next.minimumLeadMinutes,
    },
    {
      field: "startGridMinutes" as const,
      label: "开始时间网格",
      previous: current ? `${current.startGridMinutes} 分钟` : "尚未发布",
      next: `${next.startGridMinutes} 分钟`,
      changed: current?.startGridMinutes !== next.startGridMinutes,
    },
    {
      field: "onlineHoldMinutes" as const,
      label: "线上保留时间",
      previous: currentV2
        ? `${currentV2.onlineHoldMinutes} 个可处理分钟`
        : "旧版未配置",
      next: `${next.onlineHoldMinutes} 个可处理分钟`,
      changed: currentV2?.onlineHoldMinutes !== next.onlineHoldMinutes,
    },
    {
      field: "onsiteHoldMinutes" as const,
      label: "现场保留时间",
      previous: currentV2
        ? `${currentV2.onsiteHoldMinutes} 个自然分钟`
        : "旧版未配置",
      next: `${next.onsiteHoldMinutes} 个自然分钟`,
      changed: currentV2?.onsiteHoldMinutes !== next.onsiteHoldMinutes,
    },
    {
      field: "weeklyRules" as const,
      label: "每周营业区间",
      previous: current ? weeklyPolicyLabel(current) : "尚未发布",
      next: weeklyPolicyLabel(next),
      changed:
        !current ||
        normalizedRequest(current.weeklyRules) !==
          normalizedRequest(next.weeklyRules),
    },
    {
      field: "dateExceptions" as const,
      label: "指定日期例外",
      previous: current ? dateExceptionLabel(current) : "尚未发布",
      next: dateExceptionLabel(next),
      changed:
        !current ||
        normalizedRequest(current.dateExceptions) !==
          normalizedRequest(next.dateExceptions),
    },
    {
      field: "processingWeeklyRules" as const,
      label: "前台每周可处理区间",
      previous: currentV2
        ? weeklyPolicyLabel({
            weeklyRules: currentV2.processingWeeklyRules,
            dateExceptions: currentV2.processingDateExceptions,
          })
        : "旧版未配置",
      next: weeklyPolicyLabel({
        weeklyRules: next.processingWeeklyRules,
        dateExceptions: next.processingDateExceptions,
      }),
      changed:
        !currentV2 ||
        normalizedRequest(currentV2.processingWeeklyRules) !==
          normalizedRequest(next.processingWeeklyRules),
    },
    {
      field: "processingDateExceptions" as const,
      label: "前台指定日期例外",
      previous: currentV2
        ? dateExceptionLabel(
            {
              weeklyRules: currentV2.processingWeeklyRules,
              dateExceptions: currentV2.processingDateExceptions,
            },
            "全天不处理",
          )
        : "旧版未配置",
      next: dateExceptionLabel(
        {
          weeklyRules: next.processingWeeklyRules,
          dateExceptions: next.processingDateExceptions,
        },
        "全天不处理",
      ),
      changed:
        !currentV2 ||
        normalizedRequest(currentV2.processingDateExceptions) !==
          normalizedRequest(next.processingDateExceptions),
    },
  ];
  return values
    .filter((value) => value.changed)
    .map(({ changed: _changed, ...value }) => value);
}

function calendarSources(
  calendar: PolicyCalendar,
  serviceDate: string,
  previousDate: string,
) {
  const exception = calendar.dateExceptions.find(
    (item) => item.serviceDate === serviceDate,
  );
  const currentRule = calendar.weeklyRules.find(
    (item) => item.weekday === weekdayForServiceDate(serviceDate),
  );
  const previousRule = calendar.weeklyRules.find(
    (item) => item.weekday === weekdayForServiceDate(previousDate),
  );
  const previousException = calendar.dateExceptions.find(
    (item) => item.serviceDate === previousDate,
  );
  const previousIntervals = previousException
    ? previousException.kind === "replace"
      ? previousException.intervals
      : []
    : (previousRule?.intervals ?? []);
  const sources: Array<"weekly" | "previous_day_carry" | "date_exception"> = [];
  if (exception) sources.push("date_exception");
  else {
    if (currentRule?.intervals.length) sources.push("weekly");
    if (
      previousIntervals.some(
        (interval) => interval.endDayOffset === 1 && interval.endMinute > 0,
      )
    ) {
      sources.push("previous_day_carry");
    }
  }
  return sources;
}

function expandedPolicyDays(
  payload: BookingPolicyPayloadV2,
  timeZone: string,
  now: Date,
) {
  const firstDate = serviceDateInTimeZone(now, timeZone);
  return Array.from({ length: payload.maxAdvanceDays + 1 }, (_, index) => {
    const serviceDate = addServiceDays(firstDate, index);
    const previousDate = addServiceDays(serviceDate, -1);
    const sources = calendarSources(payload, serviceDate, previousDate);
    const processingCalendar = {
      weeklyRules: payload.processingWeeklyRules,
      dateExceptions: payload.processingDateExceptions,
    };
    const intervals = resolvedPolicyInstants(
      payload,
      serviceDate,
      timeZone,
    ).map((interval) => ({
      startAt: interval.startAt.toISOString(),
      endAt: interval.endAt.toISOString(),
    }));
    const processingIntervals = resolvedPolicyInstants(
      processingCalendar,
      serviceDate,
      timeZone,
    ).map((interval) => ({
      startAt: interval.startAt.toISOString(),
      endAt: interval.endAt.toISOString(),
    }));
    const effectiveProcessingIntervals = effectiveProcessingInstants(
      payload,
      serviceDate,
      timeZone,
    ).map((interval) => ({
      startAt: interval.startAt.toISOString(),
      endAt: interval.endAt.toISOString(),
    }));
    return {
      serviceDate,
      status: intervals.length > 0 ? ("open" as const) : ("closed" as const),
      sources,
      intervals,
      processingStatus:
        processingIntervals.length > 0
          ? ("open" as const)
          : ("closed" as const),
      processingSources: calendarSources(
        processingCalendar,
        serviceDate,
        previousDate,
      ),
      processingIntervals,
      effectiveProcessingIntervals,
    };
  });
}

export async function previewBookingPolicy(
  database: Database,
  storeId: string,
  draftRevisionId: string,
) {
  const client = await database.pool.connect();
  try {
    const store = await loadStore(client, storeId);
    if (!store)
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    const draft = await loadRevision(client, storeId, draftRevisionId, "draft");
    if (!draft)
      throw new AppError(
        404,
        "BOOKING_POLICY_DRAFT_NOT_FOUND",
        "草稿修订不存在",
      );
    if (!isBookingPolicyV2(draft.payload)) {
      throw new AppError(
        409,
        "BOOKING_POLICY_V2_REQUIRED",
        "该旧格式草稿缺少保留时长或前台处理日历，请补全后保存新草稿",
      );
    }
    validateBookingPolicy(draft.payload);
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const published = await loadPublishedPolicy(client, storeId);
    const now = nowResult.rows[0]!.now;
    const impacts = await findPolicyImpacts(
      client,
      storeId,
      draft.payload,
      store.timezone,
      now,
    );
    return {
      evaluatedAt: now.toISOString(),
      draftRevisionId,
      basePublishedVersion: draft.base_published_version,
      currentPublishedVersion: published?.published_version ?? null,
      canPublish:
        draft.base_published_version ===
          (published?.published_version ?? null) && impacts.length === 0,
      changes: policyChanges(published?.payload ?? null, draft.payload),
      expandedDays: expandedPolicyDays(draft.payload, store.timezone, now),
      impacts,
    };
  } finally {
    client.release();
  }
}

export interface PublishPolicyInput {
  initiatingStaffUserId: string;
  initiatingStoreId: string;
  draftRevisionId: string;
  basePublishedVersion: number | null;
  changeReason: string;
}

export async function publishBookingPolicy(
  database: Database,
  staffUserId: string,
  storeId: string,
  input: PublishPolicyInput,
  idempotencyKey: string,
) {
  const client = await database.pool.connect();
  let eventId: string | undefined;
  let operationStarted = false;
  try {
    await client.query("BEGIN");
    const event = await reserveEvent<{
      publishedRevisionId: string;
      publishedVersion: number;
      publishedAt: string;
    }>(client, staffUserId, "booking_policy.publish", idempotencyKey, input);
    if (event.response) {
      await client.query("COMMIT");
      return event.response;
    }
    eventId = event.id;
    await client.query("SAVEPOINT booking_policy_operation");
    operationStarted = true;
    const store = await loadStore(client, storeId, true);
    if (!store)
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    if (!input.changeReason.trim()) {
      throw new AppError(
        400,
        "BOOKING_POLICY_REASON_REQUIRED",
        "请填写发布原因",
      );
    }
    const draft = await loadRevision(
      client,
      storeId,
      input.draftRevisionId,
      "draft",
    );
    if (!draft)
      throw new AppError(
        404,
        "BOOKING_POLICY_DRAFT_NOT_FOUND",
        "草稿修订不存在",
      );
    if (!isBookingPolicyV2(draft.payload)) {
      throw new AppError(
        409,
        "BOOKING_POLICY_V2_REQUIRED",
        "旧格式草稿不能发布，请补全保留时长和前台处理日历后保存新草稿",
      );
    }
    validateBookingPolicy(draft.payload);
    const current = await loadPublishedPolicy(client, storeId);
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const currentVersion = current?.published_version ?? null;
    if (
      draft.base_published_version !== input.basePublishedVersion ||
      currentVersion !== input.basePublishedVersion
    ) {
      throw new AppError(
        409,
        "BOOKING_POLICY_BASE_VERSION_CHANGED",
        "当前发布版本已变化，请重新保存并预览草稿",
        { currentPublishedVersion: currentVersion },
      );
    }
    if (
      !current &&
      store.booking_creation_mode !== "paused_for_policy_activation"
    ) {
      throw new AppError(
        409,
        "BOOKING_POLICY_ACTIVATION_PAUSE_REQUIRED",
        "首次发布前请先暂停新预约并等待在途请求结束",
      );
    }
    const now = nowResult.rows[0]!.now;
    const impacts = await findPolicyImpacts(
      client,
      storeId,
      draft.payload,
      store.timezone,
      now,
    );
    if (impacts.length > 0) {
      throw new AppError(
        409,
        "BOOKING_POLICY_EXISTING_RECEPTIONS",
        "新营业安排会影响已有预约，请先处理后再发布",
        { impacts },
      );
    }
    const publishedVersion = (currentVersion ?? 0) + 1;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO booking_policy_revisions (
         store_id, kind, source_draft_revision_id, published_version,
         base_published_version, payload,
         created_by_staff_id, change_reason, published_at
       ) VALUES ($1, 'published', $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id`,
      [
        storeId,
        draft.id,
        publishedVersion,
        input.basePublishedVersion,
        JSON.stringify(draft.payload),
        staffUserId,
        input.changeReason.trim(),
        now,
      ],
    );
    await client.query(
      `UPDATE stores SET booking_config_version = booking_config_version + 1,
         booking_creation_mode = 'policy_enforced', updated_at = $2 WHERE id = $1`,
      [storeId, now],
    );
    const response = {
      publishedRevisionId: inserted.rows[0]!.id,
      publishedVersion,
      publishedAt: now.toISOString(),
    };
    await completeEvent(client, event.id, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await finishFailedPolicyOperation(client, eventId, operationStarted, error);
    throw error;
  } finally {
    client.release();
  }
}

export async function setFirstPolicyActivationPause(
  database: Database,
  staffUserId: string,
  storeId: string,
  input: { initiatingStaffUserId: string; initiatingStoreId: string },
  idempotencyKey: string,
  paused: boolean,
) {
  const client = await database.pool.connect();
  let eventId: string | undefined;
  let operationStarted = false;
  const operationType = paused
    ? "booking_policy.activation.pause"
    : "booking_policy.activation.resume_legacy";
  try {
    await client.query("BEGIN");
    const event = await reserveEvent<{
      bookingCreationMode: BookingCreationMode;
    }>(client, staffUserId, operationType, idempotencyKey, input);
    if (event.response) {
      await client.query("COMMIT");
      return event.response;
    }
    eventId = event.id;
    await client.query("SAVEPOINT booking_policy_operation");
    operationStarted = true;
    const store = await loadStore(client, storeId, true);
    if (!store)
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    if (await loadPublishedPolicy(client, storeId)) {
      throw new AppError(
        409,
        "BOOKING_POLICY_ALREADY_ENABLED",
        "门店已经发布预约政策",
      );
    }
    const bookingCreationMode = paused
      ? "paused_for_policy_activation"
      : "legacy";
    await client.query(
      "UPDATE stores SET booking_creation_mode = $2, updated_at = now() WHERE id = $1",
      [storeId, bookingCreationMode],
    );
    const response = { bookingCreationMode } as const;
    await completeEvent(client, event.id, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await finishFailedPolicyOperation(client, eventId, operationStarted, error);
    throw error;
  } finally {
    client.release();
  }
}

export async function listBookingPolicyVersions(
  database: Database,
  storeId: string,
  after?: string,
) {
  const client = await database.pool.connect();
  try {
    const result = await client.query<PolicyRow>(
      `${REVISION_SELECT}
       WHERE revision.store_id = $1 AND revision.kind = 'published'
       AND ($2::uuid IS NULL OR revision.published_version < (
         SELECT published_version FROM booking_policy_revisions
         WHERE store_id = $1 AND id = $2 AND kind = 'published'
       ))
       ORDER BY revision.published_version DESC LIMIT 21`,
      [storeId, after ?? null],
    );
    return {
      items: result.rows.slice(0, 20).map(toRevision),
      nextCursor: result.rows.length > 20 ? result.rows[19]!.id : null,
    };
  } finally {
    client.release();
  }
}

export async function getBookingPolicyRevision(
  database: Database,
  storeId: string,
  revisionId: string,
  kind?: "draft" | "published",
) {
  const client = await database.pool.connect();
  try {
    const revision = await loadRevision(client, storeId, revisionId, kind);
    if (!revision)
      throw new AppError(
        404,
        "BOOKING_POLICY_REVISION_NOT_FOUND",
        "预约政策版本不存在",
      );
    return toRevision(revision);
  } finally {
    client.release();
  }
}

export async function getBookingStartOptions(
  database: Database,
  storeId: string,
  serviceDate: string,
  serviceItemId?: string,
) {
  if (!isServiceDate(serviceDate)) {
    throw new AppError(400, "INVALID_SERVICE_DATE", "请选择有效日期");
  }
  const client = await database.pool.connect();
  try {
    const store = await loadStore(client, storeId);
    if (!store)
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const now = nowResult.rows[0]!.now;
    const policy =
      store.booking_creation_mode === "policy_enforced"
        ? await loadPublishedPolicy(client, storeId)
        : undefined;
    if (!policy) {
      return {
        serverNow: now.toISOString(),
        timeZone: store.timezone,
        policyVersion: null,
        dateRange: null,
        queriedDate: {
          serviceDate,
          status: "policy_unpublished" as const,
          reasonCode: "BOOKING_POLICY_UNPUBLISHED",
        },
        service: null,
        starts: [],
      };
    }
    validateBookingPolicy(policy.payload);
    const firstDate = serviceDateInTimeZone(now, store.timezone);
    const lastDate = addServiceDays(firstDate, policy.payload.maxAdvanceDays);
    const dateRange = {
      firstDate,
      lastDate,
      maxAdvanceDays: policy.payload.maxAdvanceDays,
      minimumLeadMinutes: policy.payload.minimumLeadMinutes,
    };
    if (serviceDate < firstDate || serviceDate > lastDate) {
      return {
        serverNow: now.toISOString(),
        timeZone: store.timezone,
        policyVersion: policy.published_version,
        dateRange,
        queriedDate: { serviceDate, status: "outside_range" as const },
        service: null,
        starts: [],
      };
    }

    let service: {
      serviceItemId: string;
      durationMinutes: number;
      serviceConfigVersion: number;
    } | null = null;
    if (serviceItemId) {
      const serviceResult = await client.query<{
        duration_minutes: number;
        config_version: number;
      }>(
        `SELECT duration_minutes, config_version FROM service_items
          WHERE id = $1 AND store_id = $2 AND active = true`,
        [serviceItemId, storeId],
      );
      const row = serviceResult.rows[0];
      if (!row)
        throw new AppError(
          404,
          "SERVICE_ITEM_NOT_FOUND",
          "服务项目不存在或已停用",
        );
      service = {
        serviceItemId,
        durationMinutes: row.duration_minutes,
        serviceConfigVersion: row.config_version,
      };
    }

    const ranges = resolvePolicyDay(policy.payload, serviceDate);
    const minimumStart = new Date(
      now.getTime() + policy.payload.minimumLeadMinutes * 60_000,
    );
    const starts: Array<{ serviceStartAt: string; localTime: string }> = [];
    for (const range of ranges) {
      let minute =
        Math.ceil(range.startMinute / policy.payload.startGridMinutes) *
        policy.payload.startGridMinutes;
      while (minute < range.endMinute) {
        const startAt = localMinuteToInstant(
          serviceDate,
          minute,
          store.timezone,
        );
        if (
          startAt &&
          startAt >= minimumStart &&
          (!service ||
            policyCoversInterval(
              policy.payload,
              store.timezone,
              startAt,
              new Date(startAt.getTime() + service.durationMinutes * 60_000),
            ))
        ) {
          starts.push({
            serviceStartAt: startAt.toISOString(),
            localTime: `${Math.floor(minute / 60)
              .toString()
              .padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`,
          });
        }
        minute += policy.payload.startGridMinutes;
      }
    }
    return {
      serverNow: now.toISOString(),
      timeZone: store.timezone,
      policyVersion: policy.published_version,
      dateRange,
      queriedDate: {
        serviceDate,
        status: ranges.length === 0 ? ("closed" as const) : ("open" as const),
      },
      service,
      starts,
    };
  } finally {
    client.release();
  }
}
