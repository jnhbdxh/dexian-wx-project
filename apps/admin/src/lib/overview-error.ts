import { ApiRequestError } from "./api";

export type OverviewFailure =
  | { kind: "login" }
  | {
      kind: "forbidden" | "unavailable";
      title: string;
      message: string;
    };

export function classifyOverviewFailure(error: unknown): OverviewFailure {
  if (error instanceof ApiRequestError && error.status === 401) {
    return { kind: "login" };
  }

  if (error instanceof ApiRequestError && error.status === 403) {
    return {
      kind: "forbidden",
      title: "当前账号没有工作台权限",
      message: error.message || "请联系店长为该账号分配工作台查看权限。",
    };
  }

  return {
    kind: "unavailable",
    title: "工作台暂时无法加载",
    message: "请检查网络后重新加载；如果仍然失败，请联系技术人员。",
  };
}
