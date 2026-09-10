import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";
import {
  ExpandDateLocks,
  LOCK_TIMEOUT_MS,
  MAX_TRANSACTION_ATTEMPTS,
  postgresCode,
  rangeDayKeys,
  TOPOLOGY_LOCK_KEY,
  waitBeforeRetry,
} from "../booking/locking.js";

const CREATE_LEAVE_OPERATION = "resource_restriction.create_leave";

interface StoreLockContext {
  lock_key: number;
  timezone: string;
}

interface ExistingEventRow {
  request_hash: string;
  response: CreateLeaveResult | null;
}

interface ReceptionRow {
  id: string;
  state: "pending" | "confirmed" | "expired" | "invalidated" | "cancelled";
  confirmation_deadline: Date | null;
}

interface AllocationRow {
  id: string;
  reception_id: string;
  resource_id: string;
  segment_kind: "prepare" | "service" | "cleanup" | "rest";
  allocation_state: "held" | "confirmed" | "inactive";
  start_at: Date;
  end_at: Date;
}

export interface CreateLeaveInput {
  therapistResourceId: string;
  startAt: string;
  endAt: string;
  reasonPrivate: string;
}

export interface CreateLeaveResult {
  restrictionId: string;
  state: "active";
  invalidatedPendingCount: number;
  affectedConfirmedCount: number;
  invalidatedReceptions: Array<{ receptionId: string }>;
  conflicts: Array<{ conflictId: string; receptionId: string }>;
}

interface ConflictWorkbenchRow {
  conflict_id: string;
  reception_id: string;
  detected_at: Date;
  customer_name: string | null;
  leave_start_at: Date;
  leave_end_at: Date;
  reason_private: string | null;
  therapist_id: string;
  therapist_name: string;
  guest_id: string;
  service_item_name: string;
  guest_therapist_name: string;
  room_name: string;
  bed_name: string;
  service_start_at: Date;
  service_end_at: Date;
}

const CONFLICT_PAGE_SIZE = 50;

export async function loadLeaveWorkbench(
  database: Database,
  storeId: string,
  afterConflictId?: string,
) {
  const [clock, therapists, total, rows] = await Promise.all([
    database.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now"),
    database.pool.query<{ id: string; name: string }>(
      `SELECT id, name
         FROM resources
        WHERE store_id = $1
          AND resource_type = 'therapist'
          AND active = true
        ORDER BY name, id`,
      [storeId],
    ),
    database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM resource_conflicts
        WHERE store_id = $1
          AND status = 'pending'`,
      [storeId],
    ),
    database.pool.query<ConflictWorkbenchRow>(
      `WITH cursor_position AS (
         SELECT detected_at, id
           FROM resource_conflicts
          WHERE store_id = $1
            AND id = $2::uuid
       ), pending_conflicts AS (
         SELECT conflict.id, conflict.resource_id, conflict.restriction_id,
                conflict.reception_id, conflict.detected_at
           FROM resource_conflicts AS conflict
          WHERE conflict.store_id = $1
            AND conflict.status = 'pending'
            AND (
              $2::uuid IS NULL
              OR (conflict.detected_at, conflict.id) <
                 (SELECT detected_at, id FROM cursor_position)
            )
          ORDER BY conflict.detected_at DESC, conflict.id DESC
          LIMIT $3
       )
       SELECT conflict.id AS conflict_id,
              conflict.reception_id,
              conflict.detected_at,
              customer.display_name AS customer_name,
              restriction.start_at AS leave_start_at,
              restriction.end_at AS leave_end_at,
              restriction.reason_private,
              therapist.id AS therapist_id,
              therapist.name AS therapist_name,
              guest.id AS guest_id,
              service.name AS service_item_name,
              guest_therapist.name AS guest_therapist_name,
              room.name AS room_name,
              bed.name AS bed_name,
              guest.service_start_at,
              guest.service_end_at
         FROM pending_conflicts AS conflict
         JOIN resource_restrictions AS restriction
           ON restriction.id = conflict.restriction_id
          AND restriction.store_id = $1
         JOIN resources AS therapist
           ON therapist.id = conflict.resource_id
          AND therapist.store_id = $1
         JOIN receptions AS reception
           ON reception.id = conflict.reception_id
          AND reception.store_id = $1
         JOIN customers AS customer ON customer.id = reception.customer_id
         JOIN reception_guests AS guest
           ON guest.reception_id = reception.id
          AND guest.store_id = $1
         JOIN service_items AS service ON service.id = guest.service_item_id
         JOIN resources AS guest_therapist
           ON guest_therapist.id = guest.therapist_resource_id
         JOIN resources AS room ON room.id = guest.room_resource_id
         JOIN resources AS bed ON bed.id = guest.bed_resource_id
        ORDER BY conflict.detected_at DESC, conflict.id DESC,
                 guest.service_start_at, guest.id`,
      [storeId, afterConflictId ?? null, CONFLICT_PAGE_SIZE + 1],
    ),
  ]);

  const conflicts = new Map<
    string,
    {
      conflictId: string;
      receptionId: string;
      detectedAt: string;
      customerName: string;
      therapistId: string;
      therapistName: string;
      leaveStartAt: string;
      leaveEndAt: string;
      reasonPrivate: string;
      guests: Array<{
        id: string;
        serviceItemName: string;
        therapistName: string;
        roomName: string;
        bedName: string;
        serviceStartAt: string;
        serviceEndAt: string;
      }>;
    }
  >();
  for (const row of rows.rows) {
    let conflict = conflicts.get(row.conflict_id);
    if (!conflict) {
      conflict = {
        conflictId: row.conflict_id,
        receptionId: row.reception_id,
        detectedAt: row.detected_at.toISOString(),
        customerName: row.customer_name?.trim() || "微信顾客",
        therapistId: row.therapist_id,
        therapistName: row.therapist_name,
        leaveStartAt: row.leave_start_at.toISOString(),
        leaveEndAt: row.leave_end_at.toISOString(),
        reasonPrivate: row.reason_private?.trim() || "未填写原因",
        guests: [],
      };
      conflicts.set(row.conflict_id, conflict);
    }
    conflict.guests.push({
      id: row.guest_id,
      serviceItemName: row.service_item_name,
      therapistName: row.guest_therapist_name,
      roomName: row.room_name,
      bedName: row.bed_name,
      serviceStartAt: row.service_start_at.toISOString(),
      serviceEndAt: row.service_end_at.toISOString(),
    });
  }

  const page = [...conflicts.values()];
  const hasMore = page.length > CONFLICT_PAGE_SIZE;
  const visibleConflicts = page.slice(0, CONFLICT_PAGE_SIZE);
  return {
    serverNow: clock.rows[0]!.now.toISOString(),
    therapists: therapists.rows,
    conflictTotal: Number(total.rows[0]!.count),
    conflicts: visibleConflicts,
    nextCursor: hasMore
      ? visibleConflicts[visibleConflicts.length - 1]!.conflictId
      : null,
  };
}

function requestHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function leaveRequestHash(input: {
  therapistResourceId: string;
  startAt: Date;
  endAt: Date;
  reasonPrivate: string;
}) {
  return requestHash(
    JSON.stringify({
      therapistResourceId: input.therapistResourceId,
      startAt: input.startAt.toISOString(),
      endAt: input.endAt.toISOString(),
      reasonPrivate: input.reasonPrivate,
    }),
  );
}

async function loadStoreContext(
  database: Database,
  storeId: string,
): Promise<StoreLockContext> {
  const result = await database.pool.query<StoreLockContext>(
    `SELECT lock_key, timezone
       FROM stores
      WHERE id = $1
        AND active = true`,
    [storeId],
  );
  const context = result.rows[0];
  if (!context)
    throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
  return context;
}

async function reserveLeaveEvent(
  client: PoolClient,
  staffUserId: string,
  idempotencyKey: string,
  hash: string,
) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO business_events (
       actor_type, actor_id, operation_type, idempotency_key, request_hash
     ) VALUES ('staff', $1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [staffUserId, CREATE_LEAVE_OPERATION, idempotencyKey, hash],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id };

  const existing = await client.query<ExistingEventRow>(
    `SELECT request_hash, response
       FROM business_events
      WHERE actor_type = 'staff'
        AND actor_id = $1
        AND operation_type = $2
        AND idempotency_key = $3`,
    [staffUserId, CREATE_LEAVE_OPERATION, idempotencyKey],
  );
  const event = existing.rows[0];
  if (!event) throw new Error("Idempotency event disappeared");
  if (event.request_hash !== hash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "该提交标识已用于其他请假，请刷新后重试",
    );
  }
  if (!event.response) {
    throw new AppError(
      409,
      "REQUEST_IN_PROGRESS",
      "请假正在处理中，请稍后核实",
    );
  }
  return { response: event.response };
}

async function reserveExpirationEvents(
  client: PoolClient,
  receptionIds: string[],
) {
  const insertedIds = new Map<string, string>();
  for (const receptionId of [...receptionIds].sort()) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO business_events (
         actor_type, actor_id, operation_type, idempotency_key, request_hash
       ) VALUES ('system', $1, 'reception.expired', $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        receptionId,
        receptionId,
        requestHash(`reception.expired:${receptionId}`),
      ],
    );
    if (inserted.rows[0]) insertedIds.set(receptionId, inserted.rows[0].id);
  }
  return insertedIds;
}

function overlaps(
  allocation: AllocationRow,
  resourceId: string,
  startAt: Date,
  endAt: Date,
) {
  return (
    allocation.resource_id === resourceId &&
    allocation.segment_kind !== "rest" &&
    allocation.start_at < endAt &&
    allocation.end_at > startAt
  );
}

async function createLeaveAttempt(
  database: Database,
  staffUserId: string,
  storeId: string,
  input: {
    therapistResourceId: string;
    startAt: Date;
    endAt: Date;
    reasonPrivate: string;
  },
  idempotencyKey: string,
  additionalLockKeys: Set<number>,
) {
  const initialContext = await loadStoreContext(database, storeId);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", [
      initialContext.lock_key,
      TOPOLOGY_LOCK_KEY,
    ]);

    const storeResult = await client.query<StoreLockContext>(
      `SELECT lock_key, timezone
         FROM stores
        WHERE id = $1
          AND active = true`,
      [storeId],
    );
    const store = storeResult.rows[0];
    if (!store || store.lock_key !== initialContext.lock_key) {
      throw new AppError(404, "STORE_NOT_FOUND", "门店不存在或已停用");
    }

    const lockedKeys = new Set([
      ...rangeDayKeys(input.startAt, input.endAt, store.timezone),
      ...additionalLockKeys,
    ]);
    for (const key of [...lockedKeys].sort((left, right) => left - right)) {
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        store.lock_key,
        key,
      ]);
    }

    const event = await reserveLeaveEvent(
      client,
      staffUserId,
      idempotencyKey,
      leaveRequestHash(input),
    );
    if (event.response) {
      await client.query("COMMIT");
      return event.response;
    }

    const therapist = await client.query(
      `SELECT 1
         FROM resources
        WHERE id = $1
          AND store_id = $2
          AND resource_type = 'therapist'
          AND active = true`,
      [input.therapistResourceId, storeId],
    );
    if (therapist.rowCount === 0) {
      throw new AppError(404, "THERAPIST_NOT_FOUND", "美容师不存在或已停用");
    }

    const affectedResult = await client.query<{
      id: string;
      state: "pending" | "confirmed";
    }>(
      `SELECT DISTINCT reception.id, reception.state
         FROM receptions AS reception
         JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
        WHERE reception.store_id = $1
          AND reception.state IN ('pending', 'confirmed')
          AND allocation.resource_id = $2
          AND allocation.segment_kind IN ('prepare', 'service', 'cleanup')
          AND allocation.allocation_state IN ('held', 'confirmed')
          AND allocation.start_at < $4
          AND allocation.end_at > $3
        ORDER BY reception.id`,
      [storeId, input.therapistResourceId, input.startAt, input.endAt],
    );
    const affectedIds = affectedResult.rows.map((row) => row.id);
    const pendingIds = affectedResult.rows
      .filter((row) => row.state === "pending")
      .map((row) => row.id);
    const expirationEventIds = await reserveExpirationEvents(
      client,
      pendingIds,
    );

    const receptions =
      affectedIds.length === 0
        ? { rows: [] as ReceptionRow[] }
        : await client.query<ReceptionRow>(
            `SELECT id, state, confirmation_deadline
               FROM receptions
              WHERE id = ANY($1::uuid[])
                AND store_id = $2
              ORDER BY id
              FOR UPDATE`,
            [affectedIds, storeId],
          );
    const allocations =
      affectedIds.length === 0
        ? { rows: [] as AllocationRow[] }
        : await client.query<AllocationRow>(
            `SELECT id, reception_id, resource_id, segment_kind,
                    allocation_state, start_at, end_at
               FROM resource_allocations
              WHERE reception_id = ANY($1::uuid[])
                AND allocation_state IN ('held', 'confirmed')
              ORDER BY reception_id, id
              FOR UPDATE`,
            [affectedIds],
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

    const restriction = await client.query<{ id: string }>(
      `INSERT INTO resource_restrictions (
         store_id, resource_id, restriction_kind, start_at, end_at,
         active, reason_private, created_at, updated_at
       ) VALUES ($1, $2, 'leave', $3, $4, true, $5, $6, $6)
       RETURNING id`,
      [
        storeId,
        input.therapistResourceId,
        input.startAt,
        input.endAt,
        input.reasonPrivate,
        decisionNow,
      ],
    );
    const restrictionId = restriction.rows[0]!.id;
    const invalidatedReceptions: Array<{ receptionId: string }> = [];
    const confirmedReceptionIds: string[] = [];

    for (const reception of receptions.rows) {
      const groupAllocations = allocations.rows.filter(
        (allocation) => allocation.reception_id === reception.id,
      );
      const affected = groupAllocations.some((allocation) =>
        overlaps(
          allocation,
          input.therapistResourceId,
          input.startAt,
          input.endAt,
        ),
      );
      if (!affected) continue;

      if (reception.state === "pending") {
        if (
          !reception.confirmation_deadline ||
          reception.confirmation_deadline <= decisionNow
        ) {
          await client.query(
            `UPDATE resource_allocations
                SET allocation_state = 'inactive', expires_at = NULL,
                    inactive_reason = 'expired', version = version + 1,
                    updated_at = $2
              WHERE reception_id = $1
                AND allocation_state = 'held'`,
            [reception.id, decisionNow],
          );
          const expired = await client.query<{ version: number }>(
            `UPDATE receptions
                SET state = 'expired', confirmation_deadline = NULL,
                    version = version + 1, updated_at = $2
              WHERE id = $1
              RETURNING version`,
            [reception.id, decisionNow],
          );
          await client.query(
            `UPDATE business_events
                SET response = $2::jsonb
              WHERE actor_type = 'system'
                AND actor_id = $1
                AND operation_type = 'reception.expired'
                AND idempotency_key = $3`,
            [
              reception.id,
              JSON.stringify({
                receptionId: reception.id,
                state: "expired",
                version: expired.rows[0]!.version,
              }),
              reception.id,
            ],
          );
          continue;
        }

        if (
          groupAllocations.length === 0 ||
          groupAllocations.some(
            (allocation) => allocation.allocation_state !== "held",
          )
        ) {
          throw new AppError(
            409,
            "RECEPTION_ALLOCATION_STATE_CONFLICT",
            "预约占用状态已变化，请重试",
            { receptionId: reception.id },
          );
        }
        await client.query(
          `UPDATE resource_allocations
              SET allocation_state = 'inactive', expires_at = NULL,
                  inactive_reason = 'resource_restriction',
                  version = version + 1, updated_at = $2
            WHERE reception_id = $1
              AND allocation_state = 'held'`,
          [reception.id, decisionNow],
        );
        await client.query(
          `UPDATE receptions
              SET state = 'invalidated', confirmation_deadline = NULL,
                  version = version + 1, updated_at = $2
            WHERE id = $1`,
          [reception.id, decisionNow],
        );
        invalidatedReceptions.push({ receptionId: reception.id });
        continue;
      }

      if (reception.state === "confirmed") {
        confirmedReceptionIds.push(reception.id);
      }
    }

    for (const [receptionId, expirationEventId] of expirationEventIds) {
      if (
        !receptions.rows.some(
          (reception) =>
            reception.id === receptionId &&
            reception.state === "pending" &&
            reception.confirmation_deadline &&
            reception.confirmation_deadline <= decisionNow,
        )
      ) {
        await client.query("DELETE FROM business_events WHERE id = $1", [
          expirationEventId,
        ]);
      }
    }

    const conflicts: Array<{ conflictId: string; receptionId: string }> = [];
    for (const receptionId of [...confirmedReceptionIds].sort()) {
      const inserted = await client.query<{
        id: string;
        reception_id: string;
      }>(
        `INSERT INTO resource_conflicts (
           store_id, resource_id, restriction_id, reception_id,
           status, detected_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'pending', $5, $5)
         ON CONFLICT (restriction_id, reception_id) DO UPDATE
           SET updated_at = resource_conflicts.updated_at
         RETURNING id, reception_id`,
        [
          storeId,
          input.therapistResourceId,
          restrictionId,
          receptionId,
          decisionNow,
        ],
      );
      conflicts.push({
        conflictId: inserted.rows[0]!.id,
        receptionId: inserted.rows[0]!.reception_id,
      });
    }

    const result: CreateLeaveResult = {
      restrictionId,
      state: "active",
      invalidatedPendingCount: invalidatedReceptions.length,
      affectedConfirmedCount: conflicts.length,
      invalidatedReceptions,
      conflicts,
    };
    await client.query(
      "UPDATE business_events SET response = $2::jsonb WHERE id = $1",
      [event.id, JSON.stringify(result)],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createLeave(
  database: Database,
  staffUserId: string,
  storeId: string,
  rawInput: CreateLeaveInput,
  idempotencyKey: string,
) {
  const startAt = new Date(rawInput.startAt);
  const endAt = new Date(rawInput.endAt);
  const reasonPrivate = rawInput.reasonPrivate.trim();
  if (
    Number.isNaN(startAt.getTime()) ||
    Number.isNaN(endAt.getTime()) ||
    endAt <= startAt
  ) {
    throw new AppError(
      400,
      "INVALID_LEAVE_PERIOD",
      "请假结束时间必须晚于开始时间",
    );
  }
  if (!reasonPrivate) {
    throw new AppError(400, "LEAVE_REASON_REQUIRED", "请填写请假原因");
  }

  const input = {
    therapistResourceId: rawInput.therapistResourceId,
    startAt,
    endAt,
    reasonPrivate,
  };
  const additionalLockKeys = new Set<number>();
  let lockAttempts = 0;
  let expansionAttempts = 0;
  while (true) {
    try {
      return await createLeaveAttempt(
        database,
        staffUserId,
        storeId,
        input,
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
          throw new Error("Failed to stabilize leave date lock range");
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
          "相关排班或预约正在处理中，请稍后重试",
        );
      }
      throw error;
    }
  }
}
