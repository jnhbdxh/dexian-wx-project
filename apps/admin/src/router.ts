import { createRouter, createWebHistory } from "vue-router";

import DashboardPage from "./views/DashboardPage.vue";
import LoginPage from "./views/LoginPage.vue";
import PaymentReviewPage from "./views/PaymentReviewPage.vue";
import SchedulingPage from "./views/SchedulingPage.vue";
import ReceptionsPage from "./views/ReceptionsPage.vue";
import ResourceCalendarPage from "./views/ResourceCalendarPage.vue";
import BookingPolicyPage from "./views/BookingPolicyPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/dashboard" },
    { path: "/login", component: LoginPage },
    { path: "/dashboard", component: DashboardPage },
    { path: "/receptions", component: ReceptionsPage },
    { path: "/calendar", component: ResourceCalendarPage },
    { path: "/booking-policy", component: BookingPolicyPage },
    { path: "/scheduling", component: SchedulingPage },
    { path: "/payments", component: PaymentReviewPage },
  ],
});
