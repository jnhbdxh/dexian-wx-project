import assert from "node:assert/strict";
import test from "node:test";

import { buildDateOptions, totalLabel } from "../miniprogram/lib/booking-ui.ts";

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

test("updates the displayed total for the selected guest count", () => {
  assert.equal(totalLabel(32800, 1), "¥328");
  assert.equal(totalLabel(32800, 3), "¥984");
  assert.equal(totalLabel(32850, 1), "¥328.50");
  assert.equal(totalLabel(32801, 1), "¥328.01");
});
