import assert from "node:assert/strict";
import test from "node:test";

import {
  bookingIdempotencyKey,
  buildDateOptions,
  buildDateOptionsForRange,
  confirmationDeadlineLabel,
  serviceStartIso,
  shouldKeepHoldRecovery,
  totalLabel,
} from "../miniprogram/lib/booking-ui.ts";

test("builds seven store-local dates across the UTC day boundary", () => {
  const dates = buildDateOptions(
    new Date("2026-09-10T16:30:00.000Z"),
    "Asia/Shanghai",
  );

  assert.equal(dates.length, 7);
  assert.deepEqual(dates[0], {
    key: "2026-9-11",
    dateLabel: "9.11",
    summaryLabel: "9月11日",
    weekday: "周五",
    relativeLabel: "今天",
  });
  assert.equal(dates[1]?.relativeLabel, "明天");
  assert.equal(dates[6]?.key, "2026-9-17");
});

test("builds the inclusive server-provided date range", () => {
  const dates = buildDateOptionsForRange("2026-09-12", "2026-09-14");
  assert.equal(dates.length, 3);
  assert.equal(dates[0]?.key, "2026-09-12");
  assert.equal(dates[2]?.key, "2026-09-14");
});

test("updates the displayed total for the selected guest count", () => {
  assert.equal(totalLabel(32800, 1), "¥328");
  assert.equal(totalLabel(32800, 3), "¥984");
  assert.equal(totalLabel(32850, 1), "¥328.50");
  assert.equal(totalLabel(32801, 1), "¥328.01");
});

test("builds a store-local service instant and a reusable request key", () => {
  assert.equal(
    serviceStartIso("2026-9-12", "14:30", "Asia/Shanghai"),
    "2026-09-12T06:30:00.000Z",
  );
  assert.equal(
    confirmationDeadlineLabel("2026-09-12T06:40:00.000Z", "Asia/Shanghai"),
    "14:40",
  );
  assert.equal(bookingIdempotencyKey(1_000, 0.5), "booking_rs_i");
});

test("keeps recovery only while a hold result is not definitive", () => {
  assert.equal(shouldKeepHoldRecovery(0, "NETWORK_ERROR"), true);
  assert.equal(shouldKeepHoldRecovery(503, "INTERNAL_ERROR"), true);
  assert.equal(shouldKeepHoldRecovery(409, "REQUEST_IN_PROGRESS"), true);
  assert.equal(shouldKeepHoldRecovery(409, "RESOURCE_BUSY_RETRY"), true);
  assert.equal(shouldKeepHoldRecovery(403, "CANDIDATE_OWNER_MISMATCH"), true);
  assert.equal(shouldKeepHoldRecovery(401, "AUTH_REQUIRED"), true);
  assert.equal(shouldKeepHoldRecovery(409, "CANDIDATE_CHANGED"), false);
});
