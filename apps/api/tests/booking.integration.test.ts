import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { hashToken } from "../src/lib/crypto.js";
import {
  signBookingCandidate,
  verifyBookingCandidate,
} from "../src/modules/booking/candidate.js";

const hasDatabase = Boolean(
  process.env.DATABASE_URL && process.env.BOOKING_TOKEN_SECRET,
);
const suffix = randomUUID();
const customerToken = `booking-customer-${suffix}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let database: Database;
let storeId = "";
let customerId = "";
let therapistId = "";
let roomId = "";
let bedId = "";
let serviceItemId = "";
let secondTherapistId = "";
let secondRoomId = "";
let secondBedId = "";
let nearServiceItemId = "";
let slotStart: Date;
let candidateToken = "";
let firstReceptionId = "";
let successfulIdempotencyKey = "";

function assignment(startAt: Date, selectedServiceItemId = serviceItemId) {
  return {
    clientGuestId: "guest-1",
    serviceItemId: selectedServiceItemId,
    therapistResourceId: therapistId,
    roomResourceId: roomId,
    bedResourceId: bedId,
    serviceStartAt: startAt.toISOString(),
  };
}

function shanghaiDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function shanghaiDayKey(value: Date) {
  const [year, month, day] = shanghaiDate(value).split("-").map(Number);
  return Math.floor(
    (Date.UTC(year!, month! - 1, day!) - Date.UTC(2000, 0, 1)) / 86_400_000,
  );
}

async function queryAvailability(
  startAt: Date,
  selectedServiceItemId = serviceItemId,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/availability/queries",
    headers: { authorization: `Bearer ${customerToken}` },
    payload: {
      storeId,
      assignments: [assignment(startAt, selectedServiceItemId)],
    },
  });
}

describe.runIf(hasDatabase)("booking hold integration", () => {
  beforeAll(async () => {
    config = loadConfig();
    database = createDatabase(config);

    const store = await database.pool.query<{ id: string }>(
      `INSERT INTO stores (
         name, default_prepare_minutes, default_therapist_cleanup_minutes,
         default_facility_cleanup_minutes, default_rest_minutes
       ) VALUES ($1, 15, 5, 20, 10)
       RETURNING id`,
      [`预约测试门店-${suffix}`],
    );
    storeId = store.rows[0]!.id;

    const customer = await database.pool.query<{ id: string }>(
      `INSERT INTO customers (display_name)
       VALUES ($1)
       RETURNING id`,
      [`预约测试顾客-${suffix}`],
    );
    customerId = customer.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [customerId, hashToken(customerToken), new Date(Date.now() + 3_600_000)],
    );

    const room = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'room', $2)
       RETURNING id`,
      [storeId, `预约测试房间-${suffix}`],
    );
    roomId = room.rows[0]!.id;
    const therapist = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (
         store_id, resource_type, name, minimum_rest_minutes
       ) VALUES ($1, 'therapist', $2, 30)
       RETURNING id`,
      [storeId, `预约测试美容师-${suffix}`],
    );
    therapistId = therapist.rows[0]!.id;
    const bed = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (
         store_id, resource_type, parent_resource_id, name
       ) VALUES ($1, 'bed', $2, $3)
       RETURNING id`,
      [storeId, roomId, `预约测试床位-${suffix}`],
    );
    bedId = bed.rows[0]!.id;

    const secondRoom = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'room', $2)
       RETURNING id`,
      [storeId, `预约测试第二房间-${suffix}`],
    );
    secondRoomId = secondRoom.rows[0]!.id;
    const secondTherapist = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (store_id, resource_type, name)
       VALUES ($1, 'therapist', $2)
       RETURNING id`,
      [storeId, `预约测试第二美容师-${suffix}`],
    );
    secondTherapistId = secondTherapist.rows[0]!.id;
    const secondBed = await database.pool.query<{ id: string }>(
      `INSERT INTO resources (
         store_id, resource_type, parent_resource_id, name
       ) VALUES ($1, 'bed', $2, $3)
       RETURNING id`,
      [storeId, secondRoomId, `预约测试第二床位-${suffix}`],
    );
    secondBedId = secondBed.rows[0]!.id;

    const service = await database.pool.query<{ id: string }>(
      `INSERT INTO service_items (
         store_id, name, duration_minutes, prepare_minutes,
         cleanup_minutes, facility_cleanup_minutes, rest_minutes, price_cents
       ) VALUES ($1, $2, 60, NULL, 10, NULL, 5, 9500)
       RETURNING id`,
      [storeId, `预约测试项目-${suffix}`],
    );
    serviceItemId = service.rows[0]!.id;
    const nearService = await database.pool.query<{ id: string }>(
      `INSERT INTO service_items (
         store_id, name, duration_minutes, prepare_minutes,
         cleanup_minutes, facility_cleanup_minutes, rest_minutes, price_cents
       ) VALUES ($1, $2, 10, 0, 0, 0, 0, 100)
       RETURNING id`,
      [storeId, `临近预约测试项目-${suffix}`],
    );
    nearServiceItemId = nearService.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO therapist_service_items (
         store_id, therapist_resource_id, service_item_id
       ) VALUES
         ($1, $2, $3),
         ($1, $2, $4),
         ($1, $5, $4)`,
      [
        storeId,
        therapistId,
        serviceItemId,
        nearServiceItemId,
        secondTherapistId,
      ],
    );

    slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
    slotStart.setUTCHours(15, 30, 0, 0);
    await database.pool.query(
      `INSERT INTO resource_shifts (
         store_id, therapist_resource_id, start_at, end_at, published
       ) VALUES
         ($1, $2, $3, $4, true),
         ($1, $5, $6, $7, true),
         ($1, $2, $6, $7, true)`,
      [
        storeId,
        therapistId,
        new Date(slotStart.getTime() - 2 * 60 * 60 * 1000),
        new Date(slotStart.getTime() + 8 * 60 * 60 * 1000),
        secondTherapistId,
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 60 * 60_000),
      ],
    );

    app = await buildApp({ config, database, logger: false });
  });

  afterAll(async () => {
    await app?.close();
    if (database && storeId) {
      await database.pool.query(
        "DELETE FROM resource_allocations WHERE store_id = $1",
        [storeId],
      );
      await database.pool.query(
        "DELETE FROM reception_guests WHERE store_id = $1",
        [storeId],
      );
      await database.pool.query(
        "DELETE FROM business_events WHERE actor_id = $1",
        [customerId],
      );
      await database.pool.query("DELETE FROM receptions WHERE store_id = $1", [
        storeId,
      ]);
      await database.pool.query(
        "DELETE FROM resource_restrictions WHERE store_id = $1",
        [storeId],
      );
      await database.pool.query(
        "DELETE FROM resource_shifts WHERE store_id = $1",
        [storeId],
      );
      await database.pool.query(
        "DELETE FROM therapist_service_items WHERE store_id = $1",
        [storeId],
      );
      await database.pool.query(
        "DELETE FROM service_items WHERE store_id = $1",
        [storeId],
      );
      await database.pool.query(
        "DELETE FROM resources WHERE store_id = $1 AND resource_type = 'bed'",
        [storeId],
      );
      await database.pool.query("DELETE FROM resources WHERE store_id = $1", [
        storeId,
      ]);
      await database.pool.query(
        "DELETE FROM customer_sessions WHERE customer_id = $1",
        [customerId],
      );
      await database.pool.query("DELETE FROM customers WHERE id = $1", [
        customerId,
      ]);
      await database.pool.query("DELETE FROM stores WHERE id = $1", [storeId]);
      await database.pool.end();
    }
  });

  it("caps a multi-guest confirmation window at the earliest work start", async () => {
    const firstStart = new Date(Date.now() + 30_000);
    const secondStart = new Date(Date.now() + 90_000);
    const availability = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        storeId,
        assignments: [
          assignment(firstStart, nearServiceItemId),
          {
            clientGuestId: "guest-2",
            serviceItemId: nearServiceItemId,
            therapistResourceId: secondTherapistId,
            roomResourceId: secondRoomId,
            bedResourceId: secondBedId,
            serviceStartAt: secondStart.toISOString(),
          },
        ],
      },
    });
    expect(availability.statusCode, availability.body).toBe(200);
    expect(availability.json().available).toBe(true);

    const idempotencyKey = `near-group-${suffix}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": idempotencyKey,
      },
      payload: { candidateToken: availability.json().candidateToken },
    });
    expect(created.statusCode).toBe(201);
    expect(
      new Date(created.json().confirmationDeadline).getTime(),
    ).toBeLessThanOrEqual(firstStart.getTime());

    const receptionId = created.json().receptionId;
    await database.pool.query(
      "DELETE FROM resource_allocations WHERE reception_id = $1",
      [receptionId],
    );
    await database.pool.query(
      "DELETE FROM reception_guests WHERE reception_id = $1",
      [receptionId],
    );
    await database.pool.query("DELETE FROM receptions WHERE id = $1", [
      receptionId,
    ]);
    await database.pool.query(
      "DELETE FROM business_events WHERE actor_id = $1 AND idempotency_key = $2",
      [customerId, idempotencyKey],
    );
  });

  it("rejects a candidate submitted after its earliest work start", async () => {
    const serviceStart = new Date(Date.now() + 4_000);
    const availability = await queryAvailability(
      serviceStart,
      nearServiceItemId,
    );
    expect(availability.statusCode).toBe(200);
    expect(availability.json().available).toBe(true);
    expect(
      new Date(availability.json().expiresAt).getTime(),
    ).toBeLessThanOrEqual(serviceStart.getTime());

    await new Promise((resolve) => setTimeout(resolve, 4_200));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": `delayed-${suffix}`,
      },
      payload: { candidateToken: availability.json().candidateToken },
    });

    expect(created.statusCode).toBe(409);
    expect(created.json().code).toBe("CANDIDATE_EXPIRED");
  }, 10_000);

  it("rechecks candidate expiry after waiting for an idempotency event", async () => {
    const templateResponse = await queryAvailability(
      new Date(Date.now() + 30_000),
      nearServiceItemId,
    );
    expect(templateResponse.statusCode).toBe(200);
    const template = verifyBookingCandidate(
      templateResponse.json().candidateToken,
      config.bookingTokenSecret,
    );
    const serviceStart = new Date(Date.now() + 1_200);
    const serviceEnd = new Date(serviceStart.getTime() + 10 * 60_000);
    const candidate = {
      ...template,
      expiresAt: serviceStart.toISOString(),
      assignments: template.assignments.map((item) => ({
        ...item,
        serviceStartAt: serviceStart.toISOString(),
        serviceEndAt: serviceEnd.toISOString(),
        prepareStartAt: serviceStart.toISOString(),
        therapistWorkEndAt: serviceEnd.toISOString(),
        facilityCleanupEndAt: serviceEnd.toISOString(),
        restEndAt: serviceEnd.toISOString(),
      })),
    };
    const candidateToken = signBookingCandidate(
      candidate,
      config.bookingTokenSecret,
    );
    const idempotencyKey = `blocked-expiry-${suffix}`;
    const hash = createHash("sha256").update(candidateToken).digest("hex");
    const before = await database.pool.query<{
      allocations: string;
      receptions: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM receptions WHERE store_id = $1) AS receptions,
         (SELECT count(*)::text FROM resource_allocations WHERE store_id = $1) AS allocations`,
      [storeId],
    );

    const { response, observedLockWait } = await (async () => {
      const blocker = await database.pool.connect();
      let rolledBack = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `INSERT INTO business_events (
             actor_type, actor_id, operation_type, idempotency_key, request_hash
           ) VALUES ('customer', $1, 'reception.create_hold', $2, $3)`,
          [customerId, idempotencyKey, hash],
        );

        const request = app.inject({
          method: "POST",
          url: "/api/v1/receptions",
          headers: {
            authorization: `Bearer ${customerToken}`,
            "idempotency-key": idempotencyKey,
          },
          payload: { candidateToken },
        });
        let observedLockWait = false;
        const waitDeadline = Date.now() + 700;
        while (!observedLockWait && Date.now() < waitDeadline) {
          const waiting = await database.pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1
                 FROM pg_stat_activity
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
          setTimeout(
            resolve,
            Math.max(0, serviceStart.getTime() - Date.now() + 100),
          ),
        );
        await blocker.query("ROLLBACK");
        rolledBack = true;
        return { response: await request, observedLockWait };
      } finally {
        if (!rolledBack) await blocker.query("ROLLBACK");
        blocker.release();
      }
    })();

    expect(observedLockWait).toBe(true);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CANDIDATE_EXPIRED");

    const after = await database.pool.query<{
      allocations: string;
      receptions: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM receptions WHERE store_id = $1) AS receptions,
         (SELECT count(*)::text FROM resource_allocations WHERE store_id = $1) AS allocations`,
      [storeId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const events = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM business_events
        WHERE actor_id = $1 AND idempotency_key = $2`,
      [customerId, idempotencyKey],
    );
    expect(events.rows[0]?.count).toBe("0");
  }, 10_000);

  it("expands expired-group date locks and times out with a retryable error", async () => {
    const candidateStart = new Date(slotStart.getTime() + 35 * 60_000);
    const oldEnd = new Date(candidateStart.getTime() - 10 * 60_000);
    const oldStart = new Date(oldEnd.getTime() - 24 * 60 * 60_000);
    const oldReception = await database.pool.query<{ id: string }>(
      `INSERT INTO receptions (
           store_id, customer_id, state, confirmation_deadline, quote_cents
         ) VALUES (
           $1, $2, 'pending', clock_timestamp() - interval '1 second', 1
         ) RETURNING id`,
      [storeId, customerId],
    );
    const oldReceptionId = oldReception.rows[0]!.id;
    const oldGuest = await database.pool.query<{ id: string }>(
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
           $1, $2, 'old-guest', $3, $4, $5, $6, $7, $8, 1,
           1, 1, 1440, 0, 0, 0, 0, '{}'::jsonb
         ) RETURNING id`,
      [
        storeId,
        oldReceptionId,
        serviceItemId,
        therapistId,
        roomId,
        bedId,
        oldStart,
        oldEnd,
      ],
    );
    await database.pool.query(
      `INSERT INTO resource_allocations (
           store_id, resource_id, reception_id, reception_guest_id,
           segment_kind, allocation_state, start_at, end_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, 'service', 'held', $5, $6,
           clock_timestamp() - interval '1 second'
         )`,
      [
        storeId,
        therapistId,
        oldReceptionId,
        oldGuest.rows[0]!.id,
        oldStart,
        oldEnd,
      ],
    );

    const availability = await queryAvailability(candidateStart);
    expect(availability.statusCode).toBe(200);
    expect(availability.json().available).toBe(true);

    const store = await database.pool.query<{ lock_key: number }>(
      "SELECT lock_key FROM stores WHERE id = $1",
      [storeId],
    );
    const lockClient = await database.pool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT pg_advisory_xact_lock($1, $2)", [
      store.rows[0]!.lock_key,
      shanghaiDayKey(oldStart),
    ]);

    const idempotencyKey = `expanded-lock-${suffix}`;
    const startedAt = Date.now();
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": idempotencyKey,
      },
      payload: { candidateToken: availability.json().candidateToken },
    });
    const waitedMs = Date.now() - startedAt;
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("RESOURCE_BUSY_RETRY");
    expect(waitedMs).toBeGreaterThanOrEqual(4_200);
    expect(waitedMs).toBeLessThan(7_500);

    const stillPending = await database.pool.query<{ state: string }>(
      "SELECT state FROM receptions WHERE id = $1",
      [oldReceptionId],
    );
    expect(stillPending.rows[0]!.state).toBe("pending");
    await lockClient.query("ROLLBACK");
    lockClient.release();

    const retried = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": idempotencyKey,
      },
      payload: { candidateToken: availability.json().candidateToken },
    });
    expect(retried.statusCode).toBe(201);
    const expired = await database.pool.query<{ state: string }>(
      "SELECT state FROM receptions WHERE id = $1",
      [oldReceptionId],
    );
    expect(expired.rows[0]!.state).toBe("expired");

    const ids = [oldReceptionId, retried.json().receptionId];
    await database.pool.query(
      "DELETE FROM resource_allocations WHERE reception_id = ANY($1::uuid[])",
      [ids],
    );
    await database.pool.query(
      "DELETE FROM reception_guests WHERE reception_id = ANY($1::uuid[])",
      [ids],
    );
    await database.pool.query(
      "DELETE FROM receptions WHERE id = ANY($1::uuid[])",
      [ids],
    );
    await database.pool.query(
      "DELETE FROM business_events WHERE actor_id = $1 AND idempotency_key = $2",
      [customerId, idempotencyKey],
    );
  }, 12_000);

  it("returns an explicit-resource candidate that may cross midnight", async () => {
    const response = await queryAvailability(slotStart);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.available).toBe(true);
    expect(body.quoteCents).toBe("9500");
    expect(body.assignments[0].quoteCents).toBe("9500");
    expect(body.assignments[0]).toMatchObject({
      prepareMinutes: 15,
      therapistCleanupMinutes: 10,
      facilityCleanupMinutes: 20,
      restMinutes: 30,
    });
    expect(shanghaiDate(new Date(body.assignments[0].restEndAt))).not.toBe(
      shanghaiDate(slotStart),
    );
    candidateToken = body.candidateToken;
  });

  it("allows only one of two concurrent holds for the same resources", async () => {
    const keys = [`concurrent-a-${suffix}`, `concurrent-b-${suffix}`];
    const responses = await Promise.all(
      keys.map((key) =>
        app.inject({
          method: "POST",
          url: "/api/v1/receptions",
          headers: {
            authorization: `Bearer ${customerToken}`,
            "idempotency-key": key,
          },
          payload: { candidateToken },
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const winnerIndex = responses.findIndex(
      (response) => response.statusCode === 201,
    );
    successfulIdempotencyKey = keys[winnerIndex]!;
    firstReceptionId = responses[winnerIndex]!.json().receptionId;
    const loser = responses.find((response) => response.statusCode === 409)!;
    expect(loser.json().code).toBe("CANDIDATE_CHANGED");

    const count = await database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM receptions WHERE store_id = $1",
      [storeId],
    );
    expect(count.rows[0]!.count).toBe("1");
    const allocationCount = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM resource_allocations
        WHERE store_id = $1
          AND allocation_state = 'held'`,
      [storeId],
    );
    expect(allocationCount.rows[0]!.count).toBe("10");

    const snapshot = await database.pool.query<{
      service_config_version: number;
      store_config_version: number;
      duration_minutes_snapshot: number;
      prepare_minutes_snapshot: number;
      therapist_cleanup_minutes_snapshot: number;
      facility_cleanup_minutes_snapshot: number;
      rest_minutes_snapshot: number;
      rule_snapshot: {
        serviceConfigured: { prepareMinutes: number | null };
        storeDefaults: { prepareMinutes: number | null };
        therapistMinimumRestMinutes: number;
      };
    }>(
      `SELECT service_config_version,
              store_config_version,
              duration_minutes_snapshot,
              prepare_minutes_snapshot,
              therapist_cleanup_minutes_snapshot,
              facility_cleanup_minutes_snapshot,
              rest_minutes_snapshot,
              rule_snapshot
         FROM reception_guests
        WHERE reception_id = $1`,
      [firstReceptionId],
    );
    expect(snapshot.rows[0]).toMatchObject({
      service_config_version: 1,
      store_config_version: 1,
      duration_minutes_snapshot: 60,
      prepare_minutes_snapshot: 15,
      therapist_cleanup_minutes_snapshot: 10,
      facility_cleanup_minutes_snapshot: 20,
      rest_minutes_snapshot: 30,
      rule_snapshot: {
        serviceConfigured: { prepareMinutes: null },
        storeDefaults: { prepareMinutes: 15 },
        therapistMinimumRestMinutes: 30,
      },
    });

    const cleanupEnds = await database.pool.query<{
      resource_type: string;
      end_at: Date;
    }>(
      `SELECT resource.resource_type, allocation.end_at
         FROM resource_allocations AS allocation
         JOIN resources AS resource ON resource.id = allocation.resource_id
        WHERE allocation.reception_id = $1
          AND allocation.segment_kind = 'cleanup'
        ORDER BY resource.resource_type`,
      [firstReceptionId],
    );
    const therapistCleanup = cleanupEnds.rows.find(
      (row) => row.resource_type === "therapist",
    );
    const facilityCleanup = cleanupEnds.rows.find(
      (row) => row.resource_type === "room",
    );
    expect(therapistCleanup!.end_at.getTime()).toBe(
      new Date(slotStart.getTime() + 70 * 60_000).getTime(),
    );
    expect(facilityCleanup!.end_at.getTime()).toBe(
      new Date(slotStart.getTime() + 80 * 60_000).getTime(),
    );
  });

  it("replays the same response for the same idempotency key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": successfulIdempotencyKey,
      },
      payload: { candidateToken },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().receptionId).toBe(firstReceptionId);
  });

  it("replays a completed idempotent response after its candidate expires", async () => {
    const expiredCandidate = {
      ...verifyBookingCandidate(candidateToken, config.bookingTokenSecret),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    const expiredToken = signBookingCandidate(
      expiredCandidate,
      config.bookingTokenSecret,
    );
    const idempotencyKey = `expired-replay-${suffix}`;
    const replay = {
      receptionId: firstReceptionId,
      state: "pending",
      confirmationDeadline: new Date(Date.now() + 60_000).toISOString(),
      quoteCents: "9500",
    };
    await database.pool.query(
      `INSERT INTO business_events (
         actor_type, actor_id, operation_type, idempotency_key,
         request_hash, response
       ) VALUES ('customer', $1, 'reception.create_hold', $2, $3, $4::jsonb)`,
      [
        customerId,
        idempotencyKey,
        createHash("sha256").update(expiredToken).digest("hex"),
        JSON.stringify(replay),
      ],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": idempotencyKey,
      },
      payload: { candidateToken: expiredToken },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(replay);
  });

  it("materializes an expired hold before creating its replacement", async () => {
    await database.pool.query(
      `UPDATE receptions
          SET confirmation_deadline = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [firstReceptionId],
    );
    await database.pool.query(
      `UPDATE resource_allocations
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE reception_id = $1`,
      [firstReceptionId],
    );

    const availability = await queryAvailability(slotStart);
    expect(availability.statusCode).toBe(200);
    expect(availability.json().available).toBe(true);

    const replacement = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": `replacement-${suffix}`,
      },
      payload: { candidateToken: availability.json().candidateToken },
    });
    expect(replacement.statusCode).toBe(201);

    const oldReception = await database.pool.query<{
      state: string;
      confirmation_deadline: Date | null;
      active_allocations: string;
    }>(
      `SELECT reception.state,
              reception.confirmation_deadline,
              count(allocation.id) FILTER (
                WHERE allocation.allocation_state <> 'inactive'
              )::text AS active_allocations
         FROM receptions AS reception
         LEFT JOIN resource_allocations AS allocation
           ON allocation.reception_id = reception.id
        WHERE reception.id = $1
        GROUP BY reception.id`,
      [firstReceptionId],
    );
    expect(oldReception.rows[0]).toMatchObject({
      state: "expired",
      confirmation_deadline: null,
      active_allocations: "0",
    });
  });

  it("subtracts an effective leave from the published base shift", async () => {
    const leaveStart = new Date(slotStart.getTime() + 4 * 60 * 60 * 1000);
    await database.pool.query(
      `INSERT INTO resource_restrictions (
         store_id, resource_id, restriction_kind, start_at, end_at
       ) VALUES ($1, $2, 'leave', $3, $4)`,
      [
        storeId,
        therapistId,
        leaveStart,
        new Date(leaveStart.getTime() + 60 * 60 * 1000),
      ],
    );

    const response = await queryAvailability(leaveStart);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      reason: "所选时间或资源当前不可用",
    });
  });

  it("rejects a missing service and store fallback instead of assuming zero", async () => {
    await database.pool.query(
      "UPDATE stores SET default_facility_cleanup_minutes = NULL WHERE id = $1",
      [storeId],
    );
    try {
      const response = await queryAvailability(slotStart);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("BOOKING_CONFIG_INCOMPLETE");
    } finally {
      await database.pool.query(
        "UPDATE stores SET default_facility_cleanup_minutes = 20 WHERE id = $1",
        [storeId],
      );
    }
  });

  it("rejects a configured normal occupancy longer than 24 hours", async () => {
    const longService = await database.pool.query<{ id: string }>(
      `INSERT INTO service_items (
         store_id, name, duration_minutes, price_cents
       ) VALUES ($1, $2, 1441, 100)
       RETURNING id`,
      [storeId, `超长测试项目-${suffix}`],
    );
    await database.pool.query(
      `INSERT INTO therapist_service_items (
         store_id, therapist_resource_id, service_item_id
       ) VALUES ($1, $2, $3)`,
      [storeId, therapistId, longService.rows[0]!.id],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        storeId,
        assignments: [assignment(slotStart, longService.rows[0]!.id)],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("INVALID_SERVICE_DURATION_CONFIG");
  });
});
