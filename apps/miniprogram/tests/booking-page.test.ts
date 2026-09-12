import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SESSION_KEY = "dexian_customer_session";
const RECOVERY_KEY = "dexian_booking_hold_recovery";

test("uses import specifiers supported by the WeChat runtime", async () => {
  const source = await readFile(
    new URL("../miniprogram/pages/index/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["']\.\.?\/[^"']+\.ts["']/);
});

test("keeps locked booking details readable in the native runtime", async () => {
  const [template, styles] = await Promise.all([
    readFile(
      new URL("../miniprogram/pages/index/index.wxml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../miniprogram/pages/index/index.wxss", import.meta.url),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(template, /(^|\s)disabled="\{\{interactionLocked\}\}"/m);
  assert.match(template, /continue-button \{\{primaryActionDisabled/);
  assert.doesNotMatch(
    template,
    /(^|\s)disabled="\{\{primaryActionDisabled\}\}"/m,
  );
  assert.match(styles, /\.continue-button\.is-disabled/);
});

const catalog = {
  stores: [
    {
      id: "store-id",
      name: "金宝店",
      timezone: "Asia/Shanghai",
      services: [
        {
          id: "service-id",
          name: "舒缓放松",
          durationMinutes: 60,
          priceCents: "10000",
          therapists: [{ id: "therapist-id", name: "夏天" }],
        },
      ],
    },
  ],
};

const session = {
  accessToken: "customer-token",
  customerId: "customer-id",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function available(quoteCents = "10000", durationMinutes = 60) {
  return {
    available: true,
    candidateToken: "opaque-candidate",
    expiresAt: "2099-01-01T00:00:00.000Z",
    quoteCents,
    assignments: [
      {
        clientGuestId: "self",
        serviceItemId: "service-id",
        therapistResourceId: "therapist-id",
        serviceStartAt: "2026-09-12T03:00:00.000Z",
        serviceEndAt: "2026-09-12T04:00:00.000Z",
        durationMinutes,
        quoteCents,
      },
    ],
  };
}

function startOptions() {
  return {
    serverNow: "2026-09-12T02:00:00.000Z",
    timeZone: "Asia/Shanghai",
    policyVersion: 1,
    dateRange: {
      firstDate: "2026-09-12",
      lastDate: "2026-09-18",
      maxAdvanceDays: 6,
      minimumLeadMinutes: 60,
    },
    queriedDate: { serviceDate: "2026-09-12", status: "open" },
    service: {
      serviceItemId: "service-id",
      durationMinutes: 60,
      serviceConfigVersion: 1,
    },
    starts: ["11:00", "13:30", "14:30", "16:00", "18:30"].map(
      (localTime, index) => ({
        localTime,
        serviceStartAt: new Date(
          Date.parse("2026-09-12T03:00:00.000Z") + index * 60 * 60_000,
        ).toISOString(),
      }),
    ),
  };
}

function recovery(selectedDateKey = "2026-9-12") {
  return {
    candidateToken: "opaque-candidate",
    idempotencyKey: "booking-original-key",
    storeId: "store-id",
    storeName: "金宝店",
    storeTimezone: "Asia/Shanghai",
    service: {
      id: "service-id",
      name: "舒缓放松",
      description: "60 分钟门店护理服务",
      durationMinutes: 60,
      priceCents: 10_000,
      priceLabel: "¥100",
      mark: "舒",
      tone: "sage",
      therapists: [
        {
          id: "therapist-id",
          name: "夏天",
          specialty: "可提供当前项目",
          mark: "夏",
          tone: "sage",
        },
      ],
    },
    therapist: {
      id: "therapist-id",
      name: "夏天",
      specialty: "可提供当前项目",
      mark: "夏",
      tone: "sage",
    },
    selectedDateKey,
    selectedDateLabel: "9月12日 周六",
    selectedTime: "14:30",
    serviceStartAt: "2026-09-12T06:30:00.000Z",
  };
}

function wxMock(
  responder: (options: Record<string, unknown>) => void,
  storedRecovery?: ReturnType<typeof recovery>,
) {
  const storage = new Map<string, unknown>([[SESSION_KEY, session]]);
  if (storedRecovery) storage.set(RECOVERY_KEY, storedRecovery);
  return {
    storage,
    api: {
      getStorageSync(key: string) {
        return storage.get(key);
      },
      setStorageSync(key: string, value: unknown) {
        storage.set(key, value);
      },
      removeStorageSync(key: string) {
        storage.delete(key);
      },
      request: responder,
    },
  };
}

async function loadPage(tag: string, wxApi: Record<string, unknown>) {
  let definition: Record<string, unknown> | undefined;
  Object.assign(globalThis, {
    wx: wxApi,
    getApp: () => ({ globalData: { apiBaseUrl: "http://api.test" } }),
    Page: (value: Record<string, unknown>) => {
      definition = value;
    },
  });
  const moduleUrl = new URL(
    `../miniprogram/pages/index/index.ts?case=${tag}`,
    import.meta.url,
  );
  await import(moduleUrl.href);
  assert.ok(definition);
  const page = {
    ...definition,
    data: structuredClone(definition.data as Record<string, unknown>),
    setData(update: Record<string, unknown>) {
      Object.assign(this.data, update);
    },
  };
  return page as Record<string, unknown> & {
    data: Record<string, unknown>;
    initialize: () => Promise<void>;
    onShow: () => void;
    showBookingSummary: () => void;
    submitBooking: () => Promise<void>;
    retryHold: () => Promise<void>;
    handlePrimaryAction: () => Promise<void>;
    finishBooking: (result: Record<string, unknown>) => void;
  };
}

function succeed(options: Record<string, unknown>, data: unknown) {
  const callback = options.success as (response: {
    statusCode: number;
    data: unknown;
  }) => void;
  callback({ statusCode: 200, data });
}

test("requires a second confirmation when price or duration changes", async () => {
  let quoteCents = "10000";
  let durationMinutes = 60;
  let holdRequests = 0;
  const mock = wxMock((options) => {
    const url = String(options.url);
    if (url.endsWith("/api/v1/booking/catalog")) {
      succeed(options, catalog);
    } else if (url.includes("/api/v1/booking/start-options?")) {
      succeed(options, startOptions());
    } else if (url.endsWith("/api/v1/availability/queries")) {
      succeed(options, available(quoteCents, durationMinutes));
    } else if (url.endsWith("/api/v1/receptions")) {
      holdRequests += 1;
      succeed(options, {
        receptionId: "reception-id",
        state: "pending",
        confirmationDeadline: "2099-01-01T00:10:00.000Z",
        quoteCents,
      });
    }
  });
  const page = await loadPage("quote-change", mock.api);
  await page.initialize.call(page);
  page.showBookingSummary.call(page);

  quoteCents = "40000";
  durationMinutes = 90;
  await page.submitBooking.call(page);

  assert.equal(holdRequests, 0);
  assert.equal(page.data.totalLabel, "¥400");
  assert.equal(
    (page.data.selectedService as { durationMinutes: number }).durationMinutes,
    90,
  );
  assert.equal(page.data.primaryActionLabel, "确认新信息并提交");
  assert.equal(page.data.interactionLocked, false);

  await page.submitBooking.call(page);
  assert.equal(holdRequests, 1);
  assert.equal(page.data.bookingComplete, true);
});

test("relogs into the original customer and replays the same unknown hold", async () => {
  const originalRecovery = recovery();
  const holdAuthorizations: string[] = [];
  const holdKeys: string[] = [];
  let loginCalls = 0;
  const mock = wxMock((options) => {
    const url = String(options.url);
    if (url.endsWith("/api/v1/customer/auth/wechat-login")) {
      succeed(options, {
        accessToken: "token-A",
        customerId: "customer-A",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return;
    }
    holdAuthorizations.push(
      String((options.header as Record<string, string>)?.Authorization),
    );
    holdKeys.push(
      String((options.header as Record<string, string>)?.["Idempotency-Key"]),
    );
    const callback = options.success as (response: {
      statusCode: number;
      data: unknown;
    }) => void;
    if (holdAuthorizations.at(-1) === "Bearer token-A") {
      callback({
        statusCode: 201,
        data: {
          receptionId: "reception-id",
          state: "pending",
          confirmationDeadline: "2099-01-01T00:10:00.000Z",
          quoteCents: "10000",
        },
      });
      return;
    }
    callback({
      statusCode: 403,
      data: {
        code: "CANDIDATE_OWNER_MISMATCH",
        message: "预约候选不属于当前登录账号",
      },
    });
  }, originalRecovery);
  mock.storage.set(SESSION_KEY, {
    ...session,
    accessToken: "cached-B",
    customerId: "customer-B",
  });
  Object.assign(mock.api, {
    login(options: { success: (result: { code: string }) => void }) {
      loginCalls += 1;
      options.success({ code: "code-A" });
    },
  });
  const page = await loadPage("identity-change", mock.api);
  await page.initialize.call(page);
  await page.retryHold.call(page);

  assert.equal(loginCalls, 0);
  assert.deepEqual(mock.storage.get(RECOVERY_KEY), {
    ...originalRecovery,
    requiresFreshLogin: true,
  });
  assert.equal(page.data.resultUnverified, true);
  assert.equal(page.data.interactionLocked, true);
  assert.match(String(page.data.bookingMessage), /切回原账号/);
  assert.equal(page.data.primaryActionLabel, "重新登录原账号并核实");

  await page.retryHold.call(page);

  assert.equal(loginCalls, 1);
  assert.deepEqual(holdAuthorizations, ["Bearer cached-B", "Bearer token-A"]);
  assert.deepEqual(holdKeys, ["booking-original-key", "booking-original-key"]);
  assert.equal(mock.storage.has(RECOVERY_KEY), false);
  assert.equal(page.data.bookingComplete, true);
});

test("does not rewrite a locked recovery or success date on show", async () => {
  const oldDate = "2025-1-2";
  const mock = wxMock(() => undefined, recovery(oldDate));
  const page = await loadPage("locked-date", mock.api);
  await page.initialize.call(page);

  page.onShow.call(page);
  assert.equal(page.data.selectedDateKey, oldDate);
  page.finishBooking.call(page, {
    receptionId: "reception-id",
    state: "pending",
    confirmationDeadline: "2099-01-01T00:10:00.000Z",
    quoteCents: "10000",
  });
  page.onShow.call(page);
  assert.equal(page.data.selectedDateKey, oldDate);
});

test("shows and runs a retry when every availability query fails", async () => {
  let shouldFail = true;
  let availabilityRequests = 0;
  const mock = wxMock((options) => {
    const url = String(options.url);
    if (url.endsWith("/api/v1/booking/catalog")) {
      succeed(options, catalog);
      return;
    }
    if (url.includes("/api/v1/booking/start-options?")) {
      succeed(options, startOptions());
      return;
    }
    if (url.endsWith("/api/v1/availability/queries")) {
      availabilityRequests += 1;
      if (shouldFail) {
        const callback = options.fail as () => void;
        callback();
      } else {
        succeed(options, available());
      }
    }
  });
  const page = await loadPage("availability-retry", mock.api);
  await page.initialize.call(page);

  assert.equal(availabilityRequests, 5);
  assert.equal(page.data.availabilityFailed, true);
  assert.equal(page.data.primaryActionDisabled, false);
  assert.equal(page.data.primaryActionLabel, "重新查询可约时间");
  assert.match(String(page.data.bookingMessage), /网络连接失败/);

  shouldFail = false;
  await page.handlePrimaryAction.call(page);
  assert.equal(availabilityRequests, 10);
  assert.equal(page.data.availabilityFailed, false);
  assert.equal(page.data.selectedTime, "11:00");
});

test("distinguishes a missing confirmation window from busy resources", async () => {
  let availabilityRequests = 0;
  const mock = wxMock((options) => {
    const url = String(options.url);
    if (url.endsWith("/api/v1/booking/catalog")) {
      succeed(options, catalog);
      return;
    }
    if (url.includes("/api/v1/booking/start-options?")) {
      succeed(options, startOptions());
      return;
    }
    if (url.endsWith("/api/v1/availability/queries")) {
      availabilityRequests += 1;
      succeed(
        options,
        availabilityRequests === 1
          ? {
              available: false,
              reasonCode: "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE",
              reason: "服务准备开始前没有前台可处理线上申请的时间",
            }
          : {
              available: false,
              reasonCode: "RESOURCE_UNAVAILABLE",
              reason: "所选时间或资源当前不可用",
            },
      );
    }
  });
  const page = await loadPage("confirmation-window-reason", mock.api);
  await page.initialize.call(page);

  const timeOptions = page.data.timeOptions as Array<{ note: string }>;
  assert.equal(timeOptions[0]?.note, "无确认处理时段");
  assert.equal(timeOptions[1]?.note, "暂无空位");
  assert.equal(
    page.data.bookingMessage,
    "该时间前门店没有可处理确认申请的时段，请选择更晚时间。",
  );
  assert.equal(page.data.availabilityFailed, false);
});

test("closes the entry without inventing dates when no policy is published", async () => {
  let availabilityRequests = 0;
  const mock = wxMock((options) => {
    const url = String(options.url);
    if (url.endsWith("/api/v1/booking/catalog")) {
      succeed(options, catalog);
      return;
    }
    if (url.includes("/api/v1/booking/start-options?")) {
      succeed(options, {
        ...startOptions(),
        policyVersion: null,
        dateRange: null,
        queriedDate: {
          serviceDate: "2026-09-12",
          status: "policy_unpublished",
        },
        service: null,
        starts: [],
      });
      return;
    }
    if (url.endsWith("/api/v1/availability/queries")) availabilityRequests += 1;
  });
  const page = await loadPage("policy-unpublished", mock.api);
  await page.initialize.call(page);

  assert.deepEqual(page.data.dates, []);
  assert.deepEqual(page.data.timeOptions, []);
  assert.equal(page.data.bookingEntryClosed, true);
  assert.equal(page.data.primaryActionDisabled, true);
  assert.equal(availabilityRequests, 0);
});
