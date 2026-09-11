import assert from "node:assert/strict";
import test from "node:test";

import { buildDateOptions, totalLabel } from "../miniprogram/lib/booking-ui.ts";

test("builds seven consecutive customer-facing dates", () => {
  const dates = buildDateOptions(new Date(2026, 8, 11, 12));

  assert.equal(dates.length, 7);
  assert.deepEqual(dates[0], {
    key: "2026-9-11",
    dateLabel: "9.11",
    weekday: "周五",
    relativeLabel: "今天",
  });
  assert.equal(dates[1]?.relativeLabel, "明天");
  assert.equal(dates[6]?.key, "2026-9-17");
});

test("updates the displayed total for the selected guest count", () => {
  assert.equal(totalLabel(32800, 1), "¥328");
  assert.equal(totalLabel(32800, 3), "¥984");
});
