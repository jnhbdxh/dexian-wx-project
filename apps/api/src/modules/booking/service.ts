import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import {
  addServiceDays,
  isBookingPolicyV2,
  minuteInTimeZone,
  onlineConfirmationDeadline,
  policyCoversInterval,
  serviceDateInTimeZone,
  validateBookingPolicy,
  type BookingPolicyPayloadV2,
} from "../booking-policy/domain.js";
import {
  loadPublishedPolicy,
  type BookingCreationMode,
} from "../booking-policy/service.js";
import {
  signBookingCandidate,
  verifyBookingCandidate,
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

export interface CustomerRequestedAssignment {
  clientGuestId: string;
  serviceItemId: string;
  therapistResourceId: string;
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
  booking_creation_mode: BookingCreationMode;
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

interface FacilityPairRow {
  room_resource_id: string;
  bed_resource_id: string;
}

interface BookingCatalogRow {
  store_id: string;
  store_name: string;
  timezone: string;
  service_item_id: string;
  service_name: string;
  duration_minutes: number;
  price_cents: number;
  therapist_resource_id: string;
  therapist_name: string;
}

type ReceptionState = "pending" | "confirmed" | "expired" | "invalidated";

interface CustomerReceptionRow {
  reception_id: string;
  store_id: string;
  store_name: string;
  store_timezone: string;
  state: ReceptionState;
  confirmation_deadline: Date | null;
  quote_cents: number;
  version: number;
  created_at: Date;
  updated_at: Date;
  guest_count: string;
  service_item_name: string;
  therapist_name: string;
  service_start_at: Date;
  service_end_at: Date;
  invalidated_by_leave: boolean;
}

interface CustomerReceptionGuestRow extends CustomerReceptionRow {
  guest_id: string;
  client_guest_id: string;
  guest_service_item_name: string;
  guest_therapist_name: string;
  guest_service_start_at: Date;
  guest_service_end_at: Date;
  guest_duration_minutes: number;
  guest_quote_cents: number;
}

interface ExistingEventRow<T> {
  request_hash: string;
  response: T | StoredBookingFailure | null;
}

interface StoredBookingFailure {
  bookingFailure: {
    statusCode: number;
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export type AvailabilityResult =
  | {
      available: false;
      reasonCode:
        | "RESOURCE_UNAVAILABLE"
        | "CONFIRMATION_TOO_LATE"
        | "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE";
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

export interface BookingCatalog {
  stores: Array<{
    id: string;
    name: string;
    timezone: string;
    services: Array<{
      id: string;
      name: string;
      durationMinutes: number;
      priceCents: string;
      therapists: Array<{ id: string; name: string }>;
    }>;
  }>;
}

const CUSTOMER_RECEPTION_PAGE_SIZE = 20;

function customerReceptionState(row: CustomerReceptionRow, serverNow: Date) {
  return row.state === "pending" &&
    row.confirmation_deadline &&
    row.confirmation_deadline <= serverNow
    ? ("expired" as const)
    : row.state;
}

function customerReceptionReason(
  row: CustomerReceptionRow,
  state: ReceptionState,
) {
  if (state === "expired") return "confirmation_timeout" as const;
  if (state !== "invalidated") return null;
  return row.invalidated_by_leave
    ? ("therapist_leave" as const)
    : ("resource_unavailable" as const);
}

function toCustomerReceptionSummary(
  row: CustomerReceptionRow,
  serverNow: Date,
) {
  const state = customerReceptionState(row, serverNow);
  return {
    receptionId: row.reception_id,
    storeId: row.store_id,
    storeName: row.store_name,
    storeTimezone: row.store_timezone,
    state,
    statusReason: customerReceptionReason(row, state),
    confirmationDeadline:
      state === "pending" && row.confirmation_deadline
        ? row.confirmation_deadline.toISOString()
        : null,
    quoteCents: String(row.quote_cents),
    version: row.version,
    guestCount: Number(row.guest_count),
    serviceItemName: row.service_item_name,
    therapistName: row.therapist_name,
    serviceStartAt: row.service_start_at.toISOString(),
    serviceEndAt: row.service_end_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
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
  return {
    clientGuestId: assignment.clientGuestId,
    serviceItemId: assignment.serviceItemId,
    therapistResourceId: assignment.therapistResourceId,
    serviceStartAt: assignment.serviceStartAt,
    serviceEndAt: assignment.serviceEndAt,
    durationMinutes: assignment.durationMinutes,
    quoteCents: String(assignment.quoteCents),
  };
}

async function loadStore(
  client: PoolClient,
  storeId: string,
  lockForShare = false,
): Promise<StoreRow | undefined> {
  const result = await client.query<StoreRow>(
    `SELECT lock_key,
            timezone,
            booking_config_version,
            booking_creation_mode,
            default_prepare_minutes,
            default_therapist_cleanup_minutes,
            default_facility_cleanup_minutes,
            default_rest_minutes
       FROM stores
      WHERE id = $1
        AND active = true${lockForShare ? " FOR SHARE" : ""}`,
    [storeId],
  );
  return result.rows[0];
}

async function assertBookingPolicyAllows(
  client: PoolClient,
  storeId: string,
  store: StoreRow,
  assignments: CandidateAssignment[],
  decisionNow: Date,
) {
  if (store.booking_creation_mode === "legacy") return undefined;
  if (store.booking_creation_mode === "paused_for_policy_activation") {
    throw new AppError(
      503,
      "BOOKING_CREATION_PAUSED",
      "门店正在启用新的预约时间，请稍后重试",
    );
  }
  const policy = await loadPublishedPolicy(client, storeId);
  if (!policy?.published_version) {
    throw new AppError(
      409,
      "BOOKING_POLICY_UNPUBLISHED",
      "门店暂未开放在线预约",
    );
  }
  validateBookingPolicy(policy.payload);
  const firstDate = serviceDateInTimeZone(decisionNow, store.timezone);
  const lastDate = addServiceDays(firstDate, policy.payload.maxAdvanceDays);
  const minimumStart = new Date(
    decisionNow.getTime() + policy.payload.minimumLeadMinutes * 60_000,
  );
  for (const assignment of assignments) {
    const startAt = new Date(assignment.serviceStartAt);
    const endAt = new Date(assignment.serviceEndAt);
    const serviceDate = serviceDateInTimeZone(startAt, store.timezone);
    if (serviceDate < firstDate || serviceDate > lastDate) {
      throw new AppError(
        409,
        "BOOKING_POLICY_DATE_OUTSIDE_RANGE",
        "所选日期不在门店当前开放的预约范围内",
      );
    }
    if (startAt < minimumStart) {
      throw new AppError(
        409,
        "BOOKING_POLICY_LEAD_TIME",
        "所选时间不满足门店最少提前预约时间",
      );
    }
    if (
      minuteInTimeZone(startAt, store.timezone) %
        policy.payload.startGridMinutes !==
      0
    ) {
      throw new AppError(
        409,
        "BOOKING_POLICY_START_GRID",
        "所选时间不在门店开放的开始时刻上",
      );
    }
    if (!policyCoversInterval(policy.payload, store.timezone, startAt, endAt)) {
      throw new AppError(
        409,
        "BOOKING_POLICY_CLOSED",
        "所选服务时间不在门店营业安排内",
      );
    }
  }
  return policy;
}

export async function listBookingCatalog(
  database: Database,
): Promise<BookingCatalog> {
  const result = await database.pool.query<BookingCatalogRow>(
    `SELECT store.id AS store_id,
            store.name AS store_name,
            store.timezone,
            service.id AS service_item_id,
            service.name AS service_name,
            service.duration_minutes,
            service.price_cents,
            therapist.id AS therapist_resource_id,
            therapist.name AS therapist_name
       FROM stores AS store
       JOIN service_items AS service
         ON service.store_id = store.id
        AND service.active = true
       JOIN therapist_service_items AS skill
         ON skill.store_id = store.id
        AND skill.service_item_id = service.id
       JOIN resources AS therapist
         ON therapist.store_id = store.id
        AND therapist.id = skill.therapist_resource_id
        AND therapist.resource_type = 'therapist'
        AND therapist.active = true
      WHERE store.active = true
      ORDER BY store.created_at,
               store.id,
               service.name,
               service.id,
               therapist.name,
               therapist.id`,
  );
  const stores = new Map<string, BookingCatalog["stores"][number]>();
  const services = new Map<
    string,
    BookingCatalog["stores"][number]["services"][number]
  >();
  for (const row of result.rows) {
    let store = stores.get(row.store_id);
    if (!store) {
      store = {
        id: row.store_id,
        name: row.store_name,
        timezone: row.timezone,
        services: [],
      };
      stores.set(row.store_id, store);
    }
    const serviceKey = `${row.store_id}:${row.service_item_id}`;
    let service = services.get(serviceKey);
    if (!service) {
      service = {
        id: row.service_item_id,
        name: row.service_name,
        durationMinutes: row.duration_minutes,
        priceCents: String(row.price_cents),
        therapists: [],
      };
      services.set(serviceKey, service);
      store.services.push(service);
    }
    service.therapists.push({
      id: row.therapist_resource_id,
      name: row.therapist_name,
    });
  }
  return { stores: [...stores.values()] };
}

export async function listCustomerReceptions(
  database: Database,
  customerId: string,
  afterReceptionId?: string,
) {
  const [clock, result] = await Promise.all([
    database.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now"),
    database.pool.query<CustomerReceptionRow>(
      `WITH cursor_position AS (
         SELECT created_at, id
           FROM receptions
          WHERE id = $2::uuid
            AND customer_id = $1
       )
       SELECT reception.id AS reception_id,
              store.id AS store_id,
              store.name AS store_name,
              store.timezone AS store_timezone,
              reception.state,
              reception.confirmation_deadline,
              reception.quote_cents,
              reception.version,
              reception.created_at,
              reception.updated_at,
              guest_count.value AS guest_count,
              primary_guest.service_item_name,
              primary_guest.therapist_name,
              primary_guest.service_start_at,
              primary_guest.service_end_at,
              EXISTS (
                SELECT 1
                  FROM resource_allocations AS allocation
                 WHERE allocation.reception_id = reception.id
                   AND allocation.inactive_reason = 'resource_restriction'
              ) AS invalidated_by_leave
         FROM receptions AS reception
         JOIN stores AS store ON store.id = reception.store_id
         JOIN LATERAL (
           SELECT count(*)::text AS value
             FROM reception_guests AS guest
            WHERE guest.reception_id = reception.id
         ) AS guest_count ON true
         JOIN LATERAL (
            SELECT coalesce(guest.service_item_name_snapshot, service.name) AS service_item_name,
                  therapist.name AS therapist_name,
                  guest.service_start_at,
                  guest.service_end_at
             FROM reception_guests AS guest
             JOIN service_items AS service ON service.id = guest.service_item_id
             JOIN resources AS therapist
               ON therapist.id = guest.therapist_resource_id
            WHERE guest.reception_id = reception.id
            ORDER BY guest.service_start_at, guest.id
            LIMIT 1
         ) AS primary_guest ON true
        WHERE reception.customer_id = $1
          AND (
            $2::uuid IS NULL
            OR (reception.created_at, reception.id) <
               (SELECT created_at, id FROM cursor_position)
          )
        ORDER BY reception.created_at DESC, reception.id DESC
        LIMIT $3`,
      [customerId, afterReceptionId ?? null, CUSTOMER_RECEPTION_PAGE_SIZE + 1],
    ),
  ]);
  const serverNow = clock.rows[0]!.now;
  const hasMore = result.rows.length > CUSTOMER_RECEPTION_PAGE_SIZE;
  const visibleRows = result.rows.slice(0, CUSTOMER_RECEPTION_PAGE_SIZE);
  return {
    serverNow: serverNow.toISOString(),
    items: visibleRows.map((row) => toCustomerReceptionSummary(row, serverNow)),
    nextCursor: hasMore
      ? visibleRows[visibleRows.length - 1]!.reception_id
      : null,
  };
}

export async function getCustomerReception(
  database: Database,
  customerId: string,
  receptionId: string,
) {
  const [clock, result] = await Promise.all([
    database.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now"),
    database.pool.query<CustomerReceptionGuestRow>(
      `SELECT reception.id AS reception_id,
              store.id AS store_id,
              store.name AS store_name,
              store.timezone AS store_timezone,
              reception.state,
              reception.confirmation_deadline,
              reception.quote_cents,
              reception.version,
              reception.created_at,
              reception.updated_at,
              count(*) OVER ()::text AS guest_count,
              first_value(coalesce(guest.service_item_name_snapshot, service.name)) OVER guest_order AS service_item_name,
              first_value(therapist.name) OVER guest_order AS therapist_name,
              first_value(guest.service_start_at) OVER guest_order AS service_start_at,
              first_value(guest.service_end_at) OVER guest_order AS service_end_at,
              EXISTS (
                SELECT 1
                  FROM resource_allocations AS allocation
                 WHERE allocation.reception_id = reception.id
                   AND allocation.inactive_reason = 'resource_restriction'
              ) AS invalidated_by_leave,
              guest.id AS guest_id,
              guest.client_guest_id,
              coalesce(guest.service_item_name_snapshot, service.name) AS guest_service_item_name,
              therapist.name AS guest_therapist_name,
              guest.service_start_at AS guest_service_start_at,
              guest.service_end_at AS guest_service_end_at,
              guest.duration_minutes_snapshot AS guest_duration_minutes,
              guest.quote_cents AS guest_quote_cents
         FROM receptions AS reception
         JOIN stores AS store ON store.id = reception.store_id
         JOIN reception_guests AS guest ON guest.reception_id = reception.id
         JOIN service_items AS service ON service.id = guest.service_item_id
         JOIN resources AS therapist ON therapist.id = guest.therapist_resource_id
        WHERE reception.id = $1
          AND reception.customer_id = $2
       WINDOW guest_order AS (
         PARTITION BY reception.id
         ORDER BY guest.service_start_at, guest.id
       )
        ORDER BY guest.service_start_at, guest.id`,
      [receptionId, customerId],
    ),
  ]);
  const first = result.rows[0];
  if (!first) {
    throw new AppError(404, "RECEPTION_NOT_FOUND", "没有找到这条预约记录");
  }
  const serverNow = clock.rows[0]!.now;
  return {
    serverNow: serverNow.toISOString(),
    ...toCustomerReceptionSummary(first, serverNow),
    guests: result.rows.map((row) => ({
      id: row.guest_id,
      clientGuestId: row.client_guest_id,
      serviceItemName: row.guest_service_item_name,
      therapistName: row.guest_therapist_name,
      serviceStartAt: row.guest_service_start_at.toISOString(),
      serviceEndAt: row.guest_service_end_at.toISOString(),
      durationMinutes: row.guest_duration_minutes,
      quoteCents: String(row.guest_quote_cents),
    })),
  };
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

async function listActiveFacilityPairs(client: PoolClient, storeId: string) {
  const result = await client.query<FacilityPairRow>(
    `SELECT room.id AS room_resource_id,
            bed.id AS bed_resource_id
       FROM resources AS room
       JOIN resources AS bed
         ON bed.store_id = room.store_id
        AND bed.parent_resource_id = room.id
        AND bed.resource_type = 'bed'
        AND bed.active = true
      WHERE room.store_id = $1
        AND room.resource_type = 'room'
        AND room.active = true
      ORDER BY room.created_at, room.id, bed.created_at, bed.id`,
    [storeId],
  );
  return result.rows;
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
        "CANDIDATE_CHANGED",
        "服务项目、人员或场地规则已经变化，请重新选择",
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

async function buildAutomaticallyAssigned(
  client: PoolClient,
  storeId: string,
  store: StoreRow,
  requestedAssignments: CustomerRequestedAssignment[],
  decisionNow: Date,
) {
  const guestIds = new Set<string>();
  const therapistIds = new Set<string>();
  const usedRoomIds = new Set<string>();
  const usedBedIds = new Set<string>();
  const facilityPairs = await listActiveFacilityPairs(client, storeId);
  const choices: CandidateAssignment[][] = [];

  for (const request of requestedAssignments) {
    if (guestIds.has(request.clientGuestId)) {
      throw new AppError(400, "DUPLICATE_GUEST", "同一位同行顾客只能出现一次");
    }
    if (therapistIds.has(request.therapistResourceId)) {
      throw new AppError(
        409,
        "SHARED_RESOURCE_NOT_ENABLED",
        "当前阶段一组预约中的美容师不能重复选择",
      );
    }
    guestIds.add(request.clientGuestId);
    therapistIds.add(request.therapistResourceId);

    const availableChoices: CandidateAssignment[] = [];
    for (const pair of facilityPairs) {
      const assignedRequest: RequestedAssignment = {
        ...request,
        roomResourceId: pair.room_resource_id,
        bedResourceId: pair.bed_resource_id,
      };
      const assignmentConfig = await loadAssignmentConfig(
        client,
        storeId,
        assignedRequest,
      );
      if (!assignmentConfig) continue;
      const assignment = buildAssignment(
        assignedRequest,
        assignmentConfig,
        store,
      );
      if (
        await assignmentIsAvailable(client, storeId, assignment, decisionNow)
      ) {
        availableChoices.push(assignment);
      }
    }
    if (availableChoices.length === 0) return undefined;
    choices.push(availableChoices);
  }

  const assignments: CandidateAssignment[] = [];
  // ponytail: the public contract is capped at 8 guests; use a larger-scale
  // matching algorithm only if that limit is raised.
  const assignNext = (index: number): boolean => {
    if (index === choices.length) return true;
    for (const choice of choices[index]!) {
      if (
        usedRoomIds.has(choice.roomResourceId) ||
        usedBedIds.has(choice.bedResourceId)
      ) {
        continue;
      }
      usedRoomIds.add(choice.roomResourceId);
      usedBedIds.add(choice.bedResourceId);
      assignments.push(choice);
      if (assignNext(index + 1)) return true;
      assignments.pop();
      usedRoomIds.delete(choice.roomResourceId);
      usedBedIds.delete(choice.bedResourceId);
    }
    return false;
  };
  if (!assignNext(0)) return undefined;

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
  requestedAssignments: CustomerRequestedAssignment[],
): Promise<AvailabilityResult> {
  const client = await database.pool.connect();
  try {
    const store = await loadStore(client, storeId);
    if (!store) {
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    }
    if (store.booking_creation_mode === "paused_for_policy_activation") {
      throw new AppError(
        503,
        "BOOKING_CREATION_PAUSED",
        "门店正在启用新的预约时间，请稍后重试",
      );
    }
    const nowResult = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const decisionNow = nowResult.rows[0]?.now;
    if (!decisionNow) throw new Error("Database did not return current time");
    const assignments = await buildAutomaticallyAssigned(
      client,
      storeId,
      store,
      requestedAssignments,
      decisionNow,
    );
    if (!assignments) {
      return {
        available: false,
        reasonCode: "RESOURCE_UNAVAILABLE",
        reason: "所选时间或资源当前不可用",
      };
    }
    const policy = await assertBookingPolicyAllows(
      client,
      storeId,
      store,
      assignments,
      decisionNow,
    );

    const quoteCents = assignments.reduce(
      (total, item) => total + item.quoteCents,
      0,
    );
    if (!Number.isSafeInteger(quoteCents) || quoteCents > 2_147_483_647) {
      throw new AppError(409, "QUOTE_OUT_OF_RANGE", "预约金额超出系统支持范围");
    }
    const firstWorkAt = earliestPrepareAt(assignments);
    if (firstWorkAt <= decisionNow) {
      return {
        available: false,
        reasonCode: "CONFIRMATION_TOO_LATE",
        reason: "距离开始时间过近，无法完成确认",
      };
    }
    if (
      policy &&
      isBookingPolicyV2(policy.payload) &&
      !onlineConfirmationDeadline(
        policy.payload,
        store.timezone,
        decisionNow,
        firstWorkAt,
      )
    ) {
      return {
        available: false,
        reasonCode: "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE",
        reason: "服务准备开始前没有前台可处理线上申请的时间",
      };
    }
    const expiresAt = new Date(
      Math.min(
        decisionNow.getTime() + CANDIDATE_DURATION_MS,
        firstWorkAt.getTime(),
      ),
    );
    const candidateFields = {
      sessionId: identity.sessionId,
      customerId: identity.customerId,
      storeId,
      expiresAt: expiresAt.toISOString(),
      assignments,
      quoteCents,
    };
    const candidate: BookingCandidate =
      policy && isBookingPolicyV2(policy.payload)
        ? {
            version: 2,
            ...candidateFields,
            policySnapshot: {
              revisionId: policy.id,
              publishedVersion: policy.published_version!,
              onlineHoldMinutes: policy.payload.onlineHoldMinutes,
            },
          }
        : { version: 1, ...candidateFields };
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

function isStoredBookingFailure(value: unknown): value is StoredBookingFailure {
  return Boolean(
    value && typeof value === "object" && "bookingFailure" in value,
  );
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
  if (isStoredBookingFailure(event.response)) {
    const failure = event.response.bookingFailure;
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
      "预约正在处理中，请稍后查询",
    );
  }
  return { response: event.response };
}

async function completeBusinessEventFailure(
  client: PoolClient,
  eventId: string,
  error: AppError,
) {
  const response: StoredBookingFailure = {
    bookingFailure: {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
  await client.query(
    "UPDATE business_events SET response = $2::jsonb WHERE id = $1",
    [eventId, JSON.stringify(response)],
  );
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
  timeZone: string,
  policy?: BookingPolicyPayloadV2,
) {
  const serviceIds = [
    ...new Set(
      candidate.assignments.map((assignment) => assignment.serviceItemId),
    ),
  ];
  const serviceNamesResult = await client.query<{ id: string; name: string }>(
    `SELECT id, name
       FROM service_items
      WHERE store_id = $1 AND id = ANY($2::uuid[])`,
    [candidate.storeId, serviceIds],
  );
  const serviceNames = new Map(
    serviceNamesResult.rows.map((service) => [service.id, service.name]),
  );
  if (serviceNames.size !== serviceIds.length) {
    throw new AppError(
      409,
      "CANDIDATE_CHANGED",
      "服务项目已经变化，请重新确认",
    );
  }
  const firstWorkAt = earliestPrepareAt(candidate.assignments);
  const timedDeadline =
    candidate.version === 2 && policy
      ? onlineConfirmationDeadline(policy, timeZone, decisionNow, firstWorkAt)
      : undefined;
  const confirmationDeadline =
    candidate.version === 2
      ? timedDeadline?.deadline
      : new Date(
          Math.min(
            decisionNow.getTime() + HOLD_DURATION_MS,
            firstWorkAt.getTime(),
          ),
        );
  if (!confirmationDeadline) {
    throw new AppError(
      409,
      "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE",
      "服务准备开始前没有前台可处理线上申请的时间，请选择更晚的时段",
    );
  }
  if (confirmationDeadline <= decisionNow) {
    throw new AppError(
      409,
      "CANDIDATE_EXPIRED",
      "已没有可用的确认时间，请重新选择稍后的时间",
    );
  }
  const confirmationHoldComputation =
    candidate.version === 2 && timedDeadline
      ? {
          version: 2,
          mode: "online",
          policyRevisionId: candidate.policySnapshot.revisionId,
          policyPublishedVersion: candidate.policySnapshot.publishedVersion,
          configuredMinutes: candidate.policySnapshot.onlineHoldMinutes,
          calculationStartedAt: decisionNow.toISOString(),
          earliestPrepareAt: firstWorkAt.toISOString(),
          accumulatedMilliseconds: timedDeadline.accumulatedMs,
          truncated: timedDeadline.truncated,
          deadline: confirmationDeadline.toISOString(),
          processingSegments: timedDeadline.segments.map((segment) => ({
            startAt: segment.startAt.toISOString(),
            endAt: segment.endAt.toISOString(),
          })),
        }
      : undefined;
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
         service_item_name_snapshot,
         therapist_resource_id, room_resource_id, bed_resource_id,
         service_start_at, service_end_at, quote_cents,
         service_config_version, store_config_version,
         duration_minutes_snapshot, prepare_minutes_snapshot,
         therapist_cleanup_minutes_snapshot,
         facility_cleanup_minutes_snapshot, rest_minutes_snapshot,
         rule_snapshot
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb
       )
       RETURNING id`,
      [
        candidate.storeId,
        receptionId,
        assignment.clientGuestId,
        assignment.serviceItemId,
        serviceNames.get(assignment.serviceItemId),
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
        JSON.stringify({
          ...assignment.ruleSnapshot,
          ...(confirmationHoldComputation
            ? { confirmationHoldComputation }
            : {}),
        }),
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
  candidateToken: string,
  idempotencyKey: string,
  bookingTokenSecret: string,
  additionalLockKeys: Set<number>,
) {
  const client = await database.pool.connect();
  let eventId: string | undefined;
  let operationStarted = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

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
    eventId = event.id;
    await client.query("SAVEPOINT reception_create_hold");
    operationStarted = true;

    const candidate = verifyBookingCandidate(
      candidateToken,
      bookingTokenSecret,
    );
    if (candidate.customerId !== identity.customerId) {
      throw new AppError(
        403,
        "CANDIDATE_OWNER_MISMATCH",
        "预约候选不属于当前登录账号",
      );
    }

    const storeBeforeLock = await loadStore(client, candidate.storeId);
    if (!storeBeforeLock) {
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    }
    await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", [
      storeBeforeLock.lock_key,
      TOPOLOGY_LOCK_KEY,
    ]);
    const store = await loadStore(client, candidate.storeId, true);
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

    if (candidate.sessionId !== identity.sessionId) {
      throw new AppError(
        403,
        "CANDIDATE_OWNER_MISMATCH",
        "预约候选不属于当前登录会话",
      );
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

    const policy = await assertBookingPolicyAllows(
      client,
      candidate.storeId,
      store,
      candidate.assignments,
      decisionNow,
    );
    if (
      candidate.version === 2
        ? !policy ||
          !isBookingPolicyV2(policy.payload) ||
          policy.id !== candidate.policySnapshot.revisionId ||
          policy.published_version !==
            candidate.policySnapshot.publishedVersion ||
          policy.payload.onlineHoldMinutes !==
            candidate.policySnapshot.onlineHoldMinutes
        : policy && isBookingPolicyV2(policy.payload)
    ) {
      throw new AppError(
        409,
        "CANDIDATE_CHANGED",
        "预约政策已经变化，请重新查询可约时间",
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

    const result = await insertReception(
      client,
      candidate,
      decisionNow,
      store.timezone,
      policy && isBookingPolicyV2(policy.payload) ? policy.payload : undefined,
    );
    await client.query(
      "UPDATE business_events SET response = $2::jsonb WHERE id = $1",
      [event.id, JSON.stringify(result)],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    const reportedError =
      postgresCode(error) === "23P01"
        ? new AppError(
            409,
            "CANDIDATE_CHANGED",
            "所选时间或资源已被占用，请重新选择",
          )
        : error;
    if (
      eventId &&
      operationStarted &&
      reportedError instanceof AppError &&
      reportedError.statusCode < 500
    ) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT reception_create_hold");
        await completeBusinessEventFailure(client, eventId, reportedError);
        await client.query("COMMIT");
      } catch (persistenceError) {
        await client.query("ROLLBACK");
        throw persistenceError;
      }
    } else {
      await client.query("ROLLBACK");
    }
    throw reportedError;
  } finally {
    client.release();
  }
}

export async function createHoldReception(
  database: Database,
  identity: CustomerIdentity,
  candidateToken: string,
  idempotencyKey: string,
  bookingTokenSecret: string,
) {
  const additionalLockKeys = new Set<number>();
  let lockAttempts = 0;
  let expansionAttempts = 0;
  while (true) {
    try {
      return await createHoldAttempt(
        database,
        identity,
        candidateToken,
        idempotencyKey,
        bookingTokenSecret,
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
