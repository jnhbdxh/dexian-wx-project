import {
  ApiRequestError,
  createHoldReception,
  ensureCustomerSession,
  getBookingCatalog,
  getBookingStartOptions,
  queryAvailability,
  type AvailabilityResult,
  type BookingCatalog,
  type HoldReceptionResult,
} from "../../lib/api";
import {
  bookingIdempotencyKey,
  buildDateOptionsForRange,
  confirmationDeadlineLabel,
  shouldKeepHoldRecovery,
  totalLabel,
} from "../../lib/booking-ui";

interface TherapistOption {
  id: string;
  name: string;
  specialty: string;
  mark: string;
  tone: string;
}

interface ServiceOption {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceCents: number;
  priceLabel: string;
  mark: string;
  tone: string;
  therapists: TherapistOption[];
}

interface GuestCountOption {
  count: number;
  enabled: boolean;
}

interface TimeOption {
  serviceStartAt: string;
  label: string;
  available: boolean;
  note: string;
}

interface HoldRecovery {
  candidateToken: string;
  idempotencyKey: string;
  storeId: string;
  storeName: string;
  storeTimezone: string;
  service: ServiceOption;
  therapist: TherapistOption;
  selectedDateKey: string;
  selectedDateLabel: string;
  selectedTime: string;
  serviceStartAt: string;
  requiresFreshLogin?: boolean;
}

const app = getApp<{ globalData: { apiBaseUrl: string } }>();
const storeTimezone = "Asia/Shanghai";
const tones = ["sage", "clay", "sand", "deep"];
const RECOVERY_STORAGE_KEY = "dexian_booking_hold_recovery";
const CLIENT_GUEST_ID = "self";
const NO_CONFIRMATION_WINDOW_MESSAGE =
  "该时间前门店没有可处理确认申请的时段，请选择更晚时间。";
const emptyService: ServiceOption = {
  id: "",
  name: "尚未选择项目",
  description: "",
  durationMinutes: 0,
  priceCents: 0,
  priceLabel: "—",
  mark: "闲",
  tone: "sage",
  therapists: [],
};
const emptyTherapist: TherapistOption = {
  id: "",
  name: "尚未选择美容师",
  specialty: "",
  mark: "闲",
  tone: "sage",
};

let availabilityGeneration = 0;
let holdRecovery: HoldRecovery | undefined;

function waitingTimeOptions() {
  return [] as TimeOption[];
}

function availabilityTimeNote(result: AvailabilityResult) {
  if (result.available) return "可预约";
  if (result.reasonCode === "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE") {
    return "无确认处理时段";
  }
  if (result.reasonCode === "CONFIRMATION_TOO_LATE") return "确认时间不足";
  return "暂无空位";
}

function unavailableMessage(result: AvailabilityResult) {
  if (result.available) return "";
  return result.reasonCode === "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE"
    ? NO_CONFIRMATION_WINDOW_MESSAGE
    : result.reason;
}

function serviceOptions(
  services: BookingCatalog["stores"][number]["services"],
) {
  return services.map<ServiceOption>((service, serviceIndex) => ({
    id: service.id,
    name: service.name,
    description: service.durationMinutes + " 分钟门店护理服务",
    durationMinutes: service.durationMinutes,
    priceCents: Number(service.priceCents),
    priceLabel: totalLabel(Number(service.priceCents), 1),
    mark: service.name.slice(0, 1) || "闲",
    tone: tones[serviceIndex % tones.length]!,
    therapists: service.therapists.map((therapist, therapistIndex) => ({
      id: therapist.id,
      name: therapist.name,
      specialty: "可提供当前项目",
      mark: therapist.name.slice(0, 1) || "闲",
      tone: tones[therapistIndex % tones.length]!,
    })),
  }));
}

function savedRecovery() {
  const value = wx.getStorageSync<HoldRecovery>(RECOVERY_STORAGE_KEY);
  if (
    value?.candidateToken &&
    value.idempotencyKey &&
    value.storeId &&
    value.service?.id &&
    value.therapist?.id
  ) {
    return value;
  }
  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof ApiRequestError
    ? error.message
    : "服务暂时无法处理，请稍后重试";
}

Page({
  data: {
    guestCounts: [
      { count: 1, enabled: true },
      { count: 2, enabled: false },
      { count: 3, enabled: false },
      { count: 4, enabled: false },
    ] satisfies GuestCountOption[],
    guestCount: 1,
    storeId: "",
    storeName: "正在读取门店",
    storeTimezone,
    services: [] as ServiceOption[],
    selectedService: emptyService,
    dates: [] as ReturnType<typeof buildDateOptionsForRange>,
    selectedDateKey: "",
    selectedDateLabel: "",
    timeOptions: waitingTimeOptions(),
    selectedTime: "",
    selectedServiceStartAt: "",
    earliestTime: "查询中",
    therapists: [] as TherapistOption[],
    selectedTherapist: emptyTherapist,
    totalLabel: "—",
    summaryExpanded: false,
    loadingCatalog: true,
    availabilityLoading: false,
    availabilityFailed: false,
    submitting: false,
    interactionLocked: false,
    resultUnverified: false,
    identityReloginRequired: false,
    bookingComplete: false,
    bookingEntryClosed: false,
    bookingMessage: "",
    bookingTone: "neutral",
    confirmationDeadline: "",
    primaryActionLabel: "加载预约信息",
    primaryActionDisabled: true,
  },

  onLoad() {
    void this.initialize();
  },

  onShow() {
    if (this.data.interactionLocked) return;
    if (!this.data.loadingCatalog && this.data.storeId) {
      void this.refreshAvailability();
    }
  },

  async initialize() {
    this.setData({ loadingCatalog: true, primaryActionDisabled: true });
    const recovery = savedRecovery();
    if (recovery) {
      holdRecovery = recovery;
      this.setData({
        loadingCatalog: false,
        storeId: recovery.storeId,
        storeName: recovery.storeName,
        storeTimezone: recovery.storeTimezone,
        services: [recovery.service],
        selectedService: recovery.service,
        therapists: recovery.service.therapists,
        selectedTherapist: recovery.therapist,
        selectedDateKey: recovery.selectedDateKey,
        selectedDateLabel: recovery.selectedDateLabel,
        selectedTime: recovery.selectedTime,
        selectedServiceStartAt: recovery.serviceStartAt,
        totalLabel: totalLabel(recovery.service.priceCents, 1),
        timeOptions: [
          {
            serviceStartAt: recovery.serviceStartAt,
            label: recovery.selectedTime,
            available: true,
            note: "待核实",
          },
        ],
        summaryExpanded: true,
        interactionLocked: true,
        resultUnverified: true,
        identityReloginRequired: Boolean(recovery.requiresFreshLogin),
        bookingMessage: recovery.requiresFreshLogin
          ? "请重新登录原账号后核实预约，原预约信息已保留。"
          : "上次预约结果尚未确认，请使用原请求核实，不要重复提交。",
        bookingTone: "warning",
        primaryActionLabel: recovery.requiresFreshLogin
          ? "重新登录原账号并核实"
          : "核实预约结果",
        primaryActionDisabled: false,
      });
      return;
    }
    try {
      const catalog = await getBookingCatalog(app.globalData.apiBaseUrl);
      const store = catalog.stores[0];
      if (!store) {
        this.setData({
          loadingCatalog: false,
          storeName: "暂无可预约门店",
          bookingMessage: "门店尚未开放线上预约，请稍后再来。",
          bookingTone: "warning",
          primaryActionLabel: "暂不可预约",
          primaryActionDisabled: true,
        });
        return;
      }
      const services = serviceOptions(store.services);
      const selectedService = services[0];
      const selectedTherapist = selectedService?.therapists[0];
      if (!selectedService || !selectedTherapist) {
        this.setData({
          loadingCatalog: false,
          storeId: store.id,
          storeName: store.name,
          storeTimezone: store.timezone,
          services,
          bookingMessage: "门店尚未配置可预约的项目和美容师。",
          bookingTone: "warning",
          primaryActionLabel: "暂不可预约",
          primaryActionDisabled: true,
        });
        return;
      }
      this.setData({
        loadingCatalog: false,
        storeId: store.id,
        storeName: store.name,
        storeTimezone: store.timezone,
        services,
        selectedService,
        therapists: selectedService.therapists,
        selectedTherapist,
        totalLabel: totalLabel(selectedService.priceCents, 1),
        primaryActionLabel: "预览预约摘要",
        primaryActionDisabled: true,
      });
      await this.refreshAvailability();
    } catch (error) {
      this.setData({
        loadingCatalog: false,
        storeName: "门店信息加载失败",
        bookingMessage: errorMessage(error),
        bookingTone: "error",
        primaryActionLabel: "重新加载",
        primaryActionDisabled: false,
      });
    }
  },

  openReceptions() {
    wx.navigateTo({ url: "/pages/receptions/index" });
  },

  selectGuestCount(event: WechatMiniprogram.TouchEvent) {
    if (this.data.interactionLocked) return;
    const guestCount = Number(event.currentTarget.dataset.count);
    const option = this.data.guestCounts.find(
      (item) => item.count === guestCount,
    );
    if (!Number.isInteger(guestCount) || !option?.enabled) return;
    this.setData({
      guestCount,
      totalLabel: totalLabel(this.data.selectedService.priceCents, guestCount),
    });
  },

  selectService(event: WechatMiniprogram.TouchEvent) {
    if (this.data.interactionLocked) return;
    const service = this.data.services.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    const therapist = service?.therapists[0];
    if (!service || !therapist) return;
    this.setData({
      selectedService: service,
      therapists: service.therapists,
      selectedTherapist: therapist,
      totalLabel: totalLabel(service.priceCents, this.data.guestCount),
      bookingMessage: "",
    });
    void this.refreshAvailability();
  },

  selectDate(event: WechatMiniprogram.TouchEvent) {
    if (this.data.interactionLocked) return;
    const selectedDateKey = String(event.currentTarget.dataset.key ?? "");
    const selectedDate = this.data.dates.find(
      (item) => item.key === selectedDateKey,
    );
    if (!selectedDate) return;
    this.setData({
      selectedDateKey,
      selectedDateLabel: selectedDate.summaryLabel,
      bookingMessage: "",
    });
    void this.refreshAvailability();
  },

  selectTime(event: WechatMiniprogram.TouchEvent) {
    if (this.data.interactionLocked) return;
    const serviceStartAt = String(event.currentTarget.dataset.start ?? "");
    const option = this.data.timeOptions.find(
      (item) => item.serviceStartAt === serviceStartAt,
    );
    if (option?.available) {
      this.setData({
        selectedTime: option.label,
        selectedServiceStartAt: option.serviceStartAt,
        bookingMessage: "",
      });
    }
  },

  selectTherapist(event: WechatMiniprogram.TouchEvent) {
    if (this.data.interactionLocked) return;
    const therapist = this.data.therapists.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (!therapist) return;
    this.setData({ selectedTherapist: therapist, bookingMessage: "" });
    void this.refreshAvailability();
  },

  async refreshAvailability() {
    if (
      !this.data.storeId ||
      !this.data.selectedService.id ||
      !this.data.selectedTherapist.id ||
      this.data.interactionLocked
    ) {
      return;
    }
    const generation = ++availabilityGeneration;
    this.setData({
      availabilityLoading: true,
      availabilityFailed: false,
      timeOptions: waitingTimeOptions(),
      selectedTime: "",
      selectedServiceStartAt: "",
      earliestTime: "查询中",
      primaryActionLabel: "正在查询可约时间",
      primaryActionDisabled: true,
    });
    try {
      const requestedDate =
        this.data.selectedDateKey || new Date().toISOString().slice(0, 10);
      let policyOptions = await getBookingStartOptions(
        app.globalData.apiBaseUrl,
        this.data.storeId,
        requestedDate,
        this.data.selectedService.id,
      );
      if (generation !== availabilityGeneration) return;
      if (!policyOptions.dateRange) {
        this.setData({
          availabilityLoading: false,
          bookingEntryClosed: true,
          dates: [],
          selectedDateKey: "",
          selectedDateLabel: "",
          timeOptions: [],
          earliestTime: "暂未开放",
          bookingMessage: "门店暂未开放在线预约，请稍后再来。",
          bookingTone: "warning",
          primaryActionLabel: "暂不可预约",
          primaryActionDisabled: true,
        });
        return;
      }
      const dates = buildDateOptionsForRange(
        policyOptions.dateRange.firstDate,
        policyOptions.dateRange.lastDate,
      );
      const selectedDate =
        dates.find((item) => item.key === requestedDate) ?? dates[0];
      if (!selectedDate) throw new Error("门店未返回可选择的预约日期");
      if (selectedDate.key !== requestedDate) {
        policyOptions = await getBookingStartOptions(
          app.globalData.apiBaseUrl,
          this.data.storeId,
          selectedDate.key,
          this.data.selectedService.id,
        );
        if (generation !== availabilityGeneration) return;
      }
      this.setData({
        bookingEntryClosed: false,
        dates,
        selectedDateKey: selectedDate.key,
        selectedDateLabel: selectedDate.summaryLabel,
        storeTimezone: policyOptions.timeZone,
      });
      const results = await Promise.all(
        policyOptions.starts.map(async (start) => {
          try {
            const result = await queryAvailability(app.globalData.apiBaseUrl, {
              storeId: this.data.storeId,
              clientGuestId: CLIENT_GUEST_ID,
              serviceItemId: this.data.selectedService.id,
              therapistResourceId: this.data.selectedTherapist.id,
              serviceStartAt: start.serviceStartAt,
            });
            return { start, result };
          } catch (error) {
            return { start, error };
          }
        }),
      );
      if (generation !== availabilityGeneration) return;
      const options = results.map<TimeOption>((item) => {
        const available = "result" in item && item.result?.available === true;
        return {
          serviceStartAt: item.start.serviceStartAt,
          label: item.start.localTime,
          available,
          note: item.result ? availabilityTimeNote(item.result) : "查询失败",
        };
      });
      const firstAvailable = options.find((item) => item.available);
      const noConfirmationWindow = results.find(
        (item) =>
          item.result?.available === false &&
          item.result.reasonCode === "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE",
      )?.result;
      const firstError = results.find(
        (
          item,
        ): item is {
          start: (typeof policyOptions.starts)[number];
          error: unknown;
        } => "error" in item,
      );
      const availabilityFailed = Boolean(firstError && !firstAvailable);
      this.setData({
        availabilityLoading: false,
        availabilityFailed,
        timeOptions: options,
        selectedTime: firstAvailable?.label ?? "",
        selectedServiceStartAt: firstAvailable?.serviceStartAt ?? "",
        earliestTime: firstAvailable?.label ?? "暂无",
        bookingMessage:
          firstError && !firstAvailable
            ? errorMessage(firstError.error)
            : firstAvailable
              ? ""
              : policyOptions.queriedDate.status === "closed"
                ? "门店当天闭店，请选择其他日期。"
                : noConfirmationWindow
                  ? unavailableMessage(noConfirmationWindow)
                  : "当天没有匹配的可约时间，请换个日期或美容师。",
        bookingTone: firstError && !firstAvailable ? "error" : "warning",
        primaryActionLabel: availabilityFailed
          ? "重新查询可约时间"
          : firstAvailable
            ? this.data.summaryExpanded
              ? "提交预约"
              : "预览预约摘要"
            : "当前暂无可约时间",
        primaryActionDisabled: !firstAvailable && !availabilityFailed,
      });
    } catch (error) {
      if (generation !== availabilityGeneration) return;
      this.setData({
        availabilityLoading: false,
        availabilityFailed: true,
        timeOptions: [],
        earliestTime: "读取失败",
        bookingMessage: errorMessage(error),
        bookingTone: "error",
        primaryActionLabel: "重新查询可约时间",
        primaryActionDisabled: false,
      });
    }
  },

  showBookingSummary() {
    if (!this.data.selectedTime || this.data.interactionLocked) return;
    this.setData({
      summaryExpanded: true,
      primaryActionLabel: "提交预约",
    });
  },

  hideBookingSummary() {
    if (this.data.interactionLocked) return;
    this.setData({
      summaryExpanded: false,
      primaryActionLabel: this.data.selectedTime
        ? "预览预约摘要"
        : "当前暂无可约时间",
    });
  },

  async handlePrimaryAction() {
    if (this.data.primaryActionDisabled) return;
    if (!this.data.storeId && !this.data.submitting) {
      await this.initialize();
      return;
    }
    if (this.data.submitting || this.data.bookingComplete) return;
    if (this.data.resultUnverified) {
      await this.retryHold();
      return;
    }
    if (this.data.availabilityFailed) {
      await this.refreshAvailability();
      return;
    }
    if (!this.data.summaryExpanded) {
      this.showBookingSummary();
      return;
    }
    await this.submitBooking();
  },

  async submitBooking() {
    if (
      !this.data.storeId ||
      !this.data.selectedService.id ||
      !this.data.selectedTherapist.id ||
      !this.data.selectedServiceStartAt
    ) {
      return;
    }
    this.setData({
      submitting: true,
      interactionLocked: true,
      bookingMessage: "正在重新检查资源并提交预约…",
      bookingTone: "neutral",
      primaryActionLabel: "正在提交",
      primaryActionDisabled: true,
    });
    try {
      const availability = await queryAvailability(app.globalData.apiBaseUrl, {
        storeId: this.data.storeId,
        clientGuestId: CLIENT_GUEST_ID,
        serviceItemId: this.data.selectedService.id,
        therapistResourceId: this.data.selectedTherapist.id,
        serviceStartAt: this.data.selectedServiceStartAt,
      });
      if (!availability.available) {
        this.setData({
          submitting: false,
          interactionLocked: false,
          bookingMessage: unavailableMessage(availability),
          bookingTone: "warning",
          primaryActionLabel: "重新查询",
          primaryActionDisabled: true,
        });
        await this.refreshAvailability();
        return;
      }
      const refreshedAssignment = availability.assignments[0];
      const refreshedPriceCents = Number(availability.quoteCents);
      const refreshedDurationMinutes = refreshedAssignment?.durationMinutes;
      if (
        !Number.isSafeInteger(refreshedPriceCents) ||
        !Number.isInteger(refreshedDurationMinutes)
      ) {
        throw new Error("服务端返回的预约报价不完整");
      }
      if (
        refreshedPriceCents !== this.data.selectedService.priceCents ||
        refreshedDurationMinutes !== this.data.selectedService.durationMinutes
      ) {
        const selectedService = {
          ...this.data.selectedService,
          durationMinutes: refreshedDurationMinutes,
          priceCents: refreshedPriceCents,
          priceLabel: totalLabel(refreshedPriceCents, 1),
          description: `${refreshedDurationMinutes} 分钟门店护理服务`,
        };
        this.setData({
          submitting: false,
          interactionLocked: false,
          selectedService,
          services: this.data.services.map((service) =>
            service.id === selectedService.id ? selectedService : service,
          ),
          totalLabel: totalLabel(refreshedPriceCents, this.data.guestCount),
          bookingMessage:
            "项目价格或时长已有更新，请核对预约摘要后再次点击提交。",
          bookingTone: "warning",
          primaryActionLabel: "确认新信息并提交",
          primaryActionDisabled: false,
        });
        return;
      }
      holdRecovery = {
        candidateToken: availability.candidateToken,
        idempotencyKey: bookingIdempotencyKey(),
        storeId: this.data.storeId,
        storeName: this.data.storeName,
        storeTimezone: this.data.storeTimezone,
        service: this.data.selectedService,
        therapist: this.data.selectedTherapist,
        selectedDateKey: this.data.selectedDateKey,
        selectedDateLabel: this.data.selectedDateLabel,
        selectedTime: this.data.selectedTime,
        serviceStartAt: this.data.selectedServiceStartAt,
      };
      wx.setStorageSync(RECOVERY_STORAGE_KEY, holdRecovery);
      await this.sendHoldRequest();
    } catch (error) {
      this.setData({
        submitting: false,
        interactionLocked: false,
        bookingMessage: errorMessage(error),
        bookingTone: "error",
        primaryActionLabel: "重新提交",
        primaryActionDisabled: false,
      });
    }
  },

  async retryHold() {
    if (!holdRecovery) return;
    const forceLogin = this.data.identityReloginRequired;
    this.setData({
      submitting: true,
      interactionLocked: true,
      bookingMessage: forceLogin
        ? "正在重新登录并使用原请求核实预约结果…"
        : "正在使用原请求核实预约结果…",
      bookingTone: "neutral",
      primaryActionLabel: "正在核实",
      primaryActionDisabled: true,
    });
    await this.sendHoldRequest(forceLogin);
  },

  async sendHoldRequest(forceLogin = false) {
    if (!holdRecovery) return;
    try {
      if (forceLogin) {
        await ensureCustomerSession(app.globalData.apiBaseUrl, true);
        holdRecovery = { ...holdRecovery, requiresFreshLogin: false };
        wx.setStorageSync(RECOVERY_STORAGE_KEY, holdRecovery);
        this.setData({ identityReloginRequired: false });
      }
      const result = await createHoldReception(
        app.globalData.apiBaseUrl,
        holdRecovery.candidateToken,
        holdRecovery.idempotencyKey,
      );
      this.finishBooking(result);
    } catch (error) {
      const apiError =
        error instanceof ApiRequestError
          ? error
          : new ApiRequestError(0, "NETWORK_ERROR", errorMessage(error));
      if (shouldKeepHoldRecovery(apiError.statusCode, apiError.code)) {
        const identityChanged =
          apiError.statusCode === 401 ||
          apiError.code === "CANDIDATE_OWNER_MISMATCH";
        if (identityChanged && holdRecovery) {
          holdRecovery = { ...holdRecovery, requiresFreshLogin: true };
          wx.setStorageSync(RECOVERY_STORAGE_KEY, holdRecovery);
        }
        const identityReloginRequired =
          identityChanged || this.data.identityReloginRequired;
        this.setData({
          submitting: false,
          interactionLocked: true,
          resultUnverified: true,
          identityReloginRequired,
          bookingMessage: identityChanged
            ? "当前登录账号无法核实原预约。请切回原账号后再次核实，原预约信息已保留。"
            : "预约结果暂未获取。请保持当前信息，点击下方按钮使用原请求核实。",
          bookingTone: "warning",
          primaryActionLabel: identityReloginRequired
            ? "重新登录原账号并核实"
            : "核实预约结果",
          primaryActionDisabled: false,
        });
        return;
      }
      holdRecovery = undefined;
      wx.removeStorageSync(RECOVERY_STORAGE_KEY);
      this.setData({
        submitting: false,
        interactionLocked: false,
        resultUnverified: false,
        identityReloginRequired: false,
        bookingMessage: apiError.message,
        bookingTone: "error",
        primaryActionLabel: "重新查询并提交",
        primaryActionDisabled: false,
      });
      await this.refreshAvailability();
    }
  },

  finishBooking(result: HoldReceptionResult) {
    holdRecovery = undefined;
    wx.removeStorageSync(RECOVERY_STORAGE_KEY);
    this.setData({
      submitting: false,
      interactionLocked: true,
      resultUnverified: false,
      identityReloginRequired: false,
      bookingComplete: true,
      totalLabel: totalLabel(Number(result.quoteCents), 1),
      confirmationDeadline: confirmationDeadlineLabel(
        result.confirmationDeadline,
        this.data.storeTimezone,
      ),
      bookingMessage:
        "预约已提交，门店将在确认截止时间前处理，请留意后续状态。",
      bookingTone: "success",
      primaryActionLabel: "已提交，等待门店确认",
      primaryActionDisabled: true,
    });
  },
});
