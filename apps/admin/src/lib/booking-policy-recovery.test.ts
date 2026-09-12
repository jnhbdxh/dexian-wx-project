// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearBookingPolicyRecovery,
  isBookingPolicyRecoveryOwner,
  loadBookingPolicyRecovery,
  saveBookingPolicyRecovery,
} from "./booking-policy-recovery";

describe("booking policy recovery", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps the complete immutable publish request", () => {
    const recovery = {
      operation: "publish" as const,
      key: "12345678-abcd",
      input: {
        initiatingStaffUserId: "staff-a",
        initiatingStoreId: "store-a",
        draftRevisionId: "draft-a",
        basePublishedVersion: 2,
        changeReason: "缩短周五营业时间",
      },
    };
    saveBookingPolicyRecovery(recovery);
    expect(loadBookingPolicyRecovery()).toEqual(recovery);
    expect(
      isBookingPolicyRecoveryOwner(recovery, {
        id: "staff-a",
        storeId: "store-a",
      }),
    ).toBe(true);
    clearBookingPolicyRecovery();
    expect(loadBookingPolicyRecovery()).toBeUndefined();
  });
});
