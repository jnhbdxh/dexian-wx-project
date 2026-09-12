<script setup lang="ts">
import { ref, watch } from "vue";
const props = withDefaults(defineProps<{ text: string; label?: string }>(), {
  label: "编号",
});
const message = ref("");
const busy = ref(false);
let revision = 0;
watch(
  () => props.text,
  () => {
    revision++;
    busy.value = false;
    message.value = "";
  },
);
async function copy() {
  if (busy.value) return;
  const version = revision;
  const text = props.text;
  busy.value = true;
  try {
    await navigator.clipboard.writeText(text);
    if (version === revision) message.value = `${props.label}已复制`;
  } catch {
    if (version === revision)
      message.value = "复制未成功，请选择原文手动复制。";
  } finally {
    if (version === revision) busy.value = false;
  }
}
</script>
<template>
  <div class="admin-ui-copy">
    <span class="admin-ui-copy-text">{{ label }}：{{ text }}</span
    ><el-button
      :disabled="busy"
      :aria-label="`复制${label} ${text}`"
      @click="copy"
      >复制</el-button
    ><span class="admin-ui-copy-result" role="status">{{ message }}</span>
  </div>
</template>
