import type {
  CalendarAllocation,
  CalendarResourceType,
  CalendarRestrictionKind,
  CalendarSegmentKind,
} from "./resource-calendar-api";

export const restrictionLabels: Record<CalendarRestrictionKind, string> = {
  leave: "请假",
  meal_break: "用餐休息",
  training: "培训",
  store_closed: "闭店",
  equipment_fault: "设备故障",
  other_unavailable: "不可用",
};

export function segmentLabel(
  kind: CalendarSegmentKind,
  resourceType: CalendarResourceType,
) {
  if (kind === "prepare") return "准备";
  if (kind === "service") return "服务";
  if (kind === "rest") return "必要休息";
  return resourceType === "therapist" ? "整理" : "清洁";
}

export function shiftDate(serviceDate: string, days: number) {
  const date = new Date(`${serviceDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function shanghaiTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function shanghaiDateLabel(serviceDate: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${serviceDate}T00:00:00+08:00`));
}

export function shanghaiDay(value: number | Date = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function periodStyle(
  startAt: string,
  endAt: string,
  serviceDate: string,
) {
  const dayStart = Date.parse(`${serviceDate}T00:00:00+08:00`);
  const dayEnd = dayStart + 24 * 60 * 60_000;
  const start = Math.max(dayStart, Date.parse(startAt));
  const end = Math.min(dayEnd, Date.parse(endAt));
  const duration = dayEnd - dayStart;
  return {
    left: `${((start - dayStart) / duration) * 100}%`,
    width: `${Math.max(0, ((end - start) / duration) * 100)}%`,
  };
}

function relativeTime(value: string, serviceDate: string) {
  const date = shanghaiDay(new Date(value));
  if (date === serviceDate) return shanghaiTime(value);

  const dayOffset =
    (Date.parse(`${date}T00:00:00.000Z`) -
      Date.parse(`${serviceDate}T00:00:00.000Z`)) /
    (24 * 60 * 60_000);
  if (dayOffset === -1) return `前日 ${shanghaiTime(value)}`;
  if (dayOffset === 1) return `次日 ${shanghaiTime(value)}`;
  return `${date} ${shanghaiTime(value)}`;
}

export function timeRange(startAt: string, endAt: string, serviceDate: string) {
  return `${relativeTime(startAt, serviceDate)}–${relativeTime(endAt, serviceDate)}`;
}

export function isEffectiveAllocation(
  allocation: CalendarAllocation,
  now: number,
) {
  if (allocation.receptionState === "confirmed") return true;
  return Boolean(
    allocation.expiresAt &&
    Date.parse(allocation.expiresAt) > now &&
    allocation.confirmationDeadline &&
    Date.parse(allocation.confirmationDeadline) > now,
  );
}
