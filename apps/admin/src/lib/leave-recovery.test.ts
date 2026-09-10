// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  clearUnverifiedLeave,
  isLeaveRecoveryOwner,
  loadUnverifiedLeave,
  saveUnverifiedLeave,
} from "./leave-recovery";

const attempt = {
  input: {
    therapistResourceId: "00000000-0000-4000-8000-000000000001",
    startAt: "2026-09-11T05:00:00.000Z",
    endAt: "2026-09-11T06:00:00.000Z",
    reasonPrivate: "已确认的个人请假",
  },
  key: "leave-attempt-1",
  staffUserId: "00000000-0000-4000-8000-000000000002",
  storeId: "00000000-0000-4000-8000-000000000003",
  therapistName: "小满",
};

afterEach(() => sessionStorage.clear());

describe("unverified leave recovery", () => {
  it("round trips the original request and key", () => {
    saveUnverifiedLeave(attempt);
    expect(loadUnverifiedLeave()).toEqual(attempt);
    clearUnverifiedLeave();
    expect(loadUnverifiedLeave()).toBeUndefined();
  });

  it("discards malformed or unsafe recovery data", () => {
    sessionStorage.setItem(
      "dexian:unverified-leave",
      JSON.stringify({
        ...attempt,
        input: { ...attempt.input, endAt: attempt.input.startAt },
      }),
    );
    expect(loadUnverifiedLeave()).toBeUndefined();
    expect(sessionStorage.getItem("dexian:unverified-leave")).toBeNull();
  });

  it("requires both the original employee and store", () => {
    expect(
      isLeaveRecoveryOwner(attempt, {
        id: attempt.staffUserId,
        storeId: attempt.storeId,
      }),
    ).toBe(true);
    expect(
      isLeaveRecoveryOwner(attempt, {
        id: "00000000-0000-4000-8000-000000000004",
        storeId: attempt.storeId,
      }),
    ).toBe(false);
    expect(
      isLeaveRecoveryOwner(attempt, {
        id: attempt.staffUserId,
        storeId: "00000000-0000-4000-8000-000000000005",
      }),
    ).toBe(false);
  });
});
