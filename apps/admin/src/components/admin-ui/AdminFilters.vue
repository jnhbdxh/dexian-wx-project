<script setup lang="ts">
const props = withDefaults(
  defineProps<{ busy?: boolean; disabled?: boolean; label?: string }>(),
  { label: "查询条件" },
);
const emit = defineEmits<{ submit: []; reset: [] }>();
function send(action: "submit" | "reset") {
  if (!props.busy && !props.disabled) {
    if (action === "submit") emit("submit");
    else emit("reset");
  }
}
</script>
<template>
  <form
    class="admin-ui-filters"
    :aria-label="label"
    @submit.prevent="send('submit')"
  >
    <fieldset :disabled="busy || disabled">
      <legend class="admin-ui-sr-only">{{ label }}</legend>
      <slot />
      <div class="admin-ui-actions">
        <el-button
          native-type="submit"
          type="primary"
          :disabled="disabled || busy"
          >查询</el-button
        ><el-button
          native-type="button"
          :disabled="disabled || busy"
          @click="send('reset')"
          >重置</el-button
        >
      </div>
    </fieldset>
    <slot name="description" />
  </form>
</template>
