import { AppError } from "../../lib/app-error.js";

export interface PolicyInterval {
  startMinute: number;
  endMinute: number;
  endDayOffset: 0 | 1;
}

export interface WeeklyPolicyRule {
  weekday: number;
  intervals: PolicyInterval[];
}

export interface DatePolicyException {
  serviceDate: string;
  kind: "closed" | "replace";
  intervals: PolicyInterval[];
}

export interface BookingPolicyPayloadV1 {
  maxAdvanceDays: number;
  minimumLeadMinutes: number;
  startGridMinutes: number;
  weeklyRules: WeeklyPolicyRule[];
  dateExceptions: DatePolicyException[];
}

export interface BookingPolicyPayloadV2 extends BookingPolicyPayloadV1 {
  version: 2;
  onlineHoldMinutes: number;
  onsiteHoldMinutes: number;
  processingWeeklyRules: WeeklyPolicyRule[];
  processingDateExceptions: DatePolicyException[];
}

export type BookingPolicyPayload =
  BookingPolicyPayloadV1 | BookingPolicyPayloadV2;

export interface PolicyCalendar {
  weeklyRules: WeeklyPolicyRule[];
  dateExceptions: DatePolicyException[];
}

export interface DayMinuteRange {
  startMinute: number;
  endMinute: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_HOLD_MINUTES = 43_200;

export function isBookingPolicyV2(
  payload: BookingPolicyPayload,
): payload is BookingPolicyPayloadV2 {
  return "version" in payload && payload.version === 2;
}

export function isServiceDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function addServiceDays(value: string, days: number) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function weekdayForServiceDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`).getUTCDay();
}

function validateIntervals(intervals: PolicyInterval[], field: string) {
  const normalized = intervals
    .map((interval) => {
      if (
        !Number.isInteger(interval.startMinute) ||
        interval.startMinute < 0 ||
        interval.startMinute > 1_439 ||
        !Number.isInteger(interval.endMinute) ||
        interval.endMinute < 0 ||
        interval.endMinute > 1_439 ||
        (interval.endDayOffset !== 0 && interval.endDayOffset !== 1)
      ) {
        throw new AppError(
          400,
          "BOOKING_POLICY_INVALID",
          `${field}包含无效时刻`,
        );
      }
      const absoluteEnd = interval.endMinute + interval.endDayOffset * 1_440;
      if (absoluteEnd <= interval.startMinute) {
        throw new AppError(
          400,
          "BOOKING_POLICY_INVALID",
          `${field}的结束时间必须晚于开始时间`,
        );
      }
      return { ...interval, absoluteEnd };
    })
    .sort((left, right) => left.startMinute - right.startMinute);

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index]!.startMinute < normalized[index - 1]!.absoluteEnd) {
      throw new AppError(400, "BOOKING_POLICY_INVALID", `${field}存在重叠区间`);
    }
  }
}

function validateCalendar(
  calendar: PolicyCalendar,
  label: string,
  requireWeeklyIntervals = false,
) {
  if (
    !Array.isArray(calendar.weeklyRules) ||
    !Array.isArray(calendar.dateExceptions)
  ) {
    throw new AppError(400, "BOOKING_POLICY_INVALID", `${label}配置不完整`);
  }

  const weekdays = new Set<number>();
  for (const rule of calendar.weeklyRules) {
    if (
      !Number.isInteger(rule.weekday) ||
      rule.weekday < 0 ||
      rule.weekday > 6
    ) {
      throw new AppError(400, "BOOKING_POLICY_INVALID", `${label}包含无效星期`);
    }
    if (weekdays.has(rule.weekday)) {
      throw new AppError(
        400,
        "BOOKING_POLICY_INVALID",
        `${label}中同一星期只能配置一条规则`,
      );
    }
    weekdays.add(rule.weekday);
    if (requireWeeklyIntervals && rule.intervals.length === 0) {
      throw new AppError(
        400,
        "BOOKING_POLICY_INVALID",
        `${label}星期${rule.weekday}至少需要一个区间`,
      );
    }
    validateIntervals(rule.intervals, `${label}星期${rule.weekday}`);
  }

  const dates = new Set<string>();
  for (const exception of calendar.dateExceptions) {
    if (!isServiceDate(exception.serviceDate)) {
      throw new AppError(
        400,
        "BOOKING_POLICY_INVALID",
        `${label}日期例外包含无效日期`,
      );
    }
    if (dates.has(exception.serviceDate)) {
      throw new AppError(
        400,
        "BOOKING_POLICY_INVALID",
        `${label}中同一日期只能配置一条例外`,
      );
    }
    dates.add(exception.serviceDate);
    if (exception.kind === "closed" && exception.intervals.length > 0) {
      throw new AppError(
        400,
        "BOOKING_POLICY_INVALID",
        `${label}闭店日期不能同时配置区间`,
      );
    }
    if (exception.kind === "replace" && exception.intervals.length === 0) {
      throw new AppError(
        400,
        "BOOKING_POLICY_INVALID",
        `${label}替代日期至少需要一个区间`,
      );
    }
    validateIntervals(exception.intervals, `${label}${exception.serviceDate}`);
  }
}

export function validateBookingPolicy(payload: BookingPolicyPayload) {
  const v2 = isBookingPolicyV2(payload);
  if (
    !Number.isInteger(payload.maxAdvanceDays) ||
    payload.maxAdvanceDays < 0 ||
    payload.maxAdvanceDays > 365
  ) {
    throw new AppError(
      400,
      "BOOKING_POLICY_INVALID",
      "最远预约天数应为 0 至 365 的整数",
    );
  }
  if (
    !Number.isInteger(payload.minimumLeadMinutes) ||
    payload.minimumLeadMinutes < 0 ||
    payload.minimumLeadMinutes > 43_200
  ) {
    throw new AppError(400, "BOOKING_POLICY_INVALID", "最少提前分钟数无效");
  }
  if (
    !Number.isInteger(payload.startGridMinutes) ||
    payload.startGridMinutes < 1 ||
    payload.startGridMinutes > 1_440
  ) {
    throw new AppError(
      400,
      "BOOKING_POLICY_INVALID",
      "开始时间网格应为 1 至 1440 分钟",
    );
  }

  validateCalendar(payload, "营业日历", v2);
  if ("version" in payload && payload.version !== 2) {
    throw new AppError(400, "BOOKING_POLICY_INVALID", "预约政策版本无效");
  }
  if (v2) {
    for (const [value, label] of [
      [payload.onlineHoldMinutes, "线上保留分钟数"],
      [payload.onsiteHoldMinutes, "现场保留分钟数"],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_HOLD_MINUTES) {
        throw new AppError(
          400,
          "BOOKING_POLICY_INVALID",
          `${label}应为 1 至 ${MAX_HOLD_MINUTES} 的整数`,
        );
      }
    }
    validateCalendar(
      {
        weeklyRules: payload.processingWeeklyRules,
        dateExceptions: payload.processingDateExceptions,
      },
      "前台处理日历",
      true,
    );
  }
}

function startingIntervals(calendar: PolicyCalendar, serviceDate: string) {
  const exception = calendar.dateExceptions.find(
    (item) => item.serviceDate === serviceDate,
  );
  if (exception) return exception.kind === "replace" ? exception.intervals : [];
  return (
    calendar.weeklyRules.find(
      (item) => item.weekday === weekdayForServiceDate(serviceDate),
    )?.intervals ?? []
  );
}

function mergeRanges(ranges: DayMinuteRange[]) {
  const sorted = ranges
    .filter((range) => range.endMinute > range.startMinute)
    .sort((left, right) => left.startMinute - right.startMinute);
  const merged: DayMinuteRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startMinute <= previous.endMinute) {
      previous.endMinute = Math.max(previous.endMinute, range.endMinute);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function resolvePolicyDay(
  calendar: PolicyCalendar,
  serviceDate: string,
) {
  if (!isServiceDate(serviceDate)) {
    throw new AppError(400, "INVALID_SERVICE_DATE", "请选择有效日期");
  }
  const currentException = calendar.dateExceptions.find(
    (item) => item.serviceDate === serviceDate,
  );
  if (currentException?.kind === "closed") return [];

  const ownRanges = startingIntervals(calendar, serviceDate).map(
    (interval) => ({
      startMinute: interval.startMinute,
      endMinute: interval.endDayOffset === 1 ? 1_440 : interval.endMinute,
    }),
  );
  if (currentException?.kind === "replace") return mergeRanges(ownRanges);

  const previousDate = addServiceDays(serviceDate, -1);
  const carryRanges = startingIntervals(calendar, previousDate)
    .filter((interval) => interval.endDayOffset === 1 && interval.endMinute > 0)
    .map((interval) => ({ startMinute: 0, endMinute: interval.endMinute }));
  return mergeRanges([...carryRanges, ...ownRanges]);
}

function zonedParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function serviceDateInTimeZone(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function minuteInTimeZone(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

export function localMinuteToInstant(
  serviceDate: string,
  minute: number,
  timeZone: string,
) {
  const boundaryDate =
    minute === 1_440 ? addServiceDays(serviceDate, 1) : serviceDate;
  const boundaryMinute = minute === 1_440 ? 0 : minute;
  const [year, month, day] = boundaryDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const hour = Math.floor(boundaryMinute / 60);
  const localMinute = boundaryMinute % 60;
  const wanted = Date.UTC(year, month - 1, day, hour, localMinute);
  let guess = wanted;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const delta = wanted - actualAsUtc;
    guess += delta;
    if (delta === 0) return new Date(guess);
  }
  throw new AppError(
    400,
    "BOOKING_POLICY_INVALID_LOCAL_TIME",
    "营业区间包含门店时区中不存在的时刻",
  );
}

export function resolvedPolicyInstants(
  calendar: PolicyCalendar,
  serviceDate: string,
  timeZone: string,
) {
  return resolvePolicyDay(calendar, serviceDate).map((range) => ({
    startAt: localMinuteToInstant(serviceDate, range.startMinute, timeZone),
    endAt: localMinuteToInstant(serviceDate, range.endMinute, timeZone),
  }));
}

export function policyCoversInterval(
  calendar: PolicyCalendar,
  timeZone: string,
  startAt: Date,
  endAt: Date,
) {
  let coveredUntil = startAt.getTime();
  let serviceDate = serviceDateInTimeZone(startAt, timeZone);
  const lastDate = serviceDateInTimeZone(
    new Date(endAt.getTime() - 1),
    timeZone,
  );
  while (serviceDate <= lastDate) {
    for (const range of resolvedPolicyInstants(
      calendar,
      serviceDate,
      timeZone,
    )) {
      if (range.endAt.getTime() <= coveredUntil) continue;
      if (range.startAt.getTime() > coveredUntil) return false;
      coveredUntil = Math.max(coveredUntil, range.endAt.getTime());
      if (coveredUntil >= endAt.getTime()) return true;
    }
    serviceDate = addServiceDays(serviceDate, 1);
  }
  return coveredUntil >= endAt.getTime();
}

function intersectInstants(
  left: Array<{ startAt: Date; endAt: Date }>,
  right: Array<{ startAt: Date; endAt: Date }>,
) {
  const intersections: Array<{ startAt: Date; endAt: Date }> = [];
  for (const leftRange of left) {
    for (const rightRange of right) {
      const startAt = new Date(
        Math.max(leftRange.startAt.getTime(), rightRange.startAt.getTime()),
      );
      const endAt = new Date(
        Math.min(leftRange.endAt.getTime(), rightRange.endAt.getTime()),
      );
      if (endAt > startAt) intersections.push({ startAt, endAt });
    }
  }
  return intersections.sort(
    (leftRange, rightRange) =>
      leftRange.startAt.getTime() - rightRange.startAt.getTime(),
  );
}

export function effectiveProcessingInstants(
  payload: BookingPolicyPayloadV2,
  serviceDate: string,
  timeZone: string,
) {
  return intersectInstants(
    resolvedPolicyInstants(payload, serviceDate, timeZone),
    resolvedPolicyInstants(
      {
        weeklyRules: payload.processingWeeklyRules,
        dateExceptions: payload.processingDateExceptions,
      },
      serviceDate,
      timeZone,
    ),
  );
}

export function onlineConfirmationDeadline(
  payload: BookingPolicyPayloadV2,
  timeZone: string,
  decisionNow: Date,
  earliestPrepareAt: Date,
) {
  const startMs = decisionNow.getTime();
  const limitMs = earliestPrepareAt.getTime();
  if (limitMs <= startMs) return undefined;

  const targetMs = payload.onlineHoldMinutes * 60_000;
  let accumulatedMs = 0;
  const segments: Array<{ startAt: Date; endAt: Date }> = [];
  let serviceDate = serviceDateInTimeZone(decisionNow, timeZone);
  const lastDate = serviceDateInTimeZone(
    new Date(earliestPrepareAt.getTime() - 1),
    timeZone,
  );
  while (serviceDate <= lastDate) {
    for (const range of effectiveProcessingInstants(
      payload,
      serviceDate,
      timeZone,
    )) {
      const segmentStart = Math.max(startMs, range.startAt.getTime());
      const segmentEnd = Math.min(limitMs, range.endAt.getTime());
      if (segmentEnd <= segmentStart) continue;
      const availableMs = segmentEnd - segmentStart;
      if (accumulatedMs + availableMs >= targetMs) {
        const usedEnd = segmentStart + targetMs - accumulatedMs;
        segments.push({
          startAt: new Date(segmentStart),
          endAt: new Date(usedEnd),
        });
        return {
          deadline: new Date(usedEnd),
          accumulatedMs: targetMs,
          segments,
          truncated: false,
        };
      }
      segments.push({
        startAt: new Date(segmentStart),
        endAt: new Date(segmentEnd),
      });
      accumulatedMs += availableMs;
    }
    serviceDate = addServiceDays(serviceDate, 1);
  }
  if (accumulatedMs === 0) return undefined;
  return {
    deadline: earliestPrepareAt,
    accumulatedMs,
    segments,
    truncated: true,
  };
}
