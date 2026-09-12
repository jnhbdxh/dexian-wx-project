<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { ApiRequestError, type StaffUser } from "../lib/api";
import {
  getBookingPolicyVersions,
  getBookingPolicyWorkspace,
  isBookingPolicyV2,
  previewBookingPolicy,
  publishBookingPolicy,
  saveBookingPolicyDraft,
  setBookingPolicyActivation,
  type BookingPolicyPayload,
  type BookingPolicyPayloadV2,
  type BookingPolicyRevision,
  type BookingPolicyWorkspace,
  type PolicyIdentity,
  type PolicyInterval,
  type PolicyPreview,
  type PublishPolicyInput,
  type SavePolicyDraftInput,
} from "../lib/booking-policy-api";
import {
  clearBookingPolicyRecovery,
  isBookingPolicyRecoveryOwner,
  loadBookingPolicyRecovery,
  saveBookingPolicyRecovery,
  type BookingPolicyRecovery,
} from "../lib/booking-policy-recovery";
import "./booking-policy.css";

interface EditorInterval {
  start: string;
  end: string;
  nextDay: boolean;
}

interface EditorDay {
  weekday: number;
  label: string;
  enabled: boolean;
  intervals: EditorInterval[];
}

interface EditorException {
  serviceDate: string;
  kind: "closed" | "replace";
  intervals: EditorInterval[];
}

const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const router = useRouter();
const workspace = ref<BookingPolicyWorkspace>();
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const preview = ref<PolicyPreview>();
const history = ref<BookingPolicyRevision[]>([]);
const historyCursor = ref<string | null>(null);
const historyLoading = ref(false);
const changeReason = ref("");
const maxAdvanceDays = ref(0);
const minimumLeadMinutes = ref(0);
const startGridMinutes = ref(30);
const onlineHoldMinutes = ref<number | "">("");
const onsiteHoldMinutes = ref<number | "">("");
const weekly = ref<EditorDay[]>(
  weekdayLabels.map((label, weekday) => ({
    weekday,
    label,
    enabled: false,
    intervals: [],
  })),
);
const exceptions = ref<EditorException[]>([]);
const processingWeekly = ref<EditorDay[]>(
  weekdayLabels.map((label, weekday) => ({
    weekday,
    label,
    enabled: false,
    intervals: [],
  })),
);
const processingExceptions = ref<EditorException[]>([]);
const recovery = ref<BookingPolicyRecovery>();
const recoveryCorrupt = ref(false);
const recoveryNeedsLogin = ref(false);
let loadSequence = 0;
let identityRequestSequence = 0;
let identityAppliedSequence = 0;
let previewRequestSequence = 0;
let historyRequestSequence = 0;

const identity = computed<PolicyIdentity | undefined>(() =>
  workspace.value
    ? {
        initiatingStaffUserId: workspace.value.user.id,
        initiatingStoreId: workspace.value.user.storeId,
      }
    : undefined,
);
const lockedByRecovery = computed(
  () => recoveryCorrupt.value || recovery.value !== undefined,
);
const firstActivation = computed(() => !workspace.value?.published);
const editorPayload = computed(() => buildPayload());
const hasCompleteTimingConfiguration = computed(
  () =>
    Number.isInteger(Number(onlineHoldMinutes.value)) &&
    Number(onlineHoldMinutes.value) >= 1 &&
    Number(onlineHoldMinutes.value) <= 43_200 &&
    Number.isInteger(Number(onsiteHoldMinutes.value)) &&
    Number(onsiteHoldMinutes.value) >= 1 &&
    Number(onsiteHoldMinutes.value) <= 43_200,
);
const hasCompleteCalendarConfiguration = computed(
  () =>
    weekly.value.every((day) => !day.enabled || day.intervals.length > 0) &&
    processingWeekly.value.every(
      (day) => !day.enabled || day.intervals.length > 0,
    ) &&
    exceptions.value.every(
      (item) => item.kind === "closed" || item.intervals.length > 0,
    ) &&
    processingExceptions.value.every(
      (item) => item.kind === "closed" || item.intervals.length > 0,
    ),
);
const hasCompletePolicyConfiguration = computed(
  () =>
    hasCompleteTimingConfiguration.value &&
    hasCompleteCalendarConfiguration.value,
);
const currentPreview = computed(() => {
  if (!preview.value || !workspace.value?.latestDraft) return undefined;
  if (preview.value.draftRevisionId !== workspace.value.latestDraft.id)
    return undefined;
  return payloadFingerprint(editorPayload.value) ===
    payloadFingerprint(workspace.value.latestDraft.payload)
    ? preview.value
    : undefined;
});
const hasUnsavedDraftChanges = computed(
  () =>
    Boolean(workspace.value?.latestDraft) &&
    payloadFingerprint(editorPayload.value) !==
      payloadFingerprint(workspace.value!.latestDraft!.payload),
);
const canPublishPreview = computed(
  () =>
    Boolean(currentPreview.value?.canPublish) &&
    Boolean(changeReason.value.trim()) &&
    !lockedByRecovery.value,
);

function payloadFingerprint(payload: BookingPolicyPayload) {
  return JSON.stringify(payload);
}

function minutesToTime(minutes: number) {
  return `${Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0")}:${(minutes % 60).toString().padStart(2, "0")}`;
}

function timeToMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

function policyIntervalLabel(interval: PolicyInterval) {
  return `${minutesToTime(interval.startMinute)}–${
    interval.endDayOffset === 1 ? "次日 " : ""
  }${minutesToTime(interval.endMinute)}`;
}

function expandedIntervalLabel(startAt: string, endAt: string) {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: workspace.value?.store.timeZone ?? "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  return `${new Intl.DateTimeFormat("zh-CN", options).format(
    new Date(startAt),
  )}–${new Intl.DateTimeFormat("zh-CN", options).format(new Date(endAt))}`;
}

function expandedSourceLabel(
  source: "weekly" | "previous_day_carry" | "date_exception",
) {
  if (source === "previous_day_carry") return "前日延续";
  if (source === "date_exception") return "日期例外";
  return "周规则";
}

function toEditorInterval(interval: PolicyInterval): EditorInterval {
  return {
    start: minutesToTime(interval.startMinute),
    end: minutesToTime(interval.endMinute),
    nextDay: interval.endDayOffset === 1,
  };
}

function toPolicyInterval(interval: EditorInterval): PolicyInterval {
  return {
    startMinute: timeToMinutes(interval.start),
    endMinute: timeToMinutes(interval.end),
    endDayOffset: interval.nextDay ? 1 : 0,
  };
}

function editorDays(
  rules: Array<{ weekday: number; intervals: PolicyInterval[] }>,
) {
  return weekdayLabels.map((label, weekday) => {
    const rule = rules.find((item) => item.weekday === weekday);
    return {
      weekday,
      label,
      enabled: Boolean(rule),
      intervals: rule?.intervals.map(toEditorInterval) ?? [],
    };
  });
}

function editorExceptions(
  values: Array<{
    serviceDate: string;
    kind: "closed" | "replace";
    intervals: PolicyInterval[];
  }>,
) {
  return values.map((item) => ({
    serviceDate: item.serviceDate,
    kind: item.kind,
    intervals: item.intervals.map(toEditorInterval),
  }));
}

function applyPayload(payload: BookingPolicyPayload) {
  maxAdvanceDays.value = payload.maxAdvanceDays;
  minimumLeadMinutes.value = payload.minimumLeadMinutes;
  startGridMinutes.value = payload.startGridMinutes;
  weekly.value = editorDays(payload.weeklyRules);
  exceptions.value = editorExceptions(payload.dateExceptions);
  onlineHoldMinutes.value = isBookingPolicyV2(payload)
    ? payload.onlineHoldMinutes
    : "";
  onsiteHoldMinutes.value = isBookingPolicyV2(payload)
    ? payload.onsiteHoldMinutes
    : "";
  processingWeekly.value = isBookingPolicyV2(payload)
    ? editorDays(payload.processingWeeklyRules)
    : editorDays([]);
  processingExceptions.value = isBookingPolicyV2(payload)
    ? editorExceptions(payload.processingDateExceptions)
    : [];
}

function resetEditor() {
  maxAdvanceDays.value = 0;
  minimumLeadMinutes.value = 0;
  startGridMinutes.value = 30;
  onlineHoldMinutes.value = "";
  onsiteHoldMinutes.value = "";
  weekly.value = weekdayLabels.map((label, weekday) => ({
    weekday,
    label,
    enabled: false,
    intervals: [],
  }));
  exceptions.value = [];
  processingWeekly.value = editorDays([]);
  processingExceptions.value = [];
  changeReason.value = "";
}

function buildPayload(): BookingPolicyPayloadV2 {
  return {
    version: 2,
    maxAdvanceDays: Number(maxAdvanceDays.value),
    minimumLeadMinutes: Number(minimumLeadMinutes.value),
    startGridMinutes: Number(startGridMinutes.value),
    onlineHoldMinutes: Number(onlineHoldMinutes.value),
    onsiteHoldMinutes: Number(onsiteHoldMinutes.value),
    weeklyRules: weekly.value
      .filter((day) => day.enabled)
      .map((day) => ({
        weekday: day.weekday,
        intervals: day.intervals.map(toPolicyInterval),
      })),
    dateExceptions: exceptions.value.map((item) => ({
      serviceDate: item.serviceDate,
      kind: item.kind,
      intervals:
        item.kind === "replace" ? item.intervals.map(toPolicyInterval) : [],
    })),
    processingWeeklyRules: processingWeekly.value
      .filter((day) => day.enabled)
      .map((day) => ({
        weekday: day.weekday,
        intervals: day.intervals.map(toPolicyInterval),
      })),
    processingDateExceptions: processingExceptions.value.map((item) => ({
      serviceDate: item.serviceDate,
      kind: item.kind,
      intervals:
        item.kind === "replace" ? item.intervals.map(toPolicyInterval) : [],
    })),
  };
}

function addInterval(target: { intervals: EditorInterval[] }) {
  target.intervals.push({ start: "09:00", end: "18:00", nextDay: false });
}

function addException() {
  exceptions.value.push({ serviceDate: "", kind: "closed", intervals: [] });
}

function addProcessingException() {
  processingExceptions.value.push({
    serviceDate: "",
    kind: "closed",
    intervals: [],
  });
}

function readableError(value: unknown) {
  return value instanceof Error
    ? value.message
    : "系统暂时无法处理，请稍后重试";
}

function sameIdentity(left: StaffUser, right: StaffUser) {
  return left.id === right.id && left.storeId === right.storeId;
}

function clearProtectedState() {
  previewRequestSequence += 1;
  historyRequestSequence += 1;
  workspace.value = undefined;
  preview.value = undefined;
  history.value = [];
  historyCursor.value = null;
  historyLoading.value = false;
  resetEditor();
}

function observeIdentity(user: StaffUser, sequence: number) {
  if (sequence <= identityAppliedSequence) return "stale" as const;
  identityAppliedSequence = sequence;
  const changed = Boolean(
    workspace.value && !sameIdentity(workspace.value.user, user),
  );
  if (changed) clearProtectedState();
  return changed ? ("changed" as const) : ("current" as const);
}

function needsRecoveryLogin(value: unknown) {
  return (
    value instanceof ApiRequestError &&
    (value.status === 401 ||
      value.status === 403 ||
      value.code === "BOOKING_POLICY_IDENTITY_CHANGED")
  );
}

function shouldKeepRecovery(value: unknown) {
  return (
    !(value instanceof ApiRequestError) ||
    value.status >= 500 ||
    value.status === 401 ||
    value.status === 403 ||
    value.code === "REQUEST_IN_PROGRESS" ||
    value.code === "BOOKING_POLICY_IDENTITY_CHANGED"
  );
}

async function load() {
  const sequence = ++loadSequence;
  previewRequestSequence += 1;
  historyRequestSequence += 1;
  preview.value = undefined;
  historyLoading.value = false;
  const identitySequence = ++identityRequestSequence;
  loading.value = !workspace.value;
  error.value = "";
  try {
    const result = await getBookingPolicyWorkspace();
    const workspaceIdentity = observeIdentity(result.user, identitySequence);
    if (workspaceIdentity === "stale") return;
    if (sequence !== loadSequence) return;
    workspace.value = result;
    const source = result.latestDraft ?? result.published;
    if (!lockedByRecovery.value) {
      if (source) applyPayload(source.payload);
      else resetEditor();
    }
    if (recovery.value) {
      recoveryNeedsLogin.value = !isBookingPolicyRecoveryOwner(
        recovery.value,
        result.user,
      );
    }
    const versionsIdentitySequence = ++identityRequestSequence;
    const versions = await getBookingPolicyVersions();
    const versionsIdentity = observeIdentity(
      versions.user,
      versionsIdentitySequence,
    );
    if (versionsIdentity === "stale") return;
    if (sequence !== loadSequence) return;
    if (!sameIdentity(result.user, versions.user)) {
      clearProtectedState();
      error.value = "登录账号已变化，请重新读取预约政策。";
      return;
    }
    history.value = versions.items;
    historyCursor.value = versions.nextCursor;
  } catch (value) {
    if (sequence !== loadSequence) return;
    if (value instanceof ApiRequestError && value.status === 403) {
      clearProtectedState();
      error.value = value.message || "当前账号无权查看预约政策。";
      return;
    }
    error.value = readableError(value);
    if (value instanceof ApiRequestError && value.status === 401) {
      clearProtectedState();
      if (recovery.value) recoveryNeedsLogin.value = true;
      else {
        await router.replace({
          path: "/login",
          query: { redirect: "/booking-policy" },
        });
      }
    }
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

async function saveDraft() {
  if (
    !workspace.value?.canEdit ||
    !identity.value ||
    lockedByRecovery.value ||
    !hasCompletePolicyConfiguration.value
  )
    return;
  const input: SavePolicyDraftInput = {
    ...identity.value,
    basePublishedVersion: workspace.value.published?.publishedVersion ?? null,
    payload: buildPayload(),
  };
  const attempt: BookingPolicyRecovery = {
    operation: "save",
    key: crypto.randomUUID(),
    input,
  };
  await executeRecovery(attempt);
}

async function runPreview(draftRevisionId?: string) {
  const id = draftRevisionId ?? workspace.value?.latestDraft?.id;
  const expectedUser = workspace.value?.user;
  if (!id || !expectedUser) return;
  const requestSequence = ++previewRequestSequence;
  const identitySequence = ++identityRequestSequence;
  busy.value = true;
  error.value = "";
  try {
    const result = await previewBookingPolicy(id);
    const identityState = observeIdentity(result.user, identitySequence);
    if (identityState === "changed") {
      error.value = "登录账号已变化，请重新读取预约政策。";
      return;
    }
    if (identityState === "stale" || requestSequence !== previewRequestSequence)
      return;
    if (
      !workspace.value ||
      !sameIdentity(expectedUser, workspace.value.user) ||
      !sameIdentity(result.user, workspace.value.user)
    ) {
      error.value = "登录账号已变化，请重新读取预约政策。";
      return;
    }
    preview.value = result;
    notice.value = result.canPublish
      ? "预览完成，当前没有发现会被新营业时间破坏的预约。"
      : `预览发现 ${result.impacts.length} 条受影响服务安排。`;
  } catch (value) {
    if (requestSequence !== previewRequestSequence) return;
    if (
      value instanceof ApiRequestError &&
      (value.status === 401 || value.status === 403)
    ) {
      clearProtectedState();
    }
    error.value = readableError(value);
  } finally {
    busy.value = false;
  }
}

async function publish() {
  if (
    !workspace.value?.canPublish ||
    !identity.value ||
    !currentPreview.value ||
    !canPublishPreview.value
  ) {
    return;
  }
  const input: PublishPolicyInput = {
    ...identity.value,
    draftRevisionId: currentPreview.value.draftRevisionId,
    basePublishedVersion: currentPreview.value.basePublishedVersion,
    changeReason: changeReason.value.trim(),
  };
  await executeRecovery({
    operation: "publish",
    key: crypto.randomUUID(),
    input,
  });
}

async function changeActivation(action: "pause" | "resume-legacy") {
  if (!workspace.value?.canPublish || !identity.value || lockedByRecovery.value)
    return;
  await executeRecovery({
    operation: action,
    key: crypto.randomUUID(),
    input: identity.value,
  });
}

async function executeRecovery(attempt: BookingPolicyRecovery) {
  recovery.value = attempt;
  saveBookingPolicyRecovery(attempt);
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (attempt.operation === "save") {
      const result = await saveBookingPolicyDraft(attempt.input, attempt.key);
      clearBookingPolicyRecovery();
      recovery.value = undefined;
      await load();
      await runPreview(result.draftRevisionId);
      notice.value = "草稿已保存为不可变修订，并已完成发布影响预览。";
      return;
    }
    if (attempt.operation === "publish") {
      const result = await publishBookingPolicy(attempt.input, attempt.key);
      clearBookingPolicyRecovery();
      recovery.value = undefined;
      preview.value = undefined;
      changeReason.value = "";
      await load();
      notice.value = `版本 ${result.publishedVersion} 已发布，新预约已按该版本校验。`;
      return;
    }
    await setBookingPolicyActivation(
      attempt.operation,
      attempt.input,
      attempt.key,
    );
    clearBookingPolicyRecovery();
    recovery.value = undefined;
    await load();
    if (attempt.operation === "pause" && workspace.value?.latestDraft?.id) {
      preview.value = undefined;
      await runPreview(workspace.value.latestDraft.id);
    }
    if (attempt.operation === "resume-legacy") preview.value = undefined;
    notice.value =
      attempt.operation === "pause"
        ? "新预占首次执行已暂停，在途请求已结束。请重新预览后发布首版。"
        : "首次启用已退出，旧预约入口已恢复。";
  } catch (value) {
    error.value = readableError(value);
    if (needsRecoveryLogin(value)) {
      recoveryNeedsLogin.value = true;
      clearProtectedState();
    }
    if (!shouldKeepRecovery(value)) {
      clearBookingPolicyRecovery();
      recovery.value = undefined;
    }
  } finally {
    busy.value = false;
  }
}

async function retryRecovery() {
  if (!recovery.value) return;
  if (
    recoveryNeedsLogin.value ||
    !workspace.value ||
    !isBookingPolicyRecoveryOwner(recovery.value, workspace.value.user)
  ) {
    await goToRecoveryLogin();
    return;
  }
  await executeRecovery(recovery.value);
}

async function goToRecoveryLogin() {
  await router.push({
    path: "/login",
    query: { redirect: "/booking-policy" },
  });
}

async function loadMoreHistory() {
  const cursor = historyCursor.value;
  const expectedUser = workspace.value?.user;
  if (!cursor || !expectedUser || historyLoading.value) return;
  const requestSequence = ++historyRequestSequence;
  const identitySequence = ++identityRequestSequence;
  historyLoading.value = true;
  try {
    const result = await getBookingPolicyVersions(cursor);
    const identityState = observeIdentity(result.user, identitySequence);
    if (identityState === "changed") {
      error.value = "登录账号已变化，请重新读取预约政策。";
      return;
    }
    if (identityState === "stale" || requestSequence !== historyRequestSequence)
      return;
    if (
      !workspace.value ||
      historyCursor.value !== cursor ||
      !sameIdentity(expectedUser, workspace.value.user) ||
      !sameIdentity(result.user, workspace.value.user)
    ) {
      error.value = "登录账号已变化，请重新读取预约政策。";
      return;
    }
    history.value.push(...result.items);
    historyCursor.value = result.nextCursor;
  } catch (value) {
    if (requestSequence !== historyRequestSequence) return;
    if (
      value instanceof ApiRequestError &&
      (value.status === 401 || value.status === 403)
    ) {
      clearProtectedState();
    }
    error.value = readableError(value);
  } finally {
    if (requestSequence === historyRequestSequence)
      historyLoading.value = false;
  }
}

onMounted(async () => {
  try {
    recovery.value = loadBookingPolicyRecovery();
  } catch (value) {
    recoveryCorrupt.value = true;
    error.value = readableError(value);
  }
  await load();
});
</script>

<template>
  <main class="dashboard-page booking-policy-page">
    <header class="dashboard-header">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">闲</span>
        <span>得闲 SPA</span>
      </div>
      <nav class="user-actions" aria-label="后台导航">
        <RouterLink to="/dashboard">今日工作台</RouterLink>
        <RouterLink to="/calendar">资源日历</RouterLink>
        <RouterLink to="/receptions">接待查询</RouterLink>
        <span v-if="workspace" class="signed-in-user">{{
          workspace.user.displayName
        }}</span>
      </nav>
    </header>

    <section class="workbench-heading policy-heading">
      <div>
        <p class="eyebrow">阶段 2A-2 · 预约期限配置</p>
        <h1>预约营业政策</h1>
        <p>同时配置营业时间、前台处理时间和两类保留期限，再预览并发布。</p>
      </div>
      <button class="refresh-button" :disabled="loading || busy" @click="load">
        刷新状态
      </button>
    </section>

    <section v-if="lockedByRecovery" class="policy-recovery" role="alert">
      <div>
        <strong>存在尚未核实的政策操作</strong>
        <p v-if="recovery">
          原操作、完整请求和提交标识已保留。核实完成前不能保存或发布新内容。
        </p>
        <p v-else>
          恢复记录已损坏，不能安全生成新请求，请联系管理员核对业务事件。
        </p>
      </div>
      <el-button v-if="recovery" :loading="busy" @click="retryRecovery">
        {{
          recoveryNeedsLogin || !workspace
            ? "重新登录原账号并核实"
            : "使用原请求核实"
        }}
      </el-button>
    </section>

    <el-skeleton v-if="loading && !workspace" :rows="8" animated />
    <section v-else-if="!workspace" class="stage-card" role="alert">
      <h2>暂时无法读取预约政策</h2>
      <p>{{ error }}</p>
      <el-button type="primary" @click="load">重新读取</el-button>
    </section>

    <template v-else>
      <p v-if="error" class="policy-message is-error" role="alert">
        {{ error }}
      </p>
      <p v-if="notice" class="policy-message is-success" role="status">
        {{ notice }}
      </p>

      <section class="policy-status-grid" aria-label="预约政策状态">
        <article>
          <span>当前发布版本</span>
          <strong>{{
            workspace.published?.publishedVersion ?? "尚未发布"
          }}</strong>
          <small>{{
            workspace.published?.publishedAt
              ? new Date(workspace.published.publishedAt).toLocaleString(
                  "zh-CN",
                )
              : "新预约暂未启用政策入口"
          }}</small>
        </article>
        <article>
          <span>最新草稿</span>
          <strong>{{ workspace.latestDraft ? "已保存" : "无" }}</strong>
          <small>{{
            workspace.latestDraft?.createdByName ?? "请先录入真实营业安排"
          }}</small>
        </article>
        <article
          :class="{
            'is-paused':
              workspace.store.bookingCreationMode ===
              'paused_for_policy_activation',
          }"
        >
          <span>新预约入口</span>
          <strong>{{
            workspace.store.bookingCreationMode === "policy_enforced"
              ? "政策已生效"
              : workspace.store.bookingCreationMode ===
                  "paused_for_policy_activation"
                ? "切换中暂停"
                : "旧入口运行中"
          }}</strong>
          <small>{{ workspace.store.name }}</small>
        </article>
      </section>

      <div class="policy-layout">
        <section class="policy-editor">
          <header>
            <div>
              <h2>1. 编辑预约政策草稿</h2>
              <p>营业与前台处理日历分别配置；线上期限只累计两者交集。</p>
            </div>
          </header>

          <div class="policy-parameters">
            <label
              ><span>最远预约天数</span
              ><input
                v-model.number="maxAdvanceDays"
                type="number"
                min="0"
                max="365"
            /></label>
            <label
              ><span>最少提前分钟</span
              ><input
                v-model.number="minimumLeadMinutes"
                type="number"
                min="0"
                max="43200"
            /></label>
            <label
              ><span>开始时间网格</span
              ><input
                v-model.number="startGridMinutes"
                type="number"
                min="1"
                max="1440"
            /></label>
            <label
              ><span>线上保留（可处理分钟）</span
              ><input
                v-model.number="onlineHoldMinutes"
                type="number"
                min="1"
                max="43200"
                placeholder="例如 120"
            /></label>
            <label
              ><span>现场保留（自然分钟）</span
              ><input
                v-model.number="onsiteHoldMinutes"
                type="number"
                min="1"
                max="43200"
                placeholder="例如 30"
            /></label>
          </div>

          <p
            v-if="!hasCompleteTimingConfiguration"
            class="policy-v2-warning"
            role="status"
          >
            请分别填写 1–43,200
            分钟的线上和现场保留时间。旧版本不会自动补默认值。
          </p>
          <p
            v-if="!hasCompleteCalendarConfiguration"
            class="policy-v2-warning"
            role="status"
          >
            已启用的营业日、处理日和替代日期都必须至少添加一个区间，才能保存草稿。
          </p>
          <p class="calendar-note">
            现场保留分钟数已配置，待现场接待入口接入；本片不会用它改变线上期限。
          </p>

          <h3 class="calendar-heading">门店营业日历</h3>

          <div class="weekly-editor">
            <article
              v-for="day in weekly"
              :key="day.weekday"
              class="policy-day"
            >
              <header>
                <label class="day-toggle"
                  ><input v-model="day.enabled" type="checkbox" />{{
                    day.label
                  }}营业</label
                >
                <button
                  v-if="day.enabled"
                  type="button"
                  @click="addInterval(day)"
                >
                  新增区间
                </button>
              </header>
              <p v-if="!day.enabled">不按周规则开放</p>
              <div
                v-for="(interval, index) in day.intervals"
                v-else
                :key="index"
                class="interval-row"
              >
                <input
                  v-model="interval.start"
                  type="time"
                  aria-label="开始时间"
                />
                <span>至</span>
                <input
                  v-model="interval.end"
                  type="time"
                  aria-label="结束时间"
                />
                <label
                  ><input
                    v-model="interval.nextDay"
                    type="checkbox"
                  />次日结束</label
                >
                <button type="button" @click="day.intervals.splice(index, 1)">
                  移除
                </button>
              </div>
              <p
                v-if="day.enabled && day.intervals.length === 0"
                class="inline-warning"
              >
                营业日尚未添加区间
              </p>
            </article>
          </div>

          <section class="exception-editor">
            <header>
              <div>
                <h3>指定日期例外</h3>
                <p>替代区间可跨日；下一自然日自己的例外仍优先。</p>
              </div>
              <button type="button" @click="addException">新增例外</button>
            </header>
            <article
              v-for="(item, index) in exceptions"
              :key="index"
              class="exception-row"
            >
              <input
                v-model="item.serviceDate"
                type="date"
                aria-label="例外日期"
              />
              <select v-model="item.kind" aria-label="例外类型">
                <option value="closed">全天闭店</option>
                <option value="replace">替代营业区间</option>
              </select>
              <button
                v-if="item.kind === 'replace'"
                type="button"
                @click="addInterval(item)"
              >
                新增区间
              </button>
              <button type="button" @click="exceptions.splice(index, 1)">
                删除例外
              </button>
              <div v-if="item.kind === 'replace'" class="exception-intervals">
                <div
                  v-for="(interval, intervalIndex) in item.intervals"
                  :key="intervalIndex"
                  class="interval-row"
                >
                  <input
                    v-model="interval.start"
                    type="time"
                    aria-label="开始时间"
                  /><span>至</span>
                  <input
                    v-model="interval.end"
                    type="time"
                    aria-label="结束时间"
                  />
                  <label
                    ><input
                      v-model="interval.nextDay"
                      type="checkbox"
                    />次日结束</label
                  >
                  <button
                    type="button"
                    @click="item.intervals.splice(intervalIndex, 1)"
                  >
                    移除
                  </button>
                </div>
              </div>
            </article>
          </section>

          <h3 class="calendar-heading">前台处理日历</h3>
          <p class="calendar-note">
            这里记录可审核线上申请的时间，不代表服务已完成或该时刻一定可预约。
          </p>

          <div class="weekly-editor">
            <article
              v-for="day in processingWeekly"
              :key="day.weekday"
              class="policy-day"
            >
              <header>
                <label class="day-toggle"
                  ><input v-model="day.enabled" type="checkbox" />{{
                    day.label
                  }}可处理</label
                >
                <button
                  v-if="day.enabled"
                  type="button"
                  @click="addInterval(day)"
                >
                  新增区间
                </button>
              </header>
              <p v-if="!day.enabled">不按周规则处理线上申请</p>
              <div
                v-for="(interval, index) in day.intervals"
                v-else
                :key="index"
                class="interval-row"
              >
                <input
                  v-model="interval.start"
                  type="time"
                  aria-label="前台处理开始时间"
                />
                <span>至</span>
                <input
                  v-model="interval.end"
                  type="time"
                  aria-label="前台处理结束时间"
                />
                <label
                  ><input
                    v-model="interval.nextDay"
                    type="checkbox"
                  />次日结束</label
                >
                <button type="button" @click="day.intervals.splice(index, 1)">
                  移除
                </button>
              </div>
              <p
                v-if="day.enabled && day.intervals.length === 0"
                class="inline-warning"
              >
                处理日尚未添加区间
              </p>
            </article>
          </div>

          <section class="exception-editor">
            <header>
              <div>
                <h3>前台处理日期例外</h3>
                <p>例外按实际自然日覆盖，也会截断前一日延续区间。</p>
              </div>
              <button type="button" @click="addProcessingException">
                新增例外
              </button>
            </header>
            <article
              v-for="(item, index) in processingExceptions"
              :key="index"
              class="exception-row"
            >
              <input
                v-model="item.serviceDate"
                type="date"
                aria-label="前台处理例外日期"
              />
              <select v-model="item.kind" aria-label="前台处理例外类型">
                <option value="closed">全天不处理</option>
                <option value="replace">替代处理区间</option>
              </select>
              <button
                v-if="item.kind === 'replace'"
                type="button"
                @click="addInterval(item)"
              >
                新增区间
              </button>
              <button
                type="button"
                @click="processingExceptions.splice(index, 1)"
              >
                删除例外
              </button>
              <div v-if="item.kind === 'replace'" class="exception-intervals">
                <div
                  v-for="(interval, intervalIndex) in item.intervals"
                  :key="intervalIndex"
                  class="interval-row"
                >
                  <input
                    v-model="interval.start"
                    type="time"
                    aria-label="前台例外开始时间"
                  /><span>至</span>
                  <input
                    v-model="interval.end"
                    type="time"
                    aria-label="前台例外结束时间"
                  />
                  <label
                    ><input
                      v-model="interval.nextDay"
                      type="checkbox"
                    />次日结束</label
                  >
                  <button
                    type="button"
                    @click="item.intervals.splice(intervalIndex, 1)"
                  >
                    移除
                  </button>
                </div>
              </div>
            </article>
          </section>

          <el-button
            type="primary"
            :disabled="
              !workspace.canEdit ||
              lockedByRecovery ||
              !hasCompletePolicyConfiguration
            "
            :loading="busy"
            @click="saveDraft"
            >保存草稿并预览</el-button
          >
          <p v-if="!workspace.canEdit" class="inline-warning">
            当前账号只有查看权限，不能保存草稿。
          </p>
        </section>

        <aside class="policy-publish-panel">
          <h2>2. 检查并发布</h2>
          <template v-if="currentPreview">
            <p
              class="preview-summary"
              :class="{ 'has-impact': currentPreview.impacts.length }"
            >
              {{
                currentPreview.impacts.length
                  ? `发现 ${currentPreview.impacts.length} 条受影响安排，不能发布。`
                  : "未发现受影响的未来有效预约。"
              }}
            </p>
            <ul v-if="currentPreview.impacts.length" class="impact-list">
              <li v-for="item in currentPreview.impacts" :key="item.guestId">
                <strong
                  >{{ item.customerName }} · {{ item.serviceItemName }}</strong
                >
                <span
                  >{{ new Date(item.serviceStartAt).toLocaleString("zh-CN") }}
                  至
                  {{
                    new Date(item.serviceEndAt).toLocaleString("zh-CN")
                  }}</span
                >
                <small
                  >{{ item.state === "pending" ? "待确认" : "已确认" }} ·
                  {{ item.reasonCode }}</small
                >
              </li>
            </ul>

            <section class="policy-preview-section">
              <h3>与当前版本的差异</h3>
              <ul v-if="currentPreview.changes.length" class="change-list">
                <li
                  v-for="change in currentPreview.changes"
                  :key="change.field"
                >
                  <strong>{{ change.label }}</strong>
                  <span>原值：{{ change.previous }}</span>
                  <span>草稿：{{ change.next }}</span>
                </li>
              </ul>
              <p v-else>草稿与当前发布版本没有配置差异。</p>
            </section>

            <details class="expanded-calendar">
              <summary>
                核对未来 {{ currentPreview.expandedDays.length }} 个自然日
              </summary>
              <div class="expanded-day-list">
                <article
                  v-for="day in currentPreview.expandedDays"
                  :key="day.serviceDate"
                >
                  <strong>{{ day.serviceDate }}</strong>
                  <span>{{ day.status === "open" ? "营业" : "闭店" }}</span>
                  <small>
                    营业来源：{{
                      day.sources.length
                        ? day.sources.map(expandedSourceLabel).join("、")
                        : "无营业区间"
                    }}
                  </small>
                  <p v-for="interval in day.intervals" :key="interval.startAt">
                    营业
                    {{
                      expandedIntervalLabel(interval.startAt, interval.endAt)
                    }}
                  </p>
                  <small>
                    前台处理：{{
                      day.processingSources.length
                        ? day.processingSources
                            .map(expandedSourceLabel)
                            .join("、")
                        : "无处理区间"
                    }}
                  </small>
                  <p
                    v-for="interval in day.processingIntervals"
                    :key="'processing-' + interval.startAt"
                  >
                    可处理
                    {{
                      expandedIntervalLabel(interval.startAt, interval.endAt)
                    }}
                  </p>
                  <small>
                    实际累计区间：{{
                      day.effectiveProcessingIntervals.length
                        ? day.effectiveProcessingIntervals
                            .map((interval) =>
                              expandedIntervalLabel(
                                interval.startAt,
                                interval.endAt,
                              ),
                            )
                            .join("、")
                        : "无"
                    }}
                  </small>
                </article>
              </div>
            </details>

            <label class="reason-field"
              ><span>发布原因</span
              ><textarea
                v-model="changeReason"
                maxlength="500"
                placeholder="说明本次营业时间或入口参数变更"
              />
            </label>

            <div v-if="firstActivation" class="activation-steps">
              <strong>首次启用步骤</strong>
              <ol>
                <li>暂停新的预占首次执行并等待在途请求结束。</li>
                <li>重新预览当前草稿。</li>
                <li>发布首版并同时启用强校验。</li>
              </ol>
              <el-button
                v-if="workspace.store.bookingCreationMode === 'legacy'"
                :disabled="lockedByRecovery"
                @click="changeActivation('pause')"
                >暂停新预约并进入切换</el-button
              >
              <el-button
                v-else-if="
                  workspace.store.bookingCreationMode ===
                  'paused_for_policy_activation'
                "
                @click="runPreview()"
                >重新检查影响</el-button
              >
              <button
                v-if="
                  workspace.store.bookingCreationMode ===
                  'paused_for_policy_activation'
                "
                class="text-action"
                type="button"
                @click="changeActivation('resume-legacy')"
              >
                退出切换并恢复旧入口
              </button>
            </div>

            <el-button
              class="publish-button"
              type="primary"
              :disabled="
                !workspace.canPublish ||
                !canPublishPreview ||
                (firstActivation &&
                  workspace.store.bookingCreationMode !==
                    'paused_for_policy_activation')
              "
              :loading="busy"
              @click="publish"
              >发布当前草稿修订</el-button
            >
          </template>
          <p v-else-if="hasUnsavedDraftChanges" class="preview-stale">
            表单内容已修改。请先保存为新草稿并重新预览，旧草稿不能发布。
          </p>
          <p v-else>
            保存草稿后，系统会列出配置差异、未来营业展开结果和受影响预约。
          </p>
        </aside>
      </div>

      <section class="policy-history">
        <header>
          <div>
            <h2>历史发布版本</h2>
            <p>历史内容不可修改，可用于核对发布人、时间与原因。</p>
          </div>
        </header>
        <div v-if="history.length" class="history-list">
          <article v-for="item in history" :key="item.id">
            <strong>版本 {{ item.publishedVersion }}</strong
            ><span>{{ item.changeReason }}</span
            ><small
              >{{ item.createdByName }} ·
              {{
                item.publishedAt
                  ? new Date(item.publishedAt).toLocaleString("zh-CN")
                  : ""
              }}</small
            >
            <details>
              <summary>查看配置</summary>
              <p>
                最远 {{ item.payload.maxAdvanceDays }} 天 · 提前
                {{ item.payload.minimumLeadMinutes }} 分钟 · 网格
                {{ item.payload.startGridMinutes }} 分钟
              </p>
              <p v-if="isBookingPolicyV2(item.payload)">
                线上 {{ item.payload.onlineHoldMinutes }} 个可处理分钟 · 现场
                {{ item.payload.onsiteHoldMinutes }}
                个自然分钟（待现场入口接入）
              </p>
              <p v-else class="inline-warning">
                旧格式版本：沿用创建时固定十个自然分钟的历史行为，未配置前台处理日历和现场期限。
              </p>
              <div class="history-config-section">
                <strong>每周营业区间</strong>
                <p v-if="item.payload.weeklyRules.length === 0">每周均不开放</p>
                <p v-for="rule in item.payload.weeklyRules" :key="rule.weekday">
                  {{ weekdayLabels[rule.weekday] }}：
                  {{
                    rule.intervals.map(policyIntervalLabel).join("、") ||
                    "不开放"
                  }}
                </p>
              </div>
              <div class="history-config-section">
                <strong>指定日期例外</strong>
                <p v-if="item.payload.dateExceptions.length === 0">
                  无日期例外
                </p>
                <p
                  v-for="exception in item.payload.dateExceptions"
                  :key="exception.serviceDate"
                >
                  {{ exception.serviceDate }}：
                  {{
                    exception.kind === "closed"
                      ? "全天闭店"
                      : exception.intervals.map(policyIntervalLabel).join("、")
                  }}
                </p>
              </div>
              <template v-if="isBookingPolicyV2(item.payload)">
                <div class="history-config-section">
                  <strong>前台每周可处理区间</strong>
                  <p v-if="item.payload.processingWeeklyRules.length === 0">
                    每周均不处理线上申请
                  </p>
                  <p
                    v-for="rule in item.payload.processingWeeklyRules"
                    :key="rule.weekday"
                  >
                    {{ weekdayLabels[rule.weekday] }}：
                    {{
                      rule.intervals.map(policyIntervalLabel).join("、") ||
                      "不处理"
                    }}
                  </p>
                </div>
                <div class="history-config-section">
                  <strong>前台处理日期例外</strong>
                  <p v-if="item.payload.processingDateExceptions.length === 0">
                    无日期例外
                  </p>
                  <p
                    v-for="exception in item.payload.processingDateExceptions"
                    :key="exception.serviceDate"
                  >
                    {{ exception.serviceDate }}：
                    {{
                      exception.kind === "closed"
                        ? "全天不处理"
                        : exception.intervals
                            .map(policyIntervalLabel)
                            .join("、")
                    }}
                  </p>
                </div>
              </template>
              <small>来源草稿：{{ item.sourceDraftRevisionId }}</small>
            </details>
          </article>
        </div>
        <p v-else>尚无已发布版本。</p>
        <button
          v-if="historyCursor"
          class="text-action"
          type="button"
          :disabled="historyLoading"
          @click="loadMoreHistory"
        >
          {{ historyLoading ? "正在加载" : "加载更早版本" }}
        </button>
      </section>
    </template>
  </main>
</template>
