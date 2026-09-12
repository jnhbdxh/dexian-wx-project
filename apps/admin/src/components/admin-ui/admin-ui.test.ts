// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import ElementPlus from "element-plus";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminFilters from "./AdminFilters.vue";
import AdminFeedback from "./AdminFeedback.vue";
import AdminPagination from "./AdminPagination.vue";
import AdminCopy from "./AdminCopy.vue";
import AdminPage from "./AdminPage.vue";
const wrappers: Array<{ unmount: () => void }> = [];
function render<T extends Parameters<typeof mount>[0]>(
  component: T,
  options = {},
) {
  const wrapper = mount(component, {
    attachTo: document.body,
    global: { plugins: [ElementPlus] },
    ...options,
  });
  wrappers.push(wrapper);
  return wrapper;
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
describe("admin display contracts", () => {
  it("owns only one form-submit path, prevents busy actions, and leaves reset policy to the caller", async () => {
    const wrapper = render(AdminFilters, {
      slots: {
        default:
          '<label for="test-field">筛选</label><input id="test-field" />',
      },
    });
    await wrapper.findAll("button")[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.emitted("submit")).toHaveLength(1);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toHaveLength(2);
    await wrapper.findAll("button")[1]!.trigger("click");
    expect(wrapper.emitted("reset")).toHaveLength(1);
    expect(wrapper.emitted("submit")).toHaveLength(2);
    await wrapper.setProps({ busy: true });
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toHaveLength(2);
    expect(
      wrapper
        .findAll("button")
        .every((button) => (button.element as HTMLButtonElement).disabled),
    ).toBe(true);
  });
  it("keeps content and focused nodes across refresh messages while allowing the parent to clear them", async () => {
    const wrapper = render(AdminFeedback, {
      slots: { default: '<button id="stable-content">查看对象</button>' },
    });
    const button = wrapper.get("#stable-content").element as HTMLElement;
    button.focus();
    await wrapper.setProps({ title: "正在刷新", busy: true });
    await wrapper.setProps({
      title: "更新失败",
      busy: false,
      tone: "warning",
      updatedAt: "09:00",
    });
    expect(wrapper.get("#stable-content").element).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(wrapper.text()).toContain("数据时间：09:00");
  });
  it("renders optional page/total without inventing counts and does not change page after next", async () => {
    const wrapper = render(AdminPagination, {
      props: { hasNext: true, hasPrevious: false },
    });
    expect(wrapper.text()).not.toContain("共");
    expect(wrapper.text()).not.toContain("第");
    await wrapper.setProps({ page: 2, total: 0 });
    await wrapper.findAll("button")[1]!.trigger("click");
    expect(wrapper.emitted("next")).toHaveLength(1);
    expect(wrapper.text()).toContain("第 2 页");
    expect(wrapper.text()).toContain("共 0 组");
    await wrapper.setProps({ busy: true });
    await wrapper.findAll("button")[1]!.trigger("click");
    expect(wrapper.emitted("next")).toHaveLength(1);
  });
  it("uses unique accessible headings and announcements across multiple instances", () => {
    const wrapper = render(
      defineComponent({
        components: { AdminPage, AdminFeedback },
        template:
          '<AdminPage title="甲"><AdminFeedback title="提示甲" /></AdminPage><AdminPage title="乙"><AdminFeedback title="提示乙" /></AdminPage>',
      }),
    );
    const ids = wrapper.findAll("[id]").map((node) => node.attributes("id"));
    expect(new Set(ids).size).toBe(ids.length);
    wrapper
      .findAll("[aria-labelledby]")
      .forEach((node) =>
        expect(
          document.getElementById(node.attributes("aria-labelledby")!),
        ).not.toBeNull(),
      );
  });
  it("keeps copy failures local and ignores a late result after the text changes", async () => {
    let resolve!: () => void;
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const wrapper = render(
      defineComponent({
        components: { AdminCopy },
        template: '<AdminCopy text="甲" /><AdminCopy text="乙" />',
      }),
    );
    const copies = wrapper.findAllComponents(AdminCopy);
    await copies[0]!.get("button").trigger("click");
    await flushPromises();
    expect(copies[0]!.text()).toContain("手动复制");
    expect(copies[1]!.text()).not.toContain("手动复制");
    expect(copies[0]!.get(".admin-ui-copy-text").text()).toContain("甲");
    const standalone = render(AdminCopy, { props: { text: "旧编号" } });
    await standalone.get("button").trigger("click");
    await standalone.setProps({ text: "新编号" });
    resolve();
    await flushPromises();
    expect(standalone.text()).not.toContain("已复制");
  });
});
