import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, getOperationsOverview } from "./api";
import { classifyOverviewFailure } from "./overview-error";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operations overview failures", () => {
  it("preserves the HTTP status and business error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "PERMISSION_DENIED",
            message: "请联系店长分配权限",
            requestId: "request-1",
            details: {},
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(getOperationsOverview()).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
      requestId: "request-1",
    });
  });

  it("sends only 401 responses to login", () => {
    const error = new ApiRequestError(
      401,
      "AUTH_REQUIRED",
      "请先登录",
      "1",
      {},
    );
    expect(classifyOverviewFailure(error)).toEqual({ kind: "login" });
  });

  it("shows an actionable permission message for 403", () => {
    const error = new ApiRequestError(
      403,
      "PERMISSION_DENIED",
      "请联系店长分配权限",
      "2",
      {},
    );
    expect(classifyOverviewFailure(error)).toEqual({
      kind: "forbidden",
      title: "当前账号没有工作台权限",
      message: "请联系店长分配权限",
    });
  });

  it.each([
    new ApiRequestError(500, "INTERNAL_ERROR", "系统异常", "3", {}),
    new TypeError("Network request failed"),
  ])("shows a retry action for service or network failures", (error) => {
    expect(classifyOverviewFailure(error)).toEqual({
      kind: "unavailable",
      title: "工作台暂时无法加载",
      message: "请检查网络后重新加载；如果仍然失败，请联系技术人员。",
    });
  });
});
