export interface CustomerSession {
  accessToken: string;
  customerId: string;
  expiresAt: string;
}

export interface BookingCatalog {
  stores: Array<{
    id: string;
    name: string;
    timezone: string;
    services: Array<{
      id: string;
      name: string;
      durationMinutes: number;
      priceCents: string;
      therapists: Array<{ id: string; name: string }>;
    }>;
  }>;
}

export interface BookingStartOptions {
  serverNow: string;
  timeZone: string;
  policyVersion: number | null;
  dateRange: {
    firstDate: string;
    lastDate: string;
    maxAdvanceDays: number;
    minimumLeadMinutes: number;
  } | null;
  queriedDate: {
    serviceDate: string;
    status: "open" | "closed" | "outside_range" | "policy_unpublished";
    reasonCode?: string;
  };
  service: {
    serviceItemId: string;
    durationMinutes: number;
    serviceConfigVersion: number;
  } | null;
  starts: Array<{ serviceStartAt: string; localTime: string }>;
}

export type AvailabilityResult =
  | {
      available: false;
      reasonCode:
        | "RESOURCE_UNAVAILABLE"
        | "CONFIRMATION_TOO_LATE"
        | "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE";
      reason: string;
    }
  | {
      available: true;
      candidateToken: string;
      expiresAt: string;
      quoteCents: string;
      assignments: Array<{
        clientGuestId: string;
        serviceItemId: string;
        therapistResourceId: string;
        serviceStartAt: string;
        serviceEndAt: string;
        durationMinutes: number;
        quoteCents: string;
      }>;
    };

export interface HoldReceptionResult {
  receptionId: string;
  state: "pending";
  confirmationDeadline: string;
  quoteCents: string;
}

export type CustomerReceptionState =
  "pending" | "confirmed" | "expired" | "invalidated";

export type CustomerReceptionReason =
  "confirmation_timeout" | "therapist_leave" | "resource_unavailable" | null;

export interface CustomerReceptionSummary {
  receptionId: string;
  storeId: string;
  storeName: string;
  storeTimezone: string;
  state: CustomerReceptionState;
  statusReason: CustomerReceptionReason;
  confirmationDeadline: string | null;
  quoteCents: string;
  version: number;
  guestCount: number;
  serviceItemName: string;
  therapistName: string;
  serviceStartAt: string;
  serviceEndAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerReceptionList {
  customerId: string;
  serverNow: string;
  items: CustomerReceptionSummary[];
  nextCursor: string | null;
}

export interface CustomerReceptionDetail extends CustomerReceptionSummary {
  customerId: string;
  serverNow: string;
  guests: Array<{
    id: string;
    clientGuestId: string;
    serviceItemName: string;
    therapistName: string;
    serviceStartAt: string;
    serviceEndAt: string;
    durationMinutes: number;
    quoteCents: string;
  }>;
}

interface ErrorBody {
  code?: string;
  message?: string;
}

export class ApiRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const SESSION_STORAGE_KEY = "dexian_customer_session";
const DEV_EXTERNAL_ID_KEY = "dexian_dev_external_id";
let loginPromise: Promise<CustomerSession> | undefined;

function request<T>(
  apiBaseUrl: string,
  path: string,
  options: {
    method?: "GET" | "POST";
    data?: WechatMiniprogram.IAnyObject;
    headers?: Record<string, string>;
  } = {},
) {
  return new Promise<T>((resolve, reject) => {
    wx.request({
      url: `${apiBaseUrl}${path}`,
      method: options.method ?? "GET",
      data: options.data,
      header: options.headers,
      timeout: 15_000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data as T);
          return;
        }
        const body = response.data as ErrorBody;
        reject(
          new ApiRequestError(
            response.statusCode,
            body.code ?? "REQUEST_FAILED",
            body.message ?? "服务暂时无法处理，请稍后重试",
          ),
        );
      },
      fail() {
        reject(
          new ApiRequestError(
            0,
            "NETWORK_ERROR",
            "网络连接失败，请检查网络后重试",
          ),
        );
      },
    });
  });
}

function loadStoredSession() {
  const session = wx.getStorageSync<CustomerSession>(SESSION_STORAGE_KEY);
  if (
    session?.accessToken &&
    Date.parse(session.expiresAt) > Date.now() + 60_000
  ) {
    return session;
  }
  return undefined;
}

export function currentCustomerId() {
  return loadStoredSession()?.customerId;
}

export function shouldClearCustomerData(error: unknown) {
  return (
    error instanceof ApiRequestError &&
    (error.statusCode === 401 ||
      error.statusCode === 403 ||
      error.statusCode === 404)
  );
}

function wechatCode() {
  return new Promise<string>((resolve, reject) => {
    wx.login({
      success(result) {
        if (result.code) {
          resolve(result.code);
          return;
        }
        reject(
          new ApiRequestError(0, "WECHAT_LOGIN_FAILED", "微信登录失败，请重试"),
        );
      },
      fail() {
        reject(
          new ApiRequestError(0, "WECHAT_LOGIN_FAILED", "微信登录失败，请重试"),
        );
      },
    });
  });
}

function isTouristApp() {
  try {
    return wx.getAccountInfoSync().miniProgram.appId === "touristappid";
  } catch {
    return false;
  }
}

function developmentExternalId() {
  const existing = wx.getStorageSync<string>(DEV_EXTERNAL_ID_KEY);
  if (existing) return existing;
  const created = `wxdev_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  wx.setStorageSync(DEV_EXTERNAL_ID_KEY, created);
  return created;
}

async function login(apiBaseUrl: string) {
  const code = await wechatCode();
  try {
    return await request<CustomerSession>(
      apiBaseUrl,
      "/api/v1/customer/auth/wechat-login",
      { method: "POST", data: { code } },
    );
  } catch (error) {
    if (
      !(error instanceof ApiRequestError) ||
      error.code !== "WECHAT_LOGIN_NOT_CONFIGURED" ||
      !isTouristApp()
    ) {
      throw error;
    }
    return request<CustomerSession>(
      apiBaseUrl,
      "/api/v1/customer/auth/dev-login",
      {
        method: "POST",
        data: { externalId: developmentExternalId() },
      },
    );
  }
}

export function clearCustomerSession() {
  wx.removeStorageSync(SESSION_STORAGE_KEY);
}

export async function ensureCustomerSession(apiBaseUrl: string, force = false) {
  if (force) clearCustomerSession();
  const stored = loadStoredSession();
  if (stored) return stored;
  loginPromise ??= login(apiBaseUrl).then((session) => {
    wx.setStorageSync(SESSION_STORAGE_KEY, session);
    return session;
  });
  try {
    return await loginPromise;
  } finally {
    loginPromise = undefined;
  }
}

async function authorizedRequestWithIdentity<T>(
  apiBaseUrl: string,
  path: string,
  options: {
    method: "GET" | "POST";
    data?: WechatMiniprogram.IAnyObject;
    headers?: Record<string, string>;
  },
) {
  let session = await ensureCustomerSession(apiBaseUrl);
  try {
    const data = await request<T>(apiBaseUrl, path, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
    return { customerId: session.customerId, data };
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.statusCode !== 401) {
      throw error;
    }
    session = await ensureCustomerSession(apiBaseUrl, true);
    const data = await request<T>(apiBaseUrl, path, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
    return { customerId: session.customerId, data };
  }
}

async function authorizedRequest<T>(
  apiBaseUrl: string,
  path: string,
  options: {
    method: "GET" | "POST";
    data?: WechatMiniprogram.IAnyObject;
    headers?: Record<string, string>;
  },
) {
  return (await authorizedRequestWithIdentity<T>(apiBaseUrl, path, options))
    .data;
}

export function getBookingCatalog(apiBaseUrl: string) {
  return request<BookingCatalog>(apiBaseUrl, "/api/v1/booking/catalog");
}

export function getBookingStartOptions(
  apiBaseUrl: string,
  storeId: string,
  serviceDate: string,
  serviceItemId?: string,
) {
  const query = `storeId=${encodeURIComponent(storeId)}&serviceDate=${encodeURIComponent(serviceDate)}${
    serviceItemId ? `&serviceItemId=${encodeURIComponent(serviceItemId)}` : ""
  }`;
  return request<BookingStartOptions>(
    apiBaseUrl,
    `/api/v1/booking/start-options?${query}`,
  );
}

export function queryAvailability(
  apiBaseUrl: string,
  input: {
    storeId: string;
    clientGuestId: string;
    serviceItemId: string;
    therapistResourceId: string;
    serviceStartAt: string;
  },
) {
  return authorizedRequest<AvailabilityResult>(
    apiBaseUrl,
    "/api/v1/availability/queries",
    {
      method: "POST",
      data: {
        storeId: input.storeId,
        assignments: [
          {
            clientGuestId: input.clientGuestId,
            serviceItemId: input.serviceItemId,
            therapistResourceId: input.therapistResourceId,
            serviceStartAt: input.serviceStartAt,
          },
        ],
      },
    },
  );
}

export function createHoldReception(
  apiBaseUrl: string,
  candidateToken: string,
  idempotencyKey: string,
) {
  return authorizedRequest<HoldReceptionResult>(
    apiBaseUrl,
    "/api/v1/receptions",
    {
      method: "POST",
      data: { candidateToken },
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
}

export function listCustomerReceptions(apiBaseUrl: string, after?: string) {
  const query = after ? `?after=${encodeURIComponent(after)}` : "";
  return authorizedRequestWithIdentity<
    Omit<CustomerReceptionList, "customerId">
  >(apiBaseUrl, `/api/v1/receptions${query}`, { method: "GET" }).then(
    ({ customerId, data }) => ({ customerId, ...data }),
  );
}

export function getCustomerReception(apiBaseUrl: string, receptionId: string) {
  return authorizedRequestWithIdentity<
    Omit<CustomerReceptionDetail, "customerId">
  >(apiBaseUrl, `/api/v1/receptions/${encodeURIComponent(receptionId)}`, {
    method: "GET",
  }).then(({ customerId, data }) => ({ customerId, ...data }));
}
