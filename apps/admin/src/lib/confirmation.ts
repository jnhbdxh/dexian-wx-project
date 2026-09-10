import { ApiRequestError } from "./api";

export type ConfirmationFailure =
  | { kind: "login" }
  | {
      kind: "forbidden" | "expired" | "changed" | "busy" | "unavailable";
      title: string;
      message: string;
      action: "refresh" | "retry" | "close";
    };

export function classifyConfirmationFailure(
  error: unknown,
): ConfirmationFailure {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return { kind: "login" };
    if (error.status === 403) {
      return {
        kind: "forbidden",
        title: "当前账号不能确认接待",
        message: error.message || "请联系店长为该账号分配确认接待权限。",
        action: "close",
      };
    }
    if (error.code === "RECEPTION_EXPIRED") {
      return {
        kind: "expired",
        title: "该申请已过确认时间",
        message: "系统已释放原资源，请刷新工作台查看最新待办。",
        action: "refresh",
      };
    }
    if (
      [
        "VERSION_CONFLICT",
        "RECEPTION_STATE_CONFLICT",
        "RECEPTION_ALLOCATION_STATE_CONFLICT",
      ].includes(error.code)
    ) {
      return {
        kind: "changed",
        title: "预约信息已经变化",
        message: "请刷新后核对最新安排，再决定是否确认。",
        action: "refresh",
      };
    }
    if (error.code === "RESOURCE_BUSY_RETRY") {
      return {
        kind: "busy",
        title: "其他同事正在处理",
        message: "当前安排没有被修改，请稍后再次确认。",
        action: "retry",
      };
    }
  }

  return {
    kind: "unavailable",
    title: "暂时无法确定确认结果",
    message:
      "请求可能已到达服务端。请先核实结果，再处理其他预约或刷新待办；系统不会重复确认。",
    action: "retry",
  };
}

export function formatMoney(cents: string) {
  const amount = BigInt(cents);
  return `¥${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

export function formatCountdown(deadline: string, now: number) {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(deadline).getTime() - now) / 1_000),
  );
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
