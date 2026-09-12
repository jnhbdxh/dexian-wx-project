import { describe, expect, it } from "vitest";

import type { CalendarAllocation } from "./resource-calendar-api";
import {
  isEffectiveAllocation,
  periodStyle,
  segmentLabel,
  shiftDate,
  timeRange,
} from "./resource-calendar-ui";

function allocation(
  overrides: Partial<CalendarAllocation> = {},
): CalendarAllocation {
  return {
    id: "allocation",
    resourceId: "resource",
    receptionId: "reception",
    guestId: "guest",
    customerName: "林女士",
    serviceItemName: "舒缓护理",
    receptionState: "pending",
    confirmationDeadline: "2026-09-11T01:10:00.000Z",
    segmentKind: "service",
    startAt: "2026-09-11T01:00:00.000Z",
    endAt: "2026-09-11T02:00:00.000Z",
    expiresAt: "2026-09-11T01:10:00.000Z",
    hasConflict: false,
    ...overrides,
  };
}

describe("resource calendar presentation", () => {
  it("labels cleanup from the real resource segment context", () => {
    expect(segmentLabel("cleanup", "therapist")).toBe("整理");
    expect(segmentLabel("cleanup", "room")).toBe("清洁");
    expect(segmentLabel("cleanup", "bed")).toBe("清洁");
    expect(segmentLabel("rest", "therapist")).toBe("必要休息");
  });

  it("clips cross-midnight periods to the selected Shanghai date", () => {
    expect(
      periodStyle(
        "2026-09-10T15:30:00.000Z",
        "2026-09-10T16:30:00.000Z",
        "2026-09-11",
      ),
    ).toEqual({ left: "0%", width: `${(30 / 1440) * 100}%` });
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(
      timeRange(
        "2026-09-10T15:30:00.000Z",
        "2026-09-10T16:30:00.000Z",
        "2026-09-11",
      ),
    ).toBe("前日 23:30–00:30");
    expect(
      timeRange(
        "2026-09-11T15:30:00.000Z",
        "2026-09-11T16:30:00.000Z",
        "2026-09-11",
      ),
    ).toBe("23:30–次日 00:30");
  });

  it("removes a held allocation locally when either deadline passes", () => {
    expect(
      isEffectiveAllocation(
        allocation(),
        Date.parse("2026-09-11T01:09:59.000Z"),
      ),
    ).toBe(true);
    expect(
      isEffectiveAllocation(
        allocation(),
        Date.parse("2026-09-11T01:10:00.000Z"),
      ),
    ).toBe(false);
    expect(
      isEffectiveAllocation(
        allocation({
          receptionState: "confirmed",
          expiresAt: null,
          confirmationDeadline: null,
        }),
        Date.parse("2026-09-12T00:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
