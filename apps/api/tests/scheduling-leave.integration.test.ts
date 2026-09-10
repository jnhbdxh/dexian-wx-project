import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { hashToken } from "../src/lib/crypto.js";
import { RECEPTIONS_CONFIRM } from "../src/modules/booking/routes.js";
import { dayKey } from "../src/modules/booking/locking.js";
import { OPERATIONS_OVERVIEW_READ } from "../src/modules/operations/routes.js";
import { SCHEDULING_LEAVE_WRITE } from "../src/modules/scheduling/routes.js";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const suffix = randomUUID();
const customerToken = `leave-customer-${suffix}`;
const allowedToken = `leave-allowed-${suffix}`;
const allowedCsrf = `leave-allowed-csrf-${suffix}`;
const deniedToken = `leave-denied-${suffix}`;
const deniedCsrf = `leave-denied-csrf-${suffix}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let database: Database;
let storeId = "";
let otherStoreId = "";
let storeLockKey = 0;
let customerId = "";
let therapistId = "";
let secondTherapistId = "";
let otherTherapistId = "";
let roomId = "";
let secondRoomId = "";
let bedId = "";
let secondBedId = "";
let serviceItemId = "";
let allowedStaffId = "";
let deniedStaffId = "";
let roleId = "";
const receptionIds: string[] = [];
let receptionSequence = 0;

interface GuestResources {
  therapistId: string;
  roomId: string;
  bedId: string;
  startAt: Date;
}

function leaveHeaders(idempotencyKey = `leave-${randomUUID()}`) {
  return {
    cookie: `dexian_admin_session=${allowedToken}; dexian_admin_csrf=${allowedCsrf}`,
    "x-csrf-token": allowedCsrf,
    "idempotency-key": idempotencyKey,
  };
}

function confirmHeaders(idempotencyKey = `confirm-${randomUUID()}`) {
  return {
    cookie: `dexian_admin_session=${allowedToken}; dexian_admin_csrf=${allowedCsrf}`,
    "x-csrf-token": allowedCsrf,
    "idempotency-key": idempotencyKey,
    "if-match": '"1"',
  };
}

function leaveBody(startAt: Date, endAt: Date, therapist = therapistId) {
  return {
    therapistResourceId: therapist,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    reasonPrivate: "已确认的个人请假",
  };
}

function nextStart() {
  return new Date(Date.now() + (2 + receptionSequence++ * 72) * 60 * 60_000);
}

async function createReception(
  state: "pending" | "confirmed",
  guests: GuestResources[],
  confirmationDeadline = new Date(Date.now() + 10 * 60_000),
) {
  const reception = await database.pool.query<{ id: string }>(
    `INSERT INTO receptions (
       store_id, customer_id, state, confirmation_deadline, quote_cents
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      storeId,
      customerId,
      state,
      state === "pending" ? confirmationDeadline : null,
      guests.length * 9500,
    ],
  );
  const receptionId = reception.rows[0]!.id;
  receptionIds.push(receptionId);

  for (const [index, resources] of guests.entries()) {
    const endAt = new Date(resources.startAt.getTime() + 60 * 60_000);
    const cleanupEnd = new Date(endAt.getTime() + 10 * 60_000);
    const restEnd = new Date(cleanupEnd.getTime() + 30 * 60_000);
    const prepareStart = new Date(resources.startAt.getTime() - 10 * 60_000);
    const guest = await database.pool.query<{ id: string }>(
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
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 9500,
         1, 1, 60, 10, 10, 10, 30, '{}'::jsonb
       ) RETURNING id`,
      [
        storeId,
        receptionId,
        `guest-${index + 1}`,
        serviceItemId,
        resources.therapistId,
        resources.roomId,
        resources.bedId,
        resources.startAt,
        endAt,
      ],
    );
    const allocationState = state === "pending" ? "held" : "confirmed";
    const expiresAt = state === "pending" ? confirmationDeadline : null;
    const allocations = [
      [resources.therapistId, "prepare", prepareStart, resources.startAt],
      [resources.therapistId, "service", resources.startAt, endAt],
      [resources.therapistId, "cleanup", endAt, cleanupEnd],
      [resources.therapistId, "rest", cleanupEnd, restEnd],
      [resources.roomId, "prepare", prepareStart, resources.startAt],
      [resources.roomId, "service", resources.startAt, endAt],
      [resources.roomId, "cleanup", endAt, cleanupEnd],
      [resources.bedId, "prepare", prepareStart, resources.startAt],
      [resources.bedId, "service", resources.startAt, endAt],
      [resources.bedId, "cleanup", endAt, cleanupEnd],
    ] as const;
    for (const [resourceId, segmentKind, start, end] of allocations) {
      await database.pool.query(
        `INSERT INTO resource_allocations (
           store_id, resource_id, reception_id, reception_guest_id,
           segment_kind, allocation_state, start_at, end_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          storeId,
          resourceId,
          receptionId,
          guest.rows[0]!.id,
          segmentKind,
          allocationState,
          start,
          end,
          expiresAt,
        ],
      );
    }
  }
  return receptionId;
}

async function waitForDatabaseLock(queryPattern: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await database.pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE $1
       ) AS waiting`,
      [queryPattern],
    );
    if (result.rows[0]?.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function blockBusinessEvent(
  client: PoolClient,
  operationType: string,
  idempotencyKey: string,
) {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO business_events (
       actor_type, actor_id, operation_type, idempotency_key, request_hash
     ) VALUES ('staff', $1, $2, $3, 'blocker')`,
    [allowedStaffId, operationType, idempotencyKey],
  );
}

describe.runIf(hasDatabase)("scheduling leave integration", () => {
  beforeAll(async () => {
    config = loadConfig();
    database = createDatabase(config);

    const store = await database.pool.query<{
      id: string;
      lock_key: number;
    }>("INSERT INTO stores (name) VALUES ($1) RETURNING id, lock_key", [
      `请假测试门店-${suffix}`,
    ]);
    storeId = store.rows[0]!.id;
    storeLockKey = store.rows[0]!.lock_key;
    const otherStore = await database.pool.query<{ id: string }>(
      "INSERT INTO stores (name) VALUES ($1) RETURNING id",
      [`其他请假测试门店-${suffix}`],
    );
    otherStoreId = otherStore.rows[0]!.id;
    customerId = (
      await database.pool.query<{ id: string }>(
        "INSERT INTO customers (display_name) VALUES ($1) RETURNING id",
        [`请假测试顾客-${suffix}`],
      )
    ).rows[0]!.id;
    await database.pool.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
       VALUES ($1, $2, clock_timestamp() + interval '1 hour')`,
      [customerId, hashToken(customerToken)],
    );

    const resources = await database.pool.query<{
      id: string;
      name: string;
    }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES
         ($1, 'therapist', $2), ($1, 'therapist', $3),
         ($1, 'room', $4), ($1, 'room', $5)
       RETURNING id, name`,
      [
        storeId,
        `请假测试美容师-${suffix}`,
        `请假测试美容师二-${suffix}`,
        `请假测试房间-${suffix}`,
        `请假测试房间二-${suffix}`,
      ],
    );
    therapistId = resources.rows.find((row) =>
      row.name.includes("美容师-"),
    )!.id;
    secondTherapistId = resources.rows.find((row) =>
      row.name.includes("美容师二-"),
    )!.id;
    roomId = resources.rows.find((row) => row.name.includes("房间-"))!.id;
    secondRoomId = resources.rows.find((row) =>
      row.name.includes("房间二-"),
    )!.id;
    otherTherapistId = (
      await database.pool.query<{ id: string }>(
        `INSERT INTO resources (store_id, resource_type, name)
         VALUES ($1, 'therapist', $2) RETURNING id`,
        [otherStoreId, `其他门店美容师-${suffix}`],
      )
    ).rows[0]!.id;
    bedId = (
      await database.pool.query<{ id: string }>(
        `INSERT INTO resources (
           store_id, resource_type, parent_resource_id, name
         ) VALUES ($1, 'bed', $2, $3) RETURNING id`,
        [storeId, roomId, `请假测试床位-${suffix}`],
      )
    ).rows[0]!.id;
    secondBedId = (
      await database.pool.query<{ id: string }>(
        `INSERT INTO resources (
           store_id, resource_type, parent_resource_id, name
         ) VALUES ($1, 'bed', $2, $3) RETURNING id`,
        [storeId, secondRoomId, `请假测试床位二-${suffix}`],
      )
    ).rows[0]!.id;
    serviceItemId = (
      await database.pool.query<{ id: string }>(
        `INSERT INTO service_items (
           store_id, name, duration_minutes, prepare_minutes,
           cleanup_minutes, facility_cleanup_minutes, rest_minutes, price_cents
         ) VALUES ($1, $2, 60, 10, 10, 10, 30, 9500)
         RETURNING id`,
        [storeId, `请假测试项目-${suffix}`],
      )
    ).rows[0]!.id;
    await database.pool.query(
      `INSERT INTO therapist_service_items (
         store_id, therapist_resource_id, service_item_id
       ) VALUES ($1, $2, $3)`,
      [storeId, therapistId, serviceItemId],
    );

    const staff = await database.pool.query<{ id: string; username: string }>(
      `INSERT INTO staff_users (
         store_id, username, password_hash, display_name
       ) VALUES
         ($1, $2, 'unused', '有请假权限员工'),
         ($1, $3, 'unused', '无请假权限员工')
       RETURNING id, username`,
      [storeId, `leave-allowed-${suffix}`, `leave-denied-${suffix}`],
    );
    allowedStaffId = staff.rows.find((row) =>
      row.username.startsWith("leave-allowed-"),
    )!.id;
    deniedStaffId = staff.rows.find((row) =>
      row.username.startsWith("leave-denied-"),
    )!.id;
    roleId = (
      await database.pool.query<{ id: string }>(
        `INSERT INTO roles (store_id, code, name)
         VALUES ($1, $2, '请假登记员') RETURNING id`,
        [storeId, `leave-writer-${suffix}`],
      )
    ).rows[0]!.id;
    await database.pool.query(
      `INSERT INTO permissions (code, name)
       VALUES ($1, '登记请假'), ($2, '确认接待'), ($3, '查看今日工作台')
       ON CONFLICT (code) DO NOTHING`,
      [SCHEDULING_LEAVE_WRITE, RECEPTIONS_CONFIRM, OPERATIONS_OVERVIEW_READ],
    );
    await database.pool.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       VALUES ($1, $2), ($1, $3), ($1, $4)`,
      [
        roleId,
        SCHEDULING_LEAVE_WRITE,
        RECEPTIONS_CONFIRM,
        OPERATIONS_OVERVIEW_READ,
      ],
    );
    await database.pool.query(
      "INSERT INTO staff_role_assignments (staff_user_id, role_id) VALUES ($1, $2)",
      [allowedStaffId, roleId],
    );
    await database.pool.query(
      `INSERT INTO staff_sessions (
         staff_user_id, token_hash, csrf_token_hash, expires_at
       ) VALUES
         ($1, $2, $3, clock_timestamp() + interval '1 hour'),
         ($4, $5, $6, clock_timestamp() + interval '1 hour')`,
      [
        allowedStaffId,
        hashToken(allowedToken),
        hashToken(allowedCsrf),
        deniedStaffId,
        hashToken(deniedToken),
        hashToken(deniedCsrf),
      ],
    );

    app = await buildApp({ config, database, logger: false });
  });

  afterAll(async () => {
    await app?.close();
    if (!database) return;
    await database.pool.query(
      "DELETE FROM resource_conflicts WHERE store_id = $1",
      [storeId],
    );
    await database.pool.query(
      "DELETE FROM resource_restrictions WHERE store_id = ANY($1::uuid[])",
      [[storeId, otherStoreId]],
    );
    await database.pool.query(
      "DELETE FROM resource_allocations WHERE reception_id = ANY($1::uuid[])",
      [receptionIds],
    );
    await database.pool.query(
      "DELETE FROM reception_guests WHERE reception_id = ANY($1::uuid[])",
      [receptionIds],
    );
    await database.pool.query(
      `DELETE FROM business_events
        WHERE actor_id = ANY($1::uuid[])
           OR actor_id = ANY($2::uuid[])`,
      [[allowedStaffId, deniedStaffId], receptionIds],
    );
    await database.pool.query(
      "DELETE FROM receptions WHERE id = ANY($1::uuid[])",
      [receptionIds],
    );
    await database.pool.query(
      "DELETE FROM staff_sessions WHERE staff_user_id = ANY($1::uuid[])",
      [[allowedStaffId, deniedStaffId]],
    );
    await database.pool.query(
      "DELETE FROM staff_role_assignments WHERE staff_user_id = $1",
      [allowedStaffId],
    );
    await database.pool.query(
      "DELETE FROM role_permissions WHERE role_id = $1",
      [roleId],
    );
    await database.pool.query("DELETE FROM roles WHERE id = $1", [roleId]);
    await database.pool.query(
      "DELETE FROM staff_users WHERE id = ANY($1::uuid[])",
      [[allowedStaffId, deniedStaffId]],
    );
    await database.pool.query(
      "DELETE FROM resource_shifts WHERE store_id = $1",
      [storeId],
    );
    await database.pool.query(
      "DELETE FROM therapist_service_items WHERE service_item_id = $1",
      [serviceItemId],
    );
    await database.pool.query("DELETE FROM service_items WHERE id = $1", [
      serviceItemId,
    ]);
    await database.pool.query(
      "DELETE FROM resources WHERE id = ANY($1::uuid[])",
      [[bedId, secondBedId]],
    );
    await database.pool.query(
      "DELETE FROM resources WHERE id = ANY($1::uuid[])",
      [[therapistId, secondTherapistId, roomId, secondRoomId]],
    );
    await database.pool.query("DELETE FROM resources WHERE id = $1", [
      otherTherapistId,
    ]);
    await database.pool.query(
      "DELETE FROM customer_sessions WHERE customer_id = $1",
      [customerId],
    );
    await database.pool.query("DELETE FROM customers WHERE id = $1", [
      customerId,
    ]);
    await database.pool.query("DELETE FROM stores WHERE id = ANY($1::uuid[])", [
      [storeId, otherStoreId],
    ]);
    await database.pool.end();
  });

  it("requires a valid session, CSRF token, and leave permission", async () => {
    const startAt = nextStart();
    const body = leaveBody(startAt, new Date(startAt.getTime() + 60 * 60_000));
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: { "idempotency-key": `unauth-${suffix}` },
      payload: body,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const noPermission = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: {
        cookie: `dexian_admin_session=${deniedToken}; dexian_admin_csrf=${deniedCsrf}`,
        "x-csrf-token": deniedCsrf,
        "idempotency-key": `denied-${suffix}`,
      },
      payload: body,
    });
    expect(noPermission.statusCode).toBe(403);
    expect(noPermission.json().code).toBe("PERMISSION_DENIED");

    const badCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: {
        cookie: `dexian_admin_session=${allowedToken}`,
        "x-csrf-token": "wrong",
        "idempotency-key": `csrf-${suffix}`,
      },
      payload: body,
    });
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.json().code).toBe("CSRF_INVALID");

    const unauthenticatedWorkbench = await app.inject({
      method: "GET",
      url: "/api/v1/admin/scheduling/leave-workbench",
    });
    expect(unauthenticatedWorkbench.statusCode).toBe(401);
    const forbiddenWorkbench = await app.inject({
      method: "GET",
      url: "/api/v1/admin/scheduling/leave-workbench",
      headers: {
        cookie: `dexian_admin_session=${deniedToken}; dexian_admin_csrf=${deniedCsrf}`,
      },
    });
    expect(forbiddenWorkbench.statusCode).toBe(403);
  });

  it("creates an immediately active future leave without requiring a shift", async () => {
    const startAt = nextStart();
    const endAt = new Date(startAt.getTime() + 60 * 60_000);
    const key = `future-${suffix}`;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: leaveHeaders(key),
      payload: leaveBody(startAt, endAt),
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: leaveHeaders(key),
      payload: leaveBody(startAt, endAt),
    });

    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({
      state: "active",
      invalidatedPendingCount: 0,
      affectedConfirmedCount: 0,
    });
    const stored = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM resource_restrictions
        WHERE id = $1
          AND restriction_kind = 'leave'
          AND reason_private = '已确认的个人请假'`,
      [first.json().restrictionId],
    );
    expect(stored.rows[0]!.count).toBe("1");

    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: leaveHeaders(key),
      payload: { ...leaveBody(startAt, endAt), reasonPrivate: "不同原因" },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects a therapist from another store without revealing it", async () => {
    const startAt = nextStart();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: leaveHeaders(),
      payload: leaveBody(
        startAt,
        new Date(startAt.getTime() + 60 * 60_000),
        otherTherapistId,
      ),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("THERAPIST_NOT_FOUND");
  });

  it("keeps a leave unavailable when a full base shift is published afterward", async () => {
    const leaveStart = nextStart();
    const leaveEnd = new Date(leaveStart.getTime() + 60 * 60_000);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: leaveHeaders(),
      payload: leaveBody(leaveStart, leaveEnd),
    });
    expect(response.statusCode, response.body).toBe(201);

    await database.pool.query(
      `INSERT INTO resource_shifts (
         store_id, therapist_resource_id, start_at, end_at, published
       ) VALUES ($1, $2, $3, $4, true)`,
      [
        storeId,
        therapistId,
        new Date(leaveStart.getTime() - 2 * 60 * 60_000),
        new Date(leaveEnd.getTime() + 2 * 60 * 60_000),
      ],
    );

    const availability = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        storeId,
        assignments: [
          {
            clientGuestId: "leave-chain-guest",
            serviceItemId,
            therapistResourceId: therapistId,
            roomResourceId: roomId,
            bedResourceId: bedId,
            serviceStartAt: leaveStart.toISOString(),
          },
        ],
      },
    });
    expect(availability.statusCode, availability.body).toBe(200);
    expect(availability.json()).toEqual({
      available: false,
      reason: "所选时间或资源当前不可用",
    });
  });

  it("invalidates held groups and creates one conflict per confirmed group", async () => {
    const pendingStart = nextStart();
    const confirmedStart = new Date(pendingStart.getTime() + 2 * 60 * 60_000);
    const pendingId = await createReception("pending", [
      { therapistId, roomId, bedId, startAt: pendingStart },
    ]);
    const confirmedId = await createReception("confirmed", [
      { therapistId, roomId, bedId, startAt: confirmedStart },
    ]);
    const pendingSnapshotBefore = await database.pool.query<{
      reception_quote_cents: number;
      guest_quote_cents: number;
      service_config_version: number;
      store_config_version: number;
      duration_minutes_snapshot: number;
      prepare_minutes_snapshot: number;
      therapist_cleanup_minutes_snapshot: number;
      facility_cleanup_minutes_snapshot: number;
      rest_minutes_snapshot: number;
      rule_snapshot: string;
    }>(
      `SELECT reception.quote_cents AS reception_quote_cents,
              guest.quote_cents AS guest_quote_cents,
              guest.service_config_version, guest.store_config_version,
              guest.duration_minutes_snapshot, guest.prepare_minutes_snapshot,
              guest.therapist_cleanup_minutes_snapshot,
              guest.facility_cleanup_minutes_snapshot,
              guest.rest_minutes_snapshot,
              guest.rule_snapshot::text AS rule_snapshot
         FROM receptions AS reception
         JOIN reception_guests AS guest ON guest.reception_id = reception.id
        WHERE reception.id = $1`,
      [pendingId],
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: leaveHeaders(),
      payload: leaveBody(
        new Date(pendingStart.getTime() - 5 * 60_000),
        new Date(confirmedStart.getTime() + 65 * 60_000),
      ),
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      invalidatedPendingCount: 1,
      affectedConfirmedCount: 1,
      invalidatedReceptions: [{ receptionId: pendingId }],
      conflicts: [{ receptionId: confirmedId }],
    });
    const state = await database.pool.query<{
      id: string;
      state: string;
      confirmation_deadline: Date | null;
      allocation_states: string[];
      expires_count: string;
    }>(
      `SELECT reception.id, reception.state, reception.confirmation_deadline,
              array_agg(DISTINCT allocation.allocation_state)::text[] AS allocation_states,
              count(*) FILTER (WHERE allocation.expires_at IS NOT NULL)::text AS expires_count
         FROM receptions AS reception
         JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
        WHERE reception.id = ANY($1::uuid[])
        GROUP BY reception.id
        ORDER BY reception.id`,
      [[pendingId, confirmedId]],
    );
    expect(state.rows.find((row) => row.id === pendingId)).toMatchObject({
      state: "invalidated",
      confirmation_deadline: null,
      allocation_states: ["inactive"],
      expires_count: "0",
    });
    expect(state.rows.find((row) => row.id === confirmedId)).toMatchObject({
      state: "confirmed",
      allocation_states: ["confirmed"],
      expires_count: "0",
    });
    const pendingSnapshotAfter = await database.pool.query(
      `SELECT reception.quote_cents AS reception_quote_cents,
              guest.quote_cents AS guest_quote_cents,
              guest.service_config_version, guest.store_config_version,
              guest.duration_minutes_snapshot, guest.prepare_minutes_snapshot,
              guest.therapist_cleanup_minutes_snapshot,
              guest.facility_cleanup_minutes_snapshot,
              guest.rest_minutes_snapshot,
              guest.rule_snapshot::text AS rule_snapshot
         FROM receptions AS reception
         JOIN reception_guests AS guest ON guest.reception_id = reception.id
        WHERE reception.id = $1`,
      [pendingId],
    );
    expect(pendingSnapshotAfter.rows).toEqual(pendingSnapshotBefore.rows);
    const conflictCount = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM resource_conflicts
        WHERE restriction_id = $1
          AND reception_id = $2`,
      [response.json().restrictionId, confirmedId],
    );
    expect(conflictCount.rows[0]!.count).toBe("1");

    const workbench = await app.inject({
      method: "GET",
      url: "/api/v1/admin/scheduling/leave-workbench",
      headers: leaveHeaders(),
    });
    expect(workbench.statusCode, workbench.body).toBe(200);
    expect(workbench.json()).toMatchObject({
      user: { id: allowedStaffId, storeId },
      canCreateLeave: true,
      therapists: expect.arrayContaining([
        expect.objectContaining({
          id: therapistId,
          name: expect.any(String),
        }),
      ]),
      conflicts: expect.arrayContaining([
        expect.objectContaining({
          receptionId: confirmedId,
          customerName: expect.any(String),
          therapistId,
          reasonPrivate: "已确认的个人请假",
          guests: expect.arrayContaining([
            expect.objectContaining({
              serviceItemName: expect.any(String),
              therapistName: expect.any(String),
              roomName: expect.any(String),
              bedName: expect.any(String),
            }),
          ]),
        }),
      ]),
    });
  });

  it("keeps a reception valid when leave overlaps only required rest", async () => {
    const startAt = nextStart();
    const receptionId = await createReception("pending", [
      { therapistId, roomId, bedId, startAt },
    ]);
    const cleanupEnd = new Date(startAt.getTime() + 70 * 60_000);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: leaveHeaders(),
      payload: leaveBody(
        new Date(cleanupEnd.getTime() + 5 * 60_000),
        new Date(cleanupEnd.getTime() + 25 * 60_000),
      ),
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      invalidatedPendingCount: 0,
      affectedConfirmedCount: 0,
    });
    const reception = await database.pool.query<{ state: string }>(
      "SELECT state FROM receptions WHERE id = $1",
      [receptionId],
    );
    expect(reception.rows[0]!.state).toBe("pending");
  });

  it("pages through every pending conflict and reports the exact total", async () => {
    const startAt = nextStart();
    const receptionId = await createReception("confirmed", [
      { therapistId, roomId, bedId, startAt },
    ]);
    const inserted = await database.pool.query<{ id: string }>(
      `WITH restrictions AS (
         INSERT INTO resource_restrictions (
           store_id, resource_id, restriction_kind, start_at, end_at,
           active, reason_private
         )
         SELECT $1, $2, 'leave', $3, $4, true,
                '分页验收-' || sequence::text
           FROM generate_series(1, 51) AS sequence
         RETURNING id
       )
       INSERT INTO resource_conflicts (
         store_id, resource_id, restriction_id, reception_id, status
       )
       SELECT $1, $2, id, $5, 'pending'
         FROM restrictions
       RETURNING id`,
      [
        storeId,
        therapistId,
        startAt,
        new Date(startAt.getTime() + 60 * 60_000),
        receptionId,
      ],
    );
    const expected = new Set(inserted.rows.map((row) => row.id));
    const allIds = new Set<string>();
    let cursor: string | null = null;
    let exactTotal = 0;
    do {
      const query: string = cursor ? `?afterConflictId=${cursor}` : "";
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject(
        {
          method: "GET",
          url: `/api/v1/admin/scheduling/leave-workbench${query}`,
          headers: leaveHeaders(),
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      const page: {
        conflictTotal: number;
        conflicts: Array<{ conflictId: string }>;
        nextCursor: string | null;
      } = response.json();
      exactTotal = page.conflictTotal;
      page.conflicts.forEach((conflict) => allIds.add(conflict.conflictId));
      cursor = page.nextCursor;
    } while (cursor);

    const databaseTotal = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM resource_conflicts
        WHERE store_id = $1`,
      [storeId],
    );
    expect(exactTotal).toBe(Number(databaseTotal.rows[0]!.count));
    expect([...expected].every((id) => allIds.has(id))).toBe(true);
    expect(allIds.size).toBe(exactTotal);
  });

  it("uses post-idempotency database time so an expired hold is not counted as leave invalidation", async () => {
    const startAt = nextStart();
    const deadline = new Date(Date.now() + 500);
    const receptionId = await createReception(
      "pending",
      [{ therapistId, roomId, bedId, startAt }],
      deadline,
    );
    const key = `event-wait-${suffix}`;
    const blocker = await database.pool.connect();
    await blockBusinessEvent(blocker, "resource_restriction.create_leave", key);
    let rolledBack = false;
    try {
      const request = app.inject({
        method: "POST",
        url: "/api/v1/admin/leaves",
        headers: leaveHeaders(key),
        payload: leaveBody(startAt, new Date(startAt.getTime() + 30 * 60_000)),
      });
      expect(await waitForDatabaseLock("%INSERT INTO business_events%")).toBe(
        true,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now() + 80)),
      );
      await blocker.query("ROLLBACK");
      rolledBack = true;
      const response = await request;
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().invalidatedPendingCount).toBe(0);
    } finally {
      if (!rolledBack) await blocker.query("ROLLBACK");
      blocker.release();
    }

    const state = await database.pool.query<{
      state: string;
      inactive_reason: string;
      expiry_events: string;
    }>(
      `SELECT reception.state,
              min(allocation.inactive_reason) AS inactive_reason,
              (
                SELECT count(*)::text
                  FROM business_events
                 WHERE actor_id = $1
                   AND operation_type = 'reception.expired'
              ) AS expiry_events
         FROM receptions AS reception
         JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
        WHERE reception.id = $1
        GROUP BY reception.id`,
      [receptionId],
    );
    expect(state.rows[0]).toEqual({
      state: "expired",
      inactive_reason: "expired",
      expiry_events: "1",
    });
  }, 10_000);

  it("expands date locks before atomically invalidating a multi-day group", async () => {
    const firstStart = nextStart();
    const secondStart = new Date(firstStart.getTime() + 2 * 24 * 60 * 60_000);
    const receptionId = await createReception("pending", [
      { therapistId, roomId, bedId, startAt: firstStart },
      {
        therapistId: secondTherapistId,
        roomId: secondRoomId,
        bedId: secondBedId,
        startAt: secondStart,
      },
    ]);
    const blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1, $2)", [
      storeLockKey,
      dayKey(secondStart, "Asia/Shanghai"),
    ]);
    let rolledBack = false;
    try {
      const request = app.inject({
        method: "POST",
        url: "/api/v1/admin/leaves",
        headers: leaveHeaders(),
        payload: leaveBody(
          new Date(firstStart.getTime() - 5 * 60_000),
          new Date(firstStart.getTime() + 30 * 60_000),
        ),
      });
      expect(await waitForDatabaseLock("%pg_advisory_xact_lock%")).toBe(true);
      await blocker.query("ROLLBACK");
      rolledBack = true;
      const response = await request;
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        invalidatedPendingCount: 1,
        invalidatedReceptions: [{ receptionId }],
      });
    } finally {
      if (!rolledBack) await blocker.query("ROLLBACK");
      blocker.release();
    }

    const allocations = await database.pool.query<{
      states: string[];
      active_expiries: string;
    }>(
      `SELECT array_agg(DISTINCT allocation_state)::text[] AS states,
              count(*) FILTER (WHERE expires_at IS NOT NULL)::text AS active_expiries
         FROM resource_allocations
        WHERE reception_id = $1`,
      [receptionId],
    );
    expect(allocations.rows[0]).toEqual({
      states: ["inactive"],
      active_expiries: "0",
    });
  }, 10_000);

  it("serializes leave before confirmation and leaves no partial state", async () => {
    const startAt = nextStart();
    const receptionId = await createReception("pending", [
      { therapistId, roomId, bedId, startAt },
    ]);
    const leaveKey = `leave-first-${suffix}`;
    const blocker = await database.pool.connect();
    await blockBusinessEvent(
      blocker,
      "resource_restriction.create_leave",
      leaveKey,
    );
    let rolledBack = false;
    try {
      const leaveRequest = app.inject({
        method: "POST",
        url: "/api/v1/admin/leaves",
        headers: leaveHeaders(leaveKey),
        payload: leaveBody(startAt, new Date(startAt.getTime() + 30 * 60_000)),
      });
      expect(await waitForDatabaseLock("%INSERT INTO business_events%")).toBe(
        true,
      );
      const confirmRequest = app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${receptionId}/confirm`,
        headers: confirmHeaders(),
      });
      expect(await waitForDatabaseLock("%pg_advisory_xact_lock%")).toBe(true);
      await blocker.query("ROLLBACK");
      rolledBack = true;
      const [leaveResponse, confirmResponse] = await Promise.all([
        leaveRequest,
        confirmRequest,
      ]);
      expect(leaveResponse.statusCode, leaveResponse.body).toBe(201);
      expect(confirmResponse.statusCode).toBe(409);
      expect(confirmResponse.json().code).toBe("RECEPTION_STATE_CONFLICT");
    } finally {
      if (!rolledBack) await blocker.query("ROLLBACK");
      blocker.release();
    }
    const reception = await database.pool.query<{ state: string }>(
      "SELECT state FROM receptions WHERE id = $1",
      [receptionId],
    );
    expect(reception.rows[0]!.state).toBe("invalidated");
  }, 10_000);

  it("serializes confirmation before leave and preserves the confirmed allocation", async () => {
    const startAt = nextStart();
    const receptionId = await createReception("pending", [
      { therapistId, roomId, bedId, startAt },
    ]);
    const confirmKey = `confirm-first-${suffix}`;
    const blocker = await database.pool.connect();
    await blockBusinessEvent(blocker, "reception.confirm", confirmKey);
    let rolledBack = false;
    try {
      const confirmRequest = app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${receptionId}/confirm`,
        headers: confirmHeaders(confirmKey),
      });
      expect(await waitForDatabaseLock("%INSERT INTO business_events%")).toBe(
        true,
      );
      const leaveRequest = app.inject({
        method: "POST",
        url: "/api/v1/admin/leaves",
        headers: leaveHeaders(),
        payload: leaveBody(startAt, new Date(startAt.getTime() + 30 * 60_000)),
      });
      expect(await waitForDatabaseLock("%pg_advisory_xact_lock%")).toBe(true);
      await blocker.query("ROLLBACK");
      rolledBack = true;
      const [confirmResponse, leaveResponse] = await Promise.all([
        confirmRequest,
        leaveRequest,
      ]);
      expect(confirmResponse.statusCode, confirmResponse.body).toBe(200);
      expect(leaveResponse.statusCode, leaveResponse.body).toBe(201);
      expect(leaveResponse.json()).toMatchObject({
        invalidatedPendingCount: 0,
        affectedConfirmedCount: 1,
        conflicts: [{ receptionId }],
      });
    } finally {
      if (!rolledBack) await blocker.query("ROLLBACK");
      blocker.release();
    }
    const state = await database.pool.query<{
      state: string;
      allocation_states: string[];
    }>(
      `SELECT reception.state,
              array_agg(DISTINCT allocation.allocation_state)::text[] AS allocation_states
         FROM receptions AS reception
         JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
        WHERE reception.id = $1
        GROUP BY reception.id`,
      [receptionId],
    );
    expect(state.rows[0]).toEqual({
      state: "confirmed",
      allocation_states: ["confirmed"],
    });
  }, 10_000);

  it("returns a retryable error without partial writes when a date lock times out", async () => {
    const startAt = nextStart();
    const key = `date-timeout-${suffix}`;
    const blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1, $2)", [
      storeLockKey,
      dayKey(startAt, "Asia/Shanghai"),
    ]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/leaves",
        headers: leaveHeaders(key),
        payload: leaveBody(startAt, new Date(startAt.getTime() + 60 * 60_000)),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("RESOURCE_BUSY_RETRY");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const residue = await database.pool.query<{
      events: string;
      restrictions: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM business_events
           WHERE actor_id = $1 AND operation_type = 'resource_restriction.create_leave'
             AND idempotency_key = $2) AS events,
         (SELECT count(*)::text FROM resource_restrictions
           WHERE store_id = $3 AND start_at = $4) AS restrictions`,
      [allowedStaffId, key, storeId, startAt],
    );
    expect(residue.rows[0]).toEqual({ events: "0", restrictions: "0" });
  }, 10_000);
});
