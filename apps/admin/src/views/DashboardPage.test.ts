// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../lib/api";
import {
  loadReceptionConfirmation,
  saveReceptionConfirmation,
} from "../lib/reception-confirmation-recovery";

const mocks = vi.hoisted(() => ({
  confirmReception: vi.fn(),
  getOperationsOverview: vi.fn(),
  logout: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  confirmReception: mocks.confirmReception,
  getOperationsOverview: mocks.getOperationsOverview,
  logout: mocks.logout,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("element-plus", () => ({
  ElMessage: { success: mocks.success },
}));

import DashboardPage from "./DashboardPage.vue";

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  emits: ["click"],
  template:
    '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

function pendingReception(
  receptionId: string,
  customerName: string,
  deadline: string,
) {
  return {
    receptionId,
    customerName,
    confirmationDeadline: deadline,
    quoteCents: "9500",
    version: 1,
    createdAt: "2026-09-10T01:00:00.000Z",
    guests: [
      {
        id: receptionId + "-guest",
        clientGuestId: "guest-1",
        serviceItemName: "舒缓护理",
        therapistName: "小满",
        roomName: "青竹房",
        bedName: "一号床",
        serviceStartAt: "2026-09-11T02:00:00.000Z",
        serviceEndAt: "2026-09-11T03:00:00.000Z",
        quoteCents: "9500",
      },
    ],
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe("confirmation workbench interaction", () => {
  it("redirects a reloaded workbench to the existing recovery flow", async () => {
    const savedAttempt = {
      receptionId: "33333333-3333-4333-8333-333333333333",
      version: 2,
      key: "44444444-4444-4444-8444-444444444444",
      staffUserId: "11111111-1111-4111-8111-111111111111",
      storeId: "22222222-2222-4222-8222-222222222222",
    };
    saveReceptionConfirmation(savedAttempt);

    const wrapper = mount(DashboardPage, {
      global: {
        stubs: {
          ElButton: ElButtonStub,
          ElResult: true,
          ElSkeleton: true,
        },
      },
    });
    await flushPromises();

    expect(mocks.replace).toHaveBeenCalledWith("/receptions");
    expect(mocks.getOperationsOverview).not.toHaveBeenCalled();
    expect(mocks.confirmReception).not.toHaveBeenCalled();
    expect(loadReceptionConfirmation()).toEqual(savedAttempt);

    wrapper.unmount();
  });

  it("keeps an in-flight result bound and replays the same request after local expiry", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-10T01:00:00.000Z");
    vi.setSystemTime(now);
    mocks.getOperationsOverview.mockResolvedValue({
      user: {
        id: "staff-1",
        storeId: "store-1",
        username: "frontdesk",
        displayName: "前台",
      },
      overview: {
        stage: "booking-confirmation",
        serverNow: new Date(now).toISOString(),
        canConfirmReceptions: true,
        pendingConfirmations: [
          pendingReception(
            "reception-a",
            "林女士",
            new Date(now + 1_000).toISOString(),
          ),
          pendingReception(
            "reception-b",
            "陈女士",
            new Date(now + 60_000).toISOString(),
          ),
        ],
      },
    });
    let rejectFirst!: (reason: unknown) => void;
    mocks.confirmReception
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockRejectedValueOnce(
        new ApiRequestError(
          409,
          "RESOURCE_BUSY_RETRY",
          "其他请求正在处理相同资源",
          "request-2",
          {},
        ),
      )
      .mockResolvedValueOnce({
        receptionId: "reception-a",
        state: "confirmed",
        version: 2,
        quoteCents: "9500",
      });

    const wrapper = mount(DashboardPage, {
      global: {
        stubs: {
          ElButton: ElButtonStub,
          ElResult: true,
          ElSkeleton: true,
        },
      },
    });
    await flushPromises();

    await wrapper.find(".confirmation-footer button").trigger("click");
    await flushPromises();
    const queueItems = wrapper.findAll(".queue-item");
    expect(queueItems[1]!.attributes("disabled")).toBeDefined();
    await queueItems[1]!.trigger("click");
    expect(wrapper.find("#detail-title").text()).toBe("林女士");

    rejectFirst(new TypeError("Network request failed"));
    await flushPromises();
    expect(wrapper.find(".confirmation-alert").text()).toContain(
      "暂时无法确定确认结果",
    );
    expect(wrapper.find(".confirmation-footer button").text()).toContain(
      "请先核实结果",
    );
    expect(
      wrapper.find(".confirmation-footer button").attributes("disabled"),
    ).toBeDefined();
    const unavailableQueueItems = wrapper.findAll(".queue-item");
    expect(
      unavailableQueueItems.every(
        (item) => item.attributes("disabled") !== undefined,
      ),
    ).toBe(true);
    expect(
      wrapper.find(".refresh-button").attributes("disabled"),
    ).toBeDefined();
    await unavailableQueueItems[0]!.trigger("click");
    await unavailableQueueItems[1]!.trigger("click");
    await wrapper.find(".refresh-button").trigger("click");
    expect(wrapper.find("#detail-title").text()).toBe("林女士");
    expect(wrapper.find(".confirmation-alert").text()).toContain("核实结果");
    expect(mocks.getOperationsOverview).toHaveBeenCalledTimes(1);
    expect(mocks.confirmReception).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await flushPromises();
    expect(wrapper.find(".confirmation-footer button").text()).toContain(
      "请先核实结果",
    );

    const firstCall = mocks.confirmReception.mock.calls[0];
    await wrapper.find(".confirmation-alert button").trigger("click");
    await flushPromises();
    expect(mocks.confirmReception).toHaveBeenCalledTimes(2);
    expect(mocks.confirmReception.mock.calls[1]).toEqual(firstCall);
    expect(wrapper.find(".confirmation-alert").text()).toContain(
      "暂时还无法核实原请求结果",
    );
    expect(wrapper.find(".confirmation-alert").text()).toContain(
      "核实确认结果",
    );
    const busyQueueItems = wrapper.findAll(".queue-item");
    expect(
      busyQueueItems.every((item) => item.attributes("disabled") !== undefined),
    ).toBe(true);
    expect(
      wrapper.find(".refresh-button").attributes("disabled"),
    ).toBeDefined();
    await busyQueueItems[0]!.trigger("click");
    await busyQueueItems[1]!.trigger("click");
    await wrapper.find(".refresh-button").trigger("click");
    expect(wrapper.find("#detail-title").text()).toBe("林女士");
    expect(mocks.getOperationsOverview).toHaveBeenCalledTimes(1);
    expect(mocks.confirmReception).toHaveBeenCalledTimes(2);

    await wrapper.find(".confirmation-alert button").trigger("click");
    await flushPromises();
    expect(mocks.confirmReception).toHaveBeenCalledTimes(3);
    expect(mocks.confirmReception.mock.calls[2]).toEqual(firstCall);
    expect(wrapper.text()).not.toContain("林女士");
    expect(wrapper.find("#detail-title").text()).toBe("陈女士");

    wrapper.unmount();
  });

  it("preserves the original request and offers original-account login after identity changes", async () => {
    const staffUserId = "11111111-1111-4111-8111-111111111111";
    const storeId = "22222222-2222-4222-8222-222222222222";
    const receptionId = "33333333-3333-4333-8333-333333333333";
    const now = Date.parse("2026-09-10T01:00:00.000Z");
    mocks.getOperationsOverview.mockResolvedValue({
      user: {
        id: staffUserId,
        storeId,
        username: "frontdesk",
        displayName: "前台",
      },
      overview: {
        stage: "booking-confirmation",
        serverNow: new Date(now).toISOString(),
        canConfirmReceptions: true,
        pendingConfirmations: [
          pendingReception(
            receptionId,
            "林女士",
            new Date(now + 60_000).toISOString(),
          ),
        ],
      },
    });
    mocks.confirmReception.mockRejectedValue(
      new ApiRequestError(
        409,
        "RECEPTION_CONFIRM_IDENTITY_CHANGED",
        "当前登录员工或门店已变化，请切回原账号后继续核实",
        "request-identity",
        {},
      ),
    );

    const wrapper = mount(DashboardPage, {
      global: {
        stubs: {
          ElButton: ElButtonStub,
          ElResult: true,
          ElSkeleton: true,
        },
      },
    });
    await flushPromises();

    await wrapper.find(".confirmation-footer button").trigger("click");
    await flushPromises();

    const originalCall = mocks.confirmReception.mock.calls[0]!;
    const savedAttempt = loadReceptionConfirmation();
    expect(originalCall).toEqual([
      receptionId,
      1,
      savedAttempt?.key,
      { staffUserId, storeId },
    ]);
    expect(savedAttempt).toEqual({
      receptionId,
      version: 1,
      key: originalCall[2],
      staffUserId,
      storeId,
    });
    expect(wrapper.find(".confirmation-alert").text()).toContain(
      "登录账号已经变化",
    );
    expect(wrapper.find(".confirmation-alert").text()).toContain(
      "重新登录原账号并核实",
    );

    await wrapper.find(".confirmation-alert button").trigger("click");
    await flushPromises();
    expect(mocks.replace).toHaveBeenCalledWith({
      path: "/login",
      query: { redirect: "/receptions" },
    });
    expect(loadReceptionConfirmation()).toEqual(savedAttempt);

    wrapper.unmount();
  });

  it("keeps an unknown request when its retry is denied before idempotency lookup", async () => {
    const staffUserId = "11111111-1111-4111-8111-111111111111";
    const storeId = "22222222-2222-4222-8222-222222222222";
    const receptionId = "33333333-3333-4333-8333-333333333333";
    const now = Date.parse("2026-09-10T01:00:00.000Z");
    mocks.getOperationsOverview.mockResolvedValue({
      user: {
        id: staffUserId,
        storeId,
        username: "frontdesk",
        displayName: "前台",
      },
      overview: {
        stage: "booking-confirmation",
        serverNow: new Date(now).toISOString(),
        canConfirmReceptions: true,
        pendingConfirmations: [
          pendingReception(
            receptionId,
            "林女士",
            new Date(now + 60_000).toISOString(),
          ),
        ],
      },
    });
    mocks.confirmReception
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockRejectedValueOnce(
        new ApiRequestError(
          403,
          "PERMISSION_DENIED",
          "当前账号没有确认权限",
          "request-forbidden",
          {},
        ),
      );

    const wrapper = mount(DashboardPage, {
      global: {
        stubs: {
          ElButton: ElButtonStub,
          ElResult: true,
          ElSkeleton: true,
        },
      },
    });
    await flushPromises();

    await wrapper.find(".confirmation-footer button").trigger("click");
    await flushPromises();
    const originalCall = mocks.confirmReception.mock.calls[0]!;
    const savedAttempt = loadReceptionConfirmation();

    await wrapper.find(".confirmation-alert button").trigger("click");
    await flushPromises();

    expect(mocks.confirmReception.mock.calls[1]).toEqual(originalCall);
    expect(loadReceptionConfirmation()).toEqual(savedAttempt);
    expect(wrapper.find(".confirmation-alert").text()).toContain(
      "原确认结果仍待核实",
    );
    expect(wrapper.find(".confirmation-alert").text()).toContain(
      "重新登录原账号并核实",
    );
    expect(
      wrapper.find(".confirmation-footer button").attributes("disabled"),
    ).toBeDefined();

    await wrapper.find(".confirmation-alert button").trigger("click");
    await flushPromises();
    expect(mocks.replace).toHaveBeenCalledWith({
      path: "/login",
      query: { redirect: "/receptions" },
    });
    expect(loadReceptionConfirmation()).toEqual(savedAttempt);

    wrapper.unmount();
  });
});
