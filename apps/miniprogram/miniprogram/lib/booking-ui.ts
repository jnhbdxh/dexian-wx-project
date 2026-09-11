export interface DateOption {
  key: string;
  dateLabel: string;
  weekday: string;
  relativeLabel: string;
}

export function buildDateOptions(referenceDate = new Date()): DateOption[] {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(referenceDate);
    date.setDate(referenceDate.getDate() + index);
    return {
      key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
      dateLabel: `${date.getMonth() + 1}.${date.getDate()}`,
      weekday: weekdays[date.getDay()]!,
      relativeLabel: index === 0 ? "今天" : index === 1 ? "明天" : "",
    };
  });
}

export function totalLabel(priceCents: number, guestCount: number) {
  return `¥${((priceCents * guestCount) / 100).toFixed(0)}`;
}
