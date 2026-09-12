import type {
  PolicyIdentity,
  PublishPolicyInput,
  SavePolicyDraftInput,
} from "./booking-policy-api";

export type BookingPolicyRecovery =
  | { operation: "save"; key: string; input: SavePolicyDraftInput }
  | { operation: "publish"; key: string; input: PublishPolicyInput }
  | {
      operation: "pause" | "resume-legacy";
      key: string;
      input: PolicyIdentity;
    };

const STORAGE_KEY = "dexian:booking-policy-recovery";

function isRecovery(value: unknown): value is BookingPolicyRecovery {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BookingPolicyRecovery>;
  const input = item.input as Partial<PolicyIdentity> | undefined;
  return (
    ["save", "publish", "pause", "resume-legacy"].includes(
      item.operation ?? "",
    ) &&
    typeof item.key === "string" &&
    item.key.length >= 8 &&
    typeof input?.initiatingStaffUserId === "string" &&
    typeof input.initiatingStoreId === "string"
  );
}

export function saveBookingPolicyRecovery(value: BookingPolicyRecovery) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function loadBookingPolicyRecovery() {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (!stored) return undefined;
  try {
    const value: unknown = JSON.parse(stored);
    if (isRecovery(value)) return value;
  } catch {
    // A malformed operation cannot be replayed without changing its request hash.
  }
  throw new Error(
    "预约政策恢复记录无法安全读取，请保留当前页面并联系管理员核实",
  );
}

export function clearBookingPolicyRecovery() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function isBookingPolicyRecoveryOwner(
  recovery: BookingPolicyRecovery,
  user: { id: string; storeId: string },
) {
  return (
    recovery.input.initiatingStaffUserId === user.id &&
    recovery.input.initiatingStoreId === user.storeId
  );
}
