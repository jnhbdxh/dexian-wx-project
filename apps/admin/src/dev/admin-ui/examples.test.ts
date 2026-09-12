// @vitest-environment happy-dom
import { defineComponent, effectScope } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReceptionExample } from "./use-reception-example";
import ReceptionExample from "./ReceptionExample.vue";
import LeaveExample from "./LeaveExample.vue";
import PreviewApp from "./PreviewApp.vue";
const scopes: ReturnType<typeof effectScope>[] = [];
const wrappers: Array<ReturnType<typeof mount>> = [];
function model(scenario: string) {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => useReceptionExample(scenario))!;
}
async function settle() {
  await vi.advanceTimersByTimeAsync(650);
  await flushPromises();
}
function render(component: Parameters<typeof mount>[0], scenario = "normal") {
  const wrapper = mount(component, {
    props: { scenario },
    attachTo: document.body,
    global: { plugins: [[ElementPlus, { locale: zhCn }]] },
  });
  wrappers.push(wrapper);
  return wrapper;
}
async function click(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper
    .findAll("button")
    .find((button) => button.text() === label);
  expect(button, label).toBeTruthy();
  await button!.trigger("click");
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("scrollTo", vi.fn());
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  scopes.splice(0).forEach((s) => s.stop());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
describe("reception scenario transitions", () => {
  it("blocks paging until a query succeeds, then clears the obsolete initial failure", async () => {
    const m = model("initial-failure");
    await m.page(true);
    await m.page(false);
    expect(m.state.hasResults).toBe(false);
    expect(m.state.more).toBe(false);
    expect(m.state.page).toBe(1);
    expect(m.state.items).toHaveLength(0);
    const retry = m.search();
    await settle();
    await retry;
    expect(m.state.hasResults).toBe(true);
    expect(m.state.error).toBe("");
    const next = m.page(true);
    await settle();
    await next;
    expect(m.state.page).toBe(2);
    expect(m.state.items[0]?.id).toContain("0004");
  });
  it("refreshes the selected detail from the same source without a loading placeholder", async () => {
    const m = model("normal");
    const selecting = m.select(m.state.items[0]!.id);
    await settle();
    await selecting;
    m.state.detail!.name = "旧缓存称呼";
    const refreshing = m.refresh();
    expect(m.state.detailLoading).toBe(false);
    expect(m.state.detail?.name).toBe("旧缓存称呼");
    await settle();
    await refreshing;
    expect(m.state.detail?.name).toBe("林女士（示例）");
    expect(m.state.detailLoading).toBe(false);
  });
  it("finds the cross-midnight fixture on both service dates", async () => {
    const m = model("normal");
    const id = m.state.items[0]!.id;
    m.state.filters.date = "2026-09-14";
    const search = m.search();
    await settle();
    await search;
    expect(m.state.items.map((item) => item.id)).toEqual([id]);
  });
  it("keeps the same object during refresh failure and records the stale data time", async () => {
    const m = model("refresh-failure");
    const selected = m.select(m.state.items[0]!.id);
    await settle();
    await selected;
    const detail = m.state.detail;
    const rows = m.state.items;
    const refresh = m.refresh();
    expect(m.state.detail).toBe(detail);
    await settle();
    await refresh;
    expect(m.state.items).toBe(rows);
    expect(m.state.detail).toBe(detail);
    expect(m.state.error).toContain("旧数据");
    expect(m.state.updatedAt).toContain("23:12");
  });
  it("clears old results on a newly submitted condition and ignores a late detail response", async () => {
    const m = model("query-failure");
    const selected = m.select(m.state.items[0]!.id);
    m.state.filters.name = "新的查询";
    expect(m.dirty.value).toBe(true);
    const search = m.search();
    expect(m.state.items).toHaveLength(0);
    expect(m.state.detail).toBeUndefined();
    await settle();
    await Promise.all([selected, search]);
    expect(m.state.detail).toBeUndefined();
    expect(m.state.error).toContain("新条件查询失败");
    expect(m.state.applied.name).toBe("新的查询");
    await m.page(true);
    await m.page(false);
    expect(m.state.more).toBe(false);
    expect(m.state.hasResults).toBe(false);
    expect(m.state.items).toHaveLength(0);
  });
  it("clears protected data during an in-flight refresh", async () => {
    const m = model("identity");
    const selecting = m.select(m.state.items[0]!.id);
    await settle();
    await selecting;
    const refreshing = m.refresh();
    m.clearProtected();
    await settle();
    await refreshing;
    expect(m.state.items).toHaveLength(0);
    expect(m.state.detail).toBeUndefined();
    expect(m.editable.value).toBe(false);
  });
  it.each(["page-failure", "append-failure"])(
    "preserves page and records on %s",
    async (scenario) => {
      const m = model(scenario);
      const ids = m.state.items.map((item) => item.id);
      const paging = m.page(true);
      await settle();
      await paging;
      expect(m.state.page).toBe(1);
      expect(m.state.items.map((item) => item.id)).toEqual(ids);
      expect(m.state.appendError).not.toBe("");
    },
  );
  it("appends all rows without inventing a total", async () => {
    const m = model("append");
    const paging = m.page(true);
    await settle();
    await paging;
    expect(m.state.items).toHaveLength(6);
    expect(m.state.more).toBe(false);
    expect(m.state.total).toBeUndefined();
  });
  it("locks unknown writes until the original operation is verified once", async () => {
    const m = model("unknown");
    const id = m.state.items[0]!.id;
    const selecting = m.select(id);
    await settle();
    await selecting;
    const confirming = m.confirm();
    void m.confirm();
    await settle();
    await confirming;
    expect(m.state.pending).toBe(id);
    expect(m.locked.value).toBe(true);
    await m.search();
    await m.confirm();
    expect(m.state.confirmedCount).toBe(0);
    const verifying = m.verify();
    await settle();
    await verifying;
    expect(m.state.confirmedCount).toBe(1);
    expect(m.state.pending).toBe("");
    expect(m.state.success).toContain(id);
  });
  it("separates successful confirmation from failed list refresh, then retries only the read", async () => {
    const m = model("success-refresh-failure");
    const selecting = m.select(m.state.items[0]!.id);
    await settle();
    await selecting;
    const confirming = m.confirm();
    await settle();
    await confirming;
    expect(m.state.success).toContain("已确认");
    expect(m.state.error).toContain("最新列表未取得");
    expect(m.state.items[0]!.state).toBe("待确认");
    const refresh = m.refresh();
    await settle();
    await refresh;
    expect(m.state.items[0]!.state).toBe("已确认");
    expect(m.state.confirmedCount).toBe(1);
  });
  it("removes a processed row while retaining a clear result", async () => {
    const m = model("remove");
    const id = m.state.items[0]!.id;
    const selecting = m.select(id);
    await settle();
    await selecting;
    const confirming = m.confirm();
    await settle();
    await confirming;
    expect(m.state.items.some((item) => item.id === id)).toBe(false);
    expect(m.state.success).toContain(id);
  });
});
describe("real-control examples", () => {
  it("uses the same explicit state tone in the selected record and detail, without treating dates as status", async () => {
    const wrapper = render(ReceptionExample);
    await wrapper.get("[data-record]").trigger("click");
    await settle();
    const recordStatus = wrapper.get("[data-record] .admin-ui-state");
    const detailStatus = wrapper.get('[aria-label="接待详情"] .admin-ui-state');
    expect(recordStatus.attributes("data-tone")).toBe("warning");
    expect(detailStatus.attributes("data-tone")).toBe(
      recordStatus.attributes("data-tone"),
    );
    expect(detailStatus.text()).toBe(recordStatus.text());
    expect(
      wrapper
        .get('[aria-label="接待列表"] .admin-ui-panel-heading > span')
        .classes(),
    ).not.toContain("admin-ui-state");
  });
  it("replaces the pre-save impact with one follow-up summary after saving", async () => {
    const wrapper = render(LeaveExample, "follow-up");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.text()).toContain("影响 2 组已确认接待");
    await click(wrapper, "确认登记请假");
    await settle();
    expect(wrapper.text()).not.toContain("影响 2 组已确认接待");
    const result = wrapper.get('[aria-label="保存处理结果"]');
    expect(result.text().match(/仍有 2 组已确认接待待跟进/g)).toHaveLength(1);
    expect(result.text()).toContain("下一步：联系顾客并记录沟通结果");
    expect(document.activeElement).toBe(result.element);
  });
  it("collapses only review settings and preserves the active work and fictional-data label", async () => {
    const wrapper = render(PreviewApp);
    await wrapper.get("[data-record]").trigger("click");
    await settle();
    await click(wrapper, "收起评审设置");
    expect(wrapper.text()).toContain("界面示例");
    expect(wrapper.text()).toContain("虚构数据");
    expect(wrapper.get("[data-record]").attributes("aria-pressed")).toBe(
      "true",
    );
    expect(wrapper.get(".admin-ui-review-controls").isVisible()).toBe(false);
    await click(wrapper, "展开评审设置");
    expect(wrapper.get(".admin-ui-review-controls").isVisible()).toBe(true);
    expect(wrapper.text()).toContain("林女士（示例）的接待");
  });
  it("does not substitute another record when detail loading fails", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    const wrapper = render(ReceptionExample, "detail-failure");
    const origin = wrapper.get("[data-record]").element;
    await wrapper.get("[data-record]").trigger("click");
    await settle();
    expect(wrapper.text()).toContain("这条接待详情读取失败");
    expect(wrapper.findAll("[data-record]")).toHaveLength(3);
    expect(wrapper.text()).not.toContain("顾客服务安排");
    expect(document.activeElement?.textContent?.trim()).toBe("详情未取得");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    await click(wrapper, "返回接待列表");
    expect(document.activeElement).toBe(origin);
  });
  it("disables the real paging controls after the initial failure until retry succeeds", async () => {
    const wrapper = render(ReceptionExample, "initial-failure");
    const next = () =>
      wrapper.findAll("button").find((b) => b.text() === "下一页")!;
    expect((next().element as HTMLButtonElement).disabled).toBe(true);
    await click(wrapper, "重试读取");
    await settle();
    expect((next().element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.text()).not.toContain("首次读取未成功");
  });
  it.each(["normal", "failure", "unknown"])(
    "focuses the visible result in the original impact area after %s",
    async (scenario) => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
      const wrapper = render(LeaveExample, scenario);
      await wrapper.get("form").trigger("submit");
      await click(wrapper, "确认登记请假");
      await settle();
      const region = wrapper.get(
        '[aria-label="请假影响"] [aria-label="保存处理结果"]',
      );
      expect(document.activeElement).toBe(region.element);
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenLastCalledWith({
        block: "nearest",
      });
      if (scenario === "unknown") {
        expect(region.text()).toContain("核实原保存结果");
        await click(wrapper, "核实原保存结果");
        await settle();
        expect(document.activeElement).toBe(region.element);
        expect(region.text()).toContain("已核实原操作");
      }
    },
  );
  it("associates specific validation messages with inputs and focuses the first invalid field", async () => {
    const wrapper = render(LeaveExample);
    await flushPromises();
    const end = wrapper.get('input[id$="-end"]');
    const reason = wrapper.get("textarea");
    await end.setValue("13:00");
    await reason.setValue("");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(document.activeElement).toBe(end.element);
    expect(end.attributes("aria-invalid")).toBe("true");
    expect(
      document.getElementById(end.attributes("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("结束时间必须晚于开始时间");
    expect(reason.attributes("aria-describedby")).toContain("-reason-error");
    expect(wrapper.text()).toContain("请填写内部请假原因");
    await end.setValue("18:00");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(document.activeElement).toBe(reason.element);
    expect(end.attributes("aria-invalid")).toBe("false");
    await reason.setValue("已更正原因");
    // Exercise the actual date component's cleared model rather than a field engine.
    wrapper
      .findComponent({ name: "ElDatePicker" })
      .vm.$emit("update:modelValue", "");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    const date = wrapper.get('input[id$="-date"]');
    expect(document.activeElement).toBe(date.element);
    expect(date.attributes("aria-invalid")).toBe("true");
    expect(
      document.getElementById(date.attributes("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("请选择请假日期。");
    await wrapper.get('input[id$="-start"]').setValue("");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.text()).toContain("请填写有效的开始时间");
    expect(wrapper.text()).toContain("模拟提交次数：0");
  });
  it("restores a narrow-screen row or its neighbour after the original row is removed", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    const wrapper = render(ReceptionExample, "remove");
    await wrapper.get("[data-record]").trigger("click");
    await settle();
    expect(document.activeElement?.textContent).toContain("林女士");
    await click(wrapper, "确认接待");
    await settle();
    await click(wrapper, "返回接待列表");
    await flushPromises();
    expect((document.activeElement as HTMLElement).dataset.record).toContain(
      "0002",
    );
  });
  it("uses one form event for clicks and Enter, locks unknown results, and retains follow-up work", async () => {
    const wrapper = render(LeaveExample, "unknown");
    await click(wrapper, "查看影响");
    await flushPromises();
    await click(wrapper, "确认登记请假");
    await wrapper.get("form").trigger("submit");
    await settle();
    expect(wrapper.text()).toContain("模拟提交次数：1");
    expect(wrapper.text()).toContain("保存结果尚未确定");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.text()).toContain("模拟提交次数：1");
    const reset = wrapper
      .findAll("button")
      .find((button) => button.text() === "重置")!;
    expect((reset.element as HTMLButtonElement).disabled).toBe(true);
    const leave = wrapper
      .findAll("button")
      .find((button) => button.text() === "返回接待示例")!;
    expect((leave.element as HTMLButtonElement).disabled).toBe(true);
    await click(wrapper, "核实原保存结果");
    await settle();
    expect(wrapper.text()).toContain("已核实原操作");
    expect(wrapper.text()).toContain("仍有 2 组已确认接待待跟进");
  });
  it("moves narrow-screen inspection to the impact and requires its separate confirmation action", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    const wrapper = render(LeaveExample, "failure");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(document.activeElement?.textContent).toBe("本次影响与下一步");
    expect(wrapper.get('[aria-label="请假影响"]').text()).toContain(
      "确认登记请假",
    );
    await wrapper.get("form").trigger("submit");
    expect(wrapper.text()).toContain("模拟提交次数：0");
    await click(wrapper, "确认登记请假");
    await settle();
    expect(wrapper.text()).toContain("本次未保存");
    expect(wrapper.text()).toContain("模拟提交次数：1");
    expect(wrapper.text()).not.toContain("保存结果已确定");
  });
  it("has unique real input IDs across multiple instances", async () => {
    render(
      defineComponent({
        props: ["scenario"],
        components: { LeaveExample },
        template:
          '<LeaveExample scenario="normal" /><LeaveExample scenario="normal" />',
      }),
    );
    await flushPromises();
    const ids = Array.from(document.querySelectorAll("[id]")).map(
      (el) => el.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    document
      .querySelectorAll("label[for]")
      .forEach((label) =>
        expect(
          document.getElementById(label.getAttribute("for")!),
        ).not.toBeNull(),
      );
  });
  it("initializes the standalone preview without network requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(PreviewApp);
    await flushPromises();
    expect(fetch).not.toHaveBeenCalled();
  });
});
