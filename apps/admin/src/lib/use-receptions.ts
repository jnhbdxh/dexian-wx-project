import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";

import {
  ApiRequestError,
  confirmReception,
  getSession,
  type StaffUser,
} from "./api";
import {
  getReception,
  getReceptions,
  shanghaiToday,
  type ReceptionList,
  type ReceptionQuery,
  type ReceptionRecord,
  type ReceptionState,
} from "./receptions-api";
import {
  clearReceptionConfirmation,
  loadReceptionConfirmation,
  saveReceptionConfirmation,
  type ReceptionConfirmationAttempt,
} from "./reception-confirmation-recovery";

export function useReceptions() {
  const route = useRoute();
  const router = useRouter();
  const filters = reactive({
    serviceDate: shanghaiToday(),
    state: "" as ReceptionState | "",
    therapistId: "",
    receptionId: "",
  });
  const list = ref<ReceptionList>();
  const detail = ref<ReceptionRecord>();
  const user = ref<StaffUser>();
  const loading = ref(false);
  const detailLoading = ref(false);
  const confirming = ref(false);
  const error = ref("");
  const detailError = ref("");
  const notice = ref("");
  const attempt = ref<ReceptionConfirmationAttempt>();
  const recoveryError = ref("");
  const canConfirm = ref(false);
  const clockNow = ref(Date.now());
  const cursor = ref<string>();
  const previousCursors = ref<Array<string | undefined>>([]);
  let applied: ReceptionQuery = { serviceDate: filters.serviceDate };
  let offset = 0;
  let sequence = 0;
  let identityGeneration = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;
  let allowLogin = false;
  const locked = computed(
    () => confirming.value || !!attempt.value || !!recoveryError.value,
  );
  const correctOwner = computed(
    () =>
      !!attempt.value &&
      user.value?.id === attempt.value.staffUserId &&
      user.value.storeId === attempt.value.storeId,
  );
  const expired = computed(
    () =>
      detail.value?.state === "pending" &&
      !!detail.value.confirmationDeadline &&
      Date.parse(detail.value.confirmationDeadline) <= clockNow.value,
  );
  function synchronize(now: string) {
    offset = Date.parse(now) - Date.now();
    clockNow.value = Date.now() + offset;
  }
  function sameIdentity(next: StaffUser) {
    return user.value?.id === next.id && user.value.storeId === next.storeId;
  }
  function clearProtectedData() {
    identityGeneration += 1;
    sequence += 1;
    list.value = undefined;
    detail.value = undefined;
    user.value = undefined;
    canConfirm.value = false;
    detailLoading.value = false;
    detailError.value = "";
    cursor.value = undefined;
    previousCursors.value = [];
  }
  function acceptIdentity(next: StaffUser) {
    if (user.value && !sameIdentity(next)) clearProtectedData();
    user.value = next;
  }
  function applyList(result: ReceptionList) {
    acceptIdentity(result.user);
    list.value = result;
    canConfirm.value = result.canConfirm;
    synchronize(result.serverNow);
  }
  async function loginAgain() {
    allowLogin = true;
    await router.push({ path: "/login", query: { redirect: "/receptions" } });
  }
  async function failure(reason: unknown, target: typeof error) {
    if (
      reason instanceof ApiRequestError &&
      [401, 403].includes(reason.status)
    ) {
      clearProtectedData();
    }
    if (reason instanceof ApiRequestError && reason.status === 401) {
      await loginAgain();
      return;
    }
    target.value =
      reason instanceof ApiRequestError
        ? reason.message
        : "暂时无法读取接待，请重试。";
  }
  async function select(id: string, background = false) {
    if (locked.value) return;
    const requestId = ++sequence;
    const requestIdentityGeneration = identityGeneration;
    if (!background) detail.value = undefined;
    detailError.value = "";
    detailLoading.value = !background;
    try {
      const result = await getReception(id);
      if (
        requestId !== sequence ||
        requestIdentityGeneration !== identityGeneration
      )
        return;
      const identityChanged = user.value && !sameIdentity(result.user);
      acceptIdentity(result.user);
      detail.value = result.item;
      canConfirm.value = result.canConfirm;
      synchronize(result.serverNow);
      if (identityChanged) detailLoading.value = false;
    } catch (reason) {
      if (requestId === sequence) {
        detail.value = undefined;
        await failure(reason, detailError);
      }
    } finally {
      if (requestId === sequence) detailLoading.value = false;
    }
  }
  async function load(refreshDetail = false) {
    if (locked.value || loading.value) return;
    const requestIdentityGeneration = identityGeneration;
    loading.value = true;
    error.value = "";
    try {
      const result = await getReceptions({
        ...applied,
        ...(cursor.value ? { after: cursor.value } : {}),
      });
      if (requestIdentityGeneration !== identityGeneration) return;
      applyList(result);
      if (refreshDetail && detail.value)
        await select(detail.value.receptionId, true);
    } catch (reason) {
      if (requestIdentityGeneration !== identityGeneration) return;
      if (
        reason instanceof ApiRequestError &&
        reason.code === "INVALID_CURSOR" &&
        cursor.value
      ) {
        cursor.value = undefined;
        previousCursors.value = [];
        try {
          const result = await getReceptions({ ...applied });
          if (requestIdentityGeneration !== identityGeneration) return;
          applyList(result);
          notice.value = "查询结果已变化，已返回第一页。";
          if (refreshDetail && detail.value)
            await select(detail.value.receptionId, true);
        } catch (recoveryReason) {
          list.value = undefined;
          await failure(recoveryReason, error);
        }
      } else {
        list.value = undefined;
        await failure(reason, error);
      }
    } finally {
      loading.value = false;
    }
  }
  async function search() {
    if (locked.value || loading.value) return;
    applied = {
      serviceDate: filters.serviceDate,
      ...(filters.state ? { state: filters.state } : {}),
      ...(filters.therapistId ? { therapistId: filters.therapistId } : {}),
      ...(filters.receptionId.trim()
        ? { receptionId: filters.receptionId.trim() }
        : {}),
    };
    cursor.value = undefined;
    previousCursors.value = [];
    ++sequence;
    detail.value = undefined;
    detailError.value = "";
    detailLoading.value = false;
    await load();
  }
  async function page(next: boolean) {
    if (loading.value || locked.value) return;
    if (next && list.value?.nextCursor) {
      previousCursors.value.push(cursor.value);
      cursor.value = list.value.nextCursor;
    } else if (!next && previousCursors.value.length)
      cursor.value = previousCursors.value.pop();
    await load();
  }
  async function clearAttempt() {
    clearReceptionConfirmation();
    attempt.value = undefined;
  }
  async function submit() {
    if (confirming.value || recoveryError.value) return;
    if (attempt.value && !correctOwner.value) {
      notice.value = "请使用发起确认的原员工账号登录后核实。";
      return;
    }
    if (
      !attempt.value &&
      (!detail.value ||
        !canConfirm.value ||
        expired.value ||
        detail.value.state !== "pending")
    )
      return;
    notice.value = "";
    if (!attempt.value) {
      const item = detail.value!;
      const next = {
        receptionId: item.receptionId,
        version: item.version,
        key: crypto.randomUUID(),
        staffUserId: user.value!.id,
        storeId: user.value!.storeId,
      };
      try {
        saveReceptionConfirmation(next);
        attempt.value = next;
      } catch {
        notice.value =
          "浏览器无法保存结果核实记录，本次尚未发送，请恢复会话存储后再试。";
        return;
      }
    }
    const current = attempt.value!;
    confirming.value = true;
    let resolved = false;
    try {
      await confirmReception(
        current.receptionId,
        current.version,
        current.key,
        {
          staffUserId: current.staffUserId,
          storeId: current.storeId,
        },
      );
      await clearAttempt();
      resolved = true;
      notice.value =
        "接待当前已确认。若其他同事已确认，系统沿用原结果，不会重复安排。";
    } catch (reason) {
      if (
        reason instanceof ApiRequestError &&
        [
          "RECEPTION_EXPIRED",
          "VERSION_CONFLICT",
          "RECEPTION_STATE_CONFLICT",
          "RECEPTION_ALLOCATION_STATE_CONFLICT",
          "RECEPTION_NOT_FOUND",
        ].includes(reason.code)
      ) {
        await clearAttempt();
        resolved = true;
        notice.value = `${reason.message}，请核对刷新后的状态。`;
      } else if (reason instanceof ApiRequestError && reason.status === 401) {
        await loginAgain();
      } else if (
        reason instanceof ApiRequestError &&
        reason.code === "RECEPTION_CONFIRM_IDENTITY_CHANGED"
      ) {
        clearProtectedData();
        notice.value = `${reason.message}。原确认请求已保留。`;
      } else {
        notice.value =
          reason instanceof ApiRequestError && reason.status === 403
            ? `${reason.message}。原确认请求已保留，恢复权限或重新登录后核实。`
            : "确认结果尚未核实，请使用原请求核实；不要重新登记或重复确认其他接待。";
      }
    } finally {
      confirming.value = false;
    }
    if (resolved) {
      await select(current.receptionId);
      cursor.value = undefined;
      previousCursors.value = [];
      await load();
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (locked.value) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  onBeforeRouteLeave(() => {
    if (locked.value && !allowLogin) {
      notice.value = "请先核实当前确认结果，再离开此页。";
      return false;
    }
  });
  onMounted(async () => {
    window.addEventListener("beforeunload", beforeUnload);
    try {
      attempt.value = loadReceptionConfirmation();
    } catch {
      recoveryError.value =
        "恢复记录无法读取。请保留当前标签页，联系店长核实原接待；当前禁止发起新确认。";
    }
    try {
      user.value = (await getSession()).user;
    } catch (reason) {
      await failure(reason, error);
      return;
    }
    if (!locked.value) {
      await load();
      const requestedId = route.query.receptionId;
      if (typeof requestedId === "string") await select(requestedId);
    }
    timer = setInterval(() => {
      clockNow.value = Date.now() + offset;
      ticks++;
      if (ticks % 15 === 0 && !locked.value && !detailLoading.value)
        void load(true);
      else if (
        !locked.value &&
        !loading.value &&
        !detailLoading.value &&
        list.value?.items.some(
          (item) =>
            item.state === "pending" &&
            item.confirmationDeadline &&
            Date.parse(item.confirmationDeadline) <= clockNow.value,
        ) &&
        ticks % 2 === 0
      )
        void load(true);
    }, 1000);
  });
  onBeforeUnmount(() => {
    ++sequence;
    if (timer) clearInterval(timer);
    window.removeEventListener("beforeunload", beforeUnload);
  });
  return {
    filters,
    list,
    detail,
    user,
    loading,
    detailLoading,
    confirming,
    error,
    detailError,
    notice,
    attempt,
    recoveryError,
    locked,
    correctOwner,
    canConfirm,
    expired,
    clockNow,
    previousCursors,
    search,
    select,
    page,
    load,
    submit,
    loginAgain,
  };
}
