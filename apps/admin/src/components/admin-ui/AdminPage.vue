<script setup lang="ts">
import { useId } from "vue";
defineProps<{ title: string; description?: string }>();
const titleId = useId();
</script>
<template>
  <main class="admin-ui-page" :aria-labelledby="titleId">
    <header class="admin-ui-topbar">
      <strong>得闲 SPA</strong>
      <nav v-if="$slots.navigation" aria-label="示例工作区导航">
        <slot name="navigation" />
      </nav>
    </header>
    <div class="admin-ui-heading">
      <div>
        <h1 :id="titleId">{{ title }}</h1>
        <p v-if="description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="admin-ui-actions">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </main>
</template>
