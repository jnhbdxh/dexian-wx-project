import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SESSION_KEY = "dexian_customer_session";

const sessionA = {
  accessToken: "token-A",
  customerId: "customer-A",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function reception(
  receptionId: string,
  state: "pending" | "confirmed" | "expired" | "invalidated",
) {
  return {
    receptionId,
    storeId: "store-id",
    storeName: "金宝店",
    storeTimezone: "Asia/Shanghai",
    state,
    statusReason: state === "expired" ? "confirmation_timeout" : null,
    confirmationDeadline:
      state === "pending" ? "2026-09-12T06:40:00.000Z" : null,
    quoteCents: "32800",
    version: 1,
    guestCount: 1,
    serviceItemName: "舒缓放松",
    therapistName: "夏天",
    serviceStartAt: "2026-09-12T06:30:00.000Z",
    serviceEndAt: "2026-09-12T07:30:00.000Z",
    createdAt: "2026-09-11T04:00:00.000Z",
    updatedAt: "2026-09-11T04:00:00.000Z",
  };
}

function detail(
  receptionId: string,
  state: "pending" | "confirmed" | "expired" | "invalidated",
) {
  return {
    ...reception(receptionId, state),
    serverNow: "2026-09-11T04:00:00.000Z",
    guests: [
      {
        id: "guest-id",
        clientGuestId: "self",
        serviceItemName: "舒缓放松",
        therapistName: "夏天",
        serviceStartAt: "2026-09-12T06:30:00.000Z",
        serviceEndAt: "2026-09-12T07:30:00.000Z",
        durationMinutes: 60,
        quoteCents: "32800",
      },
    ],
  };
}

interface PendingRequest {
  url: string;
  success: (response: { statusCode: number; data: unknown }) => void;
  fail: () => void;
}

function controlledWx() {
  const storage = new Map<string, unknown>([[SESSION_KEY, sessionA]]);
  const requests: PendingRequest[] = [];
  return {
    requests,
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
      request(options: PendingRequest) {
        requests.push(options);
      },
      stopPullDownRefresh() {},
    },
  };
}

async function loadPage(
  pagePath: "receptions" | "reception-detail",
  tag: string,
  wxApi: Record<string, unknown>,
) {
  let definition: Record<string, unknown> | undefined;
  Object.assign(globalThis, {
    wx: wxApi,
    getApp: () => ({ globalData: { apiBaseUrl: "http://api.test" } }),
    Page: (value: Record<string, unknown>) => {
      definition = value;
    },
  });
  await import(
    new URL(
      `../miniprogram/pages/${pagePath}/index.ts?case=${tag}`,
      import.meta.url,
    ).href
  );
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
    loadReceptions: () => Promise<void>;
    loadMore: () => Promise<void>;
    loadDetail: () => Promise<void>;
    onLoad: (query: Record<string, string>) => void;
  };
}

async function waitForRequests(requests: PendingRequest[], count: number) {
  for (let attempt = 0; attempt < 10 && requests.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(requests.length, count);
}

function succeed(request: PendingRequest, data: unknown) {
  request.success({ statusCode: 200, data });
}

function rejectWith(
  request: PendingRequest,
  statusCode: number,
  message = "预约不存在",
) {
  request.success({
    statusCode,
    data: { code: "RECEPTION_NOT_FOUND", message },
  });
}

test("registers customer booking list and detail pages with clear recovery actions", async () => {
  const [appConfig, bookingPage, listPage, detailPage] = await Promise.all([
    readFile(new URL("../miniprogram/app.json", import.meta.url), "utf8"),
    readFile(
      new URL("../miniprogram/pages/index/index.wxml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../miniprogram/pages/receptions/index.wxml", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../miniprogram/pages/reception-detail/index.wxml",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(appConfig, /pages\/receptions\/index/);
  assert.match(appConfig, /pages\/reception-detail\/index/);
  assert.match(bookingPage, /我的预约/);
  assert.match(listPage, /下拉刷新/);
  assert.match(listPage, /重新加载/);
  assert.match(listPage, /loading \|\| loadingMore/);
  assert.doesNotMatch(listPage, /(^|\s)disabled=/m);
  assert.match(detailPage, /刷新最新状态/);
  assert.match(detailPage, /重新预约/);
  assert.doesNotMatch(detailPage, /\.slice\(/);
});

test("keeps the newest list refresh when responses arrive out of order", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "refresh-order", mock.api);

  const oldRefresh = page.loadReceptions.call(page);
  const newRefresh = page.loadReceptions.call(page);
  await waitForRequests(mock.requests, 2);

  succeed(mock.requests[1]!, {
    serverNow: "2026-09-11T04:02:00.000Z",
    items: [reception("reception-id", "confirmed")],
    nextCursor: "new-cursor",
  });
  await newRefresh;
  succeed(mock.requests[0]!, {
    serverNow: "2026-09-11T04:01:00.000Z",
    items: [reception("reception-id", "pending")],
    nextCursor: "old-cursor",
  });
  await oldRefresh;

  const items = page.data.items as Array<{ state: string }>;
  assert.equal(items[0]?.state, "confirmed");
  assert.equal(page.data.nextCursor, "new-cursor");
  assert.equal(page.data.loading, false);
});

test("keeps the newest detail refresh when responses arrive out of order", async () => {
  const mock = controlledWx();
  const page = await loadPage("reception-detail", "detail-order", mock.api);
  page.onLoad.call(page, { id: "reception-id" });

  const oldRefresh = page.loadDetail.call(page);
  const newRefresh = page.loadDetail.call(page);
  await waitForRequests(mock.requests, 2);

  succeed(mock.requests[1]!, detail("reception-id", "confirmed"));
  await newRefresh;
  succeed(mock.requests[0]!, detail("reception-id", "pending"));
  await oldRefresh;

  assert.equal((page.data.detail as { state: string }).state, "confirmed");
  assert.equal(page.data.loading, false);
});

test("does not append an old page after a new first-page refresh", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "pagination-order", mock.api);
  Object.assign(page.data, {
    items: [reception("existing-id", "pending")],
    nextCursor: "page-2",
    customerId: "customer-A",
    loading: false,
  });

  const oldPage = page.loadMore.call(page);
  await waitForRequests(mock.requests, 1);
  const refresh = page.loadReceptions.call(page);
  await waitForRequests(mock.requests, 2);

  succeed(mock.requests[1]!, {
    serverNow: "2026-09-11T04:02:00.000Z",
    items: [reception("fresh-id", "confirmed")],
    nextCursor: "fresh-cursor",
  });
  await refresh;
  succeed(mock.requests[0]!, {
    serverNow: "2026-09-11T04:01:00.000Z",
    items: [reception("stale-page-id", "expired")],
    nextCursor: "stale-cursor",
  });
  await oldPage;

  const items = page.data.items as Array<{ receptionId: string }>;
  assert.deepEqual(
    items.map((item) => item.receptionId),
    ["fresh-id"],
  );
  assert.equal(page.data.nextCursor, "fresh-cursor");
  assert.equal(page.data.loadingMore, false);
});

test("does not start pagination while the first page is refreshing", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "refresh-before-page", mock.api);
  Object.assign(page.data, {
    items: [reception("existing-id", "pending")],
    nextCursor: "old-cursor",
    customerId: "customer-A",
    loading: false,
  });

  const refresh = page.loadReceptions.call(page);
  const blockedPage = page.loadMore.call(page);
  await waitForRequests(mock.requests, 1);
  await blockedPage;

  assert.equal(mock.requests[0]?.url, "http://api.test/api/v1/receptions");
  succeed(mock.requests[0]!, {
    serverNow: "2026-09-11T04:02:00.000Z",
    items: [reception("fresh-id", "confirmed")],
    nextCursor: "fresh-cursor",
  });
  await refresh;

  assert.equal(mock.requests.length, 1);
  assert.deepEqual(
    (page.data.items as Array<{ receptionId: string }>).map(
      (item) => item.receptionId,
    ),
    ["fresh-id"],
  );
  assert.equal(page.data.nextCursor, "fresh-cursor");
});

test("reloads the first page when pagination finds another customer", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "page-customer-change", mock.api);
  Object.assign(page.data, {
    items: [reception("customer-a-id", "confirmed")],
    nextCursor: "customer-a-cursor",
    customerId: "customer-A",
    loading: false,
  });
  mock.storage.set(SESSION_KEY, {
    ...sessionA,
    accessToken: "token-B",
    customerId: "customer-B",
  });

  const loadMore = page.loadMore.call(page);
  assert.deepEqual(page.data.items, []);
  assert.equal(page.data.nextCursor, null);
  await waitForRequests(mock.requests, 1);
  assert.equal(mock.requests[0]?.url, "http://api.test/api/v1/receptions");
  succeed(mock.requests[0]!, {
    serverNow: "2026-09-11T04:02:00.000Z",
    items: [],
    nextCursor: null,
  });
  await loadMore;

  assert.deepEqual(page.data.items, []);
  assert.equal(page.data.customerId, "customer-B");
  assert.equal(page.data.nextCursor, null);
});

test("reloads the first page when list ownership changes during pagination", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "page-response-customer", mock.api);
  Object.assign(page.data, {
    items: [reception("customer-a-id", "confirmed")],
    nextCursor: "customer-a-cursor",
    customerId: "customer-A",
    loading: false,
  });

  const loadMore = page.loadMore.call(page);
  await waitForRequests(mock.requests, 1);
  mock.storage.set(SESSION_KEY, {
    ...sessionA,
    accessToken: "token-B",
    customerId: "customer-B",
  });
  Object.assign(page.data, {
    items: [reception("customer-b-existing-id", "pending")],
    customerId: "customer-B",
  });
  succeed(mock.requests[0]!, {
    serverNow: "2026-09-11T04:01:00.000Z",
    items: [reception("customer-a-private-id", "expired")],
    nextCursor: "customer-a-next-cursor",
  });
  await waitForRequests(mock.requests, 2);
  assert.deepEqual(page.data.items, []);
  assert.equal(mock.requests[1]?.url, "http://api.test/api/v1/receptions");
  succeed(mock.requests[1]!, {
    serverNow: "2026-09-11T04:02:00.000Z",
    items: [reception("customer-b-id", "confirmed")],
    nextCursor: null,
  });
  await loadMore;

  assert.deepEqual(
    (page.data.items as Array<{ receptionId: string }>).map(
      (item) => item.receptionId,
    ),
    ["customer-b-id"],
  );
  assert.equal(page.data.customerId, "customer-B");
  assert.equal(page.data.nextCursor, null);
});

test("clears list data as soon as the stored customer changes", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "list-identity", mock.api);
  Object.assign(page.data, {
    items: [reception("customer-a-id", "confirmed")],
    nextCursor: "customer-a-cursor",
    customerId: "customer-A",
    loading: false,
  });
  mock.storage.set(SESSION_KEY, {
    ...sessionA,
    accessToken: "token-B",
    customerId: "customer-B",
  });

  const refresh = page.loadReceptions.call(page);
  assert.deepEqual(page.data.items, []);
  assert.equal(page.data.nextCursor, null);
  await waitForRequests(mock.requests, 1);
  rejectWith(mock.requests[0]!, 404);
  await refresh;

  assert.equal(page.data.customerId, "");
  assert.match(String(page.data.errorMessage), /账号已变化/);
});

test("does not write an in-flight list response after the customer changes", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "list-response-identity", mock.api);
  Object.assign(page.data, {
    items: [reception("existing-a-id", "pending")],
    customerId: "customer-A",
    loading: false,
  });

  const refresh = page.loadReceptions.call(page);
  await waitForRequests(mock.requests, 1);
  mock.storage.set(SESSION_KEY, {
    ...sessionA,
    accessToken: "token-B",
    customerId: "customer-B",
  });
  succeed(mock.requests[0]!, {
    serverNow: "2026-09-11T04:02:00.000Z",
    items: [reception("private-a-id", "confirmed")],
    nextCursor: null,
  });
  await refresh;

  assert.deepEqual(page.data.items, []);
  assert.match(String(page.data.errorMessage), /账号已变化/);
});

test("clears old detail after an account change and an access rejection", async () => {
  const mock = controlledWx();
  const page = await loadPage("reception-detail", "detail-identity", mock.api);
  page.onLoad.call(page, { id: "customer-a-id" });

  const initialLoad = page.loadDetail.call(page);
  await waitForRequests(mock.requests, 1);
  succeed(mock.requests[0]!, detail("customer-a-id", "confirmed"));
  await initialLoad;
  assert.equal(
    (page.data.detail as { receptionId: string }).receptionId,
    "customer-a-id",
  );

  mock.storage.set(SESSION_KEY, {
    ...sessionA,
    accessToken: "token-B",
    customerId: "customer-B",
  });
  const rejectedLoad = page.loadDetail.call(page);
  assert.equal(page.data.detail, null);
  await waitForRequests(mock.requests, 2);
  rejectWith(mock.requests[1]!, 404);
  await rejectedLoad;

  assert.equal(page.data.detail, null);
  assert.equal(page.data.customerId, "");
  assert.match(String(page.data.errorMessage), /账号已变化/);
});

test("does not write an in-flight detail response after the customer changes", async () => {
  const mock = controlledWx();
  const page = await loadPage(
    "reception-detail",
    "detail-response-identity",
    mock.api,
  );
  page.onLoad.call(page, { id: "customer-a-id" });
  Object.assign(page.data, {
    detail: detail("customer-a-id", "pending"),
    customerId: "customer-A",
    loading: false,
  });

  const refresh = page.loadDetail.call(page);
  await waitForRequests(mock.requests, 1);
  mock.storage.set(SESSION_KEY, {
    ...sessionA,
    accessToken: "token-B",
    customerId: "customer-B",
  });
  succeed(mock.requests[0]!, detail("customer-a-id", "confirmed"));
  await refresh;

  assert.equal(page.data.detail, null);
  assert.match(String(page.data.errorMessage), /账号已变化/);
});

test("clears old detail when the current customer receives a not-found response", async () => {
  const mock = controlledWx();
  const page = await loadPage("reception-detail", "detail-not-found", mock.api);
  page.onLoad.call(page, { id: "reception-id" });

  const initialLoad = page.loadDetail.call(page);
  await waitForRequests(mock.requests, 1);
  succeed(mock.requests[0]!, detail("reception-id", "confirmed"));
  await initialLoad;

  const rejectedLoad = page.loadDetail.call(page);
  await waitForRequests(mock.requests, 2);
  rejectWith(mock.requests[1]!, 404);
  await rejectedLoad;

  assert.equal(page.data.detail, null);
  assert.equal(page.data.customerId, "");
  assert.match(String(page.data.errorMessage), /无法查看此预约/);
});

test("retains same-customer list data when a network refresh fails", async () => {
  const mock = controlledWx();
  const page = await loadPage("receptions", "list-network", mock.api);
  Object.assign(page.data, {
    items: [reception("reception-id", "confirmed")],
    nextCursor: "next-cursor",
    customerId: "customer-A",
    loading: false,
  });

  const failedRefresh = page.loadReceptions.call(page);
  await waitForRequests(mock.requests, 1);
  mock.requests[0]!.fail();
  await failedRefresh;

  assert.equal(
    (page.data.items as Array<{ receptionId: string }>)[0]?.receptionId,
    "reception-id",
  );
  assert.equal(page.data.nextCursor, "next-cursor");
  assert.match(String(page.data.errorMessage), /当前仍显示上次结果/);
});

test("retains same-customer detail when a network refresh fails", async () => {
  const mock = controlledWx();
  const page = await loadPage("reception-detail", "detail-network", mock.api);
  page.onLoad.call(page, { id: "reception-id" });

  const initialLoad = page.loadDetail.call(page);
  await waitForRequests(mock.requests, 1);
  succeed(mock.requests[0]!, detail("reception-id", "confirmed"));
  await initialLoad;

  const failedRefresh = page.loadDetail.call(page);
  await waitForRequests(mock.requests, 2);
  mock.requests[1]!.fail();
  await failedRefresh;

  assert.equal(
    (page.data.detail as { receptionId: string }).receptionId,
    "reception-id",
  );
  assert.match(String(page.data.errorMessage), /当前仍显示上次结果/);
});
