interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  readonly name = "ApiRequestError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface StaffUser {
  id: string;
  storeId: string;
  username: string;
  displayName: string;
}

export interface PendingConfirmationGuest {
  id: string;
  clientGuestId: string;
  serviceItemName: string;
  therapistName: string;
  roomName: string;
  bedName: string;
  serviceStartAt: string;
  serviceEndAt: string;
  quoteCents: string;
}

export interface PendingConfirmation {
  receptionId: string;
  customerName: string;
  confirmationDeadline: string;
  quoteCents: string;
  version: number;
  createdAt: string;
  guests: PendingConfirmationGuest[];
}

export interface OperationsOverview {
  stage: "booking-confirmation";
  serverNow: string;
  canConfirmReceptions: boolean;
  pendingConfirmations: PendingConfirmation[];
}

export interface ConfirmReceptionIdentity {
  staffUserId: string;
  storeId: string;
}

export interface LeaveConflictGuest {
  id: string;
  serviceItemName: string;
  therapistName: string;
  roomName: string;
  bedName: string;
  serviceStartAt: string;
  serviceEndAt: string;
}

export interface LeaveConflict {
  conflictId: string;
  receptionId: string;
  detectedAt: string;
  customerName: string;
  therapistId: string;
  therapistName: string;
  leaveStartAt: string;
  leaveEndAt: string;
  reasonPrivate: string;
  guests: LeaveConflictGuest[];
}

export interface LeaveWorkbench {
  user: StaffUser;
  serverNow: string;
  canCreateLeave: boolean;
  therapists: Array<{ id: string; name: string }>;
  conflictTotal: number;
  conflicts: LeaveConflict[];
  nextCursor: string | null;
}

export interface CreateLeaveInput {
  therapistResourceId: string;
  startAt: string;
  endAt: string;
  reasonPrivate: string;
}

export interface CreateLeaveIdentity {
  staffUserId: string;
  storeId: string;
}

export interface CreateLeaveResult {
  restrictionId: string;
  state: "active";
  invalidatedPendingCount: number;
  affectedConfirmedCount: number;
  invalidatedReceptions: Array<{ receptionId: string }>;
  conflicts: Array<{ conflictId: string; receptionId: string }>;
}

export type PaymentState =
  | "created"
  | "processing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "manual_review";

export interface PaymentReviewItem {
  paymentId: string;
  receptionId: string;
  outTradeNo: string;
  state: PaymentState;
  customerName: string;
  amountCents: string;
  collectionDeadline: string;
  checkAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  nextCheckAt: string | null;
  updatedAt: string;
}

export interface PaymentReviewQueue {
  user: StaffUser;
  canReconcilePayments: boolean;
  channelConfigured: boolean;
  payments: PaymentReviewItem[];
  nextCursor: string | null;
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && init.body !== null) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfToken = readCookie("dexian_admin_csrf");
    if (csrfToken) headers.set("X-CSRF-Token", decodeURIComponent(csrfToken));
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    const error = (await response.json()) as ApiError;
    throw new ApiRequestError(
      response.status,
      error.code,
      error.message,
      error.requestId,
      error.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function login(username: string, password: string) {
  return request<{ user: StaffUser }>("/api/v1/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function getSession() {
  return request<{ user: StaffUser }>("/api/v1/admin/session");
}

export function getOperationsOverview() {
  return request<{
    user: StaffUser;
    overview: OperationsOverview;
  }>("/api/v1/admin/operations/overview");
}

export function confirmReception(
  receptionId: string,
  version: number,
  idempotencyKey: string,
  identity: ConfirmReceptionIdentity,
) {
  return request<{
    receptionId: string;
    state: "confirmed";
    version: number;
    quoteCents: string;
  }>(`/api/v1/admin/receptions/${receptionId}/confirm`, {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
      "If-Match": `"${version}"`,
      "X-Initiating-Staff-User-Id": identity.staffUserId,
      "X-Initiating-Store-Id": identity.storeId,
    },
  });
}

export function getLeaveWorkbench(afterConflictId?: string) {
  const query = afterConflictId
    ? `?afterConflictId=${encodeURIComponent(afterConflictId)}`
    : "";
  return request<LeaveWorkbench>(
    `/api/v1/admin/scheduling/leave-workbench${query}`,
  );
}

export function createLeave(
  input: CreateLeaveInput,
  idempotencyKey: string,
  identity: CreateLeaveIdentity,
) {
  return request<CreateLeaveResult>("/api/v1/admin/leaves", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      ...input,
      initiatingStaffUserId: identity.staffUserId,
      initiatingStoreId: identity.storeId,
    }),
  });
}

export function getPaymentReviewQueue(afterPaymentId?: string) {
  const query = afterPaymentId
    ? `?afterPaymentId=${encodeURIComponent(afterPaymentId)}`
    : "";
  return request<PaymentReviewQueue>(`/api/v1/admin/payments/review${query}`);
}

export function reconcilePayment(paymentId: string) {
  return request<PaymentReviewItem>(
    `/api/v1/admin/payments/${paymentId}/reconcile`,
    { method: "POST" },
  );
}

export function logout() {
  return request<void>("/api/v1/admin/auth/logout", { method: "POST" });
}
