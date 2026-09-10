// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { defineComponent } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../lib/api";

const mocks = vi.hoisted(() => ({
  createLeave: vi.fn(),
  getLeaveWorkbench: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  createLeave: mocks.createLeave,
  getLeaveWorkbench: mocks.getLeaveWorkbench,
  login: mocks.login,
  logout: mocks.logout,
}));

vi.mock("element-plus", () => ({
  ElMessage: { success: mocks.success },
}));

import LoginPage from "./LoginPage.vue";
import SchedulingPage from "./SchedulingPage.vue";

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean, nativeType: String },
  emits: ["click"],
  template:
    '<button :type="nativeType || \'button\'" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});
const ElFormStub = defineComponent({
  emits: ["submit"],
  template: "<form @submit.prevent=\"$emit('submit', $event)\"><slot /></form>",
});
const ElInputStub = defineComponent({
  props: { modelValue: String, type: String },
  emits: ["update:modelValue"],
  template:
    '<input :type="type || \'text\'" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

function pageData() {
  return {
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      storeId: "00000000-0000-4000-8000-000000000002",
      username: "frontdesk",
      displayName: "前台",
    },
    serverNow: "2026-09-10T01:00:00.000Z",
    canCreateLeave: true,
    therapists: [{ id: "00000000-0000-4000-8000-000000000003", name: "小满" }],
    conflictTotal: 0,
    conflicts: [],
    nextCursor: null,
  };
}

afterEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
});

describe("leave recovery with Vue Router", () => {
  it("blocks ordinary navigation and restores the same request after login", async () => {
    mocks.getLeaveWorkbench.mockResolvedValue(pageData());
    mocks.createLeave
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockRejectedValueOnce(
        new ApiRequestError(401, "AUTH_REQUIRED", "请先登录", "r-1", {}),
      )
      .mockResolvedValueOnce({
        restrictionId: "00000000-0000-4000-8000-000000000004",
        state: "active",
        invalidatedPendingCount: 0,
        affectedConfirmedCount: 0,
        invalidatedReceptions: [],
        conflicts: [],
      });
    mocks.login.mockResolvedValue({ user: pageData().user });
    const EmptyPage = defineComponent({ template: "<div>其他页面</div>" });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/scheduling", component: SchedulingPage },
        { path: "/login", component: LoginPage },
        { path: "/dashboard", component: EmptyPage },
      ],
    });
    await router.push("/scheduling");
    await router.isReady();
    const wrapper = mount(RouterView, {
      global: {
        plugins: [router],
        stubs: {
          ElButton: ElButtonStub,
          ElForm: ElFormStub,
          ElFormItem: { template: "<label><slot /></label>" },
          ElInput: ElInputStub,
          ElResult: true,
          ElSkeleton: true,
        },
      },
    });
    await flushPromises();
    await wrapper.find("#leave-start").setValue("2026-09-11T13:00");
    await wrapper.find("#leave-end").setValue("2026-09-11T14:00");
    await wrapper.find("#leave-reason").setValue("需要恢复的请假");
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();
    const originalCall = mocks.createLeave.mock.calls[0];

    await router.push("/dashboard");
    expect(router.currentRoute.value.path).toBe("/scheduling");
    await wrapper.find(".leave-submit-alert button").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(
      "/login?redirect=/scheduling",
    );

    const loginInputs = wrapper.findAll("input");
    await loginInputs[0]!.setValue("frontdesk");
    await loginInputs[1]!.setValue("password");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/scheduling");
    expect(wrapper.find("#leave-reason").element).toHaveProperty(
      "value",
      "需要恢复的请假",
    );

    await wrapper.find(".leave-submit-alert button").trigger("click");
    await flushPromises();
    expect(mocks.createLeave).toHaveBeenCalledTimes(3);
    for (const call of mocks.createLeave.mock.calls)
      expect(call).toEqual(originalCall);
    expect(sessionStorage.getItem("dexian:unverified-leave")).toBeNull();
  });

  it.each([
    new ApiRequestError(401, "AUTH_REQUIRED", "请先登录", "r-401", {}),
    new ApiRequestError(403, "CSRF_INVALID", "页面状态失效", "r-403", {}),
  ])(
    "allows the login redirect when the first request loses identity",
    async (error) => {
      mocks.getLeaveWorkbench.mockResolvedValue(pageData());
      mocks.createLeave.mockRejectedValue(error);
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: "/scheduling", component: SchedulingPage },
          { path: "/login", component: LoginPage },
        ],
      });
      await router.push("/scheduling");
      await router.isReady();
      const wrapper = mount(RouterView, {
        global: {
          plugins: [router],
          stubs: {
            ElButton: ElButtonStub,
            ElForm: ElFormStub,
            ElFormItem: { template: "<label><slot /></label>" },
            ElInput: ElInputStub,
            ElResult: true,
            ElSkeleton: true,
          },
        },
      });
      await flushPromises();
      await wrapper.find("#leave-start").setValue("2026-09-11T13:00");
      await wrapper.find("#leave-end").setValue("2026-09-11T14:00");
      await wrapper.find("#leave-reason").setValue("首次提交即身份失效");
      await wrapper.find(".leave-form").trigger("submit");
      await flushPromises();

      expect(router.currentRoute.value.fullPath).toBe(
        "/login?redirect=/scheduling",
      );
      expect(sessionStorage.getItem("dexian:unverified-leave")).toBeNull();
    },
  );

  it("keeps the original request when another tab changes the login", async () => {
    mocks.getLeaveWorkbench.mockResolvedValue(pageData());
    mocks.createLeave
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockRejectedValueOnce(
        new ApiRequestError(
          409,
          "LEAVE_REQUEST_IDENTITY_CHANGED",
          "当前登录员工或门店已变化",
          "r-changed",
          {},
        ),
      );
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/scheduling", component: SchedulingPage },
        { path: "/login", component: LoginPage },
      ],
    });
    await router.push("/scheduling");
    await router.isReady();
    const wrapper = mount(RouterView, {
      global: {
        plugins: [router],
        stubs: {
          ElButton: ElButtonStub,
          ElForm: ElFormStub,
          ElFormItem: { template: "<label><slot /></label>" },
          ElInput: ElInputStub,
          ElResult: true,
          ElSkeleton: true,
        },
      },
    });
    await flushPromises();
    await wrapper.find("#leave-start").setValue("2026-09-11T13:00");
    await wrapper.find("#leave-end").setValue("2026-09-11T14:00");
    await wrapper.find("#leave-reason").setValue("跨标签页身份核对");
    await wrapper.find(".leave-form").trigger("submit");
    await flushPromises();
    const originalCall = mocks.createLeave.mock.calls[0];

    await wrapper.find(".leave-submit-alert button").trigger("click");
    await flushPromises();

    expect(mocks.createLeave.mock.calls[1]).toEqual(originalCall);
    expect(wrapper.find(".leave-submit-alert").text()).toContain(
      "当前登录账号已变化",
    );
    expect(wrapper.find(".leave-submit-alert").text()).toContain("切回原账号");
    expect(sessionStorage.getItem("dexian:unverified-leave")).toContain(
      originalCall![1] as string,
    );

    await wrapper.find(".leave-submit-alert button").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(
      "/login?redirect=/scheduling",
    );
    expect(sessionStorage.getItem("dexian:unverified-leave")).toContain(
      originalCall![1] as string,
    );
  });
});
