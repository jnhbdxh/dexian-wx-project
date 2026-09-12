export interface DateOption {
  key: string;
  dateLabel: string;
  summaryLabel: string;
  weekday: string;
  relativeLabel: string;
}

function datePartsAt(referenceDate: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(referenceDate);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  return { year: value("year"), month: value("month"), day: value("day") };
}

export function buildDateOptions(
  referenceDate = new Date(),
  timeZone = "Asia/Shanghai",
): DateOption[] {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const { year, month, day } = datePartsAt(referenceDate, timeZone);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day + index));
    const optionYear = date.getUTCFullYear();
    const optionMonth = date.getUTCMonth() + 1;
    const optionDay = date.getUTCDate();
    return {
      key: `${optionYear}-${optionMonth}-${optionDay}`,
      dateLabel: `${optionMonth}.${optionDay}`,
      summaryLabel: `${optionMonth}月${optionDay}日`,
      weekday: weekdays[date.getUTCDay()]!,
      relativeLabel: index === 0 ? "今天" : index === 1 ? "明天" : "",
    };
  });
}

export function buildDateOptionsForRange(
  firstDate: string,
  lastDate: string,
): DateOption[] {
  const first = new Date(`${firstDate}T00:00:00.000Z`);
  const last = new Date(`${lastDate}T00:00:00.000Z`);
  if (
    Number.isNaN(first.getTime()) ||
    Number.isNaN(last.getTime()) ||
    last < first
  ) {
    throw new Error("服务端返回的预约日期范围无效");
  }
  const days = Math.floor((last.getTime() - first.getTime()) / 86_400_000) + 1;
  if (days > 366) throw new Error("服务端返回的预约日期范围过大");
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(first.getTime() + index * 86_400_000);
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return {
      key: date.toISOString().slice(0, 10),
      dateLabel: `${month}.${day}`,
      summaryLabel: `${month}月${day}日`,
      weekday: weekdays[date.getUTCDay()]!,
      relativeLabel: index === 0 ? "今天" : index === 1 ? "明天" : "",
    };
  });
}

export function totalLabel(priceCents: number, guestCount: number) {
  const totalCents = priceCents * guestCount;
  const yuan = (totalCents / 100).toFixed(2);
  return `¥${yuan.endsWith(".00") ? yuan.slice(0, -3) : yuan}`;
}

export function serviceStartIso(
  dateKey: string,
  time: string,
  timeZone: string,
) {
  if (timeZone !== "Asia/Shanghai") {
    throw new Error("当前小程序仅支持上海时区门店");
  }
  const dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateKey);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) throw new Error("预约日期或时间格式无效");
  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  return new Date(
    `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}T${hour}:${minute}:00+08:00`,
  ).toISOString();
}

export function bookingIdempotencyKey(
  now = Date.now(),
  random = Math.random(),
) {
  return `booking_${now.toString(36)}_${random.toString(36).slice(2, 12)}`;
}

export function shouldKeepHoldRecovery(statusCode: number, code: string) {
  return (
    statusCode === 0 ||
    statusCode === 401 ||
    statusCode >= 500 ||
    code === "CANDIDATE_OWNER_MISMATCH" ||
    code === "REQUEST_IN_PROGRESS" ||
    code === "RESOURCE_BUSY_RETRY"
  );
}

export function confirmationDeadlineLabel(
  value: string,
  timeZone = "Asia/Shanghai",
) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
