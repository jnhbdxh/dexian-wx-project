import {
  ApiRequestError,
  currentCustomerId,
  listCustomerReceptions,
  shouldClearCustomerData,
  type CustomerReceptionSummary,
} from "../../lib/api";
import {
  receptionDateTimeLabel,
  receptionMoneyLabel,
  receptionStatus,
} from "../../lib/reception-ui";

const app = getApp<{ globalData: { apiBaseUrl: string } }>();
let latestRefreshRequest = 0;
let latestPaginationRequest = 0;

function errorMessage(error: unknown) {
  return error instanceof ApiRequestError
    ? error.message
    : "预约记录暂时无法加载，请稍后重试";
}

function staleErrorMessage(error: unknown) {
  return `未能刷新最新状态，当前仍显示上次结果。${errorMessage(error)}`;
}

function accessErrorMessage(error: unknown) {
  if (error instanceof ApiRequestError && error.statusCode === 404) {
    return "当前账号无法查看这些预约，记录可能不存在或账号已变化";
  }
  return "当前登录已失效或无权查看，请重新加载";
}

function toListItem(item: CustomerReceptionSummary) {
  const status = receptionStatus(item.state, item.statusReason);
  return {
    ...item,
    statusLabel: status.label,
    statusTone: status.tone,
    dateTimeLabel: receptionDateTimeLabel(
      item.serviceStartAt,
      item.storeTimezone,
    ),
    amountLabel: receptionMoneyLabel(item.quoteCents),
  };
}

Page({
  data: {
    loading: true,
    loadingMore: false,
    items: [] as ReturnType<typeof toListItem>[],
    nextCursor: null as string | null,
    customerId: "",
    errorMessage: "",
  },

  onShow() {
    void this.loadReceptions();
  },

  onPullDownRefresh() {
    void this.loadReceptions().finally(() => wx.stopPullDownRefresh());
  },

  onUnload() {
    latestRefreshRequest += 1;
    latestPaginationRequest += 1;
  },

  async loadReceptions() {
    const requestId = ++latestRefreshRequest;
    latestPaginationRequest += 1;
    const identityChanged =
      Boolean(this.data.customerId) &&
      this.data.customerId !== currentCustomerId();
    this.setData({
      loading: true,
      loadingMore: false,
      errorMessage: "",
      ...(identityChanged
        ? { items: [], nextCursor: null, customerId: "" }
        : {}),
    });
    try {
      const result = await listCustomerReceptions(app.globalData.apiBaseUrl);
      if (requestId !== latestRefreshRequest) return;
      if (result.customerId !== currentCustomerId()) {
        this.setData({
          items: [],
          nextCursor: null,
          customerId: "",
          errorMessage: "微信账号已变化，请重新加载当前账号的预约",
        });
        return;
      }
      this.setData({
        items: result.items.map(toListItem),
        nextCursor: result.nextCursor,
        customerId: result.customerId,
      });
    } catch (error) {
      if (requestId !== latestRefreshRequest) return;
      const accountChanged =
        identityChanged ||
        (Boolean(this.data.customerId) &&
          this.data.customerId !== currentCustomerId());
      if (accountChanged || shouldClearCustomerData(error)) {
        this.setData({
          items: [],
          nextCursor: null,
          customerId: "",
          errorMessage: accountChanged
            ? "微信账号已变化，请重新加载当前账号的预约"
            : accessErrorMessage(error),
        });
      } else {
        this.setData({
          errorMessage: this.data.items.length
            ? staleErrorMessage(error)
            : errorMessage(error),
        });
      }
    } finally {
      if (requestId === latestRefreshRequest) {
        this.setData({ loading: false });
      }
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore) return;
    const cursor = this.data.nextCursor;
    if (!cursor) return;
    if (this.data.customerId !== currentCustomerId()) {
      this.setData({ items: [], nextCursor: null, customerId: "" });
      return this.loadReceptions();
    }
    const refreshRequestId = latestRefreshRequest;
    const requestId = ++latestPaginationRequest;
    this.setData({ loadingMore: true, errorMessage: "" });
    try {
      const result = await listCustomerReceptions(
        app.globalData.apiBaseUrl,
        cursor,
      );
      if (
        refreshRequestId !== latestRefreshRequest ||
        requestId !== latestPaginationRequest
      ) {
        return;
      }
      if (
        result.customerId !== currentCustomerId() ||
        result.customerId !== this.data.customerId
      ) {
        this.setData({ items: [], nextCursor: null, customerId: "" });
        return this.loadReceptions();
      }
      const known = new Set(this.data.items.map((item) => item.receptionId));
      this.setData({
        items: [
          ...this.data.items,
          ...result.items
            .filter((item) => !known.has(item.receptionId))
            .map(toListItem),
        ],
        nextCursor: result.nextCursor,
        customerId: result.customerId,
      });
    } catch (error) {
      if (
        refreshRequestId !== latestRefreshRequest ||
        requestId !== latestPaginationRequest
      ) {
        return;
      }
      const accountChanged =
        Boolean(this.data.customerId) &&
        this.data.customerId !== currentCustomerId();
      if (accountChanged) {
        this.setData({ items: [], nextCursor: null, customerId: "" });
        return this.loadReceptions();
      }
      if (shouldClearCustomerData(error)) {
        this.setData({
          items: [],
          nextCursor: null,
          customerId: "",
          errorMessage: accessErrorMessage(error),
        });
      } else {
        this.setData({ errorMessage: staleErrorMessage(error) });
      }
    } finally {
      if (
        refreshRequestId === latestRefreshRequest &&
        requestId === latestPaginationRequest
      ) {
        this.setData({ loadingMore: false });
      }
    }
  },

  openReception(event: WechatMiniprogram.BaseEvent) {
    const receptionId = String(event.currentTarget.dataset.id ?? "");
    if (!receptionId) return;
    wx.navigateTo({
      url: `/pages/reception-detail/index?id=${encodeURIComponent(receptionId)}`,
    });
  },

  createBooking() {
    wx.navigateBack({
      fail() {
        wx.redirectTo({ url: "/pages/index/index" });
      },
    });
  },
});
