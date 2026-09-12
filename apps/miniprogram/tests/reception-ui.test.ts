import assert from "node:assert/strict";
import test from "node:test";

import {
  receptionDateTimeLabel,
  receptionMoneyLabel,
  receptionStatus,
} from "../miniprogram/lib/reception-ui.ts";

test("explains every customer-visible booking state and next step", () => {
  assert.deepEqual(receptionStatus("pending", null), {
    label: "待门店确认",
    tone: "pending",
    title: "门店正在确认",
    message: "预约资源已暂时保留，请在确认截止前留意状态变化。",
  });
  assert.equal(receptionStatus("confirmed", null).label, "已确认");
  assert.match(
    receptionStatus("expired", "confirmation_timeout").message,
    /重新预约/,
  );
  assert.equal(
    receptionStatus("invalidated", "therapist_leave").label,
    "因请假失效",
  );
  assert.match(
    receptionStatus("invalidated", "resource_unavailable").message,
    /重新预约/,
  );
});

test("formats store-local appointment time and money", () => {
  assert.match(
    receptionDateTimeLabel("2026-09-12T06:30:00.000Z", "Asia/Shanghai"),
    /9(?:月|\/)12(?:日)?.*14:30/,
  );
  assert.equal(receptionMoneyLabel("39800"), "¥398");
  assert.equal(receptionMoneyLabel("39850"), "¥398.50");
});
