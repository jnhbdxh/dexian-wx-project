import type { CreateLeaveInput } from "./api";

export interface RecoverableLeaveAttempt {
  input: CreateLeaveInput;
  key: string;
  staffUserId: string;
  storeId: string;
  therapistName: string;
}

const STORAGE_KEY = "dexian:unverified-leave";

function isAttempt(value: unknown): value is RecoverableLeaveAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<RecoverableLeaveAttempt>;
  const input = attempt.input as Partial<CreateLeaveInput> | undefined;
  const startAt =
    typeof input?.startAt === "string" ? Date.parse(input.startAt) : NaN;
  const endAt =
    typeof input?.endAt === "string" ? Date.parse(input.endAt) : NaN;
  return (
    typeof attempt.key === "string" &&
    attempt.key.length >= 8 &&
    typeof attempt.staffUserId === "string" &&
    attempt.staffUserId.length > 0 &&
    typeof attempt.storeId === "string" &&
    attempt.storeId.length > 0 &&
    typeof attempt.therapistName === "string" &&
    attempt.therapistName.length > 0 &&
    !!input &&
    typeof input.therapistResourceId === "string" &&
    typeof input.startAt === "string" &&
    typeof input.endAt === "string" &&
    typeof input.reasonPrivate === "string" &&
    Number.isFinite(startAt) &&
    Number.isFinite(endAt) &&
    endAt > startAt
  );
}

export function isLeaveRecoveryOwner(
  attempt: RecoverableLeaveAttempt,
  user: { id: string; storeId: string },
) {
  return attempt.staffUserId === user.id && attempt.storeId === user.storeId;
}

export function saveUnverifiedLeave(attempt: RecoverableLeaveAttempt) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
}

export function loadUnverifiedLeave() {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (!stored) return undefined;
  try {
    const value: unknown = JSON.parse(stored);
    if (isAttempt(value)) return value;
  } catch {
    // An unreadable recovery record cannot be replayed safely.
  }
  sessionStorage.removeItem(STORAGE_KEY);
  return undefined;
}

export function clearUnverifiedLeave() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function isoToShanghaiLocal(value: string) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
  return parts.replace(" ", "T");
}
