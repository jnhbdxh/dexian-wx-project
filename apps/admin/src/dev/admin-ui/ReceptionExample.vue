<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import AdminPage from "../../components/admin-ui/AdminPage.vue";
import AdminFilters from "../../components/admin-ui/AdminFilters.vue";
import AdminFeedback from "../../components/admin-ui/AdminFeedback.vue";
import AdminPagination from "../../components/admin-ui/AdminPagination.vue";
import AdminCopy from "../../components/admin-ui/AdminCopy.vue";
import { useReceptionExample } from "./use-reception-example";
import type { DemoReception } from "./scenarios";
const props = defineProps<{ scenario: string }>();
const emit = defineEmits<{ lock: [locked: boolean]; leave: [] }>();
const {
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
} = useReceptionExample(props.scenario);
watch(locked, (value) => emit("lock", value), { immediate: true });
onBeforeUnmount(() => emit("lock", false));
const id = useId();
const listRegion = ref<HTMLElement>();
const detailRegion = ref<HTMLElement>();
let originId = "";
let originIndex = 0;
let originY = 0;
const activeItem = computed(() => state.detail);
const stateTone = (status: DemoReception["state"]) =>
  status === "待确认" ? "warning" : status === "已确认" ? "success" : "neutral";
async function open(id: string) {
  if (!editable.value) return;
  originId = id;
  originIndex = state.items.findIndex((item) => item.id === id);
  originY = window.scrollY;
  const settled = await select(id);
  await nextTick();
  if (settled && window.innerWidth <= 820) {
    detailRegion.value?.focus({ preventScroll: true });
    detailRegion.value?.closest("section")?.scrollIntoView({ block: "start" });
  }
}
async function back() {
  await nextTick();
  const rows = Array.from(
    listRegion.value?.querySelectorAll<HTMLButtonElement>("[data-record]") ??
      [],
  );
  const target =
    rows.find((row) => row.dataset.record === originId) ??
    rows[Math.min(originIndex, rows.length - 1)] ??
    listRegion.value?.querySelector<HTMLElement>("h2");
  window.scrollTo({ top: originY, behavior: "instant" });
  target?.focus({ preventScroll: true });
  if (target) {
    const rect = target.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight)
      target.scrollIntoView({ block: "nearest" });
  }
}
</script>
<template>
  <AdminPage
    title="接待查询"
    description="找到原预约，核对安排与影响，再继续处理。"
  >
    <template #navigation
      ><el-button :disabled="locked" @click="emit('leave')"
        >切换到请假示例</el-button
      ><span>值班前台 · 演示门店</span></template
    >
    <template #actions
      ><el-button :disabled="!editable || busy" @click="refresh"
        >刷新列表与详情</el-button
      ><el-button
        v-if="scenario === 'identity'"
        :disabled="locked || state.protected"
        @click="clearProtected"
        >模拟身份变化</el-button
      ></template
    >
    <AdminFeedback
      v-if="state.pending"
      tone="warning"
      title="确认结果尚未确定，请先核实原操作"
      :message="`原操作：确认接待 ${state.pending}。当前不能重新提交或切换工作区。`"
      urgent
      ><template #actions
        ><el-button type="primary" :disabled="state.writing" @click="verify">{{
          state.writing ? "正在核实…" : "核实原确认结果"
        }}</el-button></template
      ></AdminFeedback
    >
    <AdminFeedback
      v-if="state.success"
      tone="success"
      title="操作结果已确定"
      :message="state.success"
    />
    <AdminFilters
      :busy="busy"
      :disabled="!editable"
      @submit="search"
      @reset="reset"
    >
      <div class="admin-ui-field">
        <label :for="`${id}-date`">服务日期</label
        ><el-date-picker
          :id="`${id}-date`"
          v-model="state.filters.date"
          type="date"
          value-format="YYYY-MM-DD"
          format="YYYY/MM/DD"
          :clearable="false"
          :disabled="!editable || busy"
          popper-class="admin-ui-popover"
        />
      </div>
      <div class="admin-ui-field">
        <label :for="`${id}-status`">预约状态</label
        ><el-select
          :id="`${id}-status`"
          v-model="state.filters.status"
          placeholder="全部状态"
          :disabled="!editable || busy"
          popper-class="admin-ui-popover"
          ><el-option label="全部状态" value="" /><el-option
            v-for="status in ['待确认', '已确认', '已过期']"
            :key="status"
            :label="status"
            :value="status"
        /></el-select>
      </div>
      <div class="admin-ui-field">
        <label :for="`${id}-name`">顾客称呼或接待号</label
        ><el-input
          :id="`${id}-name`"
          v-model="state.filters.name"
          :disabled="!editable || busy"
          placeholder="输入称呼或完整接待号"
        />
      </div>
      <template #description
        ><p class="admin-ui-muted">
          北京时间 · 跨午夜服务在相交日期均可查。仅准备或休息跨日不计入。
        </p>
        <p v-if="dirty" role="status">
          筛选已修改，尚未查询；当前结果仍属于上次查询条件。
        </p></template
      >
    </AdminFilters>
    <AdminFeedback
      :title="
        state.refreshing
          ? '正在更新，现有内容仍可查看'
          : state.error
            ? '读取结果提示'
            : undefined
      "
      :message="state.error"
      :tone="state.error ? 'warning' : 'neutral'"
      :updated-at="
        state.error && state.items.length ? state.updatedAt : undefined
      "
      :busy="state.refreshing"
    >
      <template #actions
        ><el-button
          v-if="state.error && !state.protected"
          :disabled="busy || locked"
          @click="state.items.length ? refresh() : search()"
          >重试读取</el-button
        ></template
      >
      <div v-if="!state.protected" class="admin-ui-query-layout">
        <section ref="listRegion" class="admin-ui-panel" aria-label="接待列表">
          <div class="admin-ui-panel-heading">
            <h2 tabindex="-1">
              查询结果<span v-if="state.total !== undefined">
                · {{ state.total }} 组</span
              >
            </h2>
            <span class="admin-ui-muted">{{ state.applied.date }}</span>
          </div>
          <p class="admin-ui-muted">
            {{ state.updatedAt
            }}<span v-if="appendMode">
              · 已显示 {{ state.items.length }} 组，总数未提供</span
            >
          </p>
          <p v-if="state.loading" role="status">
            {{ state.items.length ? "正在读取更多结果…" : "正在查询…" }}
          </p>
          <p v-else-if="!state.items.length && !state.error">
            没有符合条件的接待，请调整筛选。
          </p>
          <ul class="admin-ui-records">
            <li v-for="item in state.items" :key="item.id">
              <button
                class="admin-ui-record"
                :data-record="item.id"
                :aria-pressed="activeItem?.id === item.id"
                :disabled="!editable"
                @click="open(item.id)"
              >
                <span class="admin-ui-panel-heading"
                  ><strong>{{ item.name }}</strong
                  ><span
                    class="admin-ui-state"
                    :data-tone="stateTone(item.state)"
                    >{{ item.state }}</span
                  ></span
                ><span class="admin-ui-record-time">{{ item.time }}</span
                ><span class="admin-ui-record-summary"
                  >{{ item.guests.length }} 位 ·
                  {{ item.guests.map((g) => g.project).join("、") }}</span
                ><span v-if="item.conflict" class="admin-ui-attention"
                  >有请假影响，安排仍保留</span
                ><span class="admin-ui-record-footer"
                  ><small>{{ item.id }}</small
                  ><span class="admin-ui-record-link">查看安排</span></span
                >
              </button>
            </li>
          </ul>
          <AdminFeedback
            v-if="state.appendError"
            title="当前记录保持不变"
            :message="state.appendError"
            tone="warning"
          />
          <template v-if="appendMode"
            ><div class="admin-ui-pagination">
              <el-button
                v-if="state.more"
                :disabled="busy || !editable"
                @click="page(true)"
                >{{
                  state.appendError ? "重试加载更多" : "加载更多"
                }}</el-button
              ><span v-else-if="state.hasResults">已全部加载</span>
            </div></template
          >
          <AdminPagination
            v-else
            :page="state.hasResults ? state.page : undefined"
            :total="state.total"
            :has-previous="state.hasResults && state.page > 1"
            :has-next="state.more"
            :busy="busy"
            :disabled="!editable || !state.hasResults"
            @previous="page(false)"
            @next="page(true)"
          />
        </section>
        <section class="admin-ui-panel" aria-label="接待详情">
          <el-button class="admin-ui-back" :disabled="locked" @click="back"
            >返回接待列表</el-button
          >
          <h2 ref="detailRegion" tabindex="-1">
            {{
              state.detailError
                ? "详情未取得"
                : activeItem
                  ? `${activeItem.name}的接待`
                  : "接待详情"
            }}
          </h2>
          <p v-if="state.detailLoading" role="status">正在读取所选接待…</p>
          <AdminFeedback
            v-else-if="state.detailError"
            title="详情未取得"
            :message="state.detailError"
            tone="warning"
          />
          <template v-else-if="activeItem">
            <p>
              {{ activeItem.phone }}
              <span
                class="admin-ui-state"
                :data-tone="stateTone(activeItem.state)"
                >{{ activeItem.state }}</span
              >
            </p>
            <AdminFeedback
              v-if="activeItem.state === '待确认'"
              title="待前台确认 · 模拟剩余 8 分钟"
              message="确认截止：2026/09/14 23:20（模拟时间）。确认后沿用下方人员、项目与场地安排。"
              tone="warning"
              ><template #actions
                ><el-button
                  v-if="canConfirm"
                  type="primary"
                  :disabled="locked"
                  @click="confirm"
                  >{{ state.writing ? "正在确认…" : "确认接待" }}</el-button
                ><span v-else
                  >当前账号只能查看，请联系有确认权限的员工。</span
                ></template
              ></AdminFeedback
            >
            <AdminFeedback
              v-if="activeItem.conflict"
              title="1 项请假影响待跟进"
              message="小满在服务时段请假。已确认安排仍保留，需要联系顾客后处理。"
              tone="warning"
            />
            <h3>顾客服务安排</h3>
            <p class="admin-ui-muted">预约计划不代表已到店、完工或收款。</p>
            <div
              v-for="guest in activeItem.guests"
              :key="guest.name"
              class="admin-ui-guest"
            >
              <strong>{{ guest.name }} · {{ guest.project }}</strong
              ><span>{{ guest.price }}</span>
              <p>{{ guest.time }}</p>
              <p>{{ guest.therapist }} · {{ guest.location }}</p>
            </div>
            <h3>服务前后占用</h3>
            <p>
              准备 10 分钟 · 整理 5 分钟 · 必要休息 20 分钟<br />房间与床位清洁
              15 分钟。
            </p>
            <p class="admin-ui-muted">以上占用不属于顾客服务时长。</p>
            <div class="admin-ui-money">
              <span>预约报价</span
              ><strong>{{
                activeItem.guests.length === 2 ? "¥160.00" : "¥95.00"
              }}</strong>
            </div>
            <p>支付状态：暂无支付记录。</p>
            <p class="admin-ui-muted">报价不代表已经收款。</p>
            <AdminCopy :text="activeItem.id" label="接待号" />
          </template>
          <p v-else>从列表选择一条接待，查看安排与下一步。</p>
        </section>
      </div>
    </AdminFeedback>
  </AdminPage>
</template>
