<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";

import { formatCountdown, formatMoney } from "../lib/confirmation";
import {
  receptionStateLabels,
  receptionTime,
  type ReceptionRecord,
} from "../lib/receptions-api";

const props = defineProps<{
  item: ReceptionRecord;
  canConfirm: boolean;
  expired: boolean;
  locked: boolean;
  confirming: boolean;
  now: number;
}>();
defineEmits<{ confirm: [] }>();
const groups = computed(() => {
  const result = new Map<string, ReceptionRecord["allocations"]>();
  for (const allocation of props.item.allocations) {
    const key = allocation.resourceId;
    const group = result.get(key) ?? [];
    group.push(allocation);
    result.set(key, group);
  }
  return [...result.values()];
});
const segmentLabels = {
  prepare: "准备",
  service: "服务",
  cleanup: "整理／清洁",
  rest: "必要休息",
};
const resourceLabels: Record<string, string> = {
  therapist: "美容师",
  room: "房间",
  bed: "床位",
  equipment: "设备",
};
const paymentLabels: Record<string, string> = {
  created: "待支付",
  processing: "支付处理中",
  succeeded: "已到账",
  failed: "支付未成功",
  unknown: "结果待核实",
  manual_review: "需人工复核",
};
</script>

<template>
  <article class="reception-detail" aria-labelledby="reception-detail-title">
    <header class="detail-title-row">
      <h2 id="reception-detail-title">{{ item.customerName }}的接待</h2>
      <span
        class="reception-status"
        :data-state="expired ? 'expired' : item.state"
        >{{ expired ? "已到确认期限" : receptionStateLabels[item.state] }}</span
      >
    </header>
    <p class="reception-id">接待号 {{ item.receptionId }}</p>
    <p class="muted">
      联系方式：{{ item.maskedPhone ?? "未绑定联系电话"
      }}<span v-if="item.maskedPhone">（已脱敏）</span>
    </p>

    <section
      v-if="item.state === 'pending' && item.confirmationDeadline"
      class="reception-task"
    >
      <h3>等待门店确认</h3>
      <p>
        截止 {{ receptionTime(item.confirmationDeadline) }} ·
        {{
          expired
            ? "已到期，正在核对最新状态"
            : `剩余 ${formatCountdown(item.confirmationDeadline, now)}`
        }}
      </p>
      <p>确认后沿用当前人员和场地安排。</p>
      <el-button
        v-if="canConfirm"
        type="primary"
        :loading="confirming"
        :disabled="expired || locked"
        @click="$emit('confirm')"
        >确认接待</el-button
      >
      <p v-else>当前账号可查看，确认接待需店长分配权限。</p>
    </section>
    <p v-else-if="item.state === 'expired'" class="reception-task">
      该申请已过期，原预占已失效。如需重新预约，请重新查询可约时间。
    </p>
    <p v-else-if="item.state === 'invalidated'" class="reception-task">
      原申请因资源安排变化已失效，请联系顾客重新预约。
    </p>

    <section v-if="item.conflicts.length" class="reception-task">
      <h3>{{ item.conflicts.length }} 项安排冲突待跟进</h3>
      <p v-for="conflict in item.conflicts" :key="conflict.id">
        {{ conflict.resourceName }} ·
        {{ conflict.kind === "leave" ? "请假影响" : "资源不可用" }}<br />{{
          receptionTime(conflict.startAt)
        }}
        — {{ receptionTime(conflict.endAt) }}
      </p>
      <RouterLink v-if="!locked" to="/scheduling"
        >查看请假与冲突工作台</RouterLink
      >
      <p>已确认安排继续保留，联系顾客后跟进处理。</p>
    </section>

    <h3>顾客服务安排</h3>
    <p class="muted">
      以下为预约计划；时间经过不代表已经到店、实际完工或完成收款。
    </p>
    <section
      v-for="guest in item.guests"
      :key="guest.id"
      class="service-arrangement"
    >
      <div class="detail-title-row">
        <strong>{{ guest.serviceItemName }}</strong
        ><span>{{ formatMoney(guest.quoteCents) }}</span>
      </div>
      <p>
        {{ receptionTime(guest.serviceStartAt) }} —
        {{ receptionTime(guest.serviceEndAt) }}
      </p>
      <p>
        {{ guest.therapistName }} · {{ guest.roomName }} / {{ guest.bedName }}
      </p>
    </section>
    <div class="detail-title-row">
      <strong>接待报价</strong
      ><strong>{{ formatMoney(item.quoteCents) }}</strong>
    </div>

    <h3>人员与场地占用</h3>
    <p class="muted">
      按保存的占用记录展示。整理、清洁和必要休息分别计算，不属于顾客服务时长。
    </p>
    <section
      v-for="group in groups"
      :key="group[0]!.id"
      class="allocation-group"
    >
      <h4>
        {{ resourceLabels[group[0]!.resourceType] ?? "资源" }} ·
        {{ group[0]!.resourceName }}
      </h4>
      <dl>
        <template v-for="allocation in group" :key="allocation.id">
          <dt>
            {{ segmentLabels[allocation.segmentKind]
            }}<small v-if="allocation.state === 'inactive'">已释放</small>
          </dt>
          <dd>
            {{ receptionTime(allocation.startAt) }}<br />至
            {{ receptionTime(allocation.endAt) }}
          </dd>
        </template>
      </dl>
    </section>
    <p v-if="!groups.length" class="muted">
      暂无占用明细，请联系店长核实安排。
    </p>

    <h3>收款与异常</h3>
    <p v-if="item.payments === null" class="muted">
      当前账号无资金查看权限，请联系有权限的同事核实收款。
    </p>
    <p v-else-if="!item.payments.length" class="muted">
      暂无支付交易记录。预约报价不代表已经收款。
    </p>
    <template v-else>
      <section
        v-for="payment in item.payments"
        :key="payment.id"
        class="service-arrangement"
      >
        <div class="detail-title-row">
          <strong>{{ paymentLabels[payment.state] ?? "请核实支付状态" }}</strong
          ><span>{{ formatMoney(payment.amountCents) }}</span>
        </div>
        <p class="reception-id">支付号 {{ payment.id }}</p>
        <p>收款截止 {{ receptionTime(payment.collectionDeadline) }}</p>
        <RouterLink
          v-if="!locked && ['unknown', 'manual_review'].includes(payment.state)"
          to="/payments"
          >前往异常支付核实</RouterLink
        >
      </section>
    </template>
    <p class="muted">
      登记于 {{ receptionTime(item.createdAt) }} · 版本 {{ item.version }}
    </p>
  </article>
</template>
