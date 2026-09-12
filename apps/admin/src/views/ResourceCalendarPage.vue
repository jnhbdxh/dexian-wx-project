<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { ApiRequestError } from "../lib/api";
import {
  getResourceCalendar,
  type CalendarAllocation,
  type CalendarResource,
  type CalendarRestriction,
  type ResourceCalendar,
} from "../lib/resource-calendar-api";
import {
  isEffectiveAllocation,
  periodStyle,
  restrictionLabels,
  segmentLabel,
  shanghaiDateLabel,
  shanghaiDay,
  shanghaiTime,
  shiftDate,
  timeRange,
} from "../lib/resource-calendar-ui";
import "./resource-calendar.css";

type CalendarView = "therapist" | "facility";

const router = useRouter();
const selectedDate = ref(shanghaiDay());
const calendar = ref<ResourceCalendar>();
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const failedDate = ref("");
const view = ref<CalendarView>("therapist");
const clockNow = ref(Date.now());
let serverOffsetMs = 0;
let requestSequence = 0;
let identitySequence = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;

const hourLabels = Array.from({ length: 25 }, (_, hour) => hour);
const receptionStateLabels: Record<
  CalendarAllocation["receptionState"],
  string
> = {
  pending: "待确认",
  confirmed: "已确认",
};
const effectiveAllocations = computed(() =>
  (calendar.value?.allocations ?? []).filter((item) =>
    isEffectiveAllocation(item, clockNow.value),
  ),
);
const displayedResources = computed(() => {
  const items = (calendar.value?.resources ?? []).filter((resource) =>
    view.value === "therapist"
      ? resource.resourceType === "therapist"
      : resource.resourceType === "room" || resource.resourceType === "bed",
  );
  return items.filter(
    (resource) =>
      resource.active ||
      shiftsFor(resource).length > 0 ||
      allocationsFor(resource).length > 0 ||
      restrictionsFor(resource).length > 0,
  );
});
const equipmentRestrictions = computed(() =>
  (calendar.value?.restrictions ?? []).filter(
    (item) => item.resourceType === "equipment",
  ),
);
const pendingCount = computed(
  () =>
    new Set(
      effectiveAllocations.value
        .filter((item) => item.receptionState === "pending")
        .map((item) => item.receptionId),
    ).size,
);
const confirmedCount = computed(
  () =>
    new Set(
      effectiveAllocations.value
        .filter((item) => item.receptionState === "confirmed")
        .map((item) => item.receptionId),
    ).size,
);
const conflictCount = computed(
  () =>
    new Set(
      effectiveAllocations.value
        .filter((item) => item.hasConflict)
        .map((item) => item.receptionId),
    ).size,
);
const showsCurrentTime = computed(
  () => calendar.value?.serviceDate === shanghaiDay(clockNow.value),
);
const currentTimeStyle = computed(() => {
  if (!calendar.value) return {};
  return {
    left: periodStyle(
      new Date(clockNow.value).toISOString(),
      new Date(clockNow.value + 1).toISOString(),
      calendar.value.serviceDate,
    ).left,
  };
});

function sameIdentity(left: ResourceCalendar, right: ResourceCalendar) {
  return (
    left.user.id === right.user.id && left.user.storeId === right.user.storeId
  );
}

function observeIdentity(result: ResourceCalendar, sequence: number) {
  if (sequence <= identitySequence) return;
  identitySequence = sequence;
  if (calendar.value && !sameIdentity(calendar.value, result)) {
    calendar.value = undefined;
    if (refreshing.value) loading.value = true;
  }
}

async function load(date = selectedDate.value) {
  const sequence = ++requestSequence;
  if (calendar.value) refreshing.value = true;
  else loading.value = true;
  error.value = "";
  try {
    const result = await getResourceCalendar(date);
    observeIdentity(result, sequence);
    if (sequence !== requestSequence) return;
    calendar.value = result;
    selectedDate.value = result.serviceDate;
    serverOffsetMs = Date.parse(result.serverNow) - Date.now();
    clockNow.value = Date.now() + serverOffsetMs;
    failedDate.value = "";
  } catch (reason) {
    if (sequence !== requestSequence) return;
    failedDate.value = date;
    if (reason instanceof ApiRequestError && reason.status === 401) {
      calendar.value = undefined;
      await router.replace({
        path: "/login",
        query: { redirect: "/calendar" },
      });
      return;
    }
    if (reason instanceof ApiRequestError && reason.status === 403) {
      calendar.value = undefined;
      error.value = reason.message || "当前账号无权查看预约日历。";
      return;
    }
    error.value = "日历尚未刷新成功，请稍后重试。";
  } finally {
    if (sequence === requestSequence) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

function moveDate(days: number) {
  selectedDate.value = shiftDate(selectedDate.value, days);
  void load();
}

function allocationsFor(resource: CalendarResource) {
  return effectiveAllocations.value.filter(
    (item) => item.resourceId === resource.id,
  );
}

function shiftsFor(resource: CalendarResource) {
  return (calendar.value?.shifts ?? []).filter(
    (item) => item.therapistResourceId === resource.id,
  );
}

function restrictionsFor(resource: CalendarResource) {
  return (calendar.value?.restrictions ?? []).filter(
    (item) =>
      item.kind === "store_closed" ||
      item.resourceId === resource.id ||
      (resource.resourceType === "bed" &&
        item.resourceId === resource.parentResourceId &&
        item.resourceType === "room"),
  );
}

function restrictionName(
  restriction: CalendarRestriction,
  resource: CalendarResource,
) {
  const inherited =
    resource.resourceType === "bed" &&
    restriction.resourceType === "room" &&
    restriction.resourceId === resource.parentResourceId;
  return `${restrictionLabels[restriction.kind]}${inherited ? "（所属房间）" : ""}`;
}

function resourceTypeLabel(resource: CalendarResource) {
  if (resource.resourceType === "therapist") return "美容师";
  if (resource.resourceType === "room") return "房间";
  return "床位";
}

function parentRoomName(resource: CalendarResource) {
  if (resource.resourceType !== "bed") return "";
  return (
    calendar.value?.resources.find(
      (item) => item.id === resource.parentResourceId,
    )?.name ?? "所属房间未知"
  );
}

function allocationLabel(
  allocation: CalendarAllocation,
  resource: CalendarResource,
) {
  return [
    segmentLabel(allocation.segmentKind, resource.resourceType),
    allocation.customerName,
    allocation.serviceItemName,
  ]
    .filter(Boolean)
    .join(" · ");
}

function openReception(receptionId: string) {
  void router.push({ path: "/receptions", query: { receptionId } });
}

onMounted(() => {
  void load();
  clockTimer = setInterval(() => {
    clockNow.value = Date.now() + serverOffsetMs;
  }, 1_000);
});

onBeforeUnmount(() => {
  requestSequence++;
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <main class="dashboard-page resource-calendar-page">
    <header class="dashboard-header">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">闲</span>
        <span>得闲 SPA</span>
      </div>
      <nav class="user-actions" aria-label="后台导航">
        <RouterLink to="/dashboard">今日工作台</RouterLink>
        <RouterLink to="/receptions">接待查询</RouterLink>
        <RouterLink to="/scheduling">请假与冲突</RouterLink>
        <RouterLink to="/booking-policy">预约政策</RouterLink>
        <span v-if="calendar" class="signed-in-user">
          {{ calendar.user.displayName }}
        </span>
      </nav>
    </header>

    <section class="workbench-heading calendar-heading">
      <div>
        <p class="eyebrow">阶段 1B · 只读日历</p>
        <h1>预约计划与资源限制</h1>
        <p>
          查看计划占用和限制；空白不代表可预约，计划结束也不代表服务已完成。
        </p>
      </div>
    </section>

    <form class="calendar-toolbar" @submit.prevent="load()">
      <button type="button" @click="moveDate(-1)">前一天</button>
      <label>
        <span>查看日期</span>
        <input v-model="selectedDate" type="date" required />
      </label>
      <button type="submit">查看该日</button>
      <button
        v-if="selectedDate !== shanghaiDay(clockNow)"
        type="button"
        @click="
          selectedDate = shanghaiDay(clockNow);
          load();
        "
      >
        今天
      </button>
      <button type="button" @click="moveDate(1)">后一天</button>
      <span v-if="refreshing" role="status">正在读取…</span>
    </form>

    <el-skeleton v-if="loading && !calendar" :rows="9" animated />

    <section
      v-else-if="!calendar"
      class="stage-card calendar-error"
      role="alert"
    >
      <h2>暂时无法读取预约日历</h2>
      <p>{{ error }}</p>
      <el-button type="primary" @click="load()">重新读取</el-button>
    </section>

    <template v-else>
      <section v-if="error" class="calendar-warning" role="alert">
        <strong>{{ failedDate }} 尚未读取成功</strong>
        <p>
          {{ error }} 当前继续展示
          <b>{{ calendar.serviceDate }}</b>
          的数据，最后成功读取于 {{ shanghaiTime(calendar.serverNow) }}。
        </p>
      </section>

      <section class="calendar-summary" aria-label="当日预约摘要">
        <div>
          <span>数据日期</span>
          <strong>{{ shanghaiDateLabel(calendar.serviceDate) }}</strong>
          <small>{{ calendar.serviceDate }}</small>
        </div>
        <div>
          <span>待确认</span><strong>{{ pendingCount }}</strong
          ><small>组</small>
        </div>
        <div>
          <span>已确认</span><strong>{{ confirmedCount }}</strong
          ><small>组</small>
        </div>
        <div :class="{ 'has-warning': conflictCount > 0 }">
          <span>待处理冲突</span><strong>{{ conflictCount }}</strong
          ><small>组</small>
        </div>
      </section>

      <section
        v-if="equipmentRestrictions.length"
        class="equipment-summary"
        aria-labelledby="equipment-summary-title"
      >
        <h2 id="equipment-summary-title">设备限制摘要</h2>
        <ul>
          <li v-for="item in equipmentRestrictions" :key="item.id">
            <strong>{{ item.resourceName ?? "未命名设备" }}</strong>
            <span>{{ restrictionLabels[item.kind] }}</span>
            <time>{{
              timeRange(item.startAt, item.endAt, calendar.serviceDate)
            }}</time>
          </li>
        </ul>
        <p>仅展示已登记的设备限制，不推断设备与项目之间尚未建立的依赖。</p>
      </section>

      <section class="calendar-panel">
        <header class="calendar-panel-header">
          <div>
            <h2>{{ calendar.serviceDate }} 资源安排</h2>
            <p>班次外为未排班；必要休息超出班次不会由本页自行判定为冲突。</p>
          </div>
          <div class="calendar-view-switch" aria-label="日历视图">
            <button
              type="button"
              :class="{ 'is-active': view === 'therapist' }"
              :aria-pressed="view === 'therapist'"
              @click="view = 'therapist'"
            >
              美容师
            </button>
            <button
              type="button"
              :class="{ 'is-active': view === 'facility' }"
              :aria-pressed="view === 'facility'"
              @click="view = 'facility'"
            >
              房间／床位
            </button>
          </div>
        </header>

        <div class="calendar-legend" aria-label="图例">
          <span><i class="legend-shift"></i>已发布班次</span>
          <span><i class="legend-unplanned"></i>未排班／空白</span>
          <span><i class="legend-pending"></i>待确认计划</span>
          <span><i class="legend-confirmed"></i>已确认计划</span>
          <span><i class="legend-restriction"></i>资源限制</span>
          <span><i class="legend-conflict"></i>待处理冲突</span>
        </div>

        <p v-if="displayedResources.length === 0" class="calendar-empty">
          当前视图没有可展示的资源。空白仅表示未记录占用，不代表可预约。
        </p>

        <div v-else class="desktop-calendar" aria-label="资源日时间轴">
          <div class="timeline-grid">
            <div class="timeline-resource-heading">资源</div>
            <div class="timeline-hours" aria-hidden="true">
              <span
                v-for="hour in hourLabels"
                :key="hour"
                :style="{ left: `${(hour / 24) * 100}%` }"
                >{{ String(hour).padStart(2, "0") }}:00</span
              >
            </div>

            <template v-for="resource in displayedResources" :key="resource.id">
              <div class="timeline-resource-name">
                <strong>{{ resource.name }}</strong>
                <span>{{ resourceTypeLabel(resource) }}</span>
                <small v-if="parentRoomName(resource)">{{
                  parentRoomName(resource)
                }}</small>
                <small v-if="!resource.active">已停用</small>
              </div>
              <div
                class="timeline-track"
                :class="{
                  'is-unplanned': resource.resourceType === 'therapist',
                }"
              >
                <span
                  v-for="shift in shiftsFor(resource)"
                  :key="shift.id"
                  class="shift-window"
                  :style="
                    periodStyle(
                      shift.startAt,
                      shift.endAt,
                      calendar.serviceDate,
                    )
                  "
                  :title="`已发布班次 ${timeRange(shift.startAt, shift.endAt, calendar.serviceDate)}`"
                ></span>
                <span
                  v-for="restriction in restrictionsFor(resource)"
                  :key="restriction.id"
                  class="restriction-block"
                  :style="
                    periodStyle(
                      restriction.startAt,
                      restriction.endAt,
                      calendar.serviceDate,
                    )
                  "
                  :title="`${restrictionName(restriction, resource)} ${timeRange(restriction.startAt, restriction.endAt, calendar.serviceDate)}`"
                  >{{ restrictionName(restriction, resource) }}</span
                >
                <button
                  v-for="allocation in allocationsFor(resource)"
                  :key="allocation.id"
                  type="button"
                  class="allocation-block"
                  :class="[
                    `is-${allocation.receptionState}`,
                    `is-${allocation.segmentKind}`,
                    { 'has-conflict': allocation.hasConflict },
                  ]"
                  :style="
                    periodStyle(
                      allocation.startAt,
                      allocation.endAt,
                      calendar.serviceDate,
                    )
                  "
                  :title="`${receptionStateLabels[allocation.receptionState]} · ${allocationLabel(allocation, resource)} ${timeRange(allocation.startAt, allocation.endAt, calendar.serviceDate)}`"
                  @click="openReception(allocation.receptionId)"
                >
                  <span class="allocation-state">{{
                    receptionStateLabels[allocation.receptionState]
                  }}</span>
                  <strong>{{ allocationLabel(allocation, resource) }}</strong>
                  <small>{{
                    timeRange(
                      allocation.startAt,
                      allocation.endAt,
                      calendar.serviceDate,
                    )
                  }}</small>
                  <b v-if="allocation.hasConflict" class="allocation-conflict"
                    >冲突</b
                  >
                </button>
                <span
                  v-if="showsCurrentTime"
                  class="current-time-line"
                  :style="currentTimeStyle"
                  aria-label="当前时间"
                ></span>
              </div>
            </template>
          </div>
        </div>

        <div class="mobile-calendar" aria-label="资源日安排列表">
          <article v-for="resource in displayedResources" :key="resource.id">
            <header>
              <div>
                <h3>{{ resource.name }}</h3>
                <p>
                  {{ resourceTypeLabel(resource) }}
                  <span v-if="parentRoomName(resource)"
                    >· {{ parentRoomName(resource) }}</span
                  >
                </p>
              </div>
              <span v-if="!resource.active">已停用</span>
            </header>
            <dl
              v-if="resource.resourceType === 'therapist'"
              class="mobile-shifts"
            >
              <dt>已发布班次</dt>
              <dd v-if="shiftsFor(resource).length">
                <span v-for="shift in shiftsFor(resource)" :key="shift.id">
                  {{
                    timeRange(shift.startAt, shift.endAt, calendar.serviceDate)
                  }}
                </span>
              </dd>
              <dd v-else>未排班</dd>
            </dl>
            <ul
              v-if="restrictionsFor(resource).length"
              class="mobile-restrictions"
            >
              <li v-for="item in restrictionsFor(resource)" :key="item.id">
                <strong>{{ restrictionName(item, resource) }}</strong>
                <span>{{
                  timeRange(item.startAt, item.endAt, calendar.serviceDate)
                }}</span>
              </li>
            </ul>
            <div
              v-if="allocationsFor(resource).length"
              class="mobile-allocations"
            >
              <button
                v-for="allocation in allocationsFor(resource)"
                :key="allocation.id"
                type="button"
                :class="[
                  `is-${allocation.receptionState}`,
                  { 'has-conflict': allocation.hasConflict },
                ]"
                @click="openReception(allocation.receptionId)"
              >
                <span class="allocation-time">{{
                  timeRange(
                    allocation.startAt,
                    allocation.endAt,
                    calendar.serviceDate,
                  )
                }}</span>
                <b class="allocation-state">{{
                  receptionStateLabels[allocation.receptionState]
                }}</b>
                <strong class="allocation-title">{{
                  allocationLabel(allocation, resource)
                }}</strong>
                <small class="allocation-service">{{
                  allocation.serviceItemName ?? "项目未记录"
                }}</small>
                <b v-if="allocation.hasConflict" class="allocation-conflict"
                  >待处理冲突</b
                >
              </button>
            </div>
            <p v-else class="resource-empty">未记录预约占用，不代表可预约。</p>
          </article>
        </div>
      </section>
    </template>
  </main>
</template>
