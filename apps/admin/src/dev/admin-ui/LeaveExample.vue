<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  useId,
  watch,
  watchPostEffect,
} from "vue";
import AdminPage from "../../components/admin-ui/AdminPage.vue";
import AdminFeedback from "../../components/admin-ui/AdminFeedback.vue";
const props = defineProps<{ scenario: string }>();
const emit = defineEmits<{ lock: [locked: boolean]; leave: [] }>();
const id = useId();
const form = reactive({
  therapist: "小满",
  date: "2026-09-15",
  start: "14:00",
  end: "18:00",
  reason: "个人事务（演示）",
});
const error = ref("");
const result = ref("");
const pending = ref("");
const submitting = ref(false);
const reviewed = ref(false);
const impactHeading = ref<HTMLElement>();
const resultRegion = ref<HTMLElement>();
const formElement = ref<HTMLFormElement>();
type Field = "date" | "start" | "end" | "reason";
const fieldErrors = ref<Partial<Record<Field, string>>>({});
let validationAttempted = false;
// Element Plus 2.14 DatePicker passes unknown ARIA attributes to its tooltip,
// not the native input. Keep this input's error association local to the example.
watchPostEffect(() => {
  const message = fieldErrors.value.date;
  const input = formElement.value?.querySelector<HTMLInputElement>(
    `input[id="${id}-date"]`,
  );
  input?.setAttribute("aria-invalid", String(!!message));
  if (message) input?.setAttribute("aria-describedby", `${id}-date-error`);
  else input?.removeAttribute("aria-describedby");
});
const submissions = ref(0);
let disposed = false;
const locked = computed(() => submitting.value || !!pending.value);
const hasFollowUp = computed(
  () => props.scenario === "follow-up" || props.scenario === "unknown",
);
const summary = computed(
  () => `${form.therapist} · ${form.date} ${form.start}—${form.end}`,
);
watch(locked, (value) => emit("lock", value), { immediate: true });
watch(form, () => {
  reviewed.value = false;
  error.value = "";
  result.value = "";
  if (validationAttempted) validate();
});
onBeforeUnmount(() => {
  disposed = true;
  emit("lock", false);
});
function reset() {
  if (locked.value) return;
  validationAttempted = false;
  fieldErrors.value = {};
  Object.assign(form, {
    therapist: "小满",
    date: "2026-09-15",
    start: "14:00",
    end: "18:00",
    reason: "个人事务（演示）",
  });
  reviewed.value = false;
  result.value = "";
  error.value = "";
}
function validate() {
  const errors: Partial<Record<Field, string>> = {};
  if (!form.date) errors.date = "请选择请假日期。";
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(form.start)) errors.start = "请填写有效的开始时间。";
  if (!timePattern.test(form.end)) errors.end = "请填写有效的结束时间。";
  else if (!errors.start && form.end <= form.start)
    errors.end = "结束时间必须晚于开始时间；本示例仅登记同一天内的请假。";
  if (!form.reason.trim()) errors.reason = "请填写内部请假原因。";
  fieldErrors.value = errors;
  return Object.keys(errors) as Field[];
}
async function focusResult() {
  await nextTick();
  if (disposed) return;
  resultRegion.value?.focus({ preventScroll: true });
  resultRegion.value?.scrollIntoView({ block: "nearest" });
}
async function inspect() {
  if (locked.value || result.value) return;
  error.value = "";
  validationAttempted = true;
  const invalid = validate();
  if (invalid.length) {
    reviewed.value = false;
    await nextTick();
    const input = formElement.value?.querySelector<HTMLElement>(
      `[id="${id}-${invalid[0]}"]`,
    );
    input?.focus({ preventScroll: true });
    input?.closest(".admin-ui-field")?.scrollIntoView({ block: "center" });
    return;
  }
  reviewed.value = true;
  await nextTick();
  impactHeading.value?.focus({ preventScroll: true });
  if (window.innerWidth <= 900)
    impactHeading.value?.scrollIntoView({ block: "start" });
}
async function submit() {
  if (locked.value || !reviewed.value || result.value) return;
  submitting.value = true;
  submissions.value++;
  error.value = "";
  result.value = "";
  const original = summary.value;
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (disposed) return;
  if (props.scenario === "unknown") pending.value = original;
  else if (props.scenario === "failure")
    error.value =
      "本次未保存，原因：模拟校验未通过。可修改信息后重新检查影响。";
  else result.value = `请假已保存：${original}。`;
  reviewed.value = false;
  submitting.value = false;
  await focusResult();
}
async function verify() {
  if (!pending.value || submitting.value) return;
  submitting.value = true;
  const original = pending.value;
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (disposed) return;
  result.value = `已核实原操作，请假已保存：${original}。`;
  pending.value = "";
  submitting.value = false;
  reviewed.value = false;
  await focusResult();
}
</script>
<template>
  <AdminPage
    title="登记请假"
    description="如实记录不可用时段，看清影响，再安排后续跟进。"
  >
    <template #navigation
      ><el-button :disabled="locked" @click="emit('leave')"
        >返回接待示例</el-button
      ><span>值班前台 · 演示门店</span></template
    >
    <div class="admin-ui-form-layout">
      <section class="admin-ui-panel">
        <h2>请假信息</h2>
        <p class="admin-ui-muted">仅用于交互演示，不会写入真实请假记录。</p>
        <form
          ref="formElement"
          aria-label="请假登记表单"
          novalidate
          @submit.prevent="inspect"
        >
          <fieldset class="admin-ui-form-fields" :disabled="locked">
            <legend class="admin-ui-sr-only">请假信息</legend>
            <div class="admin-ui-field">
              <label :for="`${id}-therapist`">美容师</label
              ><el-select
                :id="`${id}-therapist`"
                v-model="form.therapist"
                :disabled="locked"
                popper-class="admin-ui-popover"
                ><el-option label="小满" value="小满" /><el-option
                  label="清禾"
                  value="清禾"
              /></el-select>
            </div>
            <div class="admin-ui-field">
              <label :for="`${id}-date`">请假日期</label
              ><el-date-picker
                :id="`${id}-date`"
                v-model="form.date"
                value-format="YYYY-MM-DD"
                format="YYYY/MM/DD"
                :clearable="false"
                :disabled="locked"
                popper-class="admin-ui-popover"
              />
              <p
                v-if="fieldErrors.date"
                :id="`${id}-date-error`"
                class="admin-ui-field-error"
              >
                {{ fieldErrors.date }}
              </p>
            </div>
            <div class="admin-ui-time-fields">
              <div class="admin-ui-field">
                <label :for="`${id}-start`">开始时间</label
                ><input
                  :id="`${id}-start`"
                  v-model="form.start"
                  :aria-invalid="!!fieldErrors.start"
                  :aria-describedby="
                    fieldErrors.start ? `${id}-start-error` : undefined
                  "
                  type="time"
                  required
                />
                <p
                  v-if="fieldErrors.start"
                  :id="`${id}-start-error`"
                  class="admin-ui-field-error"
                >
                  {{ fieldErrors.start }}
                </p>
              </div>
              <div class="admin-ui-field">
                <label :for="`${id}-end`">结束时间</label
                ><input
                  :id="`${id}-end`"
                  v-model="form.end"
                  :aria-invalid="!!fieldErrors.end"
                  :aria-describedby="
                    fieldErrors.end ? `${id}-end-error` : undefined
                  "
                  type="time"
                  required
                />
                <p
                  v-if="fieldErrors.end"
                  :id="`${id}-end-error`"
                  class="admin-ui-field-error"
                >
                  {{ fieldErrors.end }}
                </p>
              </div>
            </div>
            <div class="admin-ui-field">
              <label :for="`${id}-reason`">内部请假原因</label
              ><el-input
                :id="`${id}-reason`"
                v-model="form.reason"
                :aria-invalid="!!fieldErrors.reason"
                type="textarea"
                :rows="3"
                :disabled="locked"
                :aria-describedby="`${id}-reason-help${fieldErrors.reason ? ` ${id}-reason-error` : ''}`"
              />
              <p
                v-if="fieldErrors.reason"
                :id="`${id}-reason-error`"
                class="admin-ui-field-error"
              >
                {{ fieldErrors.reason }}
              </p>
              <p :id="`${id}-reason-help`" class="admin-ui-muted">
                仅供内部处理，不作为顾客可见说明。
              </p>
            </div>
          </fieldset>
          <div class="admin-ui-actions">
            <el-button
              type="primary"
              native-type="submit"
              :disabled="locked || !!result"
              >查看影响</el-button
            ><el-button
              native-type="button"
              :disabled="locked"
              @click="reset"
              >{{ result ? "登记另一条" : "重置" }}</el-button
            >
          </div>
          <p v-if="locked">当前操作尚未结束，普通提交与重置已锁定。</p>
        </form>
      </section>
      <section class="admin-ui-panel" aria-label="请假影响">
        <h2 ref="impactHeading" tabindex="-1">本次影响与下一步</h2>
        <p v-if="!pending && !result">{{ summary }}</p>
        <div
          v-if="pending || result || error"
          ref="resultRegion"
          tabindex="-1"
          role="region"
          aria-label="保存处理结果"
          class="admin-ui-result"
        >
          <AdminFeedback
            v-if="pending"
            tone="warning"
            title="保存结果尚未确定，请核实原操作"
            :message="`${pending}。暂时不能重新提交、重置或离开工作区。`"
            urgent
            ><p v-if="hasFollowUp">
              原操作涉及 2 组已确认接待。请先核实保存结果，再跟进安排。
            </p>
            <template #actions
              ><el-button
                type="primary"
                :disabled="submitting"
                @click="verify"
                >{{ submitting ? "正在核实…" : "核实原保存结果" }}</el-button
              ></template
            ></AdminFeedback
          >
          <AdminFeedback
            v-if="result"
            title="保存结果已确定"
            :message="`${result}${hasFollowUp ? '' : ' 可以继续其他工作。'}`"
            tone="success"
          />
          <AdminFeedback
            v-if="result && hasFollowUp"
            title="仍有 2 组已确认接待待跟进"
            message="请假已生效，原接待安排继续保留。下一步：联系顾客并记录沟通结果，由有权限的员工处理安排。"
            tone="warning"
          />
          <AdminFeedback
            v-if="error"
            title="本次未保存"
            :message="error"
            tone="danger"
            urgent
          />
        </div>
        <template v-if="reviewed"
          ><AdminFeedback
            v-if="hasFollowUp"
            title="影响 2 组已确认接待"
            tone="warning"
            message="真实请假仍需如实登记；已确认安排不会自动取消或更换美容师。"
          />
          <p v-else>当前模拟时段无已确认接待。</p>
          <p>登记后，该时段将成为人员不可用时段。</p>
          <p class="admin-ui-muted">预约处理与请假保存是不同动作。</p>
          <p v-if="hasFollowUp">
            下一步：联系顾客，记录沟通结果，再跟进原接待安排。
          </p>
          <p v-else>下一步：核对保存结果后，可继续其他工作。</p>
          <el-button type="primary" :disabled="locked" @click="submit">{{
            submitting ? "正在保存…" : "确认登记请假"
          }}</el-button></template
        >
        <p v-else-if="!pending && !result" class="admin-ui-muted">
          填写请假信息后选择“查看影响”，在这里核对处理范围。
        </p>
        <p class="admin-ui-muted">
          模拟提交次数：{{
            submissions
          }}。此计数用于检查重复触发，不代表真实业务记录。
        </p>
      </section>
    </div>
  </AdminPage>
</template>
