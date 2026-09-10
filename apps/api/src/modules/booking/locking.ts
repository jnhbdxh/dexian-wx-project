export const TOPOLOGY_LOCK_KEY = -2_147_483_648;
export const LOCK_TIMEOUT_MS = 1_500;
export const MAX_TRANSACTION_ATTEMPTS = 3;

const LOCK_EPOCH_UTC = Date.UTC(2000, 0, 1);

export class ExpandDateLocks extends Error {
  constructor(readonly keys: number[]) {
    super("Business record spans dates that are not locked yet");
  }
}

export function dayKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const utcDate = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
  );
  return Math.floor((utcDate - LOCK_EPOCH_UTC) / 86_400_000);
}

export function rangeDayKeys(start: Date, end: Date, timezone: string) {
  const first = dayKey(start, timezone);
  const last = dayKey(new Date(end.getTime() - 1), timezone);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

export function postgresCode(error: unknown) {
  return (error as { code?: unknown }).code;
}

export function waitBeforeRetry() {
  return new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
}
