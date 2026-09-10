import { ApiRequestError } from "./api";

export type LeaveFailure =
  | { kind: "login"; title: string; message: string; action: "login" }
  | {
      kind: "forbidden" | "invalid";
      title: string;
      message: string;
      action: "dismiss";
    }
  | {
      kind: "busy" | "unavailable" | "server";
      title: string;
      message: string;
      action: "retry";
    }
  | {
      kind: "changed";
      title: string;
      message: string;
      action: "refresh";
    }
  | {
      kind: "identity";
      title: string;
      message: string;
      action: "switch-account";
    };

export function classifyLeaveFailure(error: unknown): LeaveFailure {
  if (!(error instanceof ApiRequestError)) {
    return {
      kind: "unavailable",
      title: "请假结果暂未获取",
      message: "网络连接中断，请使用原请求核实结果，不要重复登记。",
      action: "retry",
    };
  }
  if (error.status === 401 || error.code === "CSRF_INVALID") {
    return {
      kind: "login",
      title: "页面身份已失效",
      message: "请重新登录后继续处理；未核实的原请求会保留。",
      action: "login",
    };
  }
  if (error.status === 403) {
    return {
      kind: "forbidden",
      title: "没有登记权限",
      message: "请联系店长分配请假登记权限。",
      action: "dismiss",
    };
  }
  if (error.code === "LEAVE_REQUEST_IDENTITY_CHANGED") {
    return {
      kind: "identity",
      title: "当前登录账号已变化",
      message: "请切回发起这次请假的原员工账号，再继续核实原请求。",
      action: "switch-account",
    };
  }
  if (
    error.code === "RESOURCE_BUSY_RETRY" ||
    error.code === "REQUEST_IN_PROGRESS"
  ) {
    return {
      kind: "busy",
      title: "相关安排正在处理中",
      message: "请稍后使用原请求重试，系统不会重复登记。",
      action: "retry",
    };
  }
  if (error.code === "THERAPIST_NOT_FOUND") {
    return {
      kind: "changed",
      title: "美容师信息已变化",
      message: "请刷新列表后重新选择美容师。",
      action: "refresh",
    };
  }
  if (error.status === 400 || error.code === "IDEMPOTENCY_KEY_REUSED") {
    return {
      kind: "invalid",
      title: "请检查登记内容",
      message: error.message,
      action: "dismiss",
    };
  }
  return {
    kind: "server",
    title: "系统暂时无法登记",
    message: "本次没有取得成功结果，请稍后使用原请求重试。",
    action: "retry",
  };
}

export function shanghaiLocalToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const parsed = new Date(value + ":00+08:00");
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
