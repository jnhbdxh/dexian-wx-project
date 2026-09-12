import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { hashToken } from "../src/lib/crypto.js";
import { RECEPTIONS_CONFIRM } from "../src/modules/booking/routes.js";
import { OPERATIONS_OVERVIEW_READ } from "../src/modules/operations/routes.js";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const suffix = randomUUID();
const allowedToken = `confirm-allowed-${suffix}`;
const allowedCsrf = `confirm-allowed-csrf-${suffix}`;
const deniedToken = `confirm-denied-${suffix}`;
const deniedCsrf = `confirm-denied-csrf-${suffix}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let database: Database;
let storeId = "";
let customerId = "";
let therapistId = "";
let roomId = "";
let bedId = "";
let secondTherapistId = "";
let secondRoomId = "";
let secondBedId = "";
let serviceItemId = "";
let allowedStaffId = "";
let deniedStaffId = "";
let roleId = "";
const receptionIds: string[] = [];
let receptionSequence = 0;

function staffHeaders(
  token = allowedToken,
  csrf = allowedCsrf,
  idempotencyKey = `confirm-${randomUUID()}`,
  version = 1,
) {
  return {
    cookie: `dexian_admin_session=${token}; dexian_admin_csrf=${csrf}`,
    "x-csrf-token": csrf,
    "idempotency-key": idempotencyKey,
    "if-match": `"${version}"`,
    "x-initiating-staff-user-id":
      token === deniedToken ? deniedStaffId : allowedStaffId,
    "x-initiating-store-id": storeId,
  };
}

async function createPendingReception(
  confirmationDeadline = new Date(Date.now() + 60_000),
) {
  const reception = await database.pool.query<{ id: string }>(
    `INSERT INTO receptions (
       store_id, customer_id, state, confirmation_deadline, quote_cents
     ) VALUES ($1, $2, 'pending', $3, 9500)
     RETURNING id`,
    [storeId, customerId, confirmationDeadline],
  );
  const receptionId = reception.rows[0]!.id;
  receptionIds.push(receptionId);
  const startAt = new Date(
    Date.now() + (1 + receptionSequence++ * 72) * 60 * 60_000,
  );
  const endAt = new Date(startAt.getTime() + 60 * 60_000);
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
       $1, $2, 'guest-1', $3, $4, $5, $6, $7, $8, 9500,
       1, 1, 60, 0, 0, 0, 0, '{}'::jsonb
     ) RETURNING id`,
    [
      storeId,
      receptionId,
      serviceItemId,
      therapistId,
      roomId,
      bedId,
      startAt,
      endAt,
    ],
  );
  await database.pool.query(
    `INSERT INTO resource_allocations (
       store_id, resource_id, reception_id, reception_guest_id,
       segment_kind, allocation_state, start_at, end_at, expires_at
     ) VALUES
       ($1, $2, $5, $6, 'service', 'held', $7, $8, $9),
       ($1, $3, $5, $6, 'service', 'held', $7, $8, $9),
       ($1, $4, $5, $6, 'service', 'held', $7, $8, $9)`,
    [
      storeId,
      therapistId,
      roomId,
      bedId,
      receptionId,
      guest.rows[0]!.id,
      startAt,
      endAt,
      confirmationDeadline,
    ],
  );
  return { receptionId, startAt };
}

async function createMultiGuestCrossMidnightReception() {
  const time = await database.pool.query<{ start_at: Date }>(
    `SELECT (
       date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Shanghai')
       + interval '1 day 23 hours 40 minutes'
     ) AT TIME ZONE 'Asia/Shanghai' AS start_at`,
  );
  const firstStart = time.rows[0]!.start_at;
  const secondStart = new Date(firstStart.getTime() + 10 * 60_000);
  const confirmationDeadline = new Date(Date.now() + 60_000);
  const reception = await database.pool.query<{ id: string }>(
    `INSERT INTO receptions (
       store_id, customer_id, state, confirmation_deadline, quote_cents
     ) VALUES ($1, $2, 'pending', $3, 19000)
     RETURNING id`,
    [storeId, customerId, confirmationDeadline],
  );
  const receptionId = reception.rows[0]!.id;
  receptionIds.push(receptionId);

  const guests = await database.pool.query<{
    id: string;
    client_guest_id: string;
  }>(
    `INSERT INTO reception_guests (
       store_id, reception_id, client_guest_id, service_item_id,
       therapist_resource_id, room_resource_id, bed_resource_id,
       service_start_at, service_end_at, quote_cents,
       service_config_version, store_config_version,
       duration_minutes_snapshot, prepare_minutes_snapshot,
       therapist_cleanup_minutes_snapshot,
       facility_cleanup_minutes_snapshot, rest_minutes_snapshot,
       rule_snapshot
     ) VALUES
       ($1, $2, 'guest-1', $3, $4, $5, $6, $7, $8, 9500,
        1, 1, 60, 10, 10, 10, 30, '{}'::jsonb),
       ($1, $2, 'guest-2', $3, $9, $10, $11, $12, $13, 9500,
        1, 1, 60, 10, 10, 10, 30, '{}'::jsonb)
     RETURNING id, client_guest_id`,
    [
      storeId,
      receptionId,
      serviceItemId,
      therapistId,
      roomId,
      bedId,
      firstStart,
      new Date(firstStart.getTime() + 60 * 60_000),
      secondTherapistId,
      secondRoomId,
      secondBedId,
      secondStart,
      new Date(secondStart.getTime() + 60 * 60_000),
    ],
  );

  for (const [index, guest] of guests.rows.entries()) {
    const startAt = index === 0 ? firstStart : secondStart;
    const endAt = new Date(startAt.getTime() + 60 * 60_000);
    const therapist = index === 0 ? therapistId : secondTherapistId;
    const room = index === 0 ? roomId : secondRoomId;
    const bed = index === 0 ? bedId : secondBedId;
    const prepareStart = new Date(startAt.getTime() - 10 * 60_000);
    const cleanupEnd = new Date(endAt.getTime() + 10 * 60_000);
    const restEnd = new Date(cleanupEnd.getTime() + 30 * 60_000);
    const allocations = [
      [therapist, "prepare", prepareStart, startAt],
      [therapist, "service", startAt, endAt],
      [therapist, "cleanup", endAt, cleanupEnd],
      [therapist, "rest", cleanupEnd, restEnd],
      [room, "prepare", prepareStart, startAt],
      [room, "service", startAt, endAt],
      [room, "cleanup", endAt, cleanupEnd],
      [bed, "prepare", prepareStart, startAt],
      [bed, "service", startAt, endAt],
      [bed, "cleanup", endAt, cleanupEnd],
    ] as const;
    for (const [resourceId, segmentKind, start, end] of allocations) {
      await database.pool.query(
        `INSERT INTO resource_allocations (
           store_id, resource_id, reception_id, reception_guest_id,
           segment_kind, allocation_state, start_at, end_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'held', $6, $7, $8)`,
        [
          storeId,
          resourceId,
          receptionId,
          guest.id,
          segmentKind,
          start,
          end,
          confirmationDeadline,
        ],
      );
    }
  }
  return { receptionId, startAt: firstStart };
}

describe.runIf(hasDatabase)("booking confirmation integration", () => {
  beforeAll(async () => {
    config = loadConfig();
    database = createDatabase(config);

    const store = await database.pool.query<{ id: string }>(
      "INSERT INTO stores (name) VALUES ($1) RETURNING id",
      [`确认测试门店-${suffix}`],
    );
    storeId = store.rows[0]!.id;
    const customer = await database.pool.query<{ id: string }>(
      "INSERT INTO customers (display_name) VALUES ($1) RETURNING id",
      [`确认测试顾客-${suffix}`],
    );
    customerId = customer.rows[0]!.id;

    const room = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'room', $2) RETURNING id`,
      [storeId, `确认测试房间-${suffix}`],
    );
    roomId = room.rows[0]!.id;
    const therapist = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'therapist', $2) RETURNING id`,
      [storeId, `确认测试美容师-${suffix}`],
    );
    therapistId = therapist.rows[0]!.id;
    const bed = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (
         store_id, resource_type, parent_resource_id, name
       ) VALUES ($1, 'bed', $2, $3) RETURNING id`,
      [storeId, roomId, `确认测试床位-${suffix}`],
    );
    bedId = bed.rows[0]!.id;
    const secondRoom = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'room', $2) RETURNING id`,
      [storeId, `确认测试房间二-${suffix}`],
    );
    secondRoomId = secondRoom.rows[0]!.id;
    const secondTherapist = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'therapist', $2) RETURNING id`,
      [storeId, `确认测试美容师二-${suffix}`],
    );
    secondTherapistId = secondTherapist.rows[0]!.id;
    const secondBed = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (
         store_id, resource_type, parent_resource_id, name
       ) VALUES ($1, 'bed', $2, $3) RETURNING id`,
      [storeId, secondRoomId, `确认测试床位二-${suffix}`],
    );
    secondBedId = secondBed.rows[0]!.id;
    const service = await database.pool.query<{ id: string }>(
      `INSERT INTO service_items (
         store_id, name, duration_minutes, prepare_minutes,
         cleanup_minutes, facility_cleanup_minutes, rest_minutes, price_cents
       ) VALUES ($1, $2, 60, 0, 0, 0, 0, 9500)
       RETURNING id`,
      [storeId, `确认测试项目-${suffix}`],
    );
    serviceItemId = service.rows[0]!.id;

    const staff = await database.pool.query<{ id: string; username: string }>(
      `INSERT INTO staff_users (
         store_id, username, password_hash, display_name
       ) VALUES
         ($1, $2, 'unused', '有确认权限员工'),
         ($1, $3, 'unused', '无确认权限员工')
       RETURNING id, username`,
      [storeId, `confirm-allowed-${suffix}`, `confirm-denied-${suffix}`],
    );
    allowedStaffId = staff.rows.find((row) =>
      row.username.startsWith("confirm-allowed-"),
    )!.id;
    deniedStaffId = staff.rows.find((row) =>
      row.username.startsWith("confirm-denied-"),
    )!.id;
    const role = await database.pool.query<{ id: string }>(
      `INSERT INTO roles (store_id, code, name)
       VALUES ($1, $2, '预约确认员') RETURNING id`,
      [storeId, `reception-confirmer-${suffix}`],
    );
    roleId = role.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO permissions (code, name)
       VALUES ($1, '确认接待'), ($2, '查看今日工作台')
       ON CONFLICT (code) DO NOTHING`,
      [RECEPTIONS_CONFIRM, OPERATIONS_OVERVIEW_READ],
    );
    await database.pool.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       VALUES ($1, $2), ($1, $3)`,
      [roleId, RECEPTIONS_CONFIRM, OPERATIONS_OVERVIEW_READ],
    );
    await database.pool.query(
      `INSERT INTO staff_role_assignments (staff_user_id, role_id)
       VALUES ($1, $2)`,
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
    await database.pool.query("DELETE FROM service_items WHERE id = $1", [
      serviceItemId,
    ]);
    await database.pool.query(
      "DELETE FROM resources WHERE id = ANY($1::uuid[])",
      [[bedId, secondBedId]],
    );
    await database.pool.query(
      "DELETE FROM resources WHERE id = ANY($1::uuid[])",
      [[therapistId, roomId, secondTherapistId, secondRoomId]],
    );
    await database.pool.query("DELETE FROM customers WHERE id = $1", [
      customerId,
    ]);
    await database.pool.query("DELETE FROM stores WHERE id = $1", [storeId]);
    await database.pool.end();
  });

  it("requires a valid staff session", async () => {
    const { receptionId } = await createPendingReception();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: {
        "idempotency-key": `unauthenticated-${suffix}`,
        "if-match": '"1"',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_REQUIRED");
  });

  it("lists active pending confirmations with operator-ready details", async () => {
    const { receptionId } = await createPendingReception();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/overview",
      headers: {
        cookie: `dexian_admin_session=${allowedToken}`,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().overview).toMatchObject({
      stage: "booking-confirmation",
      canConfirmReceptions: true,
    });
    const item = response
      .json()
      .overview.pendingConfirmations.find(
        (candidate: { receptionId: string }) =>
          candidate.receptionId === receptionId,
      );
    expect(item).toMatchObject({
      receptionId,
      customerName: `确认测试顾客-${suffix}`,
      quoteCents: "9500",
      version: 1,
      guests: [
        {
          clientGuestId: "guest-1",
          serviceItemName: `确认测试项目-${suffix}`,
          therapistName: `确认测试美容师-${suffix}`,
          roomName: `确认测试房间-${suffix}`,
          bedName: `确认测试床位-${suffix}`,
          quoteCents: "9500",
        },
      ],
    });
    expect(Date.parse(response.json().overview.serverNow)).not.toBeNaN();
  });

  it("queries a service date with state and therapist filters", async () => {
    const { receptionId, startAt } = await createPendingReception();
    const localDate = await database.pool.query<{ value: string }>(
      "SELECT ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::text AS value",
      [startAt],
    );
    const response = await app.inject({
      method: "GET",
      url:
        "/api/v1/admin/receptions?serviceDate=" +
        localDate.rows[0]!.value +
        "&state=pending&therapistId=" +
        therapistId,
      headers: { cookie: `dexian_admin_session=${allowedToken}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      canConfirm: true,
      total: expect.any(Number),
    });
    const item = response
      .json()
      .items.find(
        (candidate: { receptionId: string }) =>
          candidate.receptionId === receptionId,
      );
    expect(item).toMatchObject({
      receptionId,
      customerName: `确认测试顾客-${suffix}`,
      state: "pending",
      quoteCents: "9500",
      conflicts: [],
      guests: [
        {
          serviceItemName: `确认测试项目-${suffix}`,
          therapistName: `确认测试美容师-${suffix}`,
          roomName: `确认测试房间-${suffix}`,
          bedName: `确认测试床位-${suffix}`,
          quoteCents: "9500",
        },
      ],
    });

    const staleCursor = await app.inject({
      method: "GET",
      url:
        "/api/v1/admin/receptions?serviceDate=" +
        localDate.rows[0]!.value +
        "&state=confirmed&after=" +
        receptionId,
      headers: { cookie: `dexian_admin_session=${allowedToken}` },
    });
    expect(staleCursor.statusCode).toBe(400);
    expect(staleCursor.json().code).toBe("INVALID_CURSOR");
  });

  it("requires CSRF and the confirmation permission", async () => {
    const { receptionId } = await createPendingReception();
    const invalidCsrf = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(allowedToken, "wrong-csrf"),
    });
    expect(invalidCsrf.statusCode).toBe(403);
    expect(invalidCsrf.json().code).toBe("CSRF_INVALID");

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(deniedToken, deniedCsrf),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: "PERMISSION_DENIED",
      details: { requiredPermission: RECEPTIONS_CONFIRM },
    });
  });

  it("rejects a changed initiating employee or store before idempotency", async () => {
    const { receptionId } = await createPendingReception();
    const staffKey = `changed-staff-${suffix}`;
    const storeKey = `changed-store-${suffix}`;
    const changedStaff = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: {
        ...staffHeaders(allowedToken, allowedCsrf, staffKey),
        "x-initiating-staff-user-id": deniedStaffId,
      },
    });
    const changedStore = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: {
        ...staffHeaders(allowedToken, allowedCsrf, storeKey),
        "x-initiating-store-id": randomUUID(),
      },
    });

    expect(changedStaff.statusCode).toBe(409);
    expect(changedStaff.json().code).toBe("RECEPTION_CONFIRM_IDENTITY_CHANGED");
    expect(changedStore.statusCode).toBe(409);
    expect(changedStore.json().code).toBe("RECEPTION_CONFIRM_IDENTITY_CHANGED");
    const residue = await database.pool.query<{
      event_count: string;
      state: string;
    }>(
      `SELECT reception.state,
              (SELECT count(*)::text FROM business_events
                WHERE idempotency_key = ANY($2::text[])) AS event_count
         FROM receptions AS reception
        WHERE reception.id = $1`,
      [receptionId, [staffKey, storeKey]],
    );
    expect(residue.rows[0]).toEqual({ event_count: "0", state: "pending" });
  });

  it("requires version and idempotency headers", async () => {
    const { receptionId } = await createPendingReception();
    const cookie = `dexian_admin_session=${allowedToken}; dexian_admin_csrf=${allowedCsrf}`;
    const missingVersion = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: {
        cookie,
        "x-csrf-token": allowedCsrf,
        "idempotency-key": `missing-version-${suffix}`,
        "x-initiating-staff-user-id": allowedStaffId,
        "x-initiating-store-id": storeId,
      },
    });
    expect(missingVersion.statusCode).toBe(400);
    expect(missingVersion.json().code).toBe("VERSION_REQUIRED");

    const missingIdempotency = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: {
        cookie,
        "x-csrf-token": allowedCsrf,
        "if-match": '"1"',
        "x-initiating-staff-user-id": allowedStaffId,
        "x-initiating-store-id": storeId,
      },
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(missingIdempotency.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("does not expose a reception from another store", async () => {
    const otherStore = await database.pool.query<{ id: string }>(
      "INSERT INTO stores (name) VALUES ($1) RETURNING id",
      [`其他确认测试门店-${suffix}`],
    );
    const otherStoreId = otherStore.rows[0]!.id;
    const otherReception = await database.pool.query<{ id: string }>(
      `INSERT INTO receptions (
         store_id, customer_id, state, confirmation_deadline, quote_cents
       ) VALUES ($1, $2, 'pending', clock_timestamp() + interval '1 minute', 1)
       RETURNING id`,
      [otherStoreId, customerId],
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${otherReception.rows[0]!.id}/confirm`,
        headers: staffHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("RECEPTION_NOT_FOUND");
    } finally {
      await database.pool.query("DELETE FROM receptions WHERE id = $1", [
        otherReception.rows[0]!.id,
      ]);
      await database.pool.query("DELETE FROM stores WHERE id = $1", [
        otherStoreId,
      ]);
    }
  });

  it("confirms the reception and all held allocations atomically", async () => {
    const { receptionId } = await createPendingReception();
    const key = `successful-confirm-${suffix}`;
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(allowedToken, allowedCsrf, key),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      receptionId,
      state: "confirmed",
      version: 2,
      quoteCents: "9500",
    });
    const stored = await database.pool.query<{
      confirmation_deadline: Date | null;
      state: string;
      version: number;
    }>(
      `SELECT state, confirmation_deadline, version
         FROM receptions WHERE id = $1`,
      [receptionId],
    );
    expect(stored.rows[0]).toMatchObject({
      state: "confirmed",
      confirmation_deadline: null,
      version: 2,
    });
    const allocations = await database.pool.query<{
      count: string;
      states: string[];
      with_expiry: string;
    }>(
      `SELECT count(*)::text AS count,
              array_agg(DISTINCT allocation_state)::text[] AS states,
              count(expires_at)::text AS with_expiry
         FROM resource_allocations
        WHERE reception_id = $1`,
      [receptionId],
    );
    expect(allocations.rows[0]).toEqual({
      count: "3",
      states: ["confirmed"],
      with_expiry: "0",
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(allowedToken, allowedCsrf, key),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(response.json());
    const eventCount = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM business_events
        WHERE actor_id = $1
          AND operation_type = 'reception.confirm'
          AND idempotency_key = $2`,
      [allowedStaffId, key],
    );
    expect(eventCount.rows[0]?.count).toBe("1");
  });

  it("confirms all allocations once when two requests race on a multi-guest cross-midnight reception", async () => {
    const { receptionId } = await createMultiGuestCrossMidnightReception();
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${receptionId}/confirm`,
        headers: staffHeaders(
          allowedToken,
          allowedCsrf,
          `multi-first-${randomUUID()}`,
        ),
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${receptionId}/confirm`,
        headers: staffHeaders(
          allowedToken,
          allowedCsrf,
          `multi-second-${randomUUID()}`,
        ),
      }),
    ]);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(first.json()).toMatchObject({
      receptionId,
      state: "confirmed",
      version: 2,
      quoteCents: "19000",
    });
    expect(second.json()).toEqual(first.json());
    const stored = await database.pool.query<{
      allocation_count: string;
      allocation_versions: number[];
      reception_version: number;
      states: string[];
    }>(
      `SELECT count(allocation.id)::text AS allocation_count,
              array_agg(DISTINCT allocation.version)::integer[] AS allocation_versions,
              reception.version AS reception_version,
              array_agg(DISTINCT allocation.allocation_state)::text[] AS states
         FROM receptions AS reception
         JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
        WHERE reception.id = $1
        GROUP BY reception.id`,
      [receptionId],
    );
    expect(stored.rows[0]).toEqual({
      allocation_count: "20",
      allocation_versions: [2],
      reception_version: 2,
      states: ["confirmed"],
    });
  });

  it("returns the confirmed result when confirmation is repeated with a new key", async () => {
    const { receptionId } = await createPendingReception();
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(),
    });
    expect(first.statusCode).toBe(200);

    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(),
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(first.json());
    const allocationVersions = await database.pool.query<{
      versions: number[];
    }>(
      `SELECT array_agg(DISTINCT version)::integer[] AS versions
         FROM resource_allocations
        WHERE reception_id = $1`,
      [receptionId],
    );
    expect(allocationVersions.rows[0]?.versions).toEqual([2]);
  });

  it("rejects reuse of an idempotency key with a different version", async () => {
    const { receptionId } = await createPendingReception();
    const key = `reused-confirm-${suffix}`;
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(allowedToken, allowedCsrf, key),
    });
    expect(first.statusCode).toBe(200);

    const reused = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(allowedToken, allowedCsrf, key, 2),
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("rejects a stale pending version without changing allocations", async () => {
    const { receptionId } = await createPendingReception();
    await database.pool.query(
      "UPDATE receptions SET version = 2 WHERE id = $1",
      [receptionId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { currentState: "pending", currentVersion: 2 },
    });
    const allocationStates = await database.pool.query<{ states: string[] }>(
      `SELECT array_agg(DISTINCT allocation_state)::text[] AS states
         FROM resource_allocations WHERE reception_id = $1`,
      [receptionId],
    );
    expect(allocationStates.rows[0]?.states).toEqual(["held"]);
  });

  it("does not confirm a reception with a partial allocation state", async () => {
    const { receptionId } = await createPendingReception();
    await database.pool.query(
      `UPDATE resource_allocations
          SET allocation_state = 'inactive', expires_at = NULL,
              inactive_reason = 'test'
        WHERE id = (
          SELECT id FROM resource_allocations
           WHERE reception_id = $1 ORDER BY id LIMIT 1
        )`,
      [receptionId],
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: staffHeaders(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("RECEPTION_ALLOCATION_STATE_CONFLICT");
    const stored = await database.pool.query<{ state: string }>(
      "SELECT state FROM receptions WHERE id = $1",
      [receptionId],
    );
    expect(stored.rows[0]?.state).toBe("pending");
  });

  it("expires the whole hold when the deadline passes while waiting for its date lock", async () => {
    const deadline = new Date(Date.now() + 1_200);
    const { receptionId, startAt } = await createPendingReception(deadline);
    const store = await database.pool.query<{ lock_key: number }>(
      "SELECT lock_key FROM stores WHERE id = $1",
      [storeId],
    );
    const day = await database.pool.query<{ key: number }>(
      `SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                - DATE '2000-01-01')::integer AS key`,
      [startAt],
    );
    const idempotencyKey = `deadline-race-${suffix}`;
    const blocker = await database.pool.connect();
    let rolledBack = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1, $2)", [
        store.rows[0]!.lock_key,
        day.rows[0]!.key,
      ]);
      const request = app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${receptionId}/confirm`,
        headers: staffHeaders(allowedToken, allowedCsrf, idempotencyKey),
      });
      let observedLockWait = false;
      const waitDeadline = Date.now() + 700;
      while (!observedLockWait && Date.now() < waitDeadline) {
        const waiting = await database.pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE 'SELECT pg_advisory_xact_lock(%'
           ) AS waiting`,
        );
        observedLockWait = waiting.rows[0]?.waiting ?? false;
        if (!observedLockWait) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now() + 100)),
      );
      await blocker.query("ROLLBACK");
      rolledBack = true;
      const response = await request;

      expect(observedLockWait).toBe(true);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "RECEPTION_EXPIRED",
        details: { currentState: "expired", currentVersion: 2 },
      });
    } finally {
      if (!rolledBack) await blocker.query("ROLLBACK");
      blocker.release();
    }

    const reception = await database.pool.query<{
      confirmation_deadline: Date | null;
      state: string;
    }>("SELECT state, confirmation_deadline FROM receptions WHERE id = $1", [
      receptionId,
    ]);
    expect(reception.rows[0]).toMatchObject({
      state: "expired",
      confirmation_deadline: null,
    });
    const allocations = await database.pool.query<{
      inactive: string;
      total: string;
      with_expiry: string;
    }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE allocation_state = 'inactive')::text AS inactive,
              count(expires_at)::text AS with_expiry
         FROM resource_allocations WHERE reception_id = $1`,
      [receptionId],
    );
    expect(allocations.rows[0]).toEqual({
      total: "3",
      inactive: "3",
      with_expiry: "0",
    });
    const events = await database.pool.query<{
      confirm_events: string;
      expiry_events: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE operation_type = 'reception.confirm')::text AS confirm_events,
         count(*) FILTER (WHERE operation_type = 'reception.expired')::text AS expiry_events
       FROM business_events
       WHERE (actor_id = $1 AND idempotency_key = $3)
          OR actor_id = $2`,
      [allowedStaffId, receptionId, idempotencyKey],
    );
    expect(events.rows[0]).toEqual({
      confirm_events: "0",
      expiry_events: "1",
    });
  }, 10_000);

  it("expires without residue when an idempotency event wait crosses the deadline", async () => {
    const deadline = new Date(Date.now() + 900);
    const { receptionId } = await createPendingReception(deadline);
    const idempotencyKey = `event-deadline-${suffix}`;
    const blocker = await database.pool.connect();
    let rolledBack = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `INSERT INTO business_events (
           actor_type, actor_id, operation_type, idempotency_key, request_hash
         ) VALUES ('staff', $1, 'reception.confirm', $2, 'blocking-test')`,
        [allowedStaffId, idempotencyKey],
      );
      const request = app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${receptionId}/confirm`,
        headers: staffHeaders(allowedToken, allowedCsrf, idempotencyKey),
      });
      let observedLockWait = false;
      const waitDeadline = Date.now() + 600;
      while (!observedLockWait && Date.now() < waitDeadline) {
        const waiting = await database.pool.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query ILIKE '%INSERT INTO business_events%'
           ) AS waiting`,
        );
        observedLockWait = waiting.rows[0]?.waiting ?? false;
        if (!observedLockWait) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now() + 80)),
      );
      await blocker.query("ROLLBACK");
      rolledBack = true;
      const response = await request;

      expect(observedLockWait).toBe(true);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("RECEPTION_EXPIRED");
    } finally {
      if (!rolledBack) await blocker.query("ROLLBACK");
      blocker.release();
    }

    const residue = await database.pool.query<{
      confirm_events: string;
      expiry_events: string;
      held_allocations: string;
      inactive_allocations: string;
      state: string;
    }>(
      `SELECT reception.state,
              count(DISTINCT event.id) FILTER (
                WHERE event.operation_type = 'reception.confirm'
              )::text AS confirm_events,
              count(DISTINCT event.id) FILTER (
                WHERE event.operation_type = 'reception.expired'
              )::text AS expiry_events,
              count(DISTINCT allocation.id) FILTER (
                WHERE allocation.allocation_state = 'held'
              )::text AS held_allocations,
              count(DISTINCT allocation.id) FILTER (
                WHERE allocation.allocation_state = 'inactive'
              )::text AS inactive_allocations
         FROM receptions AS reception
         JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
         LEFT JOIN business_events AS event
           ON (event.actor_id = reception.id
               AND event.operation_type = 'reception.expired')
           OR (event.actor_id = $2::uuid
               AND event.operation_type = 'reception.confirm'
               AND event.idempotency_key = $3)
        WHERE reception.id = $1
        GROUP BY reception.id`,
      [receptionId, allowedStaffId, idempotencyKey],
    );
    expect(residue.rows[0]).toEqual({
      confirm_events: "0",
      expiry_events: "1",
      held_allocations: "0",
      inactive_allocations: "3",
      state: "expired",
    });
  }, 10_000);

  it("returns a retryable error without changing state when the date lock times out", async () => {
    const { receptionId, startAt } = await createPendingReception(
      new Date(Date.now() + 30_000),
    );
    const store = await database.pool.query<{ lock_key: number }>(
      "SELECT lock_key FROM stores WHERE id = $1",
      [storeId],
    );
    const day = await database.pool.query<{ key: number }>(
      `SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                - DATE '2000-01-01')::integer AS key`,
      [startAt],
    );
    const blocker = await database.pool.connect();
    const idempotencyKey = `date-timeout-${suffix}`;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1, $2)", [
        store.rows[0]!.lock_key,
        day.rows[0]!.key,
      ]);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/receptions/${receptionId}/confirm`,
        headers: staffHeaders(allowedToken, allowedCsrf, idempotencyKey),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("RESOURCE_BUSY_RETRY");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    const unchanged = await database.pool.query<{
      event_count: string;
      reception_state: string;
      reception_version: number;
      states: string[];
      versions: number[];
    }>(
      `SELECT reception.state AS reception_state,
              reception.version AS reception_version,
              array_agg(DISTINCT allocation.allocation_state)::text[] AS states,
              array_agg(DISTINCT allocation.version)::integer[] AS versions,
              (
                SELECT count(*)::text
                  FROM business_events
                 WHERE actor_id = $2
                   AND operation_type = 'reception.confirm'
                   AND idempotency_key = $3
              ) AS event_count
         FROM receptions AS reception
         JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
        WHERE reception.id = $1
        GROUP BY reception.id`,
      [receptionId, allowedStaffId, idempotencyKey],
    );
    expect(unchanged.rows[0]).toEqual({
      event_count: "0",
      reception_state: "pending",
      reception_version: 1,
      states: ["held"],
      versions: [1],
    });
  }, 10_000);
});
