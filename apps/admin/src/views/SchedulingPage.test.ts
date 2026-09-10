// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError, type LeaveConflict } from "../lib/api";

const mocks = vi.hoisted(() => ({
  createLeave: vi.fn(),
  getLeaveWorkbench: vi.fn(),
  logout: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
  beforeLeave: undefined as ((to: { path: string }) => boolean) | undefined,
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  createLeave: mocks.createLeave,
  getLeaveWorkbench: mocks.getLeaveWorkbench,
  logout: mocks.logout,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  onBeforeRouteLeave: (guard: (to: { path: string }) => boolean) => {
    mocks.beforeLeave = guard;
  },
}));

vi.mock("element-plus", () => ({
  ElMessage: { success: mocks.success },
}));

import SchedulingPage from "./SchedulingPage.vue";

const ElButtonStub = defineComponent({
  props: {
    disabled: Boolean,
    loading: Boolean,
    nativeType: String,
  },
  emits: ["click"],
  template:
    '<button :type="nativeType || \'button\'" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

const therapistId = "00000000-0000-4000-8000-000000000001";
const conflictId = "00000000-0000-4000-8000-000000000002";
const receptionId = "00000000-0000-4000-8000-000000000003";

function conflict(id = conflictId): LeaveConflict {
  return {
    conflictId: id,
    receptionId,
    detectedAt: "2026-09-10T02:00:00.000Z",
    customerName: "林女士",
    therapistId,
    therapistName: "小满",
    leaveStartAt: "2026-09-11T05:00:00.000Z",
    leaveEndAt: "2026-09-11T06:00:00.000Z",
    reasonPrivate: "已确认的个人请假",
    guests: [
      {
        id: "00000000-0000-4000-8000-000000000004",
        serviceItemName: "舒缓护理",
        therapistName: "小满",
        roomName: "青竹房",
        bedName: "一号床",
        serviceStartAt: "2026-09-11T05:00:00.000Z",
        serviceEndAt: "2026-09-11T06:00:00.000Z",
      },
    ],
  };
}

function workbench(conflicts: LeaveConflict[] = []) {
  return {
    user: {
      id: "00000000-0000-4000-8000-000000000005",
      storeId: "00000000-0000-4000-8000-000000000006",
      username: "frontdesk",
      displayName: "前台",
    },
    serverNow: "2026-09-10T01:00:00.000Z",
    canCreateLeave: true,
    therapists: [{ id: therapistId, name: "小满" }],
    conflictTotal: conflicts.length,
    conflicts,
    nextCursor: null,
  };
}

function mountPage() {
  return mount(SchedulingPage, {
    global: {
      stubs: {
        ElButton: ElButtonStub,
        ElResult: true,
        ElSkeleton: true,
      },
    },
  });
}

async function fillLeaveForm(wrapper: ReturnType<typeof mountPage>) {
  await wrapper.find("#leave-therapist").setValue(therapistId);
  await wrapper.find("#leave-start").setValue("2026-09-11T13:00");
  await wrapper.find("#leave-end").setValue("2026-09-11T14:00");
  await wrapper.find("#leave-reason").setValue(" 已确认的个人请假 ");
}

afterEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.beforeLeave = undefined;
});

describe("leave and conflict workbench", () => {
  it("shows the confirmed reception for viewing and manual follow-up only", async () => {
    mocks.getLeaveWorkbench.mockResolvedValue(workbench([conflict()]));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.find(".conflict-detail").text()).toContain("林女士");
    expect(wrapper.find(".conflict-detail").text()).toContain("舒缓护理");
    expect(wrapper.find(".conflict-detail").text()).toContain(
      "下一步：联系顾客后人工跟进",
    );
    expect(wrapper.find(".conflict-detail").text()).toContain(
      "不会把冲突标记为已解决",
    );
    expect(
      wrapper.findAll("button").some((button) => button.text() === "解决"),
    ).toBe(false);
  });

  it("registers leave, reports group counts, refreshes, and locates the new conflict", async () => {
    const newConflict = conflict("00000000-0000-4000-8000-000000000007");
    mocks.getLeaveWorkbench
      .mockResolvedValueOnce(workbench())
      .mockResolvedValueOnce(workbench([newConflict]));
    mocks.createLeave.mockResolvedValue({
      restrictionId: "00000000-0000-4000-8000-000000000008",
      state: "active",
      invalidatedPendingCount: 1,
      affectedConfirmedCount: 1,
      invalidatedReceptions: [{ receptionId }],
      conflicts: [{ conflictId: newConflict.conflictId, receptionId }],
    });
    const wrapper = mountPage();
    await flushPromises();
    await fillLeaveForm(wrapper);
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();

    expect(mocks.createLeave).toHaveBeenCalledTimes(1);
    expect(mocks.createLeave.mock.calls[0]![0]).toEqual({
      therapistResourceId: therapistId,
      startAt: "2026-09-11T05:00:00.000Z",
      endAt: "2026-09-11T06:00:00.000Z",
      reasonPrivate: "已确认的个人请假",
    });
    expect(mocks.createLeave.mock.calls[0]![1]).toEqual(expect.any(String));
    expect(mocks.getLeaveWorkbench).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".leave-result").text()).toContain(
      "1 组待确认已失效，1 组已确认接待待人工跟进",
    );
    expect(wrapper.find(".conflict-detail").text()).toContain("林女士");
    expect(mocks.success).toHaveBeenCalledWith("请假已生效");
  });

  it("keeps the original request while result checks are busy or offline", async () => {
    mocks.getLeaveWorkbench
      .mockResolvedValueOnce(workbench())
      .mockResolvedValueOnce(workbench());
    mocks.createLeave
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockRejectedValueOnce(
        new ApiRequestError(
          409,
          "RESOURCE_BUSY_RETRY",
          "相关安排正在处理中",
          "request-2",
          {},
        ),
      )
      .mockRejectedValueOnce(new TypeError("Network request failed again"))
      .mockResolvedValueOnce({
        restrictionId: "00000000-0000-4000-8000-000000000008",
        state: "active",
        invalidatedPendingCount: 0,
        affectedConfirmedCount: 0,
        invalidatedReceptions: [],
        conflicts: [],
      });
    const wrapper = mountPage();
    await flushPromises();
    await fillLeaveForm(wrapper);
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();

    expect(wrapper.find(".leave-submit-alert").text()).toContain(
      "请假结果暂未获取",
    );
    expect(
      wrapper.find(".refresh-button").attributes("disabled"),
    ).toBeDefined();
    expect(
      wrapper
        .findAll(".dashboard-header button")
        .every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);
    expect(wrapper.find("#leave-reason").attributes("disabled")).toBeDefined();
    expect(
      wrapper.find(".leave-submit-button").attributes("disabled"),
    ).toBeDefined();

    const originalCall = mocks.createLeave.mock.calls[0];
    for (const expectedText of [
      "暂时还无法核实原请求结果",
      "请假结果暂未获取",
    ]) {
      await wrapper.find(".leave-submit-alert button").trigger("click");
      await flushPromises();
      expect(wrapper.find(".leave-submit-alert").text()).toContain(
        expectedText,
      );
    }
    await wrapper.find(".leave-submit-alert button").trigger("click");
    await flushPromises();

    expect(mocks.createLeave).toHaveBeenCalledTimes(4);
    for (const call of mocks.createLeave.mock.calls) {
      expect(call).toEqual(originalCall);
    }
    expect(wrapper.find(".leave-submit-alert").exists()).toBe(false);
    expect(wrapper.find(".leave-result").text()).toContain("请假已生效");
    expect(mocks.getLeaveWorkbench).toHaveBeenCalledTimes(2);
  });

  it("stops before the API when required information is missing", async () => {
    mocks.getLeaveWorkbench.mockResolvedValue(workbench());
    const wrapper = mountPage();
    await flushPromises();
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();

    expect(mocks.createLeave).not.toHaveBeenCalled();
    expect(wrapper.find(".form-error").text()).toContain("开始和结束时间");
  });

  it("keeps an unknown request through server, csrf, login, and reload recovery", async () => {
    mocks.getLeaveWorkbench.mockResolvedValue(workbench());
    mocks.createLeave
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockRejectedValueOnce(
        new ApiRequestError(500, "INTERNAL_ERROR", "服务异常", "r-1", {}),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(403, "CSRF_INVALID", "页面状态失效", "r-2", {}),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(401, "AUTH_REQUIRED", "请先登录", "r-3", {}),
      )
      .mockResolvedValueOnce({
        restrictionId: "00000000-0000-4000-8000-000000000008",
        state: "active",
        invalidatedPendingCount: 0,
        affectedConfirmedCount: 0,
        invalidatedReceptions: [],
        conflicts: [],
      });
    const wrapper = mountPage();
    await flushPromises();
    await fillLeaveForm(wrapper);
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();

    const originalCall = mocks.createLeave.mock.calls[0];
    for (let index = 0; index < 2; index += 1) {
      await wrapper.find(".leave-submit-alert button").trigger("click");
      await flushPromises();
      expect(sessionStorage.getItem("dexian:unverified-leave")).toContain(
        originalCall![1] as string,
      );
    }
    expect(mocks.replace).toHaveBeenCalledWith({
      path: "/login",
      query: { redirect: "/scheduling" },
    });
    expect(mocks.replace).toHaveBeenLastCalledWith({
      path: "/login",
      query: { redirect: "/scheduling" },
    });

    wrapper.unmount();
    const afterCsrfLogin = mountPage();
    await flushPromises();
    expect(afterCsrfLogin.find("#leave-reason").element).toHaveProperty(
      "value",
      "已确认的个人请假",
    );
    expect(
      afterCsrfLogin.find("#leave-reason").attributes("disabled"),
    ).toBeDefined();
    await afterCsrfLogin.find(".leave-submit-alert button").trigger("click");
    await flushPromises();
    expect(mocks.replace).toHaveBeenLastCalledWith({
      path: "/login",
      query: { redirect: "/scheduling" },
    });

    afterCsrfLogin.unmount();
    const afterSessionLogin = mountPage();
    await flushPromises();
    await afterSessionLogin.find(".leave-submit-alert button").trigger("click");
    await flushPromises();

    expect(mocks.createLeave).toHaveBeenCalledTimes(5);
    for (const call of mocks.createLeave.mock.calls) {
      expect(call).toEqual(originalCall);
    }
    expect(sessionStorage.getItem("dexian:unverified-leave")).toBeNull();
  });

  it("blocks route leave while an unknown request can still be recovered", async () => {
    mocks.getLeaveWorkbench.mockResolvedValue(workbench());
    mocks.createLeave.mockRejectedValue(new TypeError("Network failed"));
    const wrapper = mountPage();
    await flushPromises();
    await fillLeaveForm(wrapper);
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();

    expect(mocks.beforeLeave?.({ path: "/dashboard" })).toBe(false);
    expect(mocks.beforeLeave?.({ path: "/login" })).toBe(true);
    const reload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);
    expect(sessionStorage.getItem("dexian:unverified-leave")).not.toBeNull();
  });

  it("separates retrying the original busy request from editing a new one", async () => {
    mocks.getLeaveWorkbench.mockResolvedValue(workbench());
    mocks.createLeave
      .mockRejectedValueOnce(
        new ApiRequestError(
          409,
          "RESOURCE_BUSY_RETRY",
          "相关安排正在处理中",
          "r-1",
          {},
        ),
      )
      .mockResolvedValueOnce({
        restrictionId: "00000000-0000-4000-8000-000000000008",
        state: "active",
        invalidatedPendingCount: 0,
        affectedConfirmedCount: 0,
        invalidatedReceptions: [],
        conflicts: [],
      });
    const wrapper = mountPage();
    await flushPromises();
    await fillLeaveForm(wrapper);
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();

    expect(wrapper.find("#leave-reason").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".leave-submit-alert").text()).toContain("重试原请求");
    expect(
      wrapper.find(".leave-submit-button").attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.find(".leave-submit-alert").text()).toContain(
      "修改登记内容",
    );
    const modify = wrapper
      .findAll(".leave-submit-alert button")
      .find((button) => button.text().includes("修改登记内容"))!;
    await modify.trigger("click");
    await wrapper.find("#leave-reason").setValue("修改后的原因");
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();

    expect(mocks.createLeave.mock.calls[1]![0].reasonPrivate).toBe(
      "修改后的原因",
    );
    expect(mocks.createLeave.mock.calls[1]![1]).not.toBe(
      mocks.createLeave.mock.calls[0]![1],
    );
  });

  it("loads every conflict page and reports the exact total", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      conflict(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    );
    const lastConflict = conflict("00000000-0000-4000-8000-999999999999");
    mocks.getLeaveWorkbench
      .mockResolvedValueOnce({
        ...workbench(firstPage),
        conflictTotal: 51,
        nextCursor: firstPage[49]!.conflictId,
      })
      .mockResolvedValueOnce({
        ...workbench([lastConflict]),
        conflictTotal: 51,
      });
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.find(".conflict-heading").text()).toContain(
      "共 51 组等待人工跟进，已显示 50 组",
    );
    await wrapper.find(".conflict-load-more button").trigger("click");
    await flushPromises();

    expect(mocks.getLeaveWorkbench).toHaveBeenLastCalledWith(
      firstPage[49]!.conflictId,
    );
    expect(wrapper.findAll(".conflict-item")).toHaveLength(51);
    expect(wrapper.find(".conflict-heading").text()).toContain(
      "共 51 组等待人工跟进",
    );
    expect(wrapper.find(".conflict-heading").text()).not.toContain("已显示");
  });

  it("shows both dates for cross-day and both years for cross-year periods", async () => {
    const item = conflict();
    item.leaveEndAt = "2026-09-13T06:00:00.000Z";
    item.guests[0]!.serviceStartAt = "2026-12-31T15:00:00.000Z";
    item.guests[0]!.serviceEndAt = "2026-12-31T17:00:00.000Z";
    mocks.getLeaveWorkbench.mockResolvedValue(workbench([item]));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.find(".conflict-leave-time").text()).toContain(
      "9/11 13:00–9/13 14:00",
    );
    expect(wrapper.find(".conflict-guest").text()).toContain(
      "2026/12/31 23:00–2027/1/1 01:00",
    );
  });
});
