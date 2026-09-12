<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import {
  ApiRequestError,
  getPaymentReviewQueue,
  logout,
  reconcilePayment,
  type PaymentReviewItem,
  type PaymentReviewQueue,
} from "../lib/api";
import { formatMoney } from "../lib/confirmation";

const router = useRouter();
const workbench = ref<PaymentReviewQueue>();
const loading = ref(true);
const refreshing = ref(false);
const loadingMore = ref(false);
const reconcilingId = ref("");
const selectedPaymentId = ref("");
const pageFailure = ref("");
const actionMessage = ref("");

const selectedPayment = computed(
  () =>
    workbench.value?.payments.find(
      (payment) => payment.paymentId === selectedPaymentId.value,
    ) ?? workbench.value?.payments[0],
);

async function handleFailure(error: unknown, fallback: string) {
  if (error instanceof ApiRequestError && error.status === 401) {
    await router.replace({ path: "/login", query: { redirect: "/payments" } });
    return "";
  }
  if (error instanceof ApiRequestError) return error.message || fallback;
  return fallback;
}

function selectFirstAvailable() {
  if (
    !workbench.value?.payments.some(
      (payment) => payment.paymentId === selectedPaymentId.value,
    )
  ) {
    selectedPaymentId.value = workbench.value?.payments[0]?.paymentId ?? "";
  }
}

async function loadWorkbench(quiet = false) {
  if (quiet) refreshing.value = true;
  else loading.value = true;
  pageFailure.value = "";
  try {
    workbench.value = await getPaymentReviewQueue();
    selectFirstAvailable();
  } catch (error) {
    pageFailure.value = await handleFailure(
      error,
      "异常支付暂时无法加载，请检查网络后重试。",
    );
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function loadMore() {
  const current = workbench.value;
  if (!current?.nextCursor || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const next = await getPaymentReviewQueue(current.nextCursor);
    const known = new Set(current.payments.map((payment) => payment.paymentId));
    workbench.value = {
      ...current,
      payments: [
        ...current.payments,
        ...next.payments.filter((payment) => !known.has(payment.paymentId)),
      ],
      nextCursor: next.nextCursor,
    };
  } catch (error) {
    actionMessage.value = await handleFailure(
      error,
      "更多异常支付加载失败，请稍后重试。",
    );
  } finally {
    loadingMore.value = false;
  }
}

function resultMessage(payment: PaymentReviewItem) {
  if (payment.state === "succeeded")
    return "已向微信确认支付成功，待办已移除。";
  if (payment.state === "failed") return "已确认未支付或已关闭，待办已移除。";
  if (payment.state === "processing")
    return "已确认仍在处理中，系统会继续自动查单。";
  if (payment.state === "unknown")
    return "本次仍未得到明确结果，请稍后再次重新查单。";
  return "渠道结果仍需人工复核，请结合商户平台记录继续处理。";
}

async function reconcileSelected() {
  const payment = selectedPayment.value;
  if (!payment || reconcilingId.value) return;
  reconcilingId.value = payment.paymentId;
  actionMessage.value = "";
  try {
    const updated = await reconcilePayment(payment.paymentId);
    actionMessage.value = resultMessage(updated);
    ElMessage.success("微信查单已完成");
    await loadWorkbench(true);
  } catch (error) {
    actionMessage.value = await handleFailure(
      error,
      "微信查单未完成，当前支付状态没有被确认，请稍后重试。",
    );
  } finally {
    reconcilingId.value = "";
  }
}

function dateTimeLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function paymentLabel(value: string) {
  return value.slice(-8).toUpperCase();
}

function stateLabel(state: PaymentReviewItem["state"]) {
  return state === "manual_review" ? "需人工复核" : "自动查单异常";
}

async function signOut() {
  await logout();
  await router.replace("/login");
}

onMounted(() => void loadWorkbench());
</script>

<template>
  <main class="dashboard-page payment-review-page">
    <header class="dashboard-header">
      <div class="brand-lockup" aria-label="得闲 SPA 运营后台">
        <span class="brand-mark" aria-hidden="true">闲</span>
        <span>得闲 SPA</span>
      </div>
      <div v-if="workbench?.user" class="user-actions">
        <el-button plain @click="router.push('/dashboard')"
          >今日待确认</el-button
        >
        <el-button plain @click="router.push('/scheduling')"
          >请假与冲突</el-button
        >
        <span class="signed-in-user">{{ workbench.user.displayName }}</span>
        <el-button plain @click="signOut">退出</el-button>
      </div>
    </header>

    <section class="workbench-heading" aria-labelledby="payment-review-title">
      <div>
        <h1 id="payment-review-title">异常支付</h1>
        <p>先查看系统最后一次查单结果，再按单笔重新向微信确认。</p>
      </div>
      <button
        v-if="!loading && !pageFailure"
        class="refresh-button"
        type="button"
        :disabled="refreshing || Boolean(reconcilingId)"
        @click="loadWorkbench(true)"
      >
        {{ refreshing ? "正在刷新…" : "刷新待办" }}
      </button>
    </section>

    <el-skeleton v-if="loading" :rows="8" animated />
    <section v-else-if="pageFailure" class="empty-state" role="alert">
      <h2>异常支付暂时无法加载</h2>
      <p>{{ pageFailure }}</p>
      <el-button type="primary" @click="loadWorkbench()">重新加载</el-button>
    </section>

    <template v-else-if="workbench">
      <p v-if="actionMessage" class="payment-action-message" aria-live="polite">
        {{ actionMessage }}
      </p>
      <p
        v-if="!workbench.channelConfigured"
        class="payment-channel-warning"
        role="alert"
      >
        微信支付配置尚未完成，当前只能查看待办，不能重新查单。
      </p>

      <section v-if="workbench.payments.length === 0" class="empty-state">
        <h2>当前没有异常支付</h2>
        <p>自动查单无法确认的交易会出现在这里。</p>
      </section>

      <section v-else class="payment-review-workbench">
        <aside class="payment-review-list" aria-label="异常支付列表">
          <button
            v-for="payment in workbench.payments"
            :key="payment.paymentId"
            class="payment-review-item"
            :class="{
              'is-selected': selectedPayment?.paymentId === payment.paymentId,
            }"
            :aria-pressed="selectedPayment?.paymentId === payment.paymentId"
            type="button"
            @click="selectedPaymentId = payment.paymentId"
          >
            <span>
              <strong>{{ payment.customerName }}</strong>
              <small>{{ stateLabel(payment.state) }}</small>
            </span>
            <span>支付号 {{ paymentLabel(payment.paymentId) }}</span>
            <span
              >{{ dateTimeLabel(payment.updatedAt) }} ·
              {{ formatMoney(payment.amountCents) }}</span
            >
          </button>
          <div v-if="workbench.nextCursor" class="payment-load-more">
            <el-button plain :loading="loadingMore" @click="loadMore"
              >加载更多</el-button
            >
          </div>
        </aside>

        <article v-if="selectedPayment" class="payment-review-detail">
          <header>
            <div>
              <span class="status-label">{{
                stateLabel(selectedPayment.state)
              }}</span>
              <h2>{{ selectedPayment.customerName }}</h2>
              <p>接待号 {{ paymentLabel(selectedPayment.receptionId) }}</p>
            </div>
            <strong>{{ formatMoney(selectedPayment.amountCents) }}</strong>
          </header>

          <dl class="payment-facts">
            <div>
              <dt>商户订单号</dt>
              <dd>{{ selectedPayment.outTradeNo }}</dd>
            </div>
            <div>
              <dt>收款截止</dt>
              <dd>{{ dateTimeLabel(selectedPayment.collectionDeadline) }}</dd>
            </div>
            <div>
              <dt>已查单次数</dt>
              <dd>{{ selectedPayment.checkAttempts }} 次</dd>
            </div>
            <div>
              <dt>最后更新</dt>
              <dd>{{ dateTimeLabel(selectedPayment.updatedAt) }}</dd>
            </div>
          </dl>

          <section class="payment-error-detail">
            <strong>系统最后记录</strong>
            <p>
              {{
                selectedPayment.lastErrorMessage ||
                "微信渠道尚未返回可确认的支付结果。"
              }}
            </p>
            <small v-if="selectedPayment.lastErrorCode"
              >错误码 {{ selectedPayment.lastErrorCode }}</small
            >
          </section>

          <footer class="payment-review-action">
            <p>
              重新查单只读取微信订单状态；不会再次扣款，也不会创建新支付单。
            </p>
            <el-button
              type="primary"
              :loading="reconcilingId === selectedPayment.paymentId"
              :disabled="
                !workbench.canReconcilePayments ||
                !workbench.channelConfigured ||
                Boolean(reconcilingId)
              "
              @click="reconcileSelected"
            >
              重新向微信查单
            </el-button>
          </footer>
          <p
            v-if="!workbench.canReconcilePayments"
            class="payment-permission-note"
          >
            当前账号只能查看；重新查单请联系店长授权。
          </p>
        </article>
      </section>
    </template>
  </main>
</template>
