<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import {
  confirmReception,
  getOperationsOverview,
  logout,
  type PendingConfirmation,
  type StaffUser,
} from "../lib/api";
import {
  classifyConfirmationFailure,
  formatCountdown,
  formatMoney,
  type ConfirmationFailure,
} from "../lib/confirmation";
import {
  clearReceptionConfirmation,
  loadReceptionConfirmation,
  saveReceptionConfirmation,
  type ReceptionConfirmationAttempt,
} from "../lib/reception-confirmation-recovery";
import {
  classifyOverviewFailure,
  type OverviewFailure,
} from "../lib/overview-error";

const router = useRouter();
const user = ref<StaffUser>();
const loading = ref(true);
const refreshing = ref(false);
const confirming = ref(false);
const canConfirmReceptions = ref(false);
const pendingConfirmations = ref<PendingConfirmation[]>([]);
const selectedReceptionId = ref("");
const failure = ref<Exclude<OverviewFailure, { kind: "login" }>>();
type DisplayConfirmationFailure = Exclude<
  ConfirmationFailure,
  { kind: "login" }
>;
type ConfirmationAttempt = ReceptionConfirmationAttempt;
const confirmationFailure = ref<{
  attempt: ConfirmationAttempt;
  failure: DisplayConfirmationFailure;
}>();
const clockNow = ref(Date.now());
const activeConfirmationAttempt = ref<ConfirmationAttempt>();
const confirmationResultUnverified = ref(false);
let serverOffsetMs = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;

const selectedReception = computed(
  () =>
    pendingConfirmations.value.find(
      (item) => item.receptionId === selectedReceptionId.value,
    ) ?? pendingConfirmations.value[0],
);

const earliestDeadline = computed(() => pendingConfirmations.value[0]);
const selectedConfirmationFailure = computed(() =>
  confirmationFailure.value?.attempt.receptionId ===
  selectedReception.value?.receptionId
    ? confirmationFailure.value.failure
    : undefined,
);
function updateClock() {
  clockNow.value = Date.now() + serverOffsetMs;
}

async function loadOverview(options: { quiet?: boolean } = {}) {
  if (confirming.value || confirmationResultUnverified.value) return;
  if (options.quiet) refreshing.value = true;
  else loading.value = true;
  failure.value = undefined;
  confirmationFailure.value = undefined;
  activeConfirmationAttempt.value = undefined;
  confirmationResultUnverified.value = false;
  try {
    const result = await getOperationsOverview();
    user.value = result.user;
    canConfirmReceptions.value = result.overview.canConfirmReceptions;
    pendingConfirmations.value = result.overview.pendingConfirmations;
    serverOffsetMs = Date.parse(result.overview.serverNow) - Date.now();
    updateClock();
    if (
      !pendingConfirmations.value.some(
        (item) => item.receptionId === selectedReceptionId.value,
      )
    ) {
      selectedReceptionId.value =
        pendingConfirmations.value[0]?.receptionId ?? "";
    }
  } catch (error) {
    const result = classifyOverviewFailure(error);
    if (result.kind === "login") {
      await router.replace("/login");
      return;
    }
    failure.value = result;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function selectReception(receptionId: string) {
  if (confirming.value || confirmationResultUnverified.value) return;
  selectedReceptionId.value = receptionId;
  confirmationFailure.value = undefined;
  activeConfirmationAttempt.value = undefined;
  confirmationResultUnverified.value = false;
}

function isExpired(item: PendingConfirmation) {
  return new Date(item.confirmationDeadline).getTime() <= clockNow.value;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value));
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

async function submitConfirmation(retryAttempt?: ConfirmationAttempt) {
  const reception = retryAttempt
    ? pendingConfirmations.value.find(
        (item) => item.receptionId === retryAttempt.receptionId,
      )
    : selectedReception.value;
  if (!reception || confirming.value || (!retryAttempt && isExpired(reception)))
    return;
  const attempt =
    retryAttempt ??
    (activeConfirmationAttempt.value?.receptionId === reception.receptionId
      ? activeConfirmationAttempt.value
      : {
          receptionId: reception.receptionId,
          version: reception.version,
          key: crypto.randomUUID(),
          staffUserId: user.value!.id,
          storeId: user.value!.storeId,
        });
  if (!retryAttempt && activeConfirmationAttempt.value !== attempt) {
    try {
      saveReceptionConfirmation(attempt);
    } catch {
      confirmationFailure.value = {
        attempt,
        failure: {
          kind: "unavailable",
          title: "无法保存核实记录",
          message: "本次确认尚未发送，请保留当前页面并稍后重试。",
          action: "close",
        },
      };
      return;
    }
  }
  confirming.value = true;
  confirmationFailure.value = undefined;
  activeConfirmationAttempt.value = attempt;
  try {
    await confirmReception(attempt.receptionId, attempt.version, attempt.key, {
      staffUserId: attempt.staffUserId,
      storeId: attempt.storeId,
    });
    pendingConfirmations.value = pendingConfirmations.value.filter(
      (item) => item.receptionId !== attempt.receptionId,
    );
    activeConfirmationAttempt.value = undefined;
    confirmationResultUnverified.value = false;
    clearReceptionConfirmation();
    ElMessage.success(`${reception.customerName}的接待已确认`);
  } catch (error) {
    const result = classifyConfirmationFailure(error);
    if (result.kind === "login") {
      await router.replace({
        path: "/login",
        query: { redirect: "/receptions" },
      });
      return;
    }
    selectedReceptionId.value = attempt.receptionId;
    if (result.kind === "forbidden" && confirmationResultUnverified.value) {
      confirmationFailure.value = {
        attempt,
        failure: {
          kind: "forbidden",
          title: "原确认结果仍待核实",
          message:
            "当前账号无权核实原请求。请恢复原账号权限，或重新登录原账号后继续核实。",
          action: "login",
        },
      };
      return;
    }
    confirmationFailure.value = { attempt, failure: result };
    if (result.kind === "unavailable" || result.kind === "identity") {
      confirmationResultUnverified.value = true;
    } else if (result.kind !== "busy") {
      confirmationResultUnverified.value = false;
    }
    if (result.action !== "retry" && result.action !== "login") {
      activeConfirmationAttempt.value = undefined;
      clearReceptionConfirmation();
    }
  } finally {
    confirming.value = false;
  }
}

async function handleConfirmationFailureAction() {
  const boundFailure = confirmationFailure.value;
  if (boundFailure?.failure.action === "refresh") {
    await loadOverview({ quiet: true });
  } else if (boundFailure?.failure.action === "login") {
    await router.replace({
      path: "/login",
      query: { redirect: "/receptions" },
    });
  } else if (boundFailure?.failure.action === "retry") {
    await submitConfirmation(boundFailure.attempt);
  } else {
    confirmationFailure.value = undefined;
  }
}

async function signOut() {
  if (confirming.value || confirmationResultUnverified.value) return;
  await logout();
  await router.replace("/login");
}

async function openScheduling() {
  if (confirming.value || confirmationResultUnverified.value) return;
  await router.push("/scheduling");
}

async function openPaymentReview() {
  if (confirming.value || confirmationResultUnverified.value) return;
  await router.push("/payments");
}

onMounted(() => {
  try {
    if (loadReceptionConfirmation()) {
      void router.replace("/receptions");
      return;
    }
  } catch {
    void router.replace("/receptions");
    return;
  }
  void loadOverview();
  clockTimer = setInterval(updateClock, 1_000);
});

onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});
</script>

<template>
  <main class="dashboard-page">
    <header class="dashboard-header">
      <div class="brand-lockup" aria-label="得闲 SPA 运营后台">
        <span class="brand-mark" aria-hidden="true">闲</span>
        <span>得闲 SPA</span>
      </div>
      <div v-if="user" class="user-actions">
        <el-button
          plain
          :disabled="confirming || confirmationResultUnverified"
          @click="router.push('/receptions')"
        >
          接待查询
        </el-button>
        <el-button
          plain
          :disabled="confirming || confirmationResultUnverified"
          @click="router.push('/calendar')"
        >
          预约日历
        </el-button>
        <el-button
          plain
          :disabled="confirming || confirmationResultUnverified"
          @click="router.push('/booking-policy')"
        >
          预约政策
        </el-button>
        <el-button
          plain
          :disabled="confirming || confirmationResultUnverified"
          @click="openScheduling"
        >
          请假与冲突
        </el-button>
        <el-button
          plain
          :disabled="confirming || confirmationResultUnverified"
          @click="openPaymentReview"
        >
          异常支付
        </el-button>
        <span class="signed-in-user">{{ user.displayName }}</span>
        <el-button
          plain
          :disabled="confirming || confirmationResultUnverified"
          @click="signOut"
        >
          退出
        </el-button>
      </div>
    </header>

    <section class="workbench-heading" aria-labelledby="page-title">
      <div>
        <h1 id="page-title">今日待确认</h1>
        <p>先核对人员和场地安排，再确认接待。</p>
      </div>
      <button
        v-if="!loading && !failure"
        class="refresh-button"
        type="button"
        :disabled="refreshing || confirming || confirmationResultUnverified"
        @click="loadOverview({ quiet: true })"
      >
        {{ refreshing ? "正在刷新…" : "刷新待办" }}
      </button>
    </section>

    <el-skeleton v-if="loading" :rows="8" animated />
    <section v-else-if="failure" class="stage-card" role="alert">
      <el-result
        :icon="failure.kind === 'forbidden' ? 'warning' : 'error'"
        :title="failure.title"
        :sub-title="failure.message"
      >
        <template #extra>
          <el-button
            v-if="failure.kind === 'unavailable'"
            type="primary"
            @click="loadOverview()"
          >
            重新加载
          </el-button>
          <el-button v-else plain @click="signOut">切换账号</el-button>
        </template>
      </el-result>
    </section>

    <template v-else>
      <section class="queue-summary" aria-live="polite">
        <p>
          <strong>{{ pendingConfirmations.length }}</strong>
          笔申请等待处理
        </p>
        <p v-if="earliestDeadline">
          最早一笔还剩
          <span class="summary-countdown">
            {{
              formatCountdown(earliestDeadline.confirmationDeadline, clockNow)
            }}
          </span>
        </p>
        <p v-else>当前没有需要确认的申请</p>
      </section>

      <section
        v-if="pendingConfirmations.length === 0"
        class="empty-state"
        aria-labelledby="empty-title"
      >
        <span class="empty-check" aria-hidden="true">✓</span>
        <h2 id="empty-title">待确认已处理完</h2>
        <p>新的预约申请会出现在这里，营业中可随时刷新查看。</p>
      </section>

      <section v-else class="confirmation-workbench">
        <aside class="confirmation-queue" aria-label="待确认预约列表">
          <button
            v-for="item in pendingConfirmations"
            :key="item.receptionId"
            type="button"
            class="queue-item"
            :class="{
              'is-selected':
                selectedReception?.receptionId === item.receptionId,
              'is-expired': isExpired(item),
            }"
            :aria-pressed="selectedReception?.receptionId === item.receptionId"
            :disabled="confirming || confirmationResultUnverified"
            @click="selectReception(item.receptionId)"
          >
            <span class="queue-item-topline">
              <strong>{{ item.customerName }}</strong>
              <span class="queue-countdown">
                {{
                  isExpired(item)
                    ? "已到期"
                    : formatCountdown(item.confirmationDeadline, clockNow)
                }}
              </span>
            </span>
            <span class="queue-item-detail">
              {{ dateLabel(item.guests[0]!.serviceStartAt) }}
              {{ timeLabel(item.guests[0]!.serviceStartAt) }} ·
              {{ item.guests.length }} 位
            </span>
            <span class="queue-item-bottomline">
              <span>{{ item.guests[0]!.serviceItemName }}</span>
              <strong>{{ formatMoney(item.quoteCents) }}</strong>
            </span>
          </button>
        </aside>

        <article
          v-if="selectedReception"
          class="confirmation-detail"
          aria-labelledby="detail-title"
        >
          <header class="detail-header">
            <div>
              <h2 id="detail-title">{{ selectedReception.customerName }}</h2>
              <p>
                {{ selectedReception.guests.length }} 位顾客 ·
                {{ formatMoney(selectedReception.quoteCents) }}
              </p>
            </div>
            <div
              class="deadline-status"
              :class="{ 'is-expired': isExpired(selectedReception) }"
            >
              <span>确认剩余</span>
              <strong>
                {{
                  isExpired(selectedReception)
                    ? "已到期"
                    : formatCountdown(
                        selectedReception.confirmationDeadline,
                        clockNow,
                      )
                }}
              </strong>
            </div>
          </header>

          <div class="assignment-list">
            <section
              v-for="(guest, index) in selectedReception.guests"
              :key="guest.id"
              class="assignment-row"
            >
              <div class="assignment-time">
                <span>{{ dateLabel(guest.serviceStartAt) }}</span>
                <strong>
                  {{ timeLabel(guest.serviceStartAt) }}–{{
                    timeLabel(guest.serviceEndAt)
                  }}
                </strong>
              </div>
              <div class="assignment-service">
                <h3>第 {{ index + 1 }} 位 · {{ guest.serviceItemName }}</h3>
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
              </div>
              <strong class="assignment-price">{{
                formatMoney(guest.quoteCents)
              }}</strong>
            </section>
          </div>

          <div
            v-if="selectedConfirmationFailure"
            class="confirmation-alert"
            role="alert"
          >
            <div>
              <strong>{{ selectedConfirmationFailure.title }}</strong>
              <p>
                {{
                  confirmationResultUnverified &&
                  selectedConfirmationFailure.kind === "busy"
                    ? "暂时还无法核实原请求结果，请稍后继续核实；系统会沿用同一请求。"
                    : selectedConfirmationFailure.message
                }}
              </p>
            </div>
            <el-button plain @click="handleConfirmationFailureAction">
              {{
                selectedConfirmationFailure.action === "refresh"
                  ? "刷新待办"
                  : selectedConfirmationFailure.action === "login"
                    ? "重新登录原账号并核实"
                    : selectedConfirmationFailure.action === "retry"
                      ? confirmationResultUnverified
                        ? "核实确认结果"
                        : "再次确认"
                      : "知道了"
              }}
            </el-button>
          </div>

          <footer class="confirmation-footer">
            <p v-if="canConfirmReceptions">
              确认后将锁定以上人员、房间和床位安排。
            </p>
            <p v-else>当前账号只有查看权限，如需确认请联系店长。</p>
            <el-button
              type="primary"
              size="large"
              :loading="confirming"
              :disabled="
                !canConfirmReceptions ||
                isExpired(selectedReception) ||
                confirmationResultUnverified
              "
              @click="submitConfirmation()"
            >
              {{
                confirmationResultUnverified
                  ? "请先核实结果"
                  : isExpired(selectedReception)
                    ? "申请已到期"
                    : "确认接待"
              }}
            </el-button>
          </footer>
        </article>
      </section>
    </template>
  </main>
</template>
