<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { login } from "../lib/api";

const router = useRouter();
const route = useRoute();
const submitting = ref(false);
const errorMessage = ref("");
const form = reactive({ username: "", password: "" });

async function submit() {
  if (!form.username || !form.password) {
    errorMessage.value = "请输入账号和密码";
    return;
  }
  submitting.value = true;
  errorMessage.value = "";
  try {
    await login(form.username, form.password);
    const requestedRedirect = route.query.redirect;
    const redirect =
      typeof requestedRedirect === "string" &&
      requestedRedirect.startsWith("/") &&
      !requestedRedirect.startsWith("//")
        ? requestedRedirect
        : "/dashboard";
    await router.replace(redirect);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "登录失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-panel" aria-labelledby="login-title">
      <p class="eyebrow">得闲 SPA</p>
      <h1 id="login-title">运营后台</h1>
      <p class="supporting-text">登录后处理门店当天的预约、冲突和待办。</p>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            autocomplete="current-password"
            show-password
            @keyup.enter="submit"
          />
        </el-form-item>
        <p v-if="errorMessage" class="form-error" role="alert">
          {{ errorMessage }}
        </p>
        <el-button
          type="primary"
          native-type="submit"
          :loading="submitting"
          class="submit-button"
        >
          登录
        </el-button>
      </el-form>
    </section>
  </main>
</template>
