<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from "vue";
import ReceptionExample from "./ReceptionExample.vue";
import LeaveExample from "./LeaveExample.vue";
import { DEMO_MARKER, leaveScenarios, receptionScenarios } from "./scenarios";
const workspace = ref("receptions");
const requestedWorkspace = ref("receptions");
const requestedScenario = ref("normal");
const scenario = ref("normal");
const revision = ref(0);
const locked = ref(false);
const controlsOpen = ref(true);
const options = computed(() =>
  requestedWorkspace.value === "receptions"
    ? receptionScenarios
    : leaveScenarios,
);
const id = useId();
function apply() {
  locked.value = false;
  workspace.value = requestedWorkspace.value;
  scenario.value = requestedScenario.value;
  revision.value++;
}
function change() {
  requestedScenario.value = "normal";
}
function switchWorkspace() {
  if (locked.value) return;
  requestedWorkspace.value =
    workspace.value === "receptions" ? "leave" : "receptions";
  requestedScenario.value = "normal";
  apply();
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (locked.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => window.removeEventListener("beforeunload", beforeUnload));
</script>
<template>
  <aside
    class="admin-ui-review"
    aria-label="评审场景控制区"
    :data-demo="DEMO_MARKER"
  >
    <div class="admin-ui-review-intro">
      <strong>界面示例</strong><span>虚构数据 · 不连接业务服务</span>
      <el-button
        class="admin-ui-review-toggle"
        :aria-expanded="controlsOpen"
        :aria-controls="`${id}-controls`"
        @click="controlsOpen = !controlsOpen"
        >{{ controlsOpen ? "收起评审设置" : "展开评审设置" }}</el-button
      >
    </div>
    <div v-show="controlsOpen" :id="`${id}-controls`">
      <div class="admin-ui-review-controls">
        <div class="admin-ui-field">
          <label :for="`${id}-workspace`">示例</label
          ><el-select
            :id="`${id}-workspace`"
            v-model="requestedWorkspace"
            popper-class="admin-ui-popover"
            @change="change"
            ><el-option label="接待查询与详情" value="receptions" /><el-option
              label="请假登记"
              value="leave"
          /></el-select>
        </div>
        <div class="admin-ui-field admin-ui-scenario">
          <label :for="`${id}-scenario`">演示情境</label
          ><el-select
            :id="`${id}-scenario`"
            v-model="requestedScenario"
            popper-class="admin-ui-popover"
            ><el-option
              v-for="[value, label] in options"
              :key="value"
              :value="value"
              :label="label"
          /></el-select>
        </div>
        <el-button @click="apply">重置演示并应用</el-button>
      </div>
      <p>这里仅供评审切换情境，会清空模拟操作；工作区内的业务保护仍需遵守。</p>
    </div>
  </aside>
  <ReceptionExample
    v-if="workspace === 'receptions'"
    :key="revision"
    :scenario="scenario"
    @lock="locked = $event"
    @leave="switchWorkspace"
  />
  <LeaveExample
    v-else
    :key="revision"
    :scenario="scenario"
    @lock="locked = $event"
    @leave="switchWorkspace"
  />
</template>
