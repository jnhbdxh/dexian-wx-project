import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import type { ResourceCalendar } from "../src/modules/operations/resource-calendar.js";
import { createAdminReceptionFixture } from "./helpers/admin-receptions-fixture.js";

function shanghaiDay(value: Date) {
  return new Date(value.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

describe("admin resource calendar integration", () => {
  let database: ReturnType<typeof createDatabase>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fixture: Awaited<ReturnType<typeof createAdminReceptionFixture>>;
  let receptionId: string;
  let equipmentId: string;
  let roomRestrictionId: string;

  async function hold(offsetHours = 0) {
    const availability = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${fixture.customerToken}` },
      payload: {
        storeId: fixture.storeId,
        assignments: [
          {
            clientGuestId: `guest-${offsetHours}`,
            serviceItemId: fixture.serviceId,
            therapistResourceId: fixture.therapistId,
            serviceStartAt: new Date(
              fixture.start.getTime() + offsetHours * 60 * 60_000,
            ).toISOString(),
          },
        ],
      },
    });
    expect(availability.statusCode, availability.body).toBe(200);
    expect(availability.json().available).toBe(true);
    const reception = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${fixture.customerToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: { candidateToken: availability.json().candidateToken },
    });
    expect(reception.statusCode, reception.body).toBe(201);
    return reception.json().receptionId as string;
  }

  async function calendar(date: string, headers = fixture.reader.headers) {
    return app.inject({
      method: "GET",
      url: `/api/v1/admin/resource-calendar?serviceDate=${date}`,
      headers,
    });
  }

  beforeAll(async () => {
    database = createDatabase(loadConfig());
    fixture = await createAdminReceptionFixture(database);
    app = await buildApp({ config: loadConfig(), database, logger: false });
    receptionId = await hold();
    const confirmation = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${receptionId}/confirm`,
      headers: {
        ...fixture.manager.headers,
        "idempotency-key": randomUUID(),
        "if-match": '"1"',
        "x-initiating-staff-user-id": fixture.manager.staffId,
        "x-initiating-store-id": fixture.storeId,
      },
    });
    expect(confirmation.statusCode, confirmation.body).toBe(200);

    equipmentId = randomUUID();
    await database.pool.query(
      "INSERT INTO resources (id,store_id,resource_type,name) VALUES ($1,$2,'equipment','热石仪')",
      [equipmentId, fixture.storeId],
    );
    const roomRestriction = await database.pool.query<{ id: string }>(
      `INSERT INTO resource_restrictions
        (store_id,resource_id,restriction_kind,start_at,end_at,reason_private)
       VALUES ($1,$2,'other_unavailable',$3,$4,'房间内部维修说明') RETURNING id`,
      [
        fixture.storeId,
        fixture.roomId,
        new Date(fixture.start.getTime() - 30 * 60_000),
        new Date(fixture.start.getTime() + 90 * 60_000),
      ],
    );
    roomRestrictionId = roomRestriction.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO resource_restrictions
        (store_id,resource_id,restriction_kind,start_at,end_at,reason_private)
       VALUES ($1,$2,'equipment_fault',$3,$4,'设备内部故障说明'),
        ($1,NULL,'store_closed',$3,$4,'闭店内部原因')`,
      [
        fixture.storeId,
        equipmentId,
        new Date(fixture.start.getTime() - 60 * 60_000),
        new Date(fixture.start.getTime() + 2 * 60 * 60_000),
      ],
    );
    await database.pool.query(
      `INSERT INTO resource_conflicts
        (store_id,resource_id,restriction_id,reception_id)
       VALUES ($1,$2,$3,$4)`,
      [fixture.storeId, fixture.roomId, roomRestrictionId, receptionId],
    );
  });

  afterAll(async () => {
    if (app) await app.close();
    if (fixture) await fixture.cleanup();
    if (database) await database.pool.end();
  });

  it("returns real resource segments, hierarchy, shifts and restriction scopes without private reasons", async () => {
    const firstDay = shanghaiDay(fixture.start);
    const response = await calendar(firstDay);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ResourceCalendar & {
      user: { id: string; storeId: string };
    };

    expect(body.user).toMatchObject({
      id: fixture.reader.staffId,
      storeId: fixture.storeId,
    });
    expect(body.serviceDate).toBe(firstDay);
    expect(body.timeZone).toBe("Asia/Shanghai");
    expect(body.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.bedId,
          parentResourceId: fixture.roomId,
          resourceType: "bed",
        }),
        expect.objectContaining({
          id: equipmentId,
          resourceType: "equipment",
        }),
      ]),
    );
    expect(
      body.shifts.some(
        (shift) => shift.therapistResourceId === fixture.therapistId,
      ),
    ).toBe(true);
    const nextDayBody = (
      await calendar(
        shanghaiDay(new Date(fixture.start.getTime() + 24 * 60 * 60_000)),
      )
    ).json() as ResourceCalendar;
    expect(
      new Set(
        [...body.allocations, ...nextDayBody.allocations].map(
          (item) => item.segmentKind,
        ),
      ),
    ).toEqual(new Set(["prepare", "service", "cleanup", "rest"]));
    expect(
      body.allocations.some(
        (item) =>
          item.resourceId === fixture.roomId && item.hasConflict === true,
      ),
    ).toBe(true);
    expect(
      body.allocations.some((item) => item.resourceId === fixture.bedId),
    ).toBe(true);
    expect(body.restrictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: fixture.roomId,
          kind: "other_unavailable",
        }),
        expect.objectContaining({
          resourceId: equipmentId,
          resourceName: "热石仪",
          kind: "equipment_fault",
        }),
        expect.objectContaining({ resourceId: null, kind: "store_closed" }),
      ]),
    );
    expect(response.body).not.toContain("内部");
  });

  it("uses the reception name snapshot after the catalog name changes", async () => {
    await database.pool.query(
      "UPDATE service_items SET name='已改名护理' WHERE id=$1",
      [fixture.serviceId],
    );
    try {
      const body = (
        await calendar(shanghaiDay(fixture.start))
      ).json() as ResourceCalendar;
      const guestAllocations = body.allocations.filter(
        (item) => item.receptionId === receptionId && item.guestId,
      );
      expect(guestAllocations.length).toBeGreaterThan(0);
      expect(
        guestAllocations.every((item) => item.serviceItemName === "舒缓护理"),
      ).toBe(true);
    } finally {
      await database.pool.query(
        "UPDATE service_items SET name='舒缓护理' WHERE id=$1",
        [fixture.serviceId],
      );
    }
  });

  it("shows a cross-midnight service on both data dates and excludes expired holds", async () => {
    const firstDay = shanghaiDay(fixture.start);
    const nextDay = shanghaiDay(
      new Date(fixture.start.getTime() + 24 * 60 * 60_000),
    );
    for (const date of [firstDay, nextDay]) {
      const body = (await calendar(date)).json() as ResourceCalendar;
      expect(
        body.allocations.some((item) => item.receptionId === receptionId),
      ).toBe(true);
    }

    const expiredId = await hold(4);
    await database.pool.query(
      "UPDATE receptions SET confirmation_deadline=now()-interval '1 second' WHERE id=$1",
      [expiredId],
    );
    await database.pool.query(
      "UPDATE resource_allocations SET expires_at=now()-interval '1 second' WHERE reception_id=$1",
      [expiredId],
    );
    const body = (
      await calendar(
        shanghaiDay(new Date(fixture.start.getTime() + 4 * 60 * 60_000)),
      )
    ).json() as ResourceCalendar;
    expect(
      body.allocations.some((item) => item.receptionId === expiredId),
    ).toBe(false);
  });

  it("rejects invalid dates and enforces authentication and permission", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/resource-calendar?serviceDate=2026-09-11",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await calendar(shanghaiDay(fixture.start), fixture.denied.headers)
      ).json().code,
    ).toBe("PERMISSION_DENIED");
    const invalid = await calendar("2026-02-30");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("INVALID_SERVICE_DATE");
  });
});
