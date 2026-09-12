import type { Database } from "../../db/client.js";
import { readSnapshot, validateServiceDate } from "./receptions.js";

export type CalendarResourceType = "therapist" | "room" | "bed" | "equipment";

export interface ResourceCalendar {
  serverNow: string;
  serviceDate: string;
  timeZone: "Asia/Shanghai";
  resources: Array<{
    id: string;
    parentResourceId: string | null;
    name: string;
    resourceType: CalendarResourceType;
    active: boolean;
  }>;
  shifts: Array<{
    id: string;
    therapistResourceId: string;
    startAt: string;
    endAt: string;
  }>;
  restrictions: Array<{
    id: string;
    resourceId: string | null;
    resourceName: string | null;
    resourceType: CalendarResourceType | null;
    kind:
      | "leave"
      | "meal_break"
      | "training"
      | "store_closed"
      | "equipment_fault"
      | "other_unavailable";
    startAt: string;
    endAt: string;
  }>;
  allocations: Array<{
    id: string;
    resourceId: string;
    receptionId: string;
    guestId: string | null;
    customerName: string;
    serviceItemName: string | null;
    receptionState: "pending" | "confirmed";
    confirmationDeadline: string | null;
    segmentKind: "prepare" | "service" | "cleanup" | "rest";
    startAt: string;
    endAt: string;
    expiresAt: string | null;
    hasConflict: boolean;
  }>;
}

interface ResourceRow {
  id: string;
  parent_resource_id: string | null;
  name: string;
  resource_type: CalendarResourceType;
  active: boolean;
}

interface ShiftRow {
  id: string;
  therapist_resource_id: string;
  start_at: Date;
  end_at: Date;
}

interface RestrictionRow {
  id: string;
  resource_id: string | null;
  resource_name: string | null;
  resource_type: CalendarResourceType | null;
  restriction_kind: ResourceCalendar["restrictions"][number]["kind"];
  start_at: Date;
  end_at: Date;
}

interface AllocationRow {
  id: string;
  resource_id: string;
  reception_id: string;
  reception_guest_id: string | null;
  customer_name: string;
  service_item_name: string | null;
  reception_state: "pending" | "confirmed";
  confirmation_deadline: Date | null;
  segment_kind: ResourceCalendar["allocations"][number]["segmentKind"];
  start_at: Date;
  end_at: Date;
  expires_at: Date | null;
  has_conflict: boolean;
}

export async function getResourceCalendar(
  database: Database,
  storeId: string,
  serviceDate: string,
): Promise<ResourceCalendar> {
  validateServiceDate(serviceDate);
  return readSnapshot(database, async (client, now) => {
    const boundary = await client.query<{ start_at: Date; end_at: Date }>(
      `SELECT $1::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS start_at,
        (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS end_at`,
      [serviceDate],
    );
    const { start_at: startAt, end_at: endAt } = boundary.rows[0]!;
    const resources = await client.query<ResourceRow>(
      `SELECT id, parent_resource_id, name, resource_type, active
         FROM resources WHERE store_id = $1
         ORDER BY CASE resource_type WHEN 'therapist' THEN 1 WHEN 'room' THEN 2
           WHEN 'bed' THEN 3 ELSE 4 END, name, id`,
      [storeId],
    );
    const shifts = await client.query<ShiftRow>(
      `SELECT id, therapist_resource_id, start_at, end_at
         FROM resource_shifts
         WHERE store_id = $1 AND published = true AND start_at < $3 AND end_at > $2
         ORDER BY start_at, end_at, id`,
      [storeId, startAt, endAt],
    );
    const restrictions = await client.query<RestrictionRow>(
      `SELECT restriction.id, restriction.resource_id, resource.name AS resource_name,
           resource.resource_type, restriction.restriction_kind,
           restriction.start_at, restriction.end_at
         FROM resource_restrictions restriction
         LEFT JOIN resources resource ON resource.store_id = restriction.store_id
           AND resource.id = restriction.resource_id
         WHERE restriction.store_id = $1 AND restriction.active = true
           AND restriction.start_at < $3 AND restriction.end_at > $2
         ORDER BY restriction.start_at, restriction.end_at, restriction.id`,
      [storeId, startAt, endAt],
    );
    const allocations = await client.query<AllocationRow>(
      `SELECT allocation.id, allocation.resource_id, allocation.reception_id,
           allocation.reception_guest_id,
           coalesce(nullif(trim(customer.display_name), ''), '未留姓名') AS customer_name,
           coalesce(guest.service_item_name_snapshot, service.name) AS service_item_name,
           reception.state AS reception_state,
           reception.confirmation_deadline, allocation.segment_kind,
           allocation.start_at, allocation.end_at, allocation.expires_at,
           EXISTS (
             SELECT 1 FROM resource_conflicts conflict
             WHERE conflict.store_id = allocation.store_id
               AND conflict.reception_id = allocation.reception_id
               AND conflict.resource_id = allocation.resource_id
               AND conflict.status = 'pending'
           ) AS has_conflict
         FROM resource_allocations allocation
         JOIN receptions reception ON reception.store_id = allocation.store_id
           AND reception.id = allocation.reception_id
         JOIN customers customer ON customer.id = reception.customer_id
         LEFT JOIN reception_guests guest ON guest.store_id = allocation.store_id
           AND guest.reception_id = allocation.reception_id
           AND guest.id = allocation.reception_guest_id
         LEFT JOIN service_items service ON service.store_id = guest.store_id
           AND service.id = guest.service_item_id
         WHERE allocation.store_id = $1
           AND allocation.start_at < $3 AND allocation.end_at > $2
           AND (
             (allocation.allocation_state = 'confirmed' AND reception.state = 'confirmed')
             OR (
               allocation.allocation_state = 'held' AND reception.state = 'pending'
               AND allocation.expires_at > $4 AND reception.confirmation_deadline > $4
             )
           )
         ORDER BY allocation.start_at, allocation.end_at, allocation.id`,
      [storeId, startAt, endAt, now],
    );

    return {
      serverNow: now.toISOString(),
      serviceDate,
      timeZone: "Asia/Shanghai",
      resources: resources.rows.map((row) => ({
        id: row.id,
        parentResourceId: row.parent_resource_id,
        name: row.name,
        resourceType: row.resource_type,
        active: row.active,
      })),
      shifts: shifts.rows.map((row) => ({
        id: row.id,
        therapistResourceId: row.therapist_resource_id,
        startAt: row.start_at.toISOString(),
        endAt: row.end_at.toISOString(),
      })),
      restrictions: restrictions.rows.map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        resourceName: row.resource_name,
        resourceType: row.resource_type,
        kind: row.restriction_kind,
        startAt: row.start_at.toISOString(),
        endAt: row.end_at.toISOString(),
      })),
      allocations: allocations.rows.map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        receptionId: row.reception_id,
        guestId: row.reception_guest_id,
        customerName: row.customer_name,
        serviceItemName: row.service_item_name,
        receptionState: row.reception_state,
        confirmationDeadline: row.confirmation_deadline?.toISOString() ?? null,
        segmentKind: row.segment_kind,
        startAt: row.start_at.toISOString(),
        endAt: row.end_at.toISOString(),
        expiresAt: row.expires_at?.toISOString() ?? null,
        hasConflict: row.has_conflict,
      })),
    };
  });
}
