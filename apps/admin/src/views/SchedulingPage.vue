<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";

import {
  createLeave,
  getLeaveWorkbench,
  logout,
  type CreateLeaveResult,
  type LeaveConflict,
  type LeaveWorkbench,
} from "../lib/api";
import {
  classifyLeaveFailure,
  shanghaiLocalToIso,
  type LeaveFailure,
} from "../lib/leave-error";
import {
  clearUnverifiedLeave,
  isLeaveRecoveryOwner,
  isoToShanghaiLocal,
  loadUnverifiedLeave,
  saveUnverifiedLeave,
  type RecoverableLeaveAttempt,
} from "../lib/leave-recovery";
import {
  classifyOverviewFailure,
  type OverviewFailure,
} from "../lib/overview-error";

type LeaveAttempt = RecoverableLeaveAttempt;

type DisplayLeaveFailure = Exclude<LeaveFailure, { kind: "login" }>;

const router = useRouter();
const workbench = ref<LeaveWorkbench>();
const loading = ref(true);
const refreshing = ref(false);
const loadingMore = ref(false);
const submitting = ref(false);
const pageFailure = ref<Exclude<OverviewFailure, { kind: "login" }>>();
const leaveFailure = ref<{
  attempt: LeaveAttempt;
  failure: DisplayLeaveFailure;
}>();
const resultUnverified = ref(false);
const successfulResult = ref<CreateLeaveResult>();
const selectedConflictId = ref("");
const conflictSection = ref<HTMLElement>();
const pendingRecovery = ref<LeaveAttempt>();
const recoveryOwnedByAnotherUser = ref(false);
const authRedirecting = ref(false);

const therapistId = ref("");
const startLocal = ref("");
const endLocal = ref("");
const reasonPrivate = ref("");
const formError = ref("");
const conflictLoadError = ref("");

const formLocked = computed(
  () =>
    submitting.value ||
    resultUnverified.value ||
    recoveryOwnedByAnotherUser.value ||
    leaveFailure.value?.failure.action === "retry",
);

const unavailableRecoveryTherapist = computed(() => {
  const attempt = leaveFailure.value?.attempt;
  if (
    !resultUnverified.value ||
    !attempt ||
    workbench.value?.therapists.some(
      (therapist) => therapist.id === attempt.input.therapistResourceId,
    )
  )
    return undefined;
  return {
    id: attempt.input.therapistResourceId,
    name: attempt.therapistName,
  };
});

const selectedConflict = computed<LeaveConflict | undefined>(
  () =>
    workbench.value?.conflicts.find(
      (conflict) => conflict.conflictId === selectedConflictId.value,
    ) ?? workbench.value?.conflicts[0],
);

async function loadWorkbench(
  options: {
    quiet?: boolean;
    focusConflictId?: string;
    allowUnverified?: boolean;
  } = {},
) {
  if (submitting.value || (resultUnverified.value && !options.allowUnverified))
    return;
  if (options.quiet) refreshing.value = true;
  else loading.value = true;
  pageFailure.value = undefined;
  try {
    workbench.value = await getLeaveWorkbench();
    restoreUnverifiedAttempt();
    const requestedConflict = options.focusConflictId;
    if (
      requestedConflict &&
      workbench.value.conflicts.some(
        (conflict) => conflict.conflictId === requestedConflict,
      )
    ) {
      selectedConflictId.value = requestedConflict;
    } else if (
      !workbench.value.conflicts.some(
        (conflict) => conflict.conflictId === selectedConflictId.value,
      )
    ) {
      selectedConflictId.value = workbench.value.conflicts[0]?.conflictId ?? "";
    }
    if (
      !resultUnverified.value &&
      (!therapistId.value ||
        !workbench.value.therapists.some(
          (therapist) => therapist.id === therapistId.value,
        ))
    ) {
      therapistId.value = workbench.value.therapists[0]?.id ?? "";
    }
  } catch (error) {
    const failure = classifyOverviewFailure(error);
    if (failure.kind === "login") {
      await router.replace({
        path: "/login",
        query: { redirect: "/scheduling" },
      });
      return;
    }
    pageFailure.value = failure;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function loadMoreConflicts() {
  const current = workbench.value;
  if (!current?.nextCursor || loadingMore.value) return;
  loadingMore.value = true;
  conflictLoadError.value = "";
  try {
    const next = await getLeaveWorkbench(current.nextCursor);
    const knownIds = new Set(
      current.conflicts.map((conflict) => conflict.conflictId),
    );
    workbench.value = {
      ...current,
      serverNow: next.serverNow,
      conflictTotal: next.conflictTotal,
      nextCursor: next.nextCursor,
      conflicts: [
        ...current.conflicts,
        ...next.conflicts.filter(
          (conflict) => !knownIds.has(conflict.conflictId),
        ),
      ],
    };
  } catch (error) {
    const failure = classifyOverviewFailure(error);
    if (failure.kind === "login") {
      await router.replace({
        path: "/login",
        query: { redirect: "/scheduling" },
      });
      return;
    }
    conflictLoadError.value = failure.message;
  } finally {
    loadingMore.value = false;
  }
}

function buildAttempt(): LeaveAttempt | undefined {
  formError.value = "";
  const startAt = shanghaiLocalToIso(startLocal.value);
  const endAt = shanghaiLocalToIso(endLocal.value);
  const reason = reasonPrivate.value.trim();
  const user = workbench.value?.user;
  const therapist = workbench.value?.therapists.find(
    (item) => item.id === therapistId.value,
  );
  if (!therapistId.value) formError.value = "请选择请假的美容师。";
  else if (!startAt || !endAt) formError.value = "请填写完整的开始和结束时间。";
  else if (Date.parse(endAt) <= Date.parse(startAt))
    formError.value = "结束时间必须晚于开始时间。";
  else if (!reason) formError.value = "请填写仅供门店内部查看的请假原因。";
  if (formError.value || !startAt || !endAt || !user || !therapist)
    return undefined;
  return {
    input: {
      therapistResourceId: therapistId.value,
      startAt,
      endAt,
      reasonPrivate: reason,
    },
    key: crypto.randomUUID(),
    staffUserId: user.id,
    storeId: user.storeId,
    therapistName: therapist.name,
  };
}

async function submitLeave(retryAttempt?: LeaveAttempt) {
  if (submitting.value || (!retryAttempt && formLocked.value)) return;
  const attempt = retryAttempt ?? buildAttempt();
  if (!attempt) return;
  submitting.value = true;
  leaveFailure.value = undefined;
  let completed: CreateLeaveResult | undefined;
  const wasUnverified = resultUnverified.value;
  saveUnverifiedLeave(attempt);
  try {
    completed = await createLeave(attempt.input, attempt.key, {
      staffUserId: attempt.staffUserId,
      storeId: attempt.storeId,
    });
    successfulResult.value = completed;
    resultUnverified.value = false;
    clearUnverifiedLeave();
    startLocal.value = "";
    endLocal.value = "";
    reasonPrivate.value = "";
    ElMessage.success("请假已生效");
  } catch (error) {
    const failure = classifyLeaveFailure(error);
    if (failure.kind === "login") {
      if (!wasUnverified) clearUnverifiedLeave();
      authRedirecting.value = true;
      await router.replace({
        path: "/login",
        query: { redirect: "/scheduling" },
      });
      return;
    }
    if (failure.kind === "identity") {
      resultUnverified.value = true;
      saveUnverifiedLeave(attempt);
      leaveFailure.value = { attempt, failure };
      return;
    }
    const mustKeepOriginal =
      failure.kind === "unavailable" ||
      failure.kind === "server" ||
      (wasUnverified &&
        (failure.kind === "busy" || failure.kind === "forbidden"));
    if (mustKeepOriginal) {
      resultUnverified.value = true;
      saveUnverifiedLeave(attempt);
      leaveFailure.value = {
        attempt,
        failure:
          failure.action === "retry"
            ? failure
            : {
                kind: "server",
                title: "原请假结果仍未核实",
                message:
                  "当前响应不能证明原请求失败，请恢复权限或页面状态后继续使用原请求核实。",
                action: "retry",
              },
      };
    } else {
      resultUnverified.value = false;
      clearUnverifiedLeave();
      leaveFailure.value = { attempt, failure };
    }
  } finally {
    submitting.value = false;
  }

  if (completed) {
    await loadWorkbench({
      quiet: true,
      focusConflictId: completed.conflicts[0]?.conflictId,
    });
  }
}

async function handleLeaveFailureAction() {
  const boundFailure = leaveFailure.value;
  if (!boundFailure) return;
  if (boundFailure.failure.action === "retry") {
    await submitLeave(boundFailure.attempt);
  } else if (boundFailure.failure.action === "switch-account") {
    authRedirecting.value = true;
    await router.replace({
      path: "/login",
      query: { redirect: "/scheduling" },
    });
  } else if (boundFailure.failure.action === "refresh") {
    leaveFailure.value = undefined;
    resultUnverified.value = false;
    await loadWorkbench({ quiet: true });
  } else {
    leaveFailure.value = undefined;
  }
}

function editAfterFailedAttempt() {
  if (resultUnverified.value) return;
  leaveFailure.value = undefined;
}

async function focusCreatedConflict() {
  const conflictId = successfulResult.value?.conflicts[0]?.conflictId;
  if (!conflictId) return;
  selectedConflictId.value = conflictId;
  await nextTick();
  conflictSection.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function shanghaiParts(value: string) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}

function dateTimeRangeLabel(startValue: string, endValue: string) {
  const start = shanghaiParts(startValue);
  const end = shanghaiParts(endValue);
  const startTime = `${start.hour}:${start.minute}`;
  const endTime = `${end.hour}:${end.minute}`;
  if (
    start.year === end.year &&
    start.month === end.month &&
    start.day === end.day
  ) {
    return `${start.month}/${start.day} ${startTime}–${endTime}`;
  }
  if (start.year === end.year) {
    return `${start.month}/${start.day} ${startTime}–${end.month}/${end.day} ${endTime}`;
  }
  return `${start.year}/${start.month}/${start.day} ${startTime}–${end.year}/${end.month}/${end.day} ${endTime}`;
}

function receptionLabel(value: string) {
  return value.slice(-8).toUpperCase();
}

async function openConfirmationWorkbench() {
  if (submitting.value || resultUnverified.value) return;
  await router.push("/dashboard");
}

async function openResourceCalendar() {
  if (submitting.value || resultUnverified.value) return;
  await router.push("/calendar");
}

async function openPaymentReview() {
  if (submitting.value || resultUnverified.value) return;
  await router.push("/payments");
}

async function signOut() {
  if (submitting.value || resultUnverified.value) return;
  await logout();
  await router.replace("/login");
}

function restoreUnverifiedAttempt() {
  const attempt = pendingRecovery.value;
  const user = workbench.value?.user;
  if (!attempt || !user) return;
  if (!isLeaveRecoveryOwner(attempt, user)) {
    recoveryOwnedByAnotherUser.value = true;
    return;
  }
  pendingRecovery.value = undefined;
  recoveryOwnedByAnotherUser.value = false;
  therapistId.value = attempt.input.therapistResourceId;
  startLocal.value = isoToShanghaiLocal(attempt.input.startAt);
  endLocal.value = isoToShanghaiLocal(attempt.input.endAt);
  reasonPrivate.value = attempt.input.reasonPrivate;
  resultUnverified.value = true;
  leaveFailure.value = {
    attempt,
    failure: {
      kind: "unavailable",
      title: "请继续核实原请假结果",
      message: "页面已恢复上次未核实的请求，请沿用原请求核实，不要重复登记。",
      action: "retry",
    },
  };
}

function warnBeforeReload(event: BeforeUnloadEvent) {
  if (!submitting.value && !resultUnverified.value) return;
  event.preventDefault();
  event.returnValue = "";
}

onBeforeRouteLeave((to) => {
  if (!submitting.value && !resultUnverified.value) return true;
  if (authRedirecting.value && to.path === "/login") return true;
  return false;
});

onMounted(() => {
  pendingRecovery.value = loadUnverifiedLeave();
  window.addEventListener("beforeunload", warnBeforeReload);
  void loadWorkbench({ allowUnverified: true });
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnBeforeReload);
});
</script>

<template>
  <main class="dashboard-page scheduling-page">
    <header class="dashboard-header">
      <div class="brand-lockup" aria-label="得闲 SPA 运营后台">
        <span class="brand-mark" aria-hidden="true">闲</span>
        <span>得闲 SPA</span>
      </div>
      <div v-if="workbench?.user" class="user-actions">
        <el-button
          plain
          :disabled="submitting || resultUnverified"
          @click="openConfirmationWorkbench"
        >
          今日待确认
        </el-button>
        <el-button
          plain
          :disabled="submitting || resultUnverified"
          @click="openResourceCalendar"
        >
          预约日历
        </el-button>
        <el-button
          plain
          :disabled="submitting || resultUnverified"
          @click="openPaymentReview"
        >
          异常支付
        </el-button>
        <span class="signed-in-user">{{ workbench.user.displayName }}</span>
        <el-button
          plain
          :disabled="submitting || resultUnverified"
          @click="signOut"
        >
          退出
        </el-button>
      </div>
    </header>

    <section class="workbench-heading" aria-labelledby="scheduling-title">
      <div>
        <h1 id="scheduling-title">请假与冲突</h1>
        <p>登记已确定的真实请假，并定位需要人工跟进的已确认接待。</p>
      </div>
      <button
        v-if="!loading && !pageFailure"
        class="refresh-button"
        type="button"
        :disabled="refreshing || submitting || resultUnverified"
        @click="loadWorkbench({ quiet: true })"
      >
        {{ refreshing ? "正在刷新…" : "刷新工作台" }}
      </button>
    </section>

    <el-skeleton v-if="loading" :rows="9" animated />
    <section v-else-if="pageFailure" class="stage-card" role="alert">
      <el-result
        :icon="pageFailure.kind === 'forbidden' ? 'warning' : 'error'"
        :title="pageFailure.title"
        :sub-title="pageFailure.message"
      >
        <template #extra>
          <el-button
            v-if="pageFailure.kind === 'unavailable'"
            type="primary"
            @click="loadWorkbench()"
          >
            重新加载
          </el-button>
          <el-button v-else plain @click="signOut">切换账号</el-button>
        </template>
      </el-result>
    </section>

    <div v-else-if="workbench" class="scheduling-workbench">
      <section class="leave-panel" aria-labelledby="leave-form-title">
        <header class="panel-heading">
          <div>
            <h2 id="leave-form-title">登记真实请假</h2>
            <p>保存即生效，不经过申请或审批。</p>
          </div>
          <span v-if="workbench.canCreateLeave" class="permission-badge">
            可登记
          </span>
        </header>

        <div class="impact-notice">
          <strong>保存前请确认影响</strong>
          <p>
            待确认申请会整组失效；已确认接待不会自动换人，需要前台联系顾客后人工跟进。
          </p>
        </div>

        <div
          v-if="recoveryOwnedByAnotherUser"
          class="leave-submit-alert"
          role="alert"
        >
          <div>
            <strong>请切换回原账号核实请假</strong>
            <p>
              当前浏览器保存了另一名员工尚未核实的请假。为避免重复登记，原内部原因已隐藏，请由原员工登录后继续核实。
            </p>
          </div>
          <el-button plain @click="signOut">切换账号</el-button>
        </div>

        <form class="leave-form" @submit.prevent="submitLeave()">
          <label class="form-field" for="leave-therapist">
            <span>美容师</span>
            <select
              id="leave-therapist"
              v-model="therapistId"
              :disabled="formLocked"
            >
              <option value="" disabled>请选择美容师</option>
              <option
                v-if="unavailableRecoveryTherapist"
                :value="unavailableRecoveryTherapist.id"
                disabled
              >
                {{
                  unavailableRecoveryTherapist.name
                }}（已停用，仅用于核实原请求）
              </option>
              <option
                v-for="therapist in workbench.therapists"
                :key="therapist.id"
                :value="therapist.id"
              >
                {{ therapist.name }}
              </option>
            </select>
          </label>

          <div class="time-field-row">
            <label class="form-field" for="leave-start">
              <span>开始时间</span>
              <input
                id="leave-start"
                v-model="startLocal"
                type="datetime-local"
                :disabled="formLocked"
              />
            </label>
            <label class="form-field" for="leave-end">
              <span>结束时间</span>
              <input
                id="leave-end"
                v-model="endLocal"
                type="datetime-local"
                :disabled="formLocked"
              />
            </label>
          </div>

          <label class="form-field" for="leave-reason">
            <span>内部原因</span>
            <textarea
              id="leave-reason"
              v-model="reasonPrivate"
              maxlength="500"
              rows="3"
              placeholder="仅门店员工可见，例如：已确认的个人请假"
              :disabled="formLocked"
            />
          </label>

          <p v-if="formError" class="form-error" role="alert">
            {{ formError }}
          </p>

          <div v-if="leaveFailure" class="leave-submit-alert" role="alert">
            <div>
              <strong>{{ leaveFailure.failure.title }}</strong>
              <p>
                {{
                  resultUnverified && leaveFailure.failure.kind === "busy"
                    ? "暂时还无法核实原请求结果，请稍后继续核实；系统会沿用同一请求。"
                    : leaveFailure.failure.message
                }}
              </p>
            </div>
            <div class="leave-failure-actions">
              <el-button plain @click="handleLeaveFailureAction">
                {{
                  leaveFailure.failure.action === "retry"
                    ? resultUnverified
                      ? "核实请假结果"
                      : "重试原请求"
                    : leaveFailure.failure.action === "refresh"
                      ? "刷新美容师"
                      : leaveFailure.failure.action === "switch-account"
                        ? "切回原账号"
                        : "知道了"
                }}
              </el-button>
              <el-button
                v-if="
                  !resultUnverified && leaveFailure.failure.action === 'retry'
                "
                plain
                @click="editAfterFailedAttempt"
              >
                修改登记内容
              </el-button>
            </div>
          </div>

          <el-button
            class="leave-submit-button"
            type="primary"
            size="large"
            native-type="submit"
            :loading="submitting"
            :disabled="
              !workbench.canCreateLeave ||
              workbench.therapists.length === 0 ||
              formLocked
            "
          >
            {{
              recoveryOwnedByAnotherUser
                ? "请先切换原账号"
                : resultUnverified
                  ? "请先核实结果"
                  : workbench.canCreateLeave
                    ? "确认并立即生效"
                    : "当前账号无登记权限"
            }}
          </el-button>
        </form>

        <section
          v-if="successfulResult"
          class="leave-result"
          aria-live="polite"
        >
          <strong>请假已生效</strong>
          <p>
            {{ successfulResult.invalidatedPendingCount }}
            组待确认已失效，{{ successfulResult.affectedConfirmedCount }}
            组已确认接待待人工跟进。
          </p>
          <button
            v-if="successfulResult.conflicts.length"
            type="button"
            class="text-action"
            @click="focusCreatedConflict"
          >
            查看受影响接待
          </button>
        </section>
      </section>

      <section
        ref="conflictSection"
        class="conflict-panel"
        aria-labelledby="conflict-title"
      >
        <header class="panel-heading conflict-heading">
          <div>
            <h2 id="conflict-title">已确认接待冲突</h2>
            <p>
              共 {{ workbench.conflictTotal }} 组等待人工跟进<span
                v-if="workbench.conflicts.length < workbench.conflictTotal"
                >，已显示 {{ workbench.conflicts.length }} 组</span
              >
            </p>
          </div>
          <span class="pending-badge">仅查看</span>
        </header>

        <div v-if="workbench.conflicts.length === 0" class="conflict-empty">
          <h3>当前没有请假冲突</h3>
          <p>后续登记请假影响已确认接待时，会出现在这里。</p>
        </div>

        <div v-else class="conflict-workbench">
          <aside class="conflict-list" aria-label="待人工跟进冲突列表">
            <button
              v-for="conflict in workbench.conflicts"
              :key="conflict.conflictId"
              type="button"
              class="conflict-item"
              :class="{
                'is-selected':
                  selectedConflict?.conflictId === conflict.conflictId,
              }"
              :aria-pressed="
                selectedConflict?.conflictId === conflict.conflictId
              "
              @click="selectedConflictId = conflict.conflictId"
            >
              <span class="conflict-item-topline">
                <strong>{{ conflict.customerName }}</strong>
                <span>待跟进</span>
              </span>
              <span>{{ conflict.therapistName }}请假</span>
              <small>{{
                dateTimeRangeLabel(conflict.leaveStartAt, conflict.leaveEndAt)
              }}</small>
            </button>
          </aside>

          <article v-if="selectedConflict" class="conflict-detail">
            <header class="conflict-detail-header">
              <div>
                <span class="status-label">已确认 · 待人工跟进</span>
                <h3>{{ selectedConflict.customerName }}</h3>
                <p>接待号 {{ receptionLabel(selectedConflict.receptionId) }}</p>
              </div>
              <div class="conflict-leave-time">
                <span>{{ selectedConflict.therapistName }}请假</span>
                <strong>
                  {{
                    dateTimeRangeLabel(
                      selectedConflict.leaveStartAt,
                      selectedConflict.leaveEndAt,
                    )
                  }}
                </strong>
              </div>
            </header>

            <div class="private-reason">
              <span>内部原因</span>
              <p>{{ selectedConflict.reasonPrivate }}</p>
            </div>

            <div class="conflict-guest-list">
              <section
                v-for="guest in selectedConflict.guests"
                :key="guest.id"
                class="conflict-guest"
              >
                <div>
                  <strong>{{ guest.serviceItemName }}</strong>
                  <span>
                    {{
                      dateTimeRangeLabel(
                        guest.serviceStartAt,
                        guest.serviceEndAt,
                      )
                    }}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>美容师</dt>
                    <dd>{{ guest.therapistName }}</dd>
                  </div>
                  <div>
                    <dt>房间 / 床位</dt>
                    <dd>{{ guest.roomName }} / {{ guest.bedName }}</dd>
                  </div>
                </dl>
              </section>
            </div>

            <footer class="manual-followup-note">
              <strong>下一步：联系顾客后人工跟进</strong>
              <p>
                当前页面只帮助查看和定位，不会自动换人，也不会把冲突标记为已解决。
              </p>
            </footer>
          </article>
        </div>

        <div
          v-if="
            workbench.conflicts.length > 0 &&
            (workbench.nextCursor || conflictLoadError)
          "
          class="conflict-load-more"
        >
          <p v-if="conflictLoadError" role="alert">
            {{ conflictLoadError }}
          </p>
          <el-button
            v-if="workbench.nextCursor"
            plain
            :loading="loadingMore"
            @click="loadMoreConflicts"
          >
            继续加载（还剩
            {{ workbench.conflictTotal - workbench.conflicts.length }} 组）
          </el-button>
        </div>
      </section>
    </div>
  </main>
</template>
