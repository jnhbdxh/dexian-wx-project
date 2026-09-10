import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import {
  signBookingCandidate,
  type BookingCandidate,
  type CandidateAssignment,
  type PublicCandidateAssignment,
} from "./candidate.js";
import {
  dayKey,
  ExpandDateLocks,
  LOCK_TIMEOUT_MS,
  MAX_TRANSACTION_ATTEMPTS,
  postgresCode,
  rangeDayKeys,
  TOPOLOGY_LOCK_KEY,
  waitBeforeRetry,
} from "./locking.js";

const CANDIDATE_DURATION_MS = 5 * 60 * 1000;
const HOLD_DURATION_MS = 10 * 60 * 1000;
const MAX_ALLOCATION_SPAN_MS = 24 * 60 * 60 * 1000;

interface RequestedAssignment {
  clientGuestId: string;
  serviceItemId: string;
  therapistResourceId: string;
  roomResourceId: string;
  bedResourceId: string;
  serviceStartAt: string;
}

interface CustomerIdentity {
  sessionId: string;
  customerId: string;
}

interface StoreRow {
  lock_key: number;
  timezone: string;
  booking_config_version: number;
  default_prepare_minutes: number | null;
  default_therapist_cleanup_minutes: number | null;
  default_facility_cleanup_minutes: number | null;
  default_rest_minutes: number | null;
}

interface AssignmentConfigRow {
  service_item_id: string;
  duration_minutes: number;
  prepare_minutes: number | null;
  therapist_cleanup_minutes: number | null;
  facility_cleanup_minutes: number | null;
  rest_minutes: number | null;
  price_cents: number;
  config_version: number;
  therapist_minimum_rest_minutes: number;
}

interface ExistingEventRow<T> {
  request_hash: string;
  response: T | null;
}

export type AvailabilityResult =
  | {
      available: false;
      reason: string;
    }
  | {
      available: true;
      candidateToken: string;
      expiresAt: string;
      quoteCents: string;
      assignments: PublicCandidateAssignment[];
    };

export interface HoldReceptionResult {
  receptionId: string;
  state: "pending";
  confirmationDeadline: string;
  quoteCents: string;
}

export interface ConfirmReceptionResult {
  receptionId: string;
  state: "confirmed";
  version: number;
  quoteCents: string;
}

function parseDate(value: string, field: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, "INVALID_DATETIME", `${field} 不是有效时间`);
  }
  return date;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function lockDayKeys(assignments: CandidateAssignment[], timezone: string) {
  const keys = new Set<number>();
  for (const assignment of assignments) {
    const key = dayKey(new Date(assignment.serviceStartAt), timezone);
    keys.add(key - 1);
    keys.add(key);
    keys.add(key + 1);
  }
  return [...keys].sort((left, right) => left - right);
}

function earliestPrepareAt(assignments: CandidateAssignment[]) {
  return new Date(
    Math.min(
      ...assignments.map((assignment) =>
        new Date(assignment.prepareStartAt).getTime(),
      ),
    ),
  );
}

function latestOccupationAt(assignments: CandidateAssignment[]) {
  return new Date(
    Math.max(
      ...assignments.flatMap((assignment) => [
        new Date(assignment.restEndAt).getTime(),
        new Date(assignment.facilityCleanupEndAt).getTime(),
      ]),
    ),
  );
}

function toPublicAssignment(
  assignment: CandidateAssignment,
): PublicCandidateAssignment {
  return { ...assignment, quoteCents: String(assignment.quoteCents) };
}

async function loadStore(
  client: PoolClient,
  storeId: string,
): Promise<StoreRow | undefined> {
  const result = await client.query<StoreRow>(
    `SELECT lock_key,
            timezone,
            booking_config_version,
            default_prepare_minutes,
            default_therapist_cleanup_minutes,
            default_facility_cleanup_minutes,
            default_rest_minutes
       FROM stores
      WHERE id = $1
        AND active = true`,
    [storeId],
  );
  return result.rows[0];
}

async function loadAssignmentConfig(
  client: PoolClient,
  storeId: string,
  request: RequestedAssignment,
): Promise<AssignmentConfigRow | undefined> {
  const result = await client.query<AssignmentConfigRow>(
    `SELECT service.id AS service_item_id,
            service.duration_minutes,
            service.prepare_minutes,
            service.cleanup_minutes AS therapist_cleanup_minutes,
            service.facility_cleanup_minutes,
            service.rest_minutes,
            service.price_cents,
            service.config_version,
            therapist.minimum_rest_minutes AS therapist_minimum_rest_minutes
       FROM service_items AS service
       JOIN therapist_service_items AS skill
         ON skill.store_id = service.store_id
        AND skill.service_item_id = service.id
        AND skill.therapist_resource_id = $3
       JOIN resources AS therapist
         ON therapist.store_id = service.store_id
        AND therapist.id = skill.therapist_resource_id
        AND therapist.resource_type = 'therapist'
        AND therapist.active = true
       JOIN resources AS room
         ON room.store_id = service.store_id
        AND room.id = $4
        AND room.resource_type = 'room'
        AND room.active = true
       JOIN resources AS bed
         ON bed.store_id = service.store_id
        AND bed.id = $5
        AND bed.resource_type = 'bed'
        AND bed.parent_resource_id = room.id
        AND bed.active = true
      WHERE service.store_id = $1
        AND service.id = $2
        AND service.active = true`,
    [
      storeId,
      request.serviceItemId,
      request.therapistResourceId,
      request.roomResourceId,
      request.bedResourceId,
    ],
  );
  return result.rows[0];
}

function buildAssignment(
  request: RequestedAssignment,
  config: AssignmentConfigRow,
  store: StoreRow,
) {
  const requiredRule = (
    serviceValue: number | null,
    storeValue: number | null,
    label: string,
  ) => {
    const value = serviceValue ?? storeValue;
    if (value === null) {
      throw new AppError(
        409,
        "BOOKING_CONFIG_INCOMPLETE",
        `${label}未配置，当前项目暂不可预约`,
      );
    }
    return value;
  };
  const prepareMinutes = requiredRule(
    config.prepare_minutes,
    store.default_prepare_minutes,
    "准备时间",
  );
  const therapistCleanupMinutes = requiredRule(
    config.therapist_cleanup_minutes,
    store.default_therapist_cleanup_minutes,
    "美容师整理时间",
  );
  const facilityCleanupMinutes = requiredRule(
    config.facility_cleanup_minutes,
    store.default_facility_cleanup_minutes,
    "场地清洁时间",
  );
  const configuredRestMinutes = requiredRule(
    config.rest_minutes,
    store.default_rest_minutes,
    "美容师休息时间",
  );
  const restMinutes = Math.max(
    configuredRestMinutes,
    config.therapist_minimum_rest_minutes,
  );
  const start = parseDate(request.serviceStartAt, "serviceStartAt");
  const serviceEnd = addMinutes(start, config.duration_minutes);
  const prepareStart = addMinutes(start, -prepareMinutes);
  const therapistWorkEnd = addMinutes(serviceEnd, therapistCleanupMinutes);
  const facilityCleanupEnd = addMinutes(serviceEnd, facilityCleanupMinutes);
  const restEnd = addMinutes(therapistWorkEnd, restMinutes);

  if (
    Math.max(restEnd.getTime(), facilityCleanupEnd.getTime()) -
      prepareStart.getTime() >
    MAX_ALLOCATION_SPAN_MS
  ) {
    throw new AppError(
      409,
      "INVALID_SERVICE_DURATION_CONFIG",
      "该项目占用时间超过24小时，暂时无法预约",
    );
  }

  return {
    clientGuestId: request.clientGuestId,
    serviceItemId: request.serviceItemId,
    therapistResourceId: request.therapistResourceId,
    roomResourceId: request.roomResourceId,
    bedResourceId: request.bedResourceId,
    serviceStartAt: start.toISOString(),
    serviceEndAt: serviceEnd.toISOString(),
    prepareStartAt: prepareStart.toISOString(),
    therapistWorkEndAt: therapistWorkEnd.toISOString(),
    facilityCleanupEndAt: facilityCleanupEnd.toISOString(),
    restEndAt: restEnd.toISOString(),
    durationMinutes: config.duration_minutes,
    prepareMinutes,
    therapistCleanupMinutes,
    facilityCleanupMinutes,
    restMinutes,
    quoteCents: config.price_cents,
    configVersion: config.config_version,
    ruleSnapshot: {
      serviceConfigVersion: config.config_version,
      storeConfigVersion: store.booking_config_version,
      serviceConfigured: {
        prepareMinutes: config.prepare_minutes,
        therapistCleanupMinutes: config.therapist_cleanup_minutes,
        facilityCleanupMinutes: config.facility_cleanup_minutes,
        restMinutes: config.rest_minutes,
      },
      storeDefaults: {
        prepareMinutes: store.default_prepare_minutes,
        therapistCleanupMinutes: store.default_therapist_cleanup_minutes,
        facilityCleanupMinutes: store.default_facility_cleanup_minutes,
        restMinutes: store.default_rest_minutes,
      },
      therapistMinimumRestMinutes: config.therapist_minimum_rest_minutes,
    },
  } satisfies CandidateAssignment;
}

async function assignmentIsAvailable(
  client: PoolClient,
  storeId: string,
  assignment: CandidateAssignment,
  decisionNow: Date,
) {
  const prepareStart = new Date(assignment.prepareStartAt);
  const therapistWorkEnd = new Date(assignment.therapistWorkEndAt);
  const facilityCleanupEnd = new Date(assignment.facilityCleanupEndAt);
  const restEnd = new Date(assignment.restEndAt);

  if (prepareStart <= decisionNow) return false;

  const shift = await client.query(
    `SELECT 1
       FROM resource_shifts
      WHERE store_id = $1
        AND therapist_resource_id = $2
        AND published = true
        AND start_at <= $3
        AND end_at >= $4
      LIMIT 1`,
    [storeId, assignment.therapistResourceId, prepareStart, therapistWorkEnd],
  );
  if (shift.rowCount === 0) return false;

  const restriction = await client.query(
    `SELECT 1
       FROM resource_restrictions
      WHERE store_id = $1
        AND active = true
        AND (
          (
            (resource_id IS NULL OR resource_id = $2)
            AND start_at < $4
            AND end_at > $3
          )
          OR (
            resource_id = $2
            AND restriction_kind IN ('training', 'other_unavailable')
            AND start_at < $5
            AND end_at > $4
          )
          OR (
            resource_id IN ($6, $7)
            AND start_at < $8
            AND end_at > $3
          )
        )
      LIMIT 1`,
    [
      storeId,
      assignment.therapistResourceId,
      prepareStart,
      therapistWorkEnd,
      restEnd,
      assignment.roomResourceId,
      assignment.bedResourceId,
      facilityCleanupEnd,
    ],
  );
  if (restriction.rowCount !== 0) return false;

  const allocation = await client.query(
    `SELECT 1
       FROM resource_allocations
      WHERE store_id = $1
        AND (
          allocation_state = 'confirmed'
          OR (allocation_state = 'held' AND expires_at > $7)
        )
        AND (
          (resource_id = $2 AND start_at < $4 AND end_at > $3)
          OR (resource_id IN ($5, $6) AND start_at < $8 AND end_at > $3)
        )
      LIMIT 1`,
    [
      storeId,
      assignment.therapistResourceId,
      prepareStart,
      restEnd,
      assignment.roomResourceId,
      assignment.bedResourceId,
      decisionNow,
      facilityCleanupEnd,
    ],
  );
  return allocation.rowCount === 0;
}

async function buildAssignments(
  client: PoolClient,
  storeId: string,
  store: StoreRow,
  requestedAssignments: RequestedAssignment[],
) {
  const guestIds = new Set<string>();
  const therapistIds = new Set<string>();
  const roomIds = new Set<string>();
  const bedIds = new Set<string>();
  const assignments: CandidateAssignment[] = [];

  for (const request of requestedAssignments) {
    if (guestIds.has(request.clientGuestId)) {
      throw new AppError(400, "DUPLICATE_GUEST", "同一位同行顾客只能出现一次");
    }
    if (
      therapistIds.has(request.therapistResourceId) ||
      roomIds.has(request.roomResourceId) ||
      bedIds.has(request.bedResourceId)
    ) {
      throw new AppError(
        409,
        "SHARED_RESOURCE_NOT_ENABLED",
        "当前阶段一组预约中的美容师、房间和床位不能重复选择",
      );
    }
    guestIds.add(request.clientGuestId);
    therapistIds.add(request.therapistResourceId);
    roomIds.add(request.roomResourceId);
    bedIds.add(request.bedResourceId);

    const config = await loadAssignmentConfig(client, storeId, request);
    if (!config) {
      throw new AppError(
        409,
        "ASSIGNMENT_INVALID",
        "服务项目或所选美容师、房间、床位不可用",
      );
    }
    assignments.push(buildAssignment(request, config, store));
  }

  const earliest = earliestPrepareAt(assignments).getTime();
  const latest = latestOccupationAt(assignments).getTime();
  if (latest - earliest > MAX_ALLOCATION_SPAN_MS) {
    throw new AppError(
      409,
      "GROUP_SPAN_NOT_ENABLED",
      "当前阶段同一组预约的整体占用不能超过24小时",
    );
  }
  return assignments;
}

async function allAssignmentsAvailable(
  client: PoolClient,
  storeId: string,
  assignments: CandidateAssignment[],
  decisionNow: Date,
) {
  for (const assignment of assignments) {
    if (
      !(await assignmentIsAvailable(client, storeId, assignment, decisionNow))
    ) {
      return false;
    }
  }
  return true;
}

export async function queryAvailability(
  database: Database,
  config: AppConfig,
  identity: CustomerIdentity,
  storeId: string,
  requestedAssignments: RequestedAssignment[],
): Promise<AvailabilityResult> {
  const client = await database.pool.connect();
  try {
    const store = await loadStore(client, storeId);
    if (!store) {
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    }
    const assignments = await buildAssignments(
      client,
      storeId,
      store,
      requestedAssignments,
    );
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const decisionNow = nowResult.rows[0]?.now;
    if (!decisionNow) throw new Error("Database did not return current time");

    if (
      !(await allAssignmentsAvailable(
        client,
        storeId,
        assignments,
        decisionNow,
      ))
    ) {
      return { available: false, reason: "所选时间或资源当前不可用" };
    }

    const quoteCents = assignments.reduce(
      (total, item) => total + item.quoteCents,
      0,
    );
    if (!Number.isSafeInteger(quoteCents) || quoteCents > 2_147_483_647) {
      throw new AppError(409, "QUOTE_OUT_OF_RANGE", "预约金额超出系统支持范围");
    }
    const firstWorkAt = earliestPrepareAt(assignments);
    if (firstWorkAt <= decisionNow) {
      return { available: false, reason: "距离开始时间过近，无法完成确认" };
    }
    const expiresAt = new Date(
      Math.min(
        decisionNow.getTime() + CANDIDATE_DURATION_MS,
        firstWorkAt.getTime(),
      ),
    );
    const candidate: BookingCandidate = {
      version: 1,
      sessionId: identity.sessionId,
      customerId: identity.customerId,
      storeId,
      expiresAt: expiresAt.toISOString(),
      assignments,
      quoteCents,
    };
    return {
      available: true,
      candidateToken: signBookingCandidate(
        candidate,
        config.bookingTokenSecret,
      ),
      expiresAt: candidate.expiresAt,
      quoteCents: String(quoteCents),
      assignments: assignments.map(toPublicAssignment),
    };
  } finally {
    client.release();
  }
}

async function materializeExpiredHolds(
  client: PoolClient,
  storeId: string,
  decisionNow: Date,
  assignments: CandidateAssignment[],
  timezone: string,
  lockedKeys: Set<number>,
) {
  const resourceIds = [
    ...new Set(
      assignments.flatMap((assignment) => [
        assignment.therapistResourceId,
        assignment.roomResourceId,
        assignment.bedResourceId,
      ]),
    ),
  ];
  const earliest = earliestPrepareAt(assignments);
  const latest = latestOccupationAt(assignments);
  const expired = await client.query<{ id: string }>(
    `SELECT id
       FROM receptions AS reception
      WHERE reception.store_id = $1
        AND reception.state = 'pending'
        AND reception.confirmation_deadline <= $2
        AND EXISTS (
          SELECT 1
            FROM resource_allocations AS allocation
           WHERE allocation.reception_id = reception.id
             AND allocation.resource_id = ANY($3::uuid[])
             AND allocation.start_at < $5
             AND allocation.end_at > $4
        )
      FOR UPDATE`,
    [storeId, decisionNow, resourceIds, earliest, latest],
  );
  const ids = expired.rows.map((row) => row.id);
  if (ids.length === 0) return;

  const oldAllocations = await client.query<{ start_at: Date; end_at: Date }>(
    `SELECT start_at, end_at
       FROM resource_allocations
      WHERE reception_id = ANY($1::uuid[])
        AND allocation_state = 'held'`,
    [ids],
  );
  const requiredKeys = new Set(
    oldAllocations.rows.flatMap((allocation) =>
      rangeDayKeys(allocation.start_at, allocation.end_at, timezone),
    ),
  );
  const missingKeys = [...requiredKeys].filter((key) => !lockedKeys.has(key));
  if (missingKeys.length > 0) {
    throw new ExpandDateLocks(missingKeys);
  }

  await client.query(
    `UPDATE resource_allocations
        SET allocation_state = 'inactive',
            expires_at = NULL,
            inactive_reason = 'expired',
            version = version + 1,
            updated_at = $2
      WHERE reception_id = ANY($1::uuid[])
        AND allocation_state = 'held'`,
    [ids, decisionNow],
  );
  await client.query(
    `UPDATE receptions
        SET state = 'expired',
            confirmation_deadline = NULL,
            version = version + 1,
            updated_at = $2
      WHERE id = ANY($1::uuid[])`,
    [ids, decisionNow],
  );
}

function requestHash(candidateToken: string) {
  return createHash("sha256").update(candidateToken).digest("hex");
}

async function reserveBusinessEvent<T>(
  client: PoolClient,
  actorType: "customer" | "staff",
  actorId: string,
  operationType: "reception.create_hold" | "reception.confirm",
  idempotencyKey: string,
  hash: string,
) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO business_events (
       actor_type, actor_id, operation_type, idempotency_key, request_hash
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [actorType, actorId, operationType, idempotencyKey, hash],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id };

  const existing = await client.query<ExistingEventRow<T>>(
    `SELECT request_hash, response
       FROM business_events
      WHERE actor_type = $1
        AND actor_id = $2
        AND operation_type = $3
        AND idempotency_key = $4`,
    [actorType, actorId, operationType, idempotencyKey],
  );
  const event = existing.rows[0];
  if (!event) throw new Error("Idempotency event disappeared");
  if (event.request_hash !== hash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "该提交标识已用于其他预约，请刷新后重试",
    );
  }
  if (!event.response) {
    throw new AppError(
      409,
      "REQUEST_IN_PROGRESS",
      "预约正在处理中，请稍后查询",
    );
  }
  return { response: event.response };
}

function appendSegment(
  rows: Array<{
    storeId: string;
    resourceId: string;
    receptionId: string;
    receptionGuestId: string | null;
    segmentKind: "prepare" | "service" | "cleanup" | "rest";
    startAt: Date;
    endAt: Date;
    expiresAt: Date;
  }>,
  base: Omit<(typeof rows)[number], "segmentKind" | "startAt" | "endAt">,
  segmentKind: (typeof rows)[number]["segmentKind"],
  startAt: string,
  endAt: string,
) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (end > start)
    rows.push({ ...base, segmentKind, startAt: start, endAt: end });
}

async function insertReception(
  client: PoolClient,
  candidate: BookingCandidate,
  decisionNow: Date,
) {
  const confirmationDeadline = new Date(
    Math.min(
      decisionNow.getTime() + HOLD_DURATION_MS,
      earliestPrepareAt(candidate.assignments).getTime(),
    ),
  );
  if (confirmationDeadline <= decisionNow) {
    throw new AppError(
      409,
      "CANDIDATE_EXPIRED",
      "已没有可用的确认时间，请重新选择稍后的时间",
    );
  }
  const receptionResult = await client.query<{ id: string }>(
    `INSERT INTO receptions (
       store_id, customer_id, state, confirmation_deadline, quote_cents
     ) VALUES ($1, $2, 'pending', $3, $4)
     RETURNING id`,
    [
      candidate.storeId,
      candidate.customerId,
      confirmationDeadline,
      candidate.quoteCents,
    ],
  );
  const receptionId = receptionResult.rows[0]?.id;
  if (!receptionId) throw new Error("Failed to create reception");

  const allocations: Parameters<typeof appendSegment>[0] = [];
  for (const assignment of candidate.assignments) {
    const guestResult = await client.query<{ id: string }>(
      `INSERT INTO reception_guests (
         store_id, reception_id, client_guest_id, service_item_id,
         therapist_resource_id, room_resource_id, bed_resource_id,
         service_start_at, service_end_at, quote_cents,
         service_config_version, store_config_version,
         duration_minutes_snapshot, prepare_minutes_snapshot,
         therapist_cleanup_minutes_snapshot,
         facility_cleanup_minutes_snapshot, rest_minutes_snapshot,
         rule_snapshot
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18::jsonb
       )
       RETURNING id`,
      [
        candidate.storeId,
        receptionId,
        assignment.clientGuestId,
        assignment.serviceItemId,
        assignment.therapistResourceId,
        assignment.roomResourceId,
        assignment.bedResourceId,
        new Date(assignment.serviceStartAt),
        new Date(assignment.serviceEndAt),
        assignment.quoteCents,
        assignment.ruleSnapshot.serviceConfigVersion,
        assignment.ruleSnapshot.storeConfigVersion,
        assignment.durationMinutes,
        assignment.prepareMinutes,
        assignment.therapistCleanupMinutes,
        assignment.facilityCleanupMinutes,
        assignment.restMinutes,
        JSON.stringify(assignment.ruleSnapshot),
      ],
    );
    const receptionGuestId = guestResult.rows[0]?.id;
    if (!receptionGuestId) throw new Error("Failed to create reception guest");

    const therapistBase = {
      storeId: candidate.storeId,
      resourceId: assignment.therapistResourceId,
      receptionId,
      receptionGuestId,
      expiresAt: confirmationDeadline,
    };
    appendSegment(
      allocations,
      therapistBase,
      "prepare",
      assignment.prepareStartAt,
      assignment.serviceStartAt,
    );
    appendSegment(
      allocations,
      therapistBase,
      "service",
      assignment.serviceStartAt,
      assignment.serviceEndAt,
    );
    appendSegment(
      allocations,
      therapistBase,
      "cleanup",
      assignment.serviceEndAt,
      assignment.therapistWorkEndAt,
    );
    appendSegment(
      allocations,
      therapistBase,
      "rest",
      assignment.therapistWorkEndAt,
      assignment.restEndAt,
    );

    for (const resourceId of [
      assignment.roomResourceId,
      assignment.bedResourceId,
    ]) {
      const resourceBase = {
        storeId: candidate.storeId,
        resourceId,
        receptionId,
        receptionGuestId,
        expiresAt: confirmationDeadline,
      };
      appendSegment(
        allocations,
        resourceBase,
        "prepare",
        assignment.prepareStartAt,
        assignment.serviceStartAt,
      );
      appendSegment(
        allocations,
        resourceBase,
        "service",
        assignment.serviceStartAt,
        assignment.serviceEndAt,
      );
      appendSegment(
        allocations,
        resourceBase,
        "cleanup",
        assignment.serviceEndAt,
        assignment.facilityCleanupEndAt,
      );
    }
  }

  for (const allocation of allocations) {
    await client.query(
      `INSERT INTO resource_allocations (
         store_id, resource_id, reception_id, reception_guest_id,
         segment_kind, allocation_state, start_at, end_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'held', $6, $7, $8)`,
      [
        allocation.storeId,
        allocation.resourceId,
        allocation.receptionId,
        allocation.receptionGuestId,
        allocation.segmentKind,
        allocation.startAt,
        allocation.endAt,
        allocation.expiresAt,
      ],
    );
  }

  return {
    receptionId,
    state: "pending" as const,
    confirmationDeadline: confirmationDeadline.toISOString(),
    quoteCents: String(candidate.quoteCents),
  };
}

async function createHoldAttempt(
  database: Database,
  identity: CustomerIdentity,
  candidate: BookingCandidate,
  candidateToken: string,
  idempotencyKey: string,
  additionalLockKeys: Set<number>,
) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    const storeBeforeLock = await loadStore(client, candidate.storeId);
    if (!storeBeforeLock) {
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    }
    await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", [
      storeBeforeLock.lock_key,
      TOPOLOGY_LOCK_KEY,
    ]);
    const store = await loadStore(client, candidate.storeId);
    if (!store) {
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    }
    const lockedKeys = new Set([
      ...lockDayKeys(candidate.assignments, store.timezone),
      ...additionalLockKeys,
    ]);
    for (const key of [...lockedKeys].sort((left, right) => left - right)) {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        store.lock_key,
        key,
      ]);
    }

    const event = await reserveBusinessEvent<HoldReceptionResult>(
      client,
      "customer",
      identity.customerId,
      "reception.create_hold",
      idempotencyKey,
      requestHash(candidateToken),
    );
    if (event.response) {
      await client.query("COMMIT");
      return event.response;
    }

    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const decisionNow = nowResult.rows[0]?.now;
    if (!decisionNow) throw new Error("Database did not return current time");
    if (
      new Date(candidate.expiresAt) <= decisionNow ||
      earliestPrepareAt(candidate.assignments) <= decisionNow
    ) {
      throw new AppError(
        409,
        "CANDIDATE_EXPIRED",
        "预约候选已过期，请重新查询",
      );
    }

    await materializeExpiredHolds(
      client,
      candidate.storeId,
      decisionNow,
      candidate.assignments,
      store.timezone,
      lockedKeys,
    );

    const refreshedAssignments = await buildAssignments(
      client,
      candidate.storeId,
      store,
      candidate.assignments.map((assignment) => ({
        clientGuestId: assignment.clientGuestId,
        serviceItemId: assignment.serviceItemId,
        therapistResourceId: assignment.therapistResourceId,
        roomResourceId: assignment.roomResourceId,
        bedResourceId: assignment.bedResourceId,
        serviceStartAt: assignment.serviceStartAt,
      })),
    );
    if (
      JSON.stringify(refreshedAssignments) !==
      JSON.stringify(candidate.assignments)
    ) {
      throw new AppError(
        409,
        "CANDIDATE_CHANGED",
        "服务时长、人员、资源或价格已经变化，请重新确认",
      );
    }
    if (
      !(await allAssignmentsAvailable(
        client,
        candidate.storeId,
        refreshedAssignments,
        decisionNow,
      ))
    ) {
      throw new AppError(
        409,
        "CANDIDATE_CHANGED",
        "所选时间或资源已被占用，请重新选择",
      );
    }

    const result = await insertReception(client, candidate, decisionNow);
    await client.query(
      "UPDATE business_events SET response = $2::jsonb WHERE id = $1",
      [event.id, JSON.stringify(result)],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (postgresCode(error) === "23P01") {
      throw new AppError(
        409,
        "CANDIDATE_CHANGED",
        "所选时间或资源已被占用，请重新选择",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function createHoldReception(
  database: Database,
  identity: CustomerIdentity,
  candidate: BookingCandidate,
  candidateToken: string,
  idempotencyKey: string,
) {
  if (
    candidate.customerId !== identity.customerId ||
    candidate.sessionId !== identity.sessionId
  ) {
    throw new AppError(
      403,
      "CANDIDATE_OWNER_MISMATCH",
      "预约候选不属于当前登录会话",
    );
  }

  const additionalLockKeys = new Set<number>();
  let lockAttempts = 0;
  let expansionAttempts = 0;
  while (true) {
    try {
      return await createHoldAttempt(
        database,
        identity,
        candidate,
        candidateToken,
        idempotencyKey,
        additionalLockKeys,
      );
    } catch (error) {
      if (error instanceof ExpandDateLocks) {
        const sizeBefore = additionalLockKeys.size;
        error.keys.forEach((key) => additionalLockKeys.add(key));
        expansionAttempts += 1;
        if (
          additionalLockKeys.size === sizeBefore ||
          expansionAttempts > MAX_TRANSACTION_ATTEMPTS
        ) {
          throw new Error("Failed to stabilize booking date lock range");
        }
        continue;
      }

      if (["55P03", "40P01", "40001"].includes(String(postgresCode(error)))) {
        lockAttempts += 1;
        if (lockAttempts < MAX_TRANSACTION_ATTEMPTS) {
          await waitBeforeRetry();
          continue;
        }
        throw new AppError(
          409,
          "RESOURCE_BUSY_RETRY",
          "当前预约人数较多，请稍后重新提交",
        );
      }
      throw error;
    }
  }
}

interface ConfirmationLockRow {
  lock_key: number;
  timezone: string;
  start_at: Date | null;
  end_at: Date | null;
}

interface ConfirmationReceptionRow {
  state: "pending" | "confirmed" | "expired" | "invalidated" | "cancelled";
  confirmation_deadline: Date | null;
  quote_cents: number;
  version: number;
}

interface ConfirmationAllocationRow {
  allocation_state: "held" | "confirmed" | "inactive";
  start_at: Date;
  end_at: Date;
}

async function loadConfirmationLockContext(
  database: Database,
  storeId: string,
  receptionId: string,
) {
  const result = await database.pool.query<ConfirmationLockRow>(
    `SELECT store.lock_key,
            store.timezone,
            allocation.start_at,
            allocation.end_at
       FROM receptions AS reception
       JOIN stores AS store
         ON store.id = reception.store_id
       LEFT JOIN resource_allocations AS allocation
         ON allocation.reception_id = reception.id
      WHERE reception.id = $1
        AND reception.store_id = $2`,
    [receptionId, storeId],
  );
  const first = result.rows[0];
  if (!first) {
    throw new AppError(404, "RECEPTION_NOT_FOUND", "接待不存在");
  }

  const dateKeys = new Set<number>();
  for (const row of result.rows) {
    if (row.start_at && row.end_at) {
      rangeDayKeys(row.start_at, row.end_at, first.timezone).forEach((key) =>
        dateKeys.add(key),
      );
    }
  }
  return {
    lockKey: first.lock_key,
    timezone: first.timezone,
    dateKeys,
  };
}

function confirmationRequestHash(receptionId: string, expectedVersion: number) {
  return requestHash(`${receptionId}:${expectedVersion}`);
}

async function reserveExpirationEvent(client: PoolClient, receptionId: string) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO business_events (
       actor_type, actor_id, operation_type, idempotency_key, request_hash
     ) VALUES ('system', $1, 'reception.expired', $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [receptionId, receptionId, requestHash(`reception.expired:${receptionId}`)],
  );
  return inserted.rows[0]?.id;
}

async function confirmReceptionAttempt(
  database: Database,
  staffUserId: string,
  storeId: string,
  receptionId: string,
  expectedVersion: number,
  idempotencyKey: string,
  additionalLockKeys: Set<number>,
) {
  const context = await loadConfirmationLockContext(
    database,
    storeId,
    receptionId,
  );
  const lockedKeys = new Set([...context.dateKeys, ...additionalLockKeys]);
  const client = await database.pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", [
      context.lockKey,
      TOPOLOGY_LOCK_KEY,
    ]);
    const store = await loadStore(client, storeId);
    if (!store || store.lock_key !== context.lockKey) {
      throw new AppError(404, "RECEPTION_NOT_FOUND", "接待不存在");
    }
    for (const key of [...lockedKeys].sort((left, right) => left - right)) {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        context.lockKey,
        key,
      ]);
    }

    const event = await reserveBusinessEvent<ConfirmReceptionResult>(
      client,
      "staff",
      staffUserId,
      "reception.confirm",
      idempotencyKey,
      confirmationRequestHash(receptionId, expectedVersion),
    );
    if (event.response) {
      await client.query("COMMIT");
      committed = true;
      return { result: event.response };
    }

    const expirationEventId = await reserveExpirationEvent(client, receptionId);
    const receptionResult = await client.query<ConfirmationReceptionRow>(
      `SELECT state, confirmation_deadline, quote_cents, version
         FROM receptions
        WHERE id = $1
          AND store_id = $2
        FOR UPDATE`,
      [receptionId, storeId],
    );
    const reception = receptionResult.rows[0];
    if (!reception) {
      throw new AppError(404, "RECEPTION_NOT_FOUND", "接待不存在");
    }

    const allocations = await client.query<ConfirmationAllocationRow>(
      `SELECT allocation_state, start_at, end_at
         FROM resource_allocations
        WHERE reception_id = $1
        ORDER BY id
        FOR UPDATE`,
      [receptionId],
    );
    const requiredKeys = new Set(
      allocations.rows.flatMap((allocation) =>
        rangeDayKeys(allocation.start_at, allocation.end_at, store.timezone),
      ),
    );
    const missingKeys = [...requiredKeys].filter((key) => !lockedKeys.has(key));
    if (missingKeys.length > 0) throw new ExpandDateLocks(missingKeys);

    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const decisionNow = nowResult.rows[0]?.now;
    if (!decisionNow) throw new Error("Database did not return current time");

    if (reception.state === "confirmed") {
      if (expirationEventId) {
        await client.query("DELETE FROM business_events WHERE id = $1", [
          expirationEventId,
        ]);
      }
      const result: ConfirmReceptionResult = {
        receptionId,
        state: "confirmed",
        version: reception.version,
        quoteCents: String(reception.quote_cents),
      };
      await client.query(
        "UPDATE business_events SET response = $2::jsonb WHERE id = $1",
        [event.id, JSON.stringify(result)],
      );
      await client.query("COMMIT");
      committed = true;
      return { result };
    }

    if (reception.state !== "pending") {
      throw new AppError(
        409,
        "RECEPTION_STATE_CONFLICT",
        "当前接待状态不允许确认",
        { currentState: reception.state, currentVersion: reception.version },
      );
    }
    if (
      allocations.rows.length === 0 ||
      allocations.rows.some(
        (allocation) => allocation.allocation_state !== "held",
      )
    ) {
      throw new AppError(
        409,
        "RECEPTION_ALLOCATION_STATE_CONFLICT",
        "预约占用状态已变化，请刷新后处理",
        { currentState: reception.state, currentVersion: reception.version },
      );
    }

    if (
      !reception.confirmation_deadline ||
      reception.confirmation_deadline <= decisionNow
    ) {
      await client.query(
        `UPDATE resource_allocations
            SET allocation_state = 'inactive',
                expires_at = NULL,
                inactive_reason = 'expired',
                version = version + 1,
                updated_at = $2
          WHERE reception_id = $1
            AND allocation_state = 'held'`,
        [receptionId, decisionNow],
      );
      const expired = await client.query<{ version: number }>(
        `UPDATE receptions
            SET state = 'expired',
                confirmation_deadline = NULL,
                version = version + 1,
                updated_at = $2
          WHERE id = $1
          RETURNING version`,
        [receptionId, decisionNow],
      );
      await client.query(
        `UPDATE business_events
            SET response = $2::jsonb
          WHERE actor_type = 'system'
            AND actor_id = $1
            AND operation_type = 'reception.expired'
            AND idempotency_key = $3`,
        [
          receptionId,
          JSON.stringify({
            receptionId,
            state: "expired",
            version: expired.rows[0]!.version,
          }),
          receptionId,
        ],
      );
      await client.query("DELETE FROM business_events WHERE id = $1", [
        event.id,
      ]);
      await client.query("COMMIT");
      committed = true;
      return {
        error: new AppError(
          409,
          "RECEPTION_EXPIRED",
          "确认期限已过，预约已自动失效",
          {
            currentState: "expired",
            currentVersion: expired.rows[0]!.version,
          },
        ),
      };
    }

    if (reception.version !== expectedVersion) {
      throw new AppError(
        409,
        "VERSION_CONFLICT",
        "接待信息已更新，请刷新后重试",
        {
          currentState: reception.state,
          currentVersion: reception.version,
        },
      );
    }

    await client.query(
      `UPDATE resource_allocations
          SET allocation_state = 'confirmed',
              expires_at = NULL,
              version = version + 1,
              updated_at = $2
        WHERE reception_id = $1
          AND allocation_state = 'held'`,
      [receptionId, decisionNow],
    );
    const confirmed = await client.query<{
      quote_cents: number;
      version: number;
    }>(
      `UPDATE receptions
          SET state = 'confirmed',
              confirmation_deadline = NULL,
              version = version + 1,
              updated_at = $2
        WHERE id = $1
        RETURNING quote_cents, version`,
      [receptionId, decisionNow],
    );
    if (expirationEventId) {
      await client.query("DELETE FROM business_events WHERE id = $1", [
        expirationEventId,
      ]);
    }
    const result: ConfirmReceptionResult = {
      receptionId,
      state: "confirmed",
      version: confirmed.rows[0]!.version,
      quoteCents: String(confirmed.rows[0]!.quote_cents),
    };
    await client.query(
      "UPDATE business_events SET response = $2::jsonb WHERE id = $1",
      [event.id, JSON.stringify(result)],
    );
    await client.query("COMMIT");
    committed = true;
    return { result };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmReception(
  database: Database,
  staffUserId: string,
  storeId: string,
  receptionId: string,
  expectedVersion: number,
  idempotencyKey: string,
) {
  const additionalLockKeys = new Set<number>();
  let lockAttempts = 0;
  let expansionAttempts = 0;
  while (true) {
    try {
      const outcome = await confirmReceptionAttempt(
        database,
        staffUserId,
        storeId,
        receptionId,
        expectedVersion,
        idempotencyKey,
        additionalLockKeys,
      );
      if (outcome.error) throw outcome.error;
      return outcome.result;
    } catch (error) {
      if (error instanceof ExpandDateLocks) {
        const sizeBefore = additionalLockKeys.size;
        error.keys.forEach((key) => additionalLockKeys.add(key));
        expansionAttempts += 1;
        if (
          additionalLockKeys.size === sizeBefore ||
          expansionAttempts > MAX_TRANSACTION_ATTEMPTS
        ) {
          throw new Error("Failed to stabilize confirmation date lock range");
        }
        continue;
      }
      if (["55P03", "40P01", "40001"].includes(String(postgresCode(error)))) {
        lockAttempts += 1;
        if (lockAttempts < MAX_TRANSACTION_ATTEMPTS) {
          await waitBeforeRetry();
          continue;
        }
        throw new AppError(
          409,
          "RESOURCE_BUSY_RETRY",
          "该接待正在处理中，请稍后重试",
        );
      }
      throw error;
    }
  }
}
