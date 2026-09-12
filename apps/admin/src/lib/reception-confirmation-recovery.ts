export interface ReceptionConfirmationAttempt {
  receptionId: string;
  version: number;
  key: string;
  staffUserId: string;
  storeId: string;
}
const storageKey = "dexian:reception-confirmation";
export function saveReceptionConfirmation(
  attempt: ReceptionConfirmationAttempt,
) {
  sessionStorage.setItem(storageKey, JSON.stringify(attempt));
}
export function clearReceptionConfirmation() {
  sessionStorage.removeItem(storageKey);
}
export function loadReceptionConfirmation():
  ReceptionConfirmationAttempt | undefined {
  const saved = sessionStorage.getItem(storageKey);
  if (!saved) return;
  const value: unknown = JSON.parse(saved);
  if (!value || typeof value !== "object")
    throw new Error("确认恢复记录无法读取，请保留当前页面并联系店长核实");
  const item = value as Partial<ReceptionConfirmationAttempt>;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    ![item.receptionId, item.key, item.staffUserId, item.storeId].every(
      (v) => typeof v === "string" && uuid.test(v),
    ) ||
    !Number.isSafeInteger(item.version) ||
    item.version! < 1
  )
    throw new Error("确认恢复记录无法读取，请保留当前页面并联系店长核实");
  return item as ReceptionConfirmationAttempt;
}
