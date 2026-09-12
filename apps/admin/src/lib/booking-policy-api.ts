import { request, type StaffUser } from "./api";

export interface PolicyInterval {
  startMinute: number;
  endMinute: number;
  endDayOffset: 0 | 1;
}

export interface BookingPolicyPayloadV1 {
  maxAdvanceDays: number;
  minimumLeadMinutes: number;
  startGridMinutes: number;
  weeklyRules: Array<{ weekday: number; intervals: PolicyInterval[] }>;
  dateExceptions: Array<{
    serviceDate: string;
    kind: "closed" | "replace";
    intervals: PolicyInterval[];
  }>;
}

export interface BookingPolicyPayloadV2 extends BookingPolicyPayloadV1 {
  version: 2;
  onlineHoldMinutes: number;
  onsiteHoldMinutes: number;
  processingWeeklyRules: Array<{
    weekday: number;
    intervals: PolicyInterval[];
  }>;
  processingDateExceptions: Array<{
    serviceDate: string;
    kind: "closed" | "replace";
    intervals: PolicyInterval[];
  }>;
}

export type BookingPolicyPayload =
  BookingPolicyPayloadV1 | BookingPolicyPayloadV2;

export function isBookingPolicyV2(
  payload: BookingPolicyPayload,
): payload is BookingPolicyPayloadV2 {
  return "version" in payload && payload.version === 2;
}

export interface BookingPolicyRevision {
  id: string;
  kind: "draft" | "published";
  sourceDraftRevisionId: string | null;
  publishedVersion: number | null;
  basePublishedVersion: number | null;
  payload: BookingPolicyPayload;
  createdByStaffId: string;
  createdByName: string;
  changeReason: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface BookingPolicyWorkspace {
  user: StaffUser;
  canEdit: boolean;
  canPublish: boolean;
  serverNow: string;
  store: {
    id: string;
    name: string;
    timeZone: string;
    bookingCreationMode:
      "legacy" | "paused_for_policy_activation" | "policy_enforced";
  };
  published: BookingPolicyRevision | null;
  latestDraft: BookingPolicyRevision | null;
}

export interface PolicyIdentity {
  initiatingStaffUserId: string;
  initiatingStoreId: string;
}

export interface SavePolicyDraftInput extends PolicyIdentity {
  basePublishedVersion: number | null;
  payload: BookingPolicyPayloadV2;
}

export interface PublishPolicyInput extends PolicyIdentity {
  draftRevisionId: string;
  basePublishedVersion: number | null;
  changeReason: string;
}

export interface PolicyPreview {
  user: StaffUser;
  evaluatedAt: string;
  draftRevisionId: string;
  basePublishedVersion: number | null;
  currentPublishedVersion: number | null;
  canPublish: boolean;
  changes: Array<{
    field:
      | "maxAdvanceDays"
      | "minimumLeadMinutes"
      | "startGridMinutes"
      | "onlineHoldMinutes"
      | "onsiteHoldMinutes"
      | "weeklyRules"
      | "dateExceptions"
      | "processingWeeklyRules"
      | "processingDateExceptions";
    label: string;
    previous: string;
    next: string;
  }>;
  expandedDays: Array<{
    serviceDate: string;
    status: "open" | "closed";
    sources: Array<"weekly" | "previous_day_carry" | "date_exception">;
    intervals: Array<{ startAt: string; endAt: string }>;
    processingStatus: "open" | "closed";
    processingSources: Array<
      "weekly" | "previous_day_carry" | "date_exception"
    >;
    processingIntervals: Array<{ startAt: string; endAt: string }>;
    effectiveProcessingIntervals: Array<{
      startAt: string;
      endAt: string;
    }>;
  }>;
  impacts: Array<{
    receptionId: string;
    guestId: string;
    state: "pending" | "confirmed";
    customerName: string;
    serviceItemName: string;
    serviceStartAt: string;
    serviceEndAt: string;
    reasonCode:
      | "OUTSIDE_BUSINESS_HOURS"
      | "CLOSED_BY_DATE_EXCEPTION"
      | "TRUNCATED_BY_DATE_EXCEPTION";
  }>;
}

export function getBookingPolicyWorkspace() {
  return request<BookingPolicyWorkspace>("/api/v1/admin/booking-policy");
}

export function saveBookingPolicyDraft(
  input: SavePolicyDraftInput,
  idempotencyKey: string,
) {
  return request<{ draftRevisionId: string; createdAt: string }>(
    "/api/v1/admin/booking-policy/drafts",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    },
  );
}

export function previewBookingPolicy(draftRevisionId: string) {
  return request<PolicyPreview>("/api/v1/admin/booking-policy/preview", {
    method: "POST",
    body: JSON.stringify({ draftRevisionId }),
  });
}

export function publishBookingPolicy(
  input: PublishPolicyInput,
  idempotencyKey: string,
) {
  return request<{
    publishedRevisionId: string;
    publishedVersion: number;
    publishedAt: string;
  }>("/api/v1/admin/booking-policy/publish", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function setBookingPolicyActivation(
  action: "pause" | "resume-legacy",
  identity: PolicyIdentity,
  idempotencyKey: string,
) {
  return request<{
    bookingCreationMode: BookingPolicyWorkspace["store"]["bookingCreationMode"];
  }>(`/api/v1/admin/booking-policy/activation/${action}`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(identity),
  });
}

export function getBookingPolicyVersions(after?: string) {
  return request<{
    user: StaffUser;
    items: BookingPolicyRevision[];
    nextCursor: string | null;
  }>(
    `/api/v1/admin/booking-policy/versions${after ? `?after=${encodeURIComponent(after)}` : ""}`,
  );
}
