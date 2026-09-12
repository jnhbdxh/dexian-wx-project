<script setup lang="ts">
const props = defineProps<{
  page?: number;
  total?: number;
  hasPrevious: boolean;
  hasNext: boolean;
  busy?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ previous: []; next: [] }>();
function previous() {
  if (props.hasPrevious && !props.busy && !props.disabled) emit("previous");
}
function next() {
  if (props.hasNext && !props.busy && !props.disabled) emit("next");
}
</script>
<template>
  <nav class="admin-ui-pagination" aria-label="结果分页">
    <el-button :disabled="!hasPrevious || busy || disabled" @click="previous"
      >上一页</el-button
    ><span v-if="page !== undefined"
      >第 {{ page }} 页<span v-if="total !== undefined">
        · 共 {{ total }} 组</span
      ></span
    ><span v-else-if="total !== undefined">共 {{ total }} 组</span
    ><el-button :disabled="!hasNext || busy || disabled" @click="next"
      >下一页</el-button
    ><slot />
  </nav>
</template>
