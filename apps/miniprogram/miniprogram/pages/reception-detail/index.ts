import {
  ApiRequestError,
  currentCustomerId,
  getCustomerReception,
  shouldClearCustomerData,
  type CustomerReceptionDetail,
} from "../../lib/api";
import {
  receptionDateTimeLabel,
  receptionMoneyLabel,
  receptionStatus,
  receptionTimeLabel,
} from "../../lib/reception-ui";

const app = getApp<{ globalData: { apiBaseUrl: string } }>();
let latestDetailRequest = 0;

function errorMessage(error: unknown) {
  return error instanceof ApiRequestError
    ? error.message
    : "预约详情暂时无法加载，请稍后重试";
}

function staleErrorMessage(error: unknown) {
  return `未能刷新最新状态，当前仍显示上次结果。${errorMessage(error)}`;
}

function accessErrorMessage(error: unknown) {
  if (error instanceof ApiRequestError && error.statusCode === 404) {
    return "当前账号无法查看此预约，记录可能不存在或账号已变化";
  }
  return "当前登录已失效或无权查看，请返回预约列表重试";
}

function toDetailView(detail: CustomerReceptionDetail) {
  const status = receptionStatus(detail.state, detail.statusReason);
  return {
    ...detail,
    statusLabel: status.label,
    statusTone: status.tone,
    statusTitle: status.title,
    statusMessage: status.message,
    dateTimeLabel: receptionDateTimeLabel(
      detail.serviceStartAt,
      detail.storeTimezone,
    ),
    deadlineLabel: detail.confirmationDeadline
      ? receptionDateTimeLabel(
          detail.confirmationDeadline,
          detail.storeTimezone,
        )
      : "",
    amountLabel: receptionMoneyLabel(detail.quoteCents),
    referenceLabel: detail.receptionId.slice(-8),
    canRebook: detail.state === "expired" || detail.state === "invalidated",
    guests: detail.guests.map((guest) => ({
      ...guest,
      timeLabel: `${receptionTimeLabel(guest.serviceStartAt, detail.storeTimezone)}–${receptionTimeLabel(guest.serviceEndAt, detail.storeTimezone)}`,
      amountLabel: receptionMoneyLabel(guest.quoteCents),
    })),
  };
}

Page({
  data: {
    receptionId: "",
    loading: true,
    detail: null as ReturnType<typeof toDetailView> | null,
    customerId: "",
    errorMessage: "",
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ receptionId: query.id ?? "" });
  },

  onShow() {
    if (this.data.receptionId) void this.loadDetail();
  },

  onPullDownRefresh() {
    void this.loadDetail().finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    latestDetailRequest += 1;
  },

  async loadDetail() {
    if (!this.data.receptionId) {
      this.setData({
        loading: false,
        errorMessage: "预约编号缺失，请返回列表重新进入",
      });
      return;
    }
    const requestId = ++latestDetailRequest;
    const identityChanged =
      Boolean(this.data.customerId) &&
      this.data.customerId !== currentCustomerId();
    this.setData({
      loading: true,
      errorMessage: "",
      ...(identityChanged ? { detail: null, customerId: "" } : {}),
    });
    try {
      const detail = await getCustomerReception(
        app.globalData.apiBaseUrl,
        this.data.receptionId,
      );
      if (requestId !== latestDetailRequest) return;
      if (detail.customerId !== currentCustomerId()) {
        this.setData({
          detail: null,
          customerId: "",
          errorMessage: "微信账号已变化，请返回预约列表重新进入",
        });
        return;
      }
      this.setData({
        detail: toDetailView(detail),
        customerId: detail.customerId,
      });
    } catch (error) {
      if (requestId !== latestDetailRequest) return;
      const accountChanged =
        identityChanged ||
        (Boolean(this.data.customerId) &&
          this.data.customerId !== currentCustomerId());
      if (accountChanged || shouldClearCustomerData(error)) {
        this.setData({
          detail: null,
          customerId: "",
          errorMessage: accountChanged
            ? "微信账号已变化，请返回预约列表重新进入"
            : accessErrorMessage(error),
        });
      } else {
        this.setData({
          errorMessage: this.data.detail
            ? staleErrorMessage(error)
            : errorMessage(error),
        });
      }
    } finally {
      if (requestId === latestDetailRequest) {
        this.setData({ loading: false });
      }
    }
  },

  createBooking() {
    wx.reLaunch({ url: "/pages/index/index" });
  },
});
