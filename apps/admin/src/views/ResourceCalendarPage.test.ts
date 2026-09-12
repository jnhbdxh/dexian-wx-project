// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../lib/api";
import type { ResourceCalendar } from "../lib/resource-calendar-api";

const mocks = vi.hoisted(() => ({ calendar: vi.fn() }));
vi.mock("../lib/resource-calendar-api", async (original) => ({
  ...(await original<typeof import("../lib/resource-calendar-api")>()),
  getResourceCalendar: mocks.calendar,
}));

import ResourceCalendarPage from "./ResourceCalendarPage.vue";

const ids = {
  therapist: "10000000-0000-4000-8000-000000000001",
  room: "10000000-0000-4000-8000-000000000002",
  bed: "10000000-0000-4000-8000-000000000003",
  equipment: "10000000-0000-4000-8000-000000000004",
  reception: "30000000-0000-4000-8000-000000000001",
};
const user = {
  id: "40000000-0000-4000-8000-000000000001",
  storeId: "50000000-0000-4000-8000-000000000001",
  username: "frontdesk",
  displayName: "前台",
};
const serverNow = "2026-09-11T01:00:00.000Z";

function result(overrides: Partial<ResourceCalendar> = {}): ResourceCalendar {
  return {
    user,
    serverNow,
    serviceDate: "2026-09-11",
    timeZone: "Asia/Shanghai",
    resources: [
      {
        id: ids.therapist,
        parentResourceId: null,
        name: "小满",
        resourceType: "therapist",
        active: true,
      },
      {
        id: ids.room,
        parentResourceId: null,
        name: "青竹房",
        resourceType: "room",
        active: true,
      },
      {
        id: ids.bed,
        parentResourceId: ids.room,
        name: "一号床",
        resourceType: "bed",
        active: true,
      },
      {
        id: ids.equipment,
        parentResourceId: null,
        name: "热石仪",
        resourceType: "equipment",
        active: true,
      },
    ],
    shifts: [
      {
        id: "shift",
        therapistResourceId: ids.therapist,
        startAt: "2026-09-11T01:00:00.000Z",
        endAt: "2026-09-11T09:00:00.000Z",
      },
    ],
    restrictions: [
      {
        id: "room-restriction",
        resourceId: ids.room,
        resourceName: "青竹房",
        resourceType: "room",
        kind: "other_unavailable",
        startAt: "2026-09-11T05:00:00.000Z",
        endAt: "2026-09-11T06:00:00.000Z",
      },
      {
        id: "equipment-restriction",
        resourceId: ids.equipment,
        resourceName: "热石仪",
        resourceType: "equipment",
        kind: "equipment_fault",
        startAt: "2026-09-11T02:00:00.000Z",
        endAt: "2026-09-11T04:00:00.000Z",
      },
    ],
    allocations: [
      {
        id: "therapist-cleanup",
        resourceId: ids.therapist,
        receptionId: ids.reception,
        guestId: "guest",
        customerName: "林女士",
        serviceItemName: "舒缓护理",
        receptionState: "confirmed",
        confirmationDeadline: null,
        segmentKind: "cleanup",
        startAt: "2026-09-11T03:00:00.000Z",
        endAt: "2026-09-11T03:15:00.000Z",
        expiresAt: null,
        hasConflict: true,
      },
      {
        id: "room-cleanup",
        resourceId: ids.room,
        receptionId: ids.reception,
        guestId: "guest",
        customerName: "林女士",
        serviceItemName: "舒缓护理",
        receptionState: "confirmed",
        confirmationDeadline: null,
        segmentKind: "cleanup",
        startAt: "2026-09-11T03:00:00.000Z",
        endAt: "2026-09-11T03:20:00.000Z",
        expiresAt: null,
        hasConflict: false,
      },
      {
        id: "bed-cleanup",
        resourceId: ids.bed,
        receptionId: ids.reception,
        guestId: "guest",
        customerName: "林女士",
        serviceItemName: "舒缓护理",
        receptionState: "confirmed",
        confirmationDeadline: null,
        segmentKind: "cleanup",
        startAt: "2026-09-11T03:00:00.000Z",
        endAt: "2026-09-11T03:20:00.000Z",
        expiresAt: null,
        hasConflict: false,
      },
    ],
    ...overrides,
  };
}

const Button = defineComponent({
  props: { loading: Boolean, disabled: Boolean },
  emits: ["click"],
  template:
    '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
});
const wrappers: Array<ReturnType<typeof mount>> = [];

async function render() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/calendar", component: ResourceCalendarPage },
      { path: "/login", component: { template: "<p>登录</p>" } },
      { path: "/receptions", component: { template: "<p>接待详情</p>" } },
      { path: "/dashboard", component: { template: "<p>工作台</p>" } },
      { path: "/scheduling", component: { template: "<p>请假</p>" } },
    ],
  });
  await router.push("/calendar");
  await router.isReady();
  const wrapper = mount(defineComponent({ template: "<router-view />" }), {
    global: {
      plugins: [router],
      stubs: { ElButton: Button, ElSkeleton: true },
    },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}

function button(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll("button").find((item) => item.text() === label)!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(serverNow);
  vi.resetAllMocks();
  mocks.calendar.mockResolvedValue(result());
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

describe("resource calendar page", () => {
  it("shows real segments, inherited room limits and equipment summary without inferring availability", async () => {
    const { wrapper, router } = await render();

    expect(wrapper.text()).toContain("空白不代表可预约");
    expect(wrapper.text()).toContain("计划结束也不代表服务已完成");
    expect(wrapper.text()).toContain("整理 · 林女士");
    expect(wrapper.text()).toContain("热石仪");
    expect(wrapper.text()).toContain("不推断设备与项目");
    expect(wrapper.text()).toContain("待处理冲突");
    expect(wrapper.get(".allocation-block").text()).toContain("已确认");
    expect(wrapper.get(".mobile-allocations button").text()).toContain(
      "已确认",
    );

    await button(wrapper, "房间／床位").trigger("click");
    expect(wrapper.text()).toContain("清洁 · 林女士");
    expect(wrapper.text()).toContain("不可用（所属房间）");
    expect(wrapper.text()).toContain("青竹房");
    expect(wrapper.text()).toContain("一号床");

    await wrapper.find(".mobile-allocations button").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value).toMatchObject({
      path: "/receptions",
      query: { receptionId: ids.reception },
    });
  });

  it("keeps the old data date explicit when a new date fails", async () => {
    mocks.calendar
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new TypeError("network"));
    const { wrapper } = await render();

    await button(wrapper, "后一天").trigger("click");
    await flushPromises();

    expect(wrapper.get(".calendar-warning").text()).toContain(
      "2026-09-12 尚未读取成功",
    );
    expect(wrapper.get(".calendar-warning").text()).toContain(
      "当前继续展示 2026-09-11 的数据",
    );
    expect(wrapper.get(".calendar-panel h2").text()).toContain("2026-09-11");
  });

  it("removes an expiring hold while the page stays open without another request", async () => {
    mocks.calendar.mockResolvedValue(
      result({
        allocations: [
          {
            ...result().allocations[0]!,
            id: "pending",
            receptionState: "pending",
            confirmationDeadline: "2026-09-11T01:00:01.000Z",
            expiresAt: "2026-09-11T01:00:01.000Z",
            hasConflict: false,
          },
        ],
      }),
    );
    const { wrapper } = await render();
    expect(wrapper.text()).toContain("整理 · 林女士");
    expect(wrapper.text()).toContain("待确认1组");
    expect(wrapper.get(".allocation-block").text()).toContain("待确认");
    expect(wrapper.get(".mobile-allocations button").text()).toContain(
      "待确认",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(wrapper.text()).not.toContain("整理 · 林女士");
    expect(wrapper.text()).toContain("待确认0组");
    expect(mocks.calendar).toHaveBeenCalledTimes(1);
  });

  it("marks previous-day and next-day times on shifts, limits and allocations", async () => {
    mocks.calendar.mockResolvedValue(
      result({
        shifts: [
          {
            id: "cross-day-shift",
            therapistResourceId: ids.therapist,
            startAt: "2026-09-10T15:30:00.000Z",
            endAt: "2026-09-10T16:30:00.000Z",
          },
        ],
        restrictions: [
          {
            id: "cross-day-restriction",
            resourceId: ids.therapist,
            resourceName: "小满",
            resourceType: "therapist",
            kind: "leave",
            startAt: "2026-09-11T15:00:00.000Z",
            endAt: "2026-09-11T16:30:00.000Z",
          },
        ],
        allocations: [
          {
            ...result().allocations[0]!,
            startAt: "2026-09-11T15:30:00.000Z",
            endAt: "2026-09-11T16:30:00.000Z",
          },
        ],
      }),
    );

    const { wrapper } = await render();

    expect(wrapper.get(".mobile-shifts").text()).toContain("前日 23:30–00:30");
    expect(wrapper.get(".mobile-restrictions").text()).toContain(
      "23:00–次日 00:30",
    );
    expect(wrapper.get(".mobile-allocations").text()).toContain(
      "23:30–次日 00:30",
    );
  });

  it("clears old protected data when a stale date response reveals a new identity", async () => {
    let resolveChangedIdentity!: (value: ResourceCalendar) => void;
    mocks.calendar
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(
        () =>
          new Promise<ResourceCalendar>((resolve) => {
            resolveChangedIdentity = resolve;
          }),
      )
      .mockRejectedValueOnce(new TypeError("network"));
    const { wrapper } = await render();

    await button(wrapper, "后一天").trigger("click");
    await button(wrapper, "后一天").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("林女士");

    resolveChangedIdentity(
      result({
        serviceDate: "2026-09-12",
        user: {
          ...user,
          id: "40000000-0000-4000-8000-000000000002",
          storeId: "50000000-0000-4000-8000-000000000002",
          displayName: "新账号",
        },
      }),
    );
    await flushPromises();

    expect(wrapper.text()).not.toContain("林女士");
    expect(wrapper.text()).not.toContain("前台");
    expect(wrapper.text()).toContain("暂时无法读取预约日历");
    expect(wrapper.text()).toContain("日历尚未刷新成功");
  });

  it("keeps the newest response and clears protected data after permission loss", async () => {
    const { wrapper } = await render();
    let resolveOld!: (value: ResourceCalendar) => void;
    mocks.calendar
      .mockImplementationOnce(
        () =>
          new Promise<ResourceCalendar>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(
        result({
          serviceDate: "2026-09-13",
          user: {
            ...user,
            id: "40000000-0000-4000-8000-000000000002",
            storeId: "50000000-0000-4000-8000-000000000002",
            displayName: "新账号",
          },
          allocations: [],
        }),
      );

    await button(wrapper, "后一天").trigger("click");
    await button(wrapper, "后一天").trigger("click");
    await flushPromises();
    resolveOld(result({ serviceDate: "2026-09-12" }));
    await flushPromises();

    expect(wrapper.text()).toContain("新账号");
    expect(wrapper.get(".calendar-panel h2").text()).toContain("2026-09-13");

    mocks.calendar.mockRejectedValueOnce(
      new ApiRequestError(
        403,
        "PERMISSION_DENIED",
        "当前账号无权查看预约日历",
        "request",
        {},
      ),
    );
    await button(wrapper, "后一天").trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain("林女士");
    expect(wrapper.text()).toContain("当前账号无权查看预约日历");
  });
});
