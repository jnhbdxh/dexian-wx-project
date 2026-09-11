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

export function totalLabel(priceCents: number, guestCount: number) {
  const totalCents = priceCents * guestCount;
  const yuan = (totalCents / 100).toFixed(2);
  return `¥${yuan.endsWith(".00") ? yuan.slice(0, -3) : yuan}`;
}
