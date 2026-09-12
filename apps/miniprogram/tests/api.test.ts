import assert from "node:assert/strict";
import test from "node:test";

import {
  createHoldReception,
  getBookingStartOptions,
  getCustomerReception,
  listCustomerReceptions,
  queryAvailability,
} from "../miniprogram/lib/api.ts";

test("reads policy-derived date ranges and exact start instants", async () => {
  let requestedUrl = "";
  Object.assign(globalThis, {
    wx: {
      request(options: {
        url: string;
        success: (response: { statusCode: number; data: unknown }) => void;
      }) {
        requestedUrl = options.url;
        options.success({
          statusCode: 200,
          data: {
            policyVersion: null,
            dateRange: null,
            queriedDate: {
              serviceDate: "2026-09-12",
              status: "policy_unpublished",
            },
            starts: [],
          },
        });
      },
    },
  });
  const result = await getBookingStartOptions(
    "http://api.test",
    "store-id",
    "2026-09-12",
    "service-id",
  );
  assert.match(requestedUrl, /booking\/start-options\?/);
  assert.match(requestedUrl, /serviceItemId=service-id/);
  assert.equal(result.dateRange, null);
});

test("sends customer booking requests without facility identifiers", async () => {
  const requests: Array<{
    url: string;
    data?: Record<string, unknown>;
    header?: Record<string, string>;
    success: (response: { statusCode: number; data: unknown }) => void;
  }> = [];
  const session = {
    accessToken: "customer-token",
    customerId: "customer-id",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  Object.assign(globalThis, {
    wx: {
      getStorageSync() {
        return session;
      },
      request(options: (typeof requests)[number]) {
        requests.push(options);
        if (options.url.endsWith("/api/v1/receptions")) {
          options.success({
            statusCode: 201,
            data: {
              receptionId: "reception-id",
              state: "pending",
              confirmationDeadline: "2026-09-12T06:40:00.000Z",
              quoteCents: "32800",
            },
          });
          return;
        }
        options.success({
          statusCode: 200,
          data: {
            available: true,
            candidateToken: "opaque-candidate",
            expiresAt: "2026-09-12T06:35:00.000Z",
            quoteCents: "32800",
            assignments: [],
          },
        });
      },
    },
  });

  await queryAvailability("http://api.test", {
    storeId: "store-id",
    clientGuestId: "self",
    serviceItemId: "service-id",
    therapistResourceId: "therapist-id",
    serviceStartAt: "2026-09-12T06:30:00.000Z",
  });
  await createHoldReception(
    "http://api.test",
    "opaque-candidate",
    "booking-request-key",
  );

  const availability = requests[0]!;
  assert.equal(availability.header?.Authorization, "Bearer customer-token");
  assert.deepEqual(availability.data, {
    storeId: "store-id",
    assignments: [
      {
        clientGuestId: "self",
        serviceItemId: "service-id",
        therapistResourceId: "therapist-id",
        serviceStartAt: "2026-09-12T06:30:00.000Z",
      },
    ],
  });
  assert.equal(JSON.stringify(availability.data).includes("room"), false);
  assert.equal(JSON.stringify(availability.data).includes("bed"), false);
  assert.equal(requests[1]?.header?.["Idempotency-Key"], "booking-request-key");
});

test("reads the signed-in customer's booking list and detail", async () => {
  const requests: Array<{
    url: string;
    method?: string;
    header?: Record<string, string>;
    success: (response: { statusCode: number; data: unknown }) => void;
  }> = [];
  Object.assign(globalThis, {
    wx: {
      getStorageSync() {
        return {
          accessToken: "customer-token",
          customerId: "customer-id",
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        };
      },
      request(options: (typeof requests)[number]) {
        requests.push(options);
        options.success({
          statusCode: 200,
          data: options.url.includes("reception-id")
            ? { receptionId: "reception-id", guests: [] }
            : { serverNow: "2026-09-11T04:00:00.000Z", items: [] },
        });
      },
    },
  });

  const list = await listCustomerReceptions("http://api.test", "cursor-id");
  const detail = await getCustomerReception("http://api.test", "reception-id");

  assert.equal(
    requests[0]?.url,
    "http://api.test/api/v1/receptions?after=cursor-id",
  );
  assert.equal(
    requests[1]?.url,
    "http://api.test/api/v1/receptions/reception-id",
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    ["GET", "GET"],
  );
  assert.deepEqual(
    requests.map((request) => request.header?.Authorization),
    ["Bearer customer-token", "Bearer customer-token"],
  );
  assert.equal(list.customerId, "customer-id");
  assert.equal(detail.customerId, "customer-id");
});
