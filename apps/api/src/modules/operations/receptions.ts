import type { PoolClient } from "pg";

import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/app-error.js";

export type ReceptionState =
  "pending" | "confirmed" | "expired" | "invalidated" | "cancelled";
export interface ReceptionFilter {
  serviceDate: string;
  state?: ReceptionState;
  therapistId?: string;
  receptionId?: string;
  after?: string;
}

// All reads in a response share one snapshot and one decision time, including totals.
export async function readSnapshot<T>(
  database: Database,
  read: (client: PoolClient, now: Date) => Promise<T>,
) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const clock = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const result = await read(client, clock.rows[0]!.now);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function validateServiceDate(serviceDate: string) {
  const parsed = new Date(`${serviceDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== serviceDate
  ) {
    throw new AppError(400, "INVALID_SERVICE_DATE", "请选择有效的服务日期");
  }
}

export interface ReceptionRecord {
  receptionId: string;
  customerName: string;
  maskedPhone: string | null;
  state: ReceptionState;
  confirmationDeadline: string | null;
  quoteCents: string;
  version: number;
  createdAt: string;
  serviceStartAt: string;
  serviceEndAt: string;
  guests: Array<{
    id: string;
    serviceItemName: string;
    therapistName: string;
    roomName: string;
    bedName: string;
    serviceStartAt: string;
    serviceEndAt: string;
    quoteCents: string;
  }>;
  allocations: Array<{
    id: string;
    guestId: string | null;
    resourceId: string;
    resourceName: string;
    resourceType: string;
    segmentKind: "prepare" | "service" | "cleanup" | "rest";
    state: "held" | "confirmed" | "inactive";
    startAt: string;
    endAt: string;
  }>;
  conflicts: Array<{
    id: string;
    resourceName: string;
    kind: string;
    startAt: string;
    endAt: string;
  }>;
  payments: Array<{
    id: string;
    state: string;
    amountCents: string;
    collectionDeadline: string;
  }> | null;
}

async function readRecords(
  client: PoolClient,
  storeId: string,
  ids: string[],
  now: Date,
  canReadPayments: boolean,
) {
  const rows = await client.query<{ record: ReceptionRecord }>(
    `SELECT jsonb_build_object(
       'receptionId', r.id, 'customerName', coalesce(nullif(trim(c.display_name), ''), '未留姓名'),
       'maskedPhone', CASE WHEN phone.phone IS NULL THEN NULL
         ELSE left(phone.phone, 3) || '****' || right(phone.phone, 4) END,
       'state', CASE WHEN r.state = 'pending' AND r.confirmation_deadline <= $3
         THEN 'expired' ELSE r.state::text END,
       'confirmationDeadline', r.confirmation_deadline,
       'quoteCents', r.quote_cents::text, 'version', r.version, 'createdAt', r.created_at,
       'serviceStartAt', guests.start_at, 'serviceEndAt', guests.end_at, 'guests', guests.items,
       'allocations', coalesce(allocations.items, '[]'::jsonb),
       'conflicts', coalesce(conflicts.items, '[]'::jsonb),
       'payments', CASE WHEN $4::boolean THEN coalesce(payments.items, '[]'::jsonb) ELSE NULL END
     ) AS record
     FROM receptions r
     LEFT JOIN customers c ON c.id = r.customer_id
     LEFT JOIN customer_phone_bindings phone ON phone.customer_id = r.customer_id AND phone.revoked_at IS NULL
     JOIN LATERAL (
       SELECT min(g.service_start_at) start_at, max(g.service_end_at) end_at,
         jsonb_agg(jsonb_build_object(
           'id', g.id, 'serviceItemName', s.name, 'therapistName', t.name,
           'roomName', room.name, 'bedName', bed.name, 'serviceStartAt', g.service_start_at,
           'serviceEndAt', g.service_end_at, 'quoteCents', g.quote_cents::text
         ) ORDER BY g.service_start_at, g.id) items
       FROM reception_guests g
       JOIN service_items s ON s.id = g.service_item_id AND s.store_id = r.store_id
       JOIN resources t ON t.id = g.therapist_resource_id AND t.store_id = r.store_id
       JOIN resources room ON room.id = g.room_resource_id AND room.store_id = r.store_id
       JOIN resources bed ON bed.id = g.bed_resource_id AND bed.store_id = r.store_id
       WHERE g.reception_id = r.id AND g.store_id = r.store_id
     ) guests ON guests.items IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'id', a.id, 'guestId', a.reception_guest_id, 'resourceId', resource.id, 'resourceName', resource.name,
         'resourceType', resource.resource_type, 'segmentKind', a.segment_kind,
         'state', CASE WHEN a.allocation_state = 'held' AND a.expires_at <= $3 THEN 'inactive'
           ELSE a.allocation_state::text END, 'startAt', a.start_at, 'endAt', a.end_at
       ) ORDER BY resource.resource_type, resource.name, a.start_at, a.id) items
       FROM resource_allocations a JOIN resources resource ON resource.id = a.resource_id AND resource.store_id = r.store_id
       WHERE a.reception_id = r.id AND a.store_id = r.store_id
     ) allocations ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', conflict.id, 'resourceName', resource.name,
         'kind', restriction.restriction_kind, 'startAt', restriction.start_at, 'endAt', restriction.end_at)
         ORDER BY conflict.detected_at, conflict.id) items
       FROM resource_conflicts conflict
       JOIN resource_restrictions restriction ON restriction.id = conflict.restriction_id AND restriction.store_id = r.store_id
       JOIN resources resource ON resource.id = conflict.resource_id AND resource.store_id = r.store_id
       WHERE conflict.reception_id = r.id AND conflict.store_id = r.store_id AND conflict.status = 'pending'
     ) conflicts ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', p.id, 'state', p.state,
         'amountCents', p.amount_cents::text, 'collectionDeadline', o.collection_deadline)
         ORDER BY p.created_at, p.id) items
       FROM orders o JOIN payment_transactions p ON p.order_id = o.id
       WHERE $4::boolean AND o.reception_id = r.id AND o.store_id = r.store_id
     ) payments ON true
     WHERE r.store_id = $1 AND r.id = ANY($2::uuid[])
     ORDER BY guests.start_at, r.id`,
    [storeId, ids, now, canReadPayments],
  );
  return rows.rows.map((row) => row.record);
}

export async function listAdminReceptions(
  database: Database,
  storeId: string,
  filter: ReceptionFilter,
  canReadPayments: boolean,
) {
  validateServiceDate(filter.serviceDate);
  return readSnapshot(database, async (client, now) => {
    const params = [
      storeId,
      filter.serviceDate,
      now,
      filter.state ?? null,
      filter.therapistId ?? null,
      filter.receptionId ?? null,
    ];
    // Date membership uses an actual guest interval, not the gap between two guests.
    const filtered = `WITH filtered AS (
      SELECT r.id, (SELECT min(g.service_start_at) FROM reception_guests g WHERE g.reception_id = r.id) AS start_at
      FROM receptions r WHERE r.store_id = $1
        AND EXISTS (SELECT 1 FROM reception_guests g WHERE g.reception_id = r.id AND g.store_id = $1
          AND g.service_start_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND g.service_end_at > ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
        AND ($4::text IS NULL OR (CASE WHEN r.state = 'pending' AND r.confirmation_deadline <= $3
          THEN 'expired' ELSE r.state::text END) = $4)
        AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM reception_guests g WHERE g.reception_id = r.id AND g.therapist_resource_id = $5))
        AND ($6::uuid IS NULL OR r.id = $6)
    )`;
    const total = await client.query<{ total: string }>(
      `${filtered} SELECT count(*)::text total FROM filtered`,
      params,
    );
    let cursor: { id: string; start_at: Date } | undefined;
    if (filter.after) {
      const result = await client.query<{ id: string; start_at: Date }>(
        `${filtered} SELECT id, start_at FROM filtered WHERE id = $7::uuid`,
        [...params, filter.after],
      );
      cursor = result.rows[0];
      if (!cursor)
        throw new AppError(400, "INVALID_CURSOR", "列表已变化，请重新查询");
    }
    const page = await client.query<{ id: string }>(
      `${filtered}
      SELECT id FROM filtered WHERE ($7::timestamptz IS NULL OR (start_at, id) > ($7, $8::uuid))
      ORDER BY start_at, id LIMIT 26`,
      [...params, cursor?.start_at ?? null, cursor?.id ?? null],
    );
    const visible = page.rows.slice(0, 25);
    const items = await readRecords(
      client,
      storeId,
      visible.map((row) => row.id),
      now,
      canReadPayments,
    );
    const therapists = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM resources WHERE store_id = $1 AND resource_type = 'therapist' ORDER BY name, id",
      [storeId],
    );
    return {
      serverNow: now.toISOString(),
      total: Number(total.rows[0]!.total),
      items,
      nextCursor: page.rows.length > 25 ? visible.at(-1)!.id : null,
      therapists: therapists.rows,
    };
  });
}

export async function getAdminReception(
  database: Database,
  storeId: string,
  receptionId: string,
  canReadPayments: boolean,
) {
  return readSnapshot(database, async (client, now) => {
    const owner = await client.query<{ store_id: string }>(
      "SELECT store_id FROM receptions WHERE id = $1",
      [receptionId],
    );
    if (!owner.rows[0])
      throw new AppError(404, "RECEPTION_NOT_FOUND", "接待记录不存在");
    if (owner.rows[0].store_id !== storeId) {
      throw new AppError(
        403,
        "RECEPTION_STORE_FORBIDDEN",
        "当前账号不能查看其他门店的接待",
      );
    }
    const [item] = await readRecords(
      client,
      storeId,
      [receptionId],
      now,
      canReadPayments,
    );
    if (!item)
      throw new AppError(
        409,
        "RECEPTION_DETAILS_UNAVAILABLE",
        "接待明细不完整，请联系店长核实",
      );
    return { serverNow: now.toISOString(), item };
  });
}
