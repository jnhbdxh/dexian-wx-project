// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPaymentReviewQueue: vi.fn(),
  reconcilePayment: vi.fn(),
  logout: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  getPaymentReviewQueue: mocks.getPaymentReviewQueue,
  reconcilePayment: mocks.reconcilePayment,
  logout: mocks.logout,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));

vi.mock("element-plus", () => ({
  ElMessage: { success: mocks.success },
}));

import PaymentReviewPage from "./PaymentReviewPage.vue";

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean, type: String, plain: Boolean },
  emits: ["click"],
  template:
    '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

const payment = {
  paymentId: "00000000-0000-4000-8000-000000000001",
  receptionId: "00000000-0000-4000-8000-000000000002",
  outTradeNo: "202609110001",
  state: "manual_review" as const,
  customerName: "张女士",
  amountCents: "32800",
  collectionDeadline: "2026-09-11T08:00:00.000Z",
  checkAttempts: 20,
  lastErrorCode: "REQUEST_FAILED",
  lastErrorMessage: "微信渠道连续超时",
  nextCheckAt: null,
  updatedAt: "2026-09-11T06:00:00.000Z",
};

function queue(payments = [payment]) {
  return {
    user: {
      id: "00000000-0000-4000-8000-000000000003",
      storeId: "00000000-0000-4000-8000-000000000004",
      username: "frontdesk",
      displayName: "前台",
    },
    canReconcilePayments: true,
    channelConfigured: true,
    payments,
    nextCursor: null,
  };
}

afterEach(() => vi.resetAllMocks());

describe("payment review workbench", () => {
  it("shows the last channel result and performs a controlled re-query", async () => {
    mocks.getPaymentReviewQueue
      .mockResolvedValueOnce(queue())
      .mockResolvedValueOnce(queue([]));
    mocks.reconcilePayment.mockResolvedValue({
      ...payment,
      state: "succeeded",
    });
    const wrapper = mount(PaymentReviewPage, {
      global: {
        stubs: { ElButton: ElButtonStub, ElSkeleton: true },
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("张女士");
    expect(wrapper.text()).toContain("微信渠道连续超时");
    expect(wrapper.text()).toContain("重新查单只读取微信订单状态");
    expect(
      wrapper.find(".payment-review-item").attributes("aria-pressed"),
    ).toBe("true");

    await wrapper.find(".payment-review-action button").trigger("click");
    await flushPromises();

    expect(mocks.reconcilePayment).toHaveBeenCalledWith(payment.paymentId);
    expect(mocks.success).toHaveBeenCalledWith("微信查单已完成");
    expect(wrapper.text()).toContain("已向微信确认支付成功");
    expect(wrapper.text()).toContain("当前没有异常支付");
  });
});
