import { request, type StaffUser } from "./api";

export type ReceptionState =
  "pending" | "confirmed" | "expired" | "invalidated" | "cancelled";
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
export interface ReceptionAccess {
  user: StaffUser;
  canConfirm: boolean;
  canReadPayments: boolean;
  serverNow: string;
}
export interface ReceptionList extends ReceptionAccess {
  items: ReceptionRecord[];
  total: number;
  nextCursor: string | null;
  therapists: Array<{ id: string; name: string }>;
}
export interface ReceptionQuery {
  serviceDate: string;
  state?: ReceptionState;
  therapistId?: string;
  receptionId?: string;
  after?: string;
}
export function getReceptions(query: ReceptionQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value) params.set(key, value);
  return request<ReceptionList>(`/api/v1/admin/receptions?${params}`);
}
export function getReception(receptionId: string) {
  return request<ReceptionAccess & { item: ReceptionRecord }>(
    `/api/v1/admin/receptions/${encodeURIComponent(receptionId)}`,
  );
}
export const receptionStateLabels: Record<ReceptionState, string> = {
  pending: "待确认",
  confirmed: "已确认",
  expired: "已过期",
  invalidated: "已失效",
  cancelled: "已取消",
};
export function receptionTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
