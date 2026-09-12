import { describe, expect, it } from "vitest";

import { ApiRequestError } from "./api";
import {
  classifyConfirmationFailure,
  formatCountdown,
  formatMoney,
} from "./confirmation";

function apiError(status: number, code: string, message = "") {
  return new ApiRequestError(status, code, message, "request-1", {});
}

describe("confirmation presentation", () => {
  it("formats integer cents without floating-point rounding", () => {
    expect(formatMoney("9500")).toBe("¥95.00");
    expect(formatMoney("10000000000000001")).toBe("¥100000000000000.01");
  });

  it("shows a stable minute and second countdown", () => {
    expect(
      formatCountdown(
        "2026-09-10T10:01:01.100Z",
        Date.parse("2026-09-10T10:00:00Z"),
      ),
    ).toBe("01:02");
    expect(
      formatCountdown(
        "2026-09-10T09:59:00Z",
        Date.parse("2026-09-10T10:00:00Z"),
      ),
    ).toBe("00:00");
  });

  it.each([
    [401, "AUTH_REQUIRED", "login"],
    [403, "PERMISSION_DENIED", "forbidden"],
    [409, "RECEPTION_CONFIRM_IDENTITY_CHANGED", "identity"],
    [409, "RECEPTION_EXPIRED", "expired"],
    [409, "VERSION_CONFLICT", "changed"],
    [409, "RESOURCE_BUSY_RETRY", "busy"],
    [500, "INTERNAL_ERROR", "unavailable"],
  ] as const)("classifies %s %s as %s", (status, code, kind) => {
    expect(classifyConfirmationFailure(apiError(status, code))).toMatchObject({
      kind,
    });
  });
});
