import { request, type StaffUser } from "./api";

export type CalendarResourceType = "therapist" | "room" | "bed" | "equipment";
export type CalendarSegmentKind = "prepare" | "service" | "cleanup" | "rest";
export type CalendarRestrictionKind =
  | "leave"
  | "meal_break"
  | "training"
  | "store_closed"
  | "equipment_fault"
  | "other_unavailable";

export interface CalendarResource {
  id: string;
  parentResourceId: string | null;
  name: string;
  resourceType: CalendarResourceType;
  active: boolean;
}

export interface CalendarShift {
  id: string;
  therapistResourceId: string;
  startAt: string;
  endAt: string;
}

export interface CalendarRestriction {
  id: string;
  resourceId: string | null;
  resourceName: string | null;
  resourceType: CalendarResourceType | null;
  kind: CalendarRestrictionKind;
  startAt: string;
  endAt: string;
}

export interface CalendarAllocation {
  id: string;
  resourceId: string;
  receptionId: string;
  guestId: string | null;
  customerName: string;
  serviceItemName: string | null;
  receptionState: "pending" | "confirmed";
  confirmationDeadline: string | null;
  segmentKind: CalendarSegmentKind;
  startAt: string;
  endAt: string;
  expiresAt: string | null;
  hasConflict: boolean;
}

export interface ResourceCalendar {
  user: StaffUser;
  serverNow: string;
  serviceDate: string;
  timeZone: "Asia/Shanghai";
  resources: CalendarResource[];
  shifts: CalendarShift[];
  restrictions: CalendarRestriction[];
  allocations: CalendarAllocation[];
}

export function getResourceCalendar(serviceDate: string) {
  const query = new URLSearchParams({ serviceDate });
  return request<ResourceCalendar>(`/api/v1/admin/resource-calendar?${query}`);
}
