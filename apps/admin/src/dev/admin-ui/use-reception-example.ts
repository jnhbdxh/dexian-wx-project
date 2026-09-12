import { computed, onScopeDispose, reactive } from "vue";
import { receptionFixtures, type DemoReception } from "./scenarios";

export function useReceptionExample(scenario: string) {
  let records = receptionFixtures();
  if (scenario === "long-content") {
    const first = records[0]!;
    first.name = "林女士与同行顾客（长名称展示示例，请核对两位顾客的独立安排）";
    first.id = "DEMO-20260915-0001-LONG-REFERENCE-ONLY-FOR-LAYOUT-REVIEW";
    first.guests[0]!.project =
      "舒缓护理与肩颈放松组合项目（长项目名称展示示例）";
  }
  let request = 0;
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
    request++;
  });
  const state = reactive({
    filters: { date: "2026-09-15", status: "", name: "" },
    applied: { date: "2026-09-15", status: "", name: "" },
    items: [] as DemoReception[],
    detail: undefined as DemoReception | undefined,
    page: 1,
    total: undefined as number | undefined,
    more: false,
    hasResults: false,
    loading: false,
    refreshing: false,
    detailLoading: false,
    writing: false,
    error: "",
    detailError: "",
    appendError: "",
    success: "",
    pending: "",
    protected: scenario === "denied",
    updatedAt: "2026/09/14 23:12（模拟时间）",
    confirmedCount: 0,
  });
  const appendMode = scenario === "append" || scenario === "append-failure";
  const locked = computed(() => state.writing || !!state.pending);
  const editable = computed(() => !locked.value && !state.protected);
  const busy = computed(() => state.loading || state.refreshing);
  const canConfirm = computed(
    () => scenario !== "read-only" && !state.protected,
  );
  const dirty = computed(
    () => JSON.stringify(state.filters) !== JSON.stringify(state.applied),
  );
  function matches() {
    return records.filter(
      (item) =>
        item.serviceDates.includes(state.applied.date) &&
        (!state.applied.status || item.state === state.applied.status) &&
        (!state.applied.name ||
          item.name.includes(state.applied.name) ||
          item.id.includes(state.applied.name)),
    );
  }
  function update(page = 1) {
    const items = matches();
    state.items = structuredClone(
      appendMode
        ? items.slice(0, page * 3)
        : items.slice((page - 1) * 3, page * 3),
    );
    state.total = appendMode ? undefined : items.length;
    state.more = page * 3 < items.length;
    state.page = page;
    state.hasResults = true;
    state.error = "";
  }
  async function wait() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return !disposed;
  }
  if (state.protected)
    state.error = "当前员工无查看权限，受保护内容已清除。请联系店长。";
  else if (scenario === "initial-failure")
    state.error = "首次读取未成功，尚无可展示的接待。";
  else update();

  function clearProtected() {
    request++;
    state.protected = true;
    state.items = [];
    state.detail = undefined;
    state.total = undefined;
    state.hasResults = false;
    state.more = false;
    state.detailLoading = false;
    state.detailError = "";
    state.success = "";
    state.error = "身份已变化，旧员工的接待数据已清除。请重新取得查看权限。";
  }
  function reset() {
    if (!editable.value || busy.value) return;
    state.filters = { date: "2026-09-15", status: "", name: "" };
  }
  async function search() {
    if (!editable.value || busy.value) return;
    request++;
    state.detail = undefined;
    state.detailError = "";
    state.detailLoading = false;
    state.applied = { ...state.filters };
    state.items = [];
    state.total = undefined;
    state.hasResults = false;
    state.more = false;
    state.page = 1;
    state.error = "";
    state.appendError = "";
    state.loading = true;
    if (await wait()) {
      if (!state.protected) {
        if (scenario === "query-failure")
          state.error = "新条件查询失败，尚无属于这些条件的结果。";
        else update();
      }
      state.loading = false;
    }
  }
  async function refresh() {
    if (!editable.value || busy.value) return;
    if (!state.hasResults) return search();
    state.refreshing = true;
    state.error = "";
    if (await wait()) {
      if (!state.protected) {
        if (scenario === "refresh-failure")
          state.error =
            "更新失败，以下仍为旧数据；可继续查看，最新状态尚未取得。";
        else {
          update(state.page);
          if (state.detail) {
            const current = records.find(
              (item) => item.id === state.detail?.id,
            );
            state.detail = current ? structuredClone(current) : undefined;
          }
          state.updatedAt = "2026/09/14 23:13（模拟时间）";
        }
      }
      state.refreshing = false;
    }
  }
  async function select(id: string) {
    if (!editable.value) return false;
    const current = ++request;
    state.detail = undefined;
    state.detailError = "";
    state.detailLoading = true;
    if (!(await wait()) || current !== request) return false;
    state.detailLoading = false;
    if (scenario === "detail-failure") {
      state.detailError = "这条接待详情读取失败，列表仍可继续查询。";
      return true;
    }
    const item = records.find((item) => item.id === id);
    state.detail = item ? structuredClone(item) : undefined;
    return !!state.detail;
  }
  async function page(next: boolean) {
    if (
      !editable.value ||
      busy.value ||
      !state.hasResults ||
      (next ? !state.more : state.page === 1)
    )
      return;
    state.loading = true;
    state.appendError = "";
    if (await wait()) {
      if (!state.protected) {
        if (scenario === "page-failure" || scenario === "append-failure")
          state.appendError = appendMode
            ? "更多接待读取失败，已显示的记录保持不变。"
            : "下一页未取得，仍显示原页码与原记录。";
        else update(state.page + (next ? 1 : -1));
      }
      state.loading = false;
    }
  }
  function finish(id: string) {
    const item = records.find((item) => item.id === id);
    if (item) item.state = "已确认";
    state.confirmedCount++;
    state.success = `接待 ${id} 已确认。可以继续处理其他工作。`;
    if (scenario === "remove")
      records = records.filter((item) => item.id !== id);
    if (scenario === "success-refresh-failure")
      state.error =
        "操作已成功，但最新列表未取得。以下列表为旧数据，请仅重试读取。";
    else {
      state.page = 1;
      update();
    }
    if (state.detail?.id === id) state.detail = item ? { ...item } : undefined;
  }
  async function confirm() {
    const item = state.detail;
    if (
      !item ||
      !editable.value ||
      !canConfirm.value ||
      item.state !== "待确认"
    )
      return;
    state.writing = true;
    state.success = "";
    const id = item.id;
    if (await wait()) {
      if (!state.protected) {
        if (scenario === "unknown") state.pending = id;
        else finish(id);
      }
      state.writing = false;
    }
  }
  async function verify() {
    if (!state.pending || state.writing || state.protected) return;
    const original = state.pending;
    state.writing = true;
    if (await wait()) {
      if (!state.protected) {
        finish(original);
        state.pending = "";
      }
      state.writing = false;
    }
  }
  return {
    state,
    appendMode,
    locked,
    editable,
    busy,
    dirty,
    canConfirm,
    search,
    reset,
    refresh,
    select,
    page,
    confirm,
    verify,
    clearProtected,
  };
}
