import type { CustomerReceptionReason, CustomerReceptionState } from "./api";

export function receptionStatus(
  state: CustomerReceptionState,
  reason: CustomerReceptionReason,
) {
  if (state === "pending") {
    return {
      label: "待门店确认",
      tone: "pending",
      title: "门店正在确认",
      message: "预约资源已暂时保留，请在确认截止前留意状态变化。",
    };
  }
  if (state === "confirmed") {
    return {
      label: "已确认",
      tone: "confirmed",
      title: "预约已确认",
      message: "请按预约时间到店；如需调整，请提前联系门店。",
    };
  }
  if (state === "expired") {
    return {
      label: "已过期",
      tone: "expired",
      title: "确认时间已过",
      message: "门店未在截止时间前确认，本次预占已释放，可重新预约。",
    };
  }
  if (reason === "therapist_leave") {
    return {
      label: "因请假失效",
      tone: "invalidated",
      title: "服务人员临时请假",
      message: "本次预约已失效，资源已释放，请重新选择时间或服务人员。",
    };
  }
  return {
    label: "预约已失效",
    tone: "invalidated",
    title: "预约条件发生变化",
    message: "门店资源发生变化，本次预约已失效，请重新预约。",
  };
}

export function receptionDateTimeLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function receptionTimeLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function receptionMoneyLabel(value: string) {
  const yuan = (Number(value) / 100).toFixed(2);
  return `¥${yuan.endsWith(".00") ? yuan.slice(0, -3) : yuan}`;
}
