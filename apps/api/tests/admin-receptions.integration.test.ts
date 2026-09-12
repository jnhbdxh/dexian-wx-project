import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import type { ReceptionRecord } from "../src/modules/operations/receptions.js";
import { createAdminReceptionFixture } from "./helpers/admin-receptions-fixture.js";

function day(value: Date) {
  return new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
describe("admin reception list and detail integration", () => {
  let database: ReturnType<typeof createDatabase>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fixture: Awaited<ReturnType<typeof createAdminReceptionFixture>>;
  const created: string[] = [];
  async function hold(offsetHours: number) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${fixture.customerToken}` },
      payload: {
        storeId: fixture.storeId,
        assignments: [
          {
            clientGuestId: "guest-1",
            serviceItemId: fixture.serviceId,
            therapistResourceId: fixture.therapistId,
            serviceStartAt: new Date(
              fixture.start.getTime() + offsetHours * 3600000,
            ).toISOString(),
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().available).toBe(true);
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${fixture.customerToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: { candidateToken: response.json().candidateToken },
    });
    expect(result.statusCode, result.body).toBe(201);
    created.push(result.json().receptionId);
    return result.json().receptionId as string;
  }
  async function detail(id: string, headers = fixture.manager.headers) {
    return app.inject({
      method: "GET",
      url: `/api/v1/admin/receptions/${id}`,
      headers,
    });
  }
  beforeAll(async () => {
    database = createDatabase(loadConfig());
    fixture = await createAdminReceptionFixture(database);
    app = await buildApp({ config: loadConfig(), database, logger: false });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (fixture) await fixture.cleanup();
    if (database) await database.pool.end();
  });

  it("runs customer create → admin query/confirm → customer read, and preserves resource segments", async () => {
    const id = await hold(0);
    for (const date of [
      day(fixture.start),
      day(new Date(fixture.start.getTime() + 86400000)),
    ]) {
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/admin/receptions?serviceDate=${date}&state=pending&therapistId=${fixture.therapistId}&receptionId=${id}`,
        headers: fixture.manager.headers,
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().total).toBe(1);
      expect(list.json().items[0].receptionId).toBe(id);
    }
    const result = await detail(id);
    expect(result.statusCode, result.body).toBe(200);
    const item = result.json().item as ReceptionRecord;
    expect(new Set(item.allocations.map((a) => a.segmentKind))).toEqual(
      new Set(["prepare", "service", "cleanup", "rest"]),
    );
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/admin/receptions/${id}/confirm`,
      headers: {
        ...fixture.manager.headers,
        "idempotency-key": randomUUID(),
        "if-match": '"1"',
        "x-initiating-staff-user-id": fixture.manager.staffId,
        "x-initiating-store-id": fixture.storeId,
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((await detail(id)).json().item.state).toBe("confirmed");
    const customer = await app.inject({
      method: "GET",
      url: `/api/v1/receptions/${id}`,
      headers: { authorization: `Bearer ${fixture.customerToken}` },
    });
    expect(customer.statusCode, customer.body).toBe(200);
    expect(customer.json().state).toBe("confirmed");
    expect(customer.body).not.toContain("roomName");
    expect(customer.body).not.toContain("maskedPhone");
  });
  it("treats expired pending rows consistently without a cleanup worker, including zero-match totals", async () => {
    const id = await hold(3);
    await database.pool.query(
      "UPDATE receptions SET confirmation_deadline=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    await database.pool.query(
      "UPDATE resource_allocations SET expires_at=now()-interval '1 second' WHERE reception_id=$1",
      [id],
    );
    const date = day(new Date(fixture.start.getTime() + 3 * 3600000));
    for (const [state, expected] of [
      ["pending", 0],
      ["expired", 1],
    ] as const) {
      const result = await app.inject({
        method: "GET",
        url: `/api/v1/admin/receptions?serviceDate=${date}&state=${state}&receptionId=${id}`,
        headers: fixture.manager.headers,
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().total).toBe(expected);
      expect(result.json().items).toHaveLength(expected);
    }
    const expired = (await detail(id)).json().item as ReceptionRecord;
    expect(expired.state).toBe("expired");
    expect(expired.allocations.every((a) => a.state === "inactive")).toBe(true);
    expect(
      (
        await database.pool.query("SELECT state FROM receptions WHERE id=$1", [
          id,
        ])
      ).rows[0].state,
    ).toBe("pending");
    const customer = await app.inject({
      method: "GET",
      url: `/api/v1/receptions/${id}`,
      headers: { authorization: `Bearer ${fixture.customerToken}` },
    });
    expect(customer.json().state).toBe("expired");
  });
  it("reflects real leave invalidation and confirmed conflicts without exposing private reasons", async () => {
    const pending = await hold(6);
    const confirmed = created[0]!;
    const leave = await app.inject({
      method: "POST",
      url: "/api/v1/admin/leaves",
      headers: { ...fixture.manager.headers, "idempotency-key": randomUUID() },
      payload: {
        therapistResourceId: fixture.therapistId,
        startAt: fixture.start.toISOString(),
        endAt: new Date(fixture.start.getTime() + 8 * 3600000).toISOString(),
        reasonPrivate: "内部原因不得公开",
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
      },
    });
    expect(leave.statusCode, leave.body).toBe(201);
    expect((await detail(pending)).json().item.state).toBe("invalidated");
    const conflict = await detail(confirmed);
    expect(conflict.json().item.conflicts).toHaveLength(1);
    expect(conflict.body).not.toContain("内部原因不得公开");
    const customer = await app.inject({
      method: "GET",
      url: `/api/v1/receptions/${pending}`,
      headers: { authorization: `Bearer ${fixture.customerToken}` },
    });
    expect(customer.json().state).toBe("invalidated");
    expect(customer.body).not.toContain("内部原因不得公开");
  });
  it("distinguishes authentication, missing permission, foreign store and nonexistent record", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/admin/receptions/${created[0]}`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await detail(created[0]!, fixture.denied.headers)).json().code,
    ).toBe("PERMISSION_DENIED");
    expect((await detail(randomUUID())).statusCode).toBe(404);
    const foreign = randomUUID();
    const id = randomUUID();
    await database.pool.query(
      "INSERT INTO stores (id,name) VALUES ($1,'其他测试门店')",
      [foreign],
    );
    try {
      await database.pool.query(
        "INSERT INTO receptions (id,store_id,customer_id,state,quote_cents) VALUES ($1,$2,$3,'invalidated',0)",
        [id, foreign, fixture.customerId],
      );
      const result = await detail(id);
      expect(result.statusCode).toBe(403);
      expect(result.json().code).toBe("RECEPTION_STORE_FORBIDDEN");
      expect(result.body).not.toContain(foreign);
    } finally {
      await database.pool.query("DELETE FROM receptions WHERE id=$1", [id]);
      await database.pool.query("DELETE FROM stores WHERE id=$1", [foreign]);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/receptions?serviceDate=2026-02-30",
          headers: fixture.manager.headers,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("gates payment data, masks only the active verified phone and never invents a phone", async () => {
    const id = created[0]!;
    const verification = randomUUID();
    const order = randomUUID();
    expect((await detail(id)).json().item.maskedPhone).toBeNull();
    const phone = `139${String(Math.floor(Math.random() * 100000000)).padStart(8, "0")}`;
    await database.pool.query(
      "INSERT INTO sms_verifications (id,customer_id,phone,purpose,code_hash,attempts_remaining,expires_at,next_send_at) VALUES ($1,$2,$3,'bind_phone','test',5,now()+interval '1 hour',now())",
      [verification, fixture.customerId, phone],
    );
    await database.pool.query(
      "INSERT INTO customer_phone_bindings (customer_id,phone,verification_id,verified_at) VALUES ($1,$2,$3,now())",
      [fixture.customerId, phone, verification],
    );
    await database.pool.query(
      "INSERT INTO orders (id,store_id,customer_id,reception_id,payable_cents,quote_snapshot,collection_deadline) VALUES ($1,$2,$3,$4,9500,'{}',now()+interval '1 day')",
      [order, fixture.storeId, fixture.customerId, id],
    );
    await database.pool.query(
      "INSERT INTO payment_transactions (id,order_id,state,out_trade_no,amount_cents,payer_open_id) VALUES ($1,$2,'manual_review',$3,9500,'test-payer')",
      [randomUUID(), order, randomUUID()],
    );
    const allowed = await detail(id);
    expect(allowed.json().item.payments[0].state).toBe("manual_review");
    expect(allowed.json().item.maskedPhone).toBe(`139****${phone.slice(-4)}`);
    expect(allowed.body).not.toContain(phone);
    const limited = await detail(id, fixture.reader.headers);
    expect(limited.json().item.payments).toBeNull();
    expect(limited.json().canConfirm).toBe(false);
    expect(limited.body).not.toContain("manual_review");
  });
  it("paginates a stable service-start/id order and excludes pure midnight preparation", async () => {
    const start = new Date(fixture.start.getTime() + 48 * 3600000);
    start.setUTCHours(16, 0, 0, 0);
    for (let i = 0; i < 27; i++) {
      const id = randomUUID();
      await database.pool.query(
        "INSERT INTO receptions (id,store_id,customer_id,state,quote_cents) VALUES ($1,$2,$3,'invalidated',9500)",
        [id, fixture.storeId, fixture.customerId],
      );
      await database.pool.query(
        `INSERT INTO reception_guests (store_id,reception_id,client_guest_id,service_item_id,therapist_resource_id,room_resource_id,bed_resource_id,
        service_start_at,service_end_at,quote_cents,service_config_version,store_config_version,duration_minutes_snapshot,prepare_minutes_snapshot,
        therapist_cleanup_minutes_snapshot,facility_cleanup_minutes_snapshot,rest_minutes_snapshot,rule_snapshot)
        VALUES ($1,$2,'guest-1',$3,$4,$5,$6,$7,$8,9500,1,1,60,10,5,15,20,'{}')`,
        [
          fixture.storeId,
          id,
          fixture.serviceId,
          fixture.therapistId,
          fixture.roomId,
          fixture.bedId,
          start,
          new Date(start.getTime() + 3600000),
        ],
      );
    }
    const base = `/api/v1/admin/receptions?serviceDate=${day(start)}&state=invalidated`;
    const first = await app.inject({
      method: "GET",
      url: base,
      headers: fixture.manager.headers,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().total).toBe(27);
    expect(first.json().items).toHaveLength(25);
    const second = await app.inject({
      method: "GET",
      url: `${base}&after=${first.json().nextCursor}`,
      headers: fixture.manager.headers,
    });
    expect(second.json().total).toBe(27);
    expect(second.json().items).toHaveLength(2);
    expect(second.json().nextCursor).toBeNull();
    const ids = [...first.json().items, ...second.json().items].map(
      (r: ReceptionRecord) => r.receptionId,
    );
    expect(new Set(ids).size).toBe(27);
    const prior = await app.inject({
      method: "GET",
      url: `/api/v1/admin/receptions?serviceDate=${day(new Date(start.getTime() - 86400000))}&state=invalidated`,
      headers: fixture.manager.headers,
    });
    expect(
      prior
        .json()
        .items.some((r: ReceptionRecord) => ids.includes(r.receptionId)),
    ).toBe(false);
  });
});
