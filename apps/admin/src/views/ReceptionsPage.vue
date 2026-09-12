<script setup lang="ts">
import { nextTick, ref } from "vue";
import { RouterLink } from "vue-router";
import { formatMoney } from "../lib/confirmation";
import { receptionStateLabels, receptionTime } from "../lib/receptions-api";
import { useReceptions } from "../lib/use-receptions";
import ReceptionDetails from "./ReceptionDetails.vue";
import "./receptions.css";

const {
  filters,
  list,
  detail,
  user,
  loading,
  detailLoading,
  confirming,
  error,
  detailError,
  notice,
  attempt,
  recoveryError,
  locked,
  correctOwner,
  canConfirm,
  expired,
  clockNow,
  previousCursors,
  search,
  select,
  page,
  load,
  submit,
  loginAgain,
} = useReceptions();
const detailRegion = ref<HTMLElement>();
const listRegion = ref<HTMLElement>();
async function selectFromList(id: string) {
  await select(id);
  await nextTick();
  if (detail.value && window.innerWidth <= 820) {
    detailRegion.value?.scrollIntoView({ block: "start" });
    detailRegion.value?.focus({ preventScroll: true });
  }
}
function returnToList() {
  listRegion.value?.scrollIntoView({ block: "start" });
  listRegion.value?.focus({ preventScroll: true });
}
</script>

<template>
  <main class="dashboard-page receptions-page">
    <!-- THESIS: Find an existing reception and act on its current facts.
    OWN-WORLD: Inherit the green operating desk, system Chinese type and white work panels.
    STORY: Filter service dates, read the original plan, confirm or follow an exception.
    FIRST VIEWPORT: Compact filters above a list; selected detail at right; confirmation beside deadline.
    FORM: Precisely scoped extension, code-led, admin-receptions-1a. No new visual identity.
    FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md -->
    <header class="dashboard-header">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">闲</span
        ><span>得闲 SPA</span>
      </div>
      <nav class="user-actions" aria-label="后台导航">
        <RouterLink v-if="!locked" to="/dashboard">今日工作台</RouterLink>
        <RouterLink v-if="!locked" to="/calendar">预约日历</RouterLink>
        <RouterLink v-if="!locked" to="/scheduling">请假与冲突</RouterLink>
        <RouterLink v-if="!locked" to="/booking-policy">预约政策</RouterLink>
        <span v-if="user" class="signed-in-user">{{ user.displayName }}</span>
      </nav>
    </header>
    <div class="workbench-heading">
      <div>
        <h1>接待查询</h1>
        <p>找到原预约，核对安排，继续处理。</p>
      </div>
      <el-button
        :disabled="locked || loading"
        :loading="loading"
        @click="load(true)"
        >刷新列表与详情</el-button
      >
    </div>

    <section
      v-if="attempt || recoveryError"
      class="reception-recovery"
      role="alert"
    >
      <h2>先核实上一次确认结果</h2>
      <p v-if="attempt" class="reception-id">
        接待号 {{ attempt.receptionId }}
      </p>
      <p>
        {{
          recoveryError ||
          "原请求已保留。核实完成前，请勿重复登记或确认其他接待。"
        }}
      </p>
      <el-button
        v-if="attempt && correctOwner"
        type="primary"
        :loading="confirming"
        :disabled="confirming"
        @click="submit"
        >{{ confirming ? "正在核实" : "核实原确认结果" }}</el-button
      >
      <p v-else-if="attempt">请使用发起确认的原员工账号登录后核实。</p>
      <el-button v-if="attempt && !confirming" @click="loginAgain"
        >重新登录后核实</el-button
      >
    </section>
    <p v-if="notice" class="reception-notice" role="status">{{ notice }}</p>
    <form class="reception-filters" @submit.prevent="search">
      <fieldset :disabled="locked || loading">
        <div>
          <label for="service-date">服务日期</label
          ><input
            id="service-date"
            v-model="filters.serviceDate"
            type="date"
            required
          />
        </div>
        <div>
          <label for="reception-state">预约状态</label
          ><select id="reception-state" v-model="filters.state">
            <option value="">全部状态</option>
            <option
              v-for="(label, state) in receptionStateLabels"
              :key="state"
              :value="state"
            >
              {{ label }}
            </option>
          </select>
        </div>
        <div>
          <label for="reception-therapist">美容师</label
          ><select id="reception-therapist" v-model="filters.therapistId">
            <option value="">全部美容师</option>
            <option
              v-for="therapist in list?.therapists ?? []"
              :key="therapist.id"
              :value="therapist.id"
            >
              {{ therapist.name }}
            </option>
          </select>
        </div>
        <div class="reception-number-filter">
          <label for="reception-number">完整接待号</label
          ><input
            id="reception-number"
            v-model="filters.receptionId"
            type="text"
            placeholder="粘贴完整接待号"
            maxlength="36"
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
          />
        </div>
        <el-button
          type="primary"
          native-type="submit"
          :disabled="locked || loading"
          >查询接待</el-button
        >
      </fieldset>
      <p class="muted">
        按北京时间查询与当天相交的顾客服务；跨午夜接待在两天均可查。仅准备或休息跨日不计入。
      </p>
    </form>
    <section v-if="error" class="reception-notice" role="alert">
      <p>{{ error }}</p>
      <el-button :disabled="locked || loading" @click="load()"
        >重试查询</el-button
      >
    </section>
    <div class="reception-workspace" :aria-busy="loading">
      <section
        ref="listRegion"
        class="reception-list"
        aria-label="接待列表"
        tabindex="-1"
      >
        <header class="detail-title-row">
          <h2>
            查询结果 <span v-if="list" class="muted">{{ list.total }} 组</span>
          </h2>
          <span v-if="loading" role="status">正在读取…</span>
        </header>
        <p v-if="list" class="muted">
          截至 {{ receptionTime(list.serverNow) }}，每 15 秒更新
        </p>
        <p v-if="list && !list.items.length" class="reception-empty">
          没有符合条件的接待。请调整日期或筛选条件。
        </p>
        <ul v-if="list?.items.length" class="reception-results">
          <li v-for="item in list.items" :key="item.receptionId">
            <button
              type="button"
              class="reception-row"
              :aria-pressed="detail?.receptionId === item.receptionId"
              :disabled="locked"
              @click="selectFromList(item.receptionId)"
            >
              <span class="detail-title-row"
                ><strong>{{ item.customerName }}</strong
                ><span class="reception-status" :data-state="item.state">{{
                  receptionStateLabels[item.state]
                }}</span></span
              >
              <span
                >{{ receptionTime(item.serviceStartAt) }} —
                {{ receptionTime(item.serviceEndAt) }}</span
              >
              <span>{{
                item.guests
                  .map((g) => `${g.serviceItemName} · ${g.therapistName}`)
                  .join("；")
              }}</span>
              <span v-if="item.conflicts.length" class="reception-warning"
                >{{ item.conflicts.length }} 项安排冲突待跟进</span
              >
              <span class="detail-title-row muted"
                ><span
                  >共 {{ item.guests.length }} 位 ·
                  {{ formatMoney(item.quoteCents) }}</span
                ><span>查看详情</span></span
              >
              <small class="reception-id">{{ item.receptionId }}</small>
            </button>
          </li>
        </ul>
        <footer v-if="list" class="reception-pagination">
          <el-button
            :disabled="!previousCursors.length || locked || loading"
            @click="page(false)"
            >上一页</el-button
          ><span>第 {{ previousCursors.length + 1 }} 页</span
          ><el-button
            :disabled="!list.nextCursor || locked || loading"
            @click="page(true)"
            >下一页</el-button
          >
        </footer>
      </section>
      <section
        ref="detailRegion"
        aria-label="接待详情"
        :aria-busy="detailLoading"
        tabindex="-1"
      >
        <el-button
          v-if="detail && !locked"
          class="return-to-list"
          @click="returnToList"
          >返回接待列表</el-button
        >
        <div
          v-if="detailLoading"
          class="reception-detail reception-empty"
          role="status"
        >
          正在读取接待详情…
        </div>
        <div v-else-if="detailError" class="reception-detail" role="alert">
          <h2>暂时无法查看详情</h2>
          <p>{{ detailError }}</p>
          <p>请重新选择记录；如无权限，请联系店长。</p>
        </div>
        <ReceptionDetails
          v-else-if="detail"
          :item="detail"
          :can-confirm="canConfirm"
          :expired="expired"
          :locked="locked"
          :confirming="confirming"
          :now="clockNow"
          @confirm="submit"
        />
        <div v-else class="reception-detail reception-empty">
          <h2>选择一条接待</h2>
          <p>在列表中查看原预约的服务、人员与场地安排。</p>
        </div>
      </section>
    </div>
  </main>
</template>
