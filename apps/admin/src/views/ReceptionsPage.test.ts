// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../lib/api";
import type { ReceptionRecord } from "../lib/receptions-api";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  session: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../lib/receptions-api", async (original) => ({
  ...(await original<typeof import("../lib/receptions-api")>()),
  getReceptions: mocks.list,
  getReception: mocks.detail,
}));
vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  getSession: mocks.session,
  confirmReception: mocks.confirm,
}));
import ReceptionsPage from "./ReceptionsPage.vue";

const user = {
  id: "10000000-0000-4000-8000-000000000001",
  storeId: "20000000-0000-4000-8000-000000000001",
  username: "frontdesk",
  displayName: "前台",
};
const id = "30000000-0000-4000-8000-000000000001";
const nextId = "30000000-0000-4000-8000-000000000002";
const now = "2026-09-11T01:00:00.000Z";
function record(receptionId = id): ReceptionRecord {
  return {
    receptionId,
    customerName: receptionId === id ? "林女士" : "陈女士",
    maskedPhone: "138****0000",
    state: "pending",
    confirmationDeadline: "2026-09-11T01:10:00.000Z",
    quoteCents: "9500",
    version: 3,
    createdAt: now,
    serviceStartAt: "2026-09-11T15:30:00.000Z",
    serviceEndAt: "2026-09-11T16:30:00.000Z",
    guests: [
      {
        id: "guest",
        serviceItemName: "舒缓护理",
        therapistName: "小满",
        roomName: "青竹房",
        bedName: "一号床",
        serviceStartAt: "2026-09-11T15:30:00.000Z",
        serviceEndAt: "2026-09-11T16:30:00.000Z",
        quoteCents: "9500",
      },
    ],
    allocations: [
      {
        id: "allocation",
        guestId: "guest",
        resourceId: "therapist-resource",
        resourceName: "小满",
        resourceType: "therapist",
        segmentKind: "rest",
        state: "held",
        startAt: "2026-09-11T16:35:00.000Z",
        endAt: "2026-09-11T16:55:00.000Z",
      },
    ],
    conflicts: [],
    payments: null,
  };
}
const access = {
  user,
  canConfirm: true,
  canReadPayments: false,
  serverNow: now,
};
const Button = defineComponent({
  props: {
    disabled: Boolean,
    loading: Boolean,
    nativeType: { type: String, default: "button" },
  },
  emits: ["click"],
  template:
    '<button :type="nativeType" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
});
const wrappers: Array<ReturnType<typeof mount>> = [];
async function render() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/receptions", component: ReceptionsPage },
      { path: "/login", component: { template: "<p>登录</p>" } },
      { path: "/dashboard", component: { template: "<p>工作台</p>" } },
      { path: "/scheduling", component: { template: "<p>请假</p>" } },
      { path: "/payments", component: { template: "<p>支付</p>" } },
    ],
  });
  await router.push("/receptions");
  await router.isReady();
  const wrapper = mount(defineComponent({ template: "<router-view />" }), {
    global: { plugins: [router], stubs: { ElButton: Button } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}
async function clickText(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper.findAll("button").find((b) => b.text() === label);
  expect(button, label).toBeTruthy();
  await button!.trigger("click");
  await flushPromises();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.session.mockResolvedValue({ user });
  mocks.list.mockResolvedValue({
    ...access,
    total: 2,
    items: [record(), record(nextId)],
    nextCursor: null,
    therapists: [{ id: user.id, name: "小满" }],
  });
  mocks.detail.mockImplementation(async (receptionId: string) => ({
    ...access,
    item: record(receptionId),
  }));
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  vi.useRealTimers();
  sessionStorage.clear();
});

describe("reception lookup and confirmation", () => {
  it("keeps the detail controls mounted during background refresh and clears them if access is revoked", async () => {
    const { wrapper } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    const title = wrapper.get("#reception-detail-title").element;
    const confirm = wrapper
      .findAll("button")
      .find((button) => button.text() === "确认接待")!.element;
    let resolveDetail!: (value: unknown) => void;
    mocks.detail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(15000);
    await flushPromises();
    expect(wrapper.get("#reception-detail-title").element).toBe(title);
    expect(
      wrapper.findAll("button").find((button) => button.text() === "确认接待")!
        .element,
    ).toBe(confirm);
    resolveDetail({ ...access, item: { ...record(), version: 4 } });
    await flushPromises();
    expect(wrapper.get("#reception-detail-title").element).toBe(title);
    expect(wrapper.text()).toContain("版本 4");
    mocks.detail.mockRejectedValueOnce(
      new ApiRequestError(403, "FORBIDDEN", "无权查看接待", "test", {}),
    );
    await vi.advanceTimersByTimeAsync(15000);
    await flushPromises();
    expect(wrapper.find("#reception-detail-title").exists()).toBe(false);
    expect(wrapper.text()).toContain("无权查看接待");
  });
  it("filters by service date, status, therapist and reception number, and separates plans from service facts", async () => {
    const { wrapper } = await render();
    await wrapper.get("#service-date").setValue("2026-09-12");
    await wrapper.get("#reception-state").setValue("confirmed");
    await wrapper.get("#reception-therapist").setValue(user.id);
    await wrapper.get("#reception-number").setValue(id);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(mocks.list).toHaveBeenLastCalledWith({
      serviceDate: "2026-09-12",
      state: "confirmed",
      therapistId: user.id,
      receptionId: id,
    });
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("必要休息");
    expect(wrapper.text()).toContain("时间经过不代表已经到店");
    expect(wrapper.text()).toContain("2026/09/12");
    expect(wrapper.text()).toContain("无资金查看权限");
  });
  it("discards an older detail response after selecting another reception", async () => {
    let first!: (value: unknown) => void;
    mocks.detail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    );
    const { wrapper } = await render();
    await wrapper.findAll(".reception-row")[0]!.trigger("click");
    await wrapper.findAll(".reception-row")[1]!.trigger("click");
    await flushPromises();
    first({ ...access, item: record() });
    await flushPromises();
    expect(wrapper.get("#reception-detail-title").text()).toBe("陈女士的接待");
  });
  it("keeps the original request through unknown → busy → refresh → success, even after its deadline", async () => {
    mocks.confirm
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(
        new ApiRequestError(409, "RESOURCE_BUSY_RETRY", "资源繁忙", "test", {}),
      )
      .mockResolvedValue({
        receptionId: id,
        state: "confirmed",
        version: 4,
        quoteCents: "9500",
      });
    const { wrapper, router } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    await clickText(wrapper, "确认接待");
    const original = mocks.confirm.mock.calls[0];
    expect(original?.slice(0, 2)).toEqual([id, 3]);
    expect(
      wrapper.get("#service-date").element.closest("fieldset")?.disabled,
    ).toBe(true);
    await router.push("/dashboard");
    expect(router.currentRoute.value.path).toBe("/receptions");
    await clickText(wrapper, "核实原确认结果");
    expect(mocks.confirm.mock.calls[1]).toEqual(original);
    wrapper.unmount();
    vi.setSystemTime("2026-09-11T03:00:00Z");
    const restored = await render();
    expect(restored.wrapper.text()).toContain(id);
    mocks.detail.mockResolvedValue({
      ...access,
      item: {
        ...record(),
        state: "confirmed",
        version: 4,
        confirmationDeadline: null,
      },
    });
    await clickText(restored.wrapper, "核实原确认结果");
    expect(mocks.confirm.mock.calls[2]).toEqual(original);
    expect(sessionStorage.getItem("dexian:reception-confirmation")).toBeNull();
    expect(restored.wrapper.text()).toContain("接待当前已确认");
    expect(mocks.list.mock.calls.length).toBeGreaterThan(1);
  });
  it("preserves an unknown request across session expiry and prevents a different employee replaying it", async () => {
    mocks.confirm.mockRejectedValue(
      new ApiRequestError(401, "AUTH_REQUIRED", "请先登录", "test", {}),
    );
    const { wrapper, router } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    await clickText(wrapper, "确认接待");
    expect(router.currentRoute.value.path).toBe("/login");
    expect(
      sessionStorage.getItem("dexian:reception-confirmation"),
    ).not.toBeNull();
    wrapper.unmount();
    mocks.session.mockResolvedValue({ user: { ...user, id: nextId } });
    const restored = await render();
    expect(restored.wrapper.text()).toContain("原员工账号");
    expect(
      restored.wrapper
        .findAll("button")
        .some((b) => b.text() === "核实原确认结果"),
    ).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });
  it("refreshes both detail and list on a version conflict without reporting success", async () => {
    mocks.confirm.mockRejectedValue(
      new ApiRequestError(
        409,
        "VERSION_CONFLICT",
        "其他同事已更新安排",
        "test",
        {},
      ),
    );
    const { wrapper } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    mocks.detail.mockResolvedValue({
      ...access,
      item: { ...record(), version: 4 },
    });
    await clickText(wrapper, "确认接待");
    expect(wrapper.text()).toContain("其他同事已更新安排");
    expect(wrapper.text()).toContain("版本 4");
    expect(wrapper.text()).not.toContain("接待当前已确认");
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
  it("refreshes the filtered total when a hold expires, and shows empty instead of stale rows", async () => {
    const item = {
      ...record(),
      confirmationDeadline: "2026-09-11T01:00:01.000Z",
    };
    mocks.list
      .mockResolvedValueOnce({
        ...access,
        total: 1,
        items: [item],
        nextCursor: null,
        therapists: [],
      })
      .mockResolvedValue({
        ...access,
        serverNow: "2026-09-11T01:00:02.000Z",
        total: 0,
        items: [],
        nextCursor: null,
        therapists: [],
      });
    const { wrapper } = await render();
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(wrapper.text()).toContain("0 组");
    expect(wrapper.findAll(".reception-row")).toHaveLength(0);
  });
  it("clears the previous detail on forbidden access and displays an actionable reason", async () => {
    const { wrapper } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    mocks.detail.mockRejectedValue(
      new ApiRequestError(
        403,
        "RECEPTION_STORE_FORBIDDEN",
        "不能查看其他门店的接待",
        "test",
        {},
      ),
    );
    await wrapper.findAll(".reception-row")[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.find("#reception-detail-title").exists()).toBe(false);
    expect(wrapper.text()).toContain("不能查看其他门店");
  });
  it("does not send a write if the recovery request cannot be persisted", async () => {
    const { wrapper } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    const spy = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await clickText(wrapper, "确认接待");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("本次尚未发送");
    spy.mockRestore();
  });
  it("returns to the first page when the current cursor no longer matches the filter", async () => {
    mocks.list
      .mockResolvedValueOnce({
        ...access,
        total: 26,
        items: [record()],
        nextCursor: nextId,
        therapists: [],
      })
      .mockRejectedValueOnce(
        new ApiRequestError(
          400,
          "INVALID_CURSOR",
          "列表已变化，请重新查询",
          "test",
          {},
        ),
      )
      .mockResolvedValueOnce({
        ...access,
        total: 1,
        items: [record()],
        nextCursor: null,
        therapists: [],
      });
    const { wrapper } = await render();
    await clickText(wrapper, "下一页");
    expect(mocks.list).toHaveBeenNthCalledWith(2, {
      serviceDate: "2026-09-11",
      after: nextId,
    });
    expect(mocks.list).toHaveBeenNthCalledWith(3, {
      serviceDate: "2026-09-11",
    });
    expect(wrapper.text()).toContain("查询结果已变化，已返回第一页");
    expect(wrapper.text()).toContain("第 1 页");
  });
  it("clears the previous employee's detail when a refreshed list changes identity", async () => {
    const nextUser = { ...user, id: "10000000-0000-4000-8000-000000000009" };
    mocks.list.mockResolvedValueOnce({
      ...access,
      total: 1,
      items: [record()],
      nextCursor: null,
      therapists: [],
    });
    const { wrapper } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    expect(wrapper.get("#reception-detail-title").text()).toContain("林女士");
    mocks.list.mockResolvedValueOnce({
      ...access,
      user: nextUser,
      total: 0,
      items: [],
      nextCursor: null,
      therapists: [],
    });
    await clickText(wrapper, "刷新列表与详情");
    expect(wrapper.find("#reception-detail-title").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("138****0000");
    expect(wrapper.text()).toContain("选择一条接待");
  });
  it("clears protected content when invalid-cursor recovery is denied", async () => {
    mocks.list
      .mockResolvedValueOnce({
        ...access,
        total: 26,
        items: [record()],
        nextCursor: nextId,
        therapists: [],
      })
      .mockRejectedValueOnce(
        new ApiRequestError(
          400,
          "INVALID_CURSOR",
          "列表已变化，请重新查询",
          "test",
          {},
        ),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(
          403,
          "PERMISSION_DENIED",
          "当前账号无权查看接待",
          "test",
          {},
        ),
      );
    const { wrapper } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("138****0000");

    await clickText(wrapper, "下一页");

    expect(wrapper.find("#reception-detail-title").exists()).toBe(false);
    expect(wrapper.findAll(".reception-row")).toHaveLength(0);
    expect(wrapper.text()).not.toContain("138****0000");
    expect(wrapper.text()).toContain("当前账号无权查看接待");
  });
  it("clears the old list when detail changes identity and ignores its in-flight refresh", async () => {
    const nextUser = { ...user, id: "10000000-0000-4000-8000-000000000009" };
    const oldList = {
      ...access,
      total: 2,
      items: [record(), record(nextId)],
      nextCursor: null,
      therapists: [],
    };
    let resolveOldList!: (value: typeof oldList) => void;
    mocks.list.mockResolvedValueOnce(oldList).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldList = resolve;
        }),
    );
    mocks.detail.mockResolvedValue({
      ...access,
      user: nextUser,
      item: { ...record(), customerName: "新账号顾客" },
    });
    const { wrapper } = await render();
    const refresh = wrapper
      .findAll("button")
      .find((button) => button.text() === "刷新列表与详情")!;
    await refresh.trigger("click");
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();

    expect(wrapper.get("#reception-detail-title").text()).toContain(
      "新账号顾客",
    );
    expect(wrapper.findAll(".reception-row")).toHaveLength(0);
    resolveOldList(oldList);
    await flushPromises();
    expect(wrapper.get("#reception-detail-title").text()).toContain(
      "新账号顾客",
    );
    expect(wrapper.findAll(".reception-row")).toHaveLength(0);
  });
  it("sends the saved initiator and preserves recovery after server identity rejection", async () => {
    mocks.confirm.mockRejectedValue(
      new ApiRequestError(
        409,
        "RECEPTION_CONFIRM_IDENTITY_CHANGED",
        "当前登录员工或门店已变化，请切回原账号后继续核实",
        "test",
        {},
      ),
    );
    const { wrapper } = await render();
    await wrapper.get(".reception-row").trigger("click");
    await flushPromises();
    await clickText(wrapper, "确认接待");

    expect(mocks.confirm.mock.calls[0]![3]).toEqual({
      staffUserId: user.id,
      storeId: user.storeId,
    });
    expect(
      sessionStorage.getItem("dexian:reception-confirmation"),
    ).not.toBeNull();
    expect(wrapper.find("#reception-detail-title").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("138****0000");
    expect(wrapper.text()).toContain("原确认请求已保留");
  });
});
