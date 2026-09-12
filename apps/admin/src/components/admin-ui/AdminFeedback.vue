<script setup lang="ts">
import { useId } from "vue";
withDefaults(
  defineProps<{
    title?: string;
    message?: string;
    tone?: "neutral" | "success" | "warning" | "danger";
    updatedAt?: string;
    busy?: boolean;
    urgent?: boolean;
  }>(),
  { tone: "neutral" },
);
const id = useId();
</script>
<template>
  <div class="admin-ui-feedback-host" :aria-busy="busy || undefined">
    <div
      v-if="title || message"
      class="admin-ui-feedback"
      :data-tone="tone"
      :role="urgent ? 'alert' : 'status'"
      :aria-labelledby="title ? id : undefined"
    >
      <strong v-if="title" :id="id">{{ title }}</strong>
      <p v-if="message">{{ message }}</p>
      <p v-if="updatedAt">数据时间：{{ updatedAt }}</p>
      <div v-if="$slots.actions" class="admin-ui-actions">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </div>
</template>
