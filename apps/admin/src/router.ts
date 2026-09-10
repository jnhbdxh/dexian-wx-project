import { createRouter, createWebHistory } from "vue-router";

import DashboardPage from "./views/DashboardPage.vue";
import LoginPage from "./views/LoginPage.vue";
import SchedulingPage from "./views/SchedulingPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/dashboard" },
    { path: "/login", component: LoginPage },
    { path: "/dashboard", component: DashboardPage },
    { path: "/scheduling", component: SchedulingPage },
  ],
});
