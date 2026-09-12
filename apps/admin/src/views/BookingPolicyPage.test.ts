// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../lib/api";
import type {
  BookingPolicyRevision,
  BookingPolicyWorkspace,
  PolicyPreview,
} from "../lib/booking-policy-api";
import { saveBookingPolicyRecovery } from "../lib/booking-policy-recovery";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  versions: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
  publish: vi.fn(),
  activation: vi.fn(),
}));

vi.mock("../lib/booking-policy-api", async (original) => ({
  ...(await original<typeof import("../lib/booking-policy-api")>()),
  getBookingPolicyWorkspace: mocks.workspace,
  getBookingPolicyVersions: mocks.versions,
  saveBookingPolicyDraft: mocks.save,
  previewBookingPolicy: mocks.preview,
  publishBookingPolicy: mocks.publish,
  setBookingPolicyActivation: mocks.activation,
}));

import BookingPolicyPage from "./BookingPolicyPage.vue";

const payload = {
  version: 2 as const,
  maxAdvanceDays: 14,
  minimumLeadMinutes: 60,
  startGridMinutes: 30,
  onlineHoldMinutes: 120,
  onsiteHoldMinutes: 30,
  weeklyRules: [
    {
      weekday: 1,
      intervals: [
        { startMinute: 540, endMinute: 1_080, endDayOffset: 0 as const },
      ],
    },
  ],
  dateExceptions: [],
  processingWeeklyRules: [
    {
      weekday: 1,
      intervals: [
        { startMinute: 540, endMinute: 1_080, endDayOffset: 0 as const },
      ],
    },
  ],
  processingDateExceptions: [],
};

function workspace(
  userId = "staff-a",
  storeId = "store-a",
): BookingPolicyWorkspace {
  return {
    user: {
      id: userId,
      storeId,
      username: "manager",
      displayName: "值班店长",
    },
    canEdit: true,
    canPublish: true,
    serverNow: "2026-09-12T01:00:00.000Z",
    store: {
      id: storeId,
      name: storeId === "store-a" ? "金宝店" : "银泰店",
      timeZone: "Asia/Shanghai",
      bookingCreationMode: "legacy",
    },
    published: null,
    latestDraft: {
      id: "draft-a",
      kind: "draft",
      sourceDraftRevisionId: null,
      publishedVersion: null,
      basePublishedVersion: null,
      payload,
      createdByStaffId: userId,
      createdByName: "值班店长",
      changeReason: null,
      publishedAt: null,
      createdAt: "2026-09-12T01:00:00.000Z",
    },
  };
}

function publishedRevision(
  id: string,
  changeReason: string,
  userId = "staff-a",
): BookingPolicyRevision {
  return {
    ...workspace(userId).latestDraft!,
    id,
    kind: "published",
    sourceDraftRevisionId: "draft-source",
    publishedVersion: 1,
    changeReason,
    publishedAt: "2026-09-12T01:30:00.000Z",
  };
}

const ElButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  emits: ["click"],
  template:
    '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/booking-policy", component: BookingPolicyPage },
      { path: "/login", component: { template: "<div>登录</div>" } },
      { path: "/dashboard", component: { template: "<div />" } },
      { path: "/calendar", component: { template: "<div />" } },
      { path: "/receptions", component: { template: "<div />" } },
    ],
  });
  await router.push("/booking-policy");
  await router.isReady();
  const wrapper = mount(BookingPolicyPage, {
    global: {
      plugins: [router],
      stubs: { ElButton: ElButtonStub, ElSkeleton: true },
    },
  });
  await flushPromises();
  return { wrapper, router };
}

describe("booking policy page", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mocks.workspace.mockResolvedValue(workspace());
    mocks.versions.mockResolvedValue({
      user: workspace().user,
      items: [],
      nextCursor: null,
    });
    mocks.save.mockResolvedValue({
      draftRevisionId: "draft-b",
      createdAt: "2026-09-12T02:00:00.000Z",
    });
    mocks.preview.mockResolvedValue({
      user: workspace().user,
      evaluatedAt: "2026-09-12T02:00:00.000Z",
      draftRevisionId: "draft-b",
      basePublishedVersion: null,
      currentPublishedVersion: null,
      canPublish: true,
      changes: [],
      expandedDays: [],
      impacts: [],
    });
    mocks.publish.mockResolvedValue({
      publishedRevisionId: "published-a",
      publishedVersion: 1,
      publishedAt: "2026-09-12T03:00:00.000Z",
    });
  });

  it("saves the complete draft and immediately previews its impact", async () => {
    const { wrapper } = await mountPage();
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存草稿并预览"));
    expect(saveButton).toBeDefined();
    await saveButton!.trigger("click");
    await flushPromises();

    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        initiatingStaffUserId: "staff-a",
        initiatingStoreId: "store-a",
        basePublishedVersion: null,
        payload,
      }),
      expect.any(String),
    );
    expect(mocks.preview).toHaveBeenCalledWith("draft-b");
    expect(wrapper.text()).toContain("草稿已保存为不可变修订");
  });

  it("shows separate configurable online and onsite timing with processing hours", async () => {
    const { wrapper } = await mountPage();

    expect(
      (
        wrapper.find('input[placeholder="例如 120"]')
          .element as HTMLInputElement
      ).value,
    ).toBe("120");
    expect(
      (wrapper.find('input[placeholder="例如 30"]').element as HTMLInputElement)
        .value,
    ).toBe("30");
    expect(wrapper.text()).toContain("前台处理日历");
    expect(wrapper.text()).toContain("线上期限只累计两者交集");
    expect(wrapper.text()).toContain("待现场接待入口接入");
  });

  it("does not save an enabled calendar day until an interval is present", async () => {
    const { wrapper } = await mountPage();
    const removeButton = wrapper
      .findAll("button")
      .find((button) => button.text() === "移除");
    expect(removeButton).toBeDefined();
    await removeButton!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain(
      "已启用的营业日、处理日和替代日期都必须至少添加一个区间",
    );
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存草稿并预览"));
    expect(saveButton?.attributes("disabled")).toBeDefined();
    await saveButton!.trigger("click");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not invent V2 timing defaults for a V1 draft or history item", async () => {
    const legacyPayload = {
      maxAdvanceDays: payload.maxAdvanceDays,
      minimumLeadMinutes: payload.minimumLeadMinutes,
      startGridMinutes: payload.startGridMinutes,
      weeklyRules: payload.weeklyRules,
      dateExceptions: payload.dateExceptions,
    };
    const legacyWorkspace = workspace();
    legacyWorkspace.latestDraft = {
      ...legacyWorkspace.latestDraft!,
      payload: legacyPayload,
    };
    mocks.workspace.mockResolvedValue(legacyWorkspace);
    mocks.versions.mockResolvedValue({
      user: legacyWorkspace.user,
      items: [
        {
          ...publishedRevision("legacy-policy", "旧版政策"),
          payload: legacyPayload,
        },
      ],
      nextCursor: null,
    });

    const { wrapper } = await mountPage();
    expect(
      (
        wrapper.find('input[placeholder="例如 120"]')
          .element as HTMLInputElement
      ).value,
    ).toBe("");
    expect(wrapper.text()).toContain("旧版本不会自动补默认值");
    expect(wrapper.text()).toContain("固定十个自然分钟的历史行为");
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存草稿并预览"));
    expect(saveButton?.attributes("disabled")).toBeDefined();
  });

  it("invalidates the preview as soon as the editor differs from its draft", async () => {
    const savedWorkspace = workspace();
    savedWorkspace.latestDraft = {
      ...savedWorkspace.latestDraft!,
      id: "draft-b",
    };
    mocks.workspace
      .mockReset()
      .mockResolvedValueOnce(workspace())
      .mockResolvedValue(savedWorkspace);
    const { wrapper } = await mountPage();
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存草稿并预览"));
    await saveButton!.trigger("click");
    await flushPromises();

    await wrapper.find(".reason-field textarea").setValue("启用首版");
    await wrapper.find(".policy-parameters input").setValue("99");
    await flushPromises();

    expect(wrapper.text()).toContain("请先保存为新草稿并重新预览");
    expect(
      wrapper
        .findAll("button")
        .some((button) => button.text().includes("发布当前草稿修订")),
    ).toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("clears the previous store editor before saving for a new identity", async () => {
    const nextWorkspace = workspace("staff-b", "store-b");
    nextWorkspace.latestDraft = null;
    mocks.workspace
      .mockReset()
      .mockResolvedValueOnce(workspace())
      .mockResolvedValue(nextWorkspace);
    mocks.versions
      .mockReset()
      .mockResolvedValueOnce({
        user: workspace().user,
        items: [],
        nextCursor: null,
      })
      .mockResolvedValue({
        user: nextWorkspace.user,
        items: [],
        nextCursor: null,
      });
    mocks.preview.mockResolvedValue({
      user: nextWorkspace.user,
      evaluatedAt: "2026-09-12T02:00:00.000Z",
      draftRevisionId: "draft-b",
      basePublishedVersion: null,
      currentPublishedVersion: null,
      canPublish: true,
      changes: [],
      expandedDays: [],
      impacts: [],
    });
    const { wrapper } = await mountPage();
    const refresh = wrapper
      .findAll("button")
      .find((button) => button.text().includes("刷新状态"));
    await refresh!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("银泰店");
    expect(
      (wrapper.find(".policy-parameters input").element as HTMLInputElement)
        .value,
    ).toBe("0");
    await wrapper.find('input[placeholder="例如 120"]').setValue("120");
    await wrapper.find('input[placeholder="例如 30"]').setValue("30");
    const saveButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存草稿并预览"));
    await saveButton!.trigger("click");
    await flushPromises();
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        initiatingStaffUserId: "staff-b",
        initiatingStoreId: "store-b",
        payload: expect.objectContaining({
          version: 2,
          maxAdvanceDays: 0,
          onlineHoldMinutes: 120,
          onsiteHoldMinutes: 30,
        }),
      }),
      expect.any(String),
    );
  });

  it("clears protected policy data when current access is denied", async () => {
    const { wrapper } = await mountPage();
    mocks.workspace.mockRejectedValueOnce(
      new ApiRequestError(
        403,
        "PERMISSION_DENIED",
        "当前账号无权查看预约政策。",
        "request-403",
        {},
      ),
    );
    const refresh = wrapper
      .findAll("button")
      .find((button) => button.text().includes("刷新状态"));
    await refresh!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("当前账号无权查看预约政策");
    expect(wrapper.text()).not.toContain("金宝店");
    expect(wrapper.find(".policy-editor").exists()).toBe(false);
  });

  it("applies identity changes from stale data responses without restoring stale data", async () => {
    const nextWorkspace = workspace("staff-b", "store-b");
    let resolveOlder!: (value: BookingPolicyWorkspace) => void;
    const olderResponse = new Promise<BookingPolicyWorkspace>((resolve) => {
      resolveOlder = resolve;
    });
    const { wrapper } = await mountPage();
    mocks.workspace
      .mockImplementationOnce(() => olderResponse)
      .mockRejectedValueOnce(new Error("latest request failed"));
    const refresh = () =>
      wrapper
        .findAll("button")
        .find((button) => button.text().includes("刷新状态"))!;

    await refresh().trigger("click");
    await refresh().trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("金宝店");

    resolveOlder(nextWorkspace);
    await flushPromises();
    expect(wrapper.text()).not.toContain("金宝店");
    expect(wrapper.find(".policy-editor").exists()).toBe(false);
  });

  it("does not append an old store history page after a new identity refresh", async () => {
    const currentWorkspace = workspace();
    const nextWorkspace = workspace("staff-b", "store-b");
    let resolveOldPage!: (value: {
      user: BookingPolicyWorkspace["user"];
      items: BookingPolicyRevision[];
      nextCursor: string | null;
    }) => void;
    const oldPage = new Promise<{
      user: BookingPolicyWorkspace["user"];
      items: BookingPolicyRevision[];
      nextCursor: string | null;
    }>((resolve) => {
      resolveOldPage = resolve;
    });
    mocks.workspace
      .mockReset()
      .mockResolvedValueOnce(currentWorkspace)
      .mockResolvedValueOnce(nextWorkspace);
    mocks.versions
      .mockReset()
      .mockResolvedValueOnce({
        user: currentWorkspace.user,
        items: [publishedRevision("published-a", "A 门店当前版本")],
        nextCursor: "cursor-a",
      })
      .mockImplementationOnce(() => oldPage)
      .mockResolvedValueOnce({
        user: nextWorkspace.user,
        items: [publishedRevision("published-b", "B 门店当前版本", "staff-b")],
        nextCursor: null,
      });
    const { wrapper } = await mountPage();
    const olderButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("加载更早版本"));
    await olderButton!.trigger("click");

    const refresh = wrapper
      .findAll("button")
      .find((button) => button.text().includes("刷新状态"));
    await refresh!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("B 门店当前版本");

    resolveOldPage({
      user: currentWorkspace.user,
      items: [publishedRevision("published-a-old", "A 门店更早版本")],
      nextCursor: "cursor-a-old",
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain("A 门店更早版本");
    expect(
      wrapper
        .findAll("button")
        .some((button) => button.text().includes("加载更早版本")),
    ).toBe(false);
  });

  it("does not apply an old preview after a new identity refresh", async () => {
    const currentWorkspace = workspace();
    currentWorkspace.store.bookingCreationMode = "paused_for_policy_activation";
    const nextWorkspace = workspace("staff-b", "store-b");
    nextWorkspace.store.bookingCreationMode = "paused_for_policy_activation";
    let resolveOldPreview!: (value: PolicyPreview) => void;
    const oldPreview = new Promise<PolicyPreview>((resolve) => {
      resolveOldPreview = resolve;
    });
    mocks.workspace
      .mockReset()
      .mockResolvedValueOnce(currentWorkspace)
      .mockResolvedValueOnce(nextWorkspace);
    mocks.versions
      .mockReset()
      .mockResolvedValueOnce({
        user: currentWorkspace.user,
        items: [],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        user: nextWorkspace.user,
        items: [],
        nextCursor: null,
      });
    mocks.preview.mockReset().mockImplementationOnce(() => oldPreview);
    const { wrapper } = await mountPage();
    const page = (
      wrapper.vm as unknown as {
        $: {
          setupState: {
            load: () => Promise<void>;
            runPreview: () => Promise<void>;
          };
        };
      }
    ).$.setupState;
    void page.runPreview();

    await page.load();
    await flushPromises();
    expect(wrapper.text()).toContain("银泰店");

    resolveOldPreview({
      user: currentWorkspace.user,
      evaluatedAt: "2026-09-12T02:00:00.000Z",
      draftRevisionId: "draft-a",
      basePublishedVersion: null,
      currentPublishedVersion: null,
      canPublish: true,
      changes: [
        {
          field: "maxAdvanceDays",
          label: "A 门店旧预览",
          previous: "7 天",
          next: "14 天",
        },
      ],
      expandedDays: [],
      impacts: [],
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain("A 门店旧预览");
  });

  it("offers the original-login flow after a recovery request gets 401", async () => {
    saveBookingPolicyRecovery({
      operation: "publish",
      key: "publish-original-key",
      input: {
        initiatingStaffUserId: "staff-a",
        initiatingStoreId: "store-a",
        draftRevisionId: "draft-a",
        basePublishedVersion: null,
        changeReason: "首次启用",
      },
    });
    mocks.publish.mockRejectedValueOnce(
      new ApiRequestError(401, "AUTH_REQUIRED", "请先登录", "request-401", {}),
    );
    const { wrapper, router } = await mountPage();
    const retry = wrapper
      .findAll("button")
      .find((button) => button.text().includes("使用原请求核实"));
    await retry!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("重新登录原账号并核实");
    const login = wrapper
      .findAll("button")
      .find((button) => button.text().includes("重新登录原账号并核实"));
    await login!.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/login");
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("locks new actions and sends another employee to the original-login flow", async () => {
    saveBookingPolicyRecovery({
      operation: "publish",
      key: "publish-original-key",
      input: {
        initiatingStaffUserId: "staff-a",
        initiatingStoreId: "store-a",
        draftRevisionId: "draft-a",
        basePublishedVersion: null,
        changeReason: "首次启用",
      },
    });
    mocks.workspace.mockResolvedValue(workspace("staff-b"));
    mocks.versions.mockResolvedValue({
      user: workspace("staff-b").user,
      items: [],
      nextCursor: null,
    });
    const { wrapper, router } = await mountPage();
    expect(wrapper.text()).toContain("存在尚未核实的政策操作");
    const retry = wrapper
      .findAll("button")
      .find((button) => button.text().includes("重新登录原账号并核实"));
    await retry!.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/login");
    expect(router.currentRoute.value.query.redirect).toBe("/booking-policy");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
