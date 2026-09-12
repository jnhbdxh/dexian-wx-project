import { describe, expect, it } from "vitest";

import {
  onlineConfirmationDeadline,
  policyCoversInterval,
  resolvePolicyDay,
  validateBookingPolicy,
  type BookingPolicyPayloadV1,
  type BookingPolicyPayloadV2,
} from "../src/modules/booking-policy/domain.js";

const policy: BookingPolicyPayloadV1 = {
  maxAdvanceDays: 14,
  minimumLeadMinutes: 60,
  startGridMinutes: 30,
  weeklyRules: [
    {
      weekday: 5,
      intervals: [{ startMinute: 20 * 60, endMinute: 2 * 60, endDayOffset: 1 }],
    },
  ],
  dateExceptions: [],
};

describe("booking policy calendar", () => {
  it("keeps a weekly overnight carry on the next natural day", () => {
    expect(resolvePolicyDay(policy, "2026-09-12")).toEqual([
      { startMinute: 0, endMinute: 120 },
    ]);
  });

  it("lets a closed natural day cut the previous-day carry", () => {
    expect(
      resolvePolicyDay(
        {
          ...policy,
          dateExceptions: [
            { serviceDate: "2026-09-12", kind: "closed", intervals: [] },
          ],
        },
        "2026-09-12",
      ),
    ).toEqual([]);
  });

  it("lets a replacement natural day replace the previous-day carry", () => {
    expect(
      resolvePolicyDay(
        {
          ...policy,
          dateExceptions: [
            {
              serviceDate: "2026-09-12",
              kind: "replace",
              intervals: [
                { startMinute: 10 * 60, endMinute: 18 * 60, endDayOffset: 0 },
              ],
            },
          ],
        },
        "2026-09-12",
      ),
    ).toEqual([{ startMinute: 600, endMinute: 1_080 }]);
  });

  it("applies the following day's exception to an overnight replacement", () => {
    const replacement: BookingPolicyPayloadV1 = {
      ...policy,
      dateExceptions: [
        {
          serviceDate: "2026-09-12",
          kind: "replace",
          intervals: [
            { startMinute: 22 * 60, endMinute: 3 * 60, endDayOffset: 1 },
          ],
        },
        { serviceDate: "2026-09-13", kind: "closed", intervals: [] },
      ],
    };
    expect(resolvePolicyDay(replacement, "2026-09-12")).toEqual([
      { startMinute: 1_320, endMinute: 1_440 },
    ]);
    expect(resolvePolicyDay(replacement, "2026-09-13")).toEqual([]);
  });

  it("checks a full service interval instead of only its start", () => {
    expect(
      policyCoversInterval(
        policy,
        "Asia/Shanghai",
        new Date("2026-09-11T16:30:00.000Z"),
        new Date("2026-09-11T17:30:00.000Z"),
      ),
    ).toBe(true);
    expect(
      policyCoversInterval(
        policy,
        "Asia/Shanghai",
        new Date("2026-09-11T17:30:00.000Z"),
        new Date("2026-09-11T18:30:00.000Z"),
      ),
    ).toBe(false);
  });
});

const timedPolicy: BookingPolicyPayloadV2 = {
  version: 2,
  maxAdvanceDays: 14,
  minimumLeadMinutes: 0,
  startGridMinutes: 30,
  onlineHoldMinutes: 120,
  onsiteHoldMinutes: 30,
  weeklyRules: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    intervals: [{ startMinute: 540, endMinute: 1_080, endDayOffset: 0 }],
  })),
  dateExceptions: [],
  processingWeeklyRules: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    intervals: [
      { startMinute: 540, endMinute: 720, endDayOffset: 0 },
      { startMinute: 780, endMinute: 1_080, endDayOffset: 0 },
    ],
  })),
  processingDateExceptions: [],
};

describe("online confirmation deadline", () => {
  it("rejects enabled V2 weekdays without an explicit interval", () => {
    expect(() =>
      validateBookingPolicy({
        ...timedPolicy,
        weeklyRules: [{ weekday: 1, intervals: [] }],
      }),
    ).toThrow("营业日历星期1至少需要一个区间");
    expect(() =>
      validateBookingPolicy({
        ...timedPolicy,
        processingWeeklyRules: [{ weekday: 1, intervals: [] }],
      }),
    ).toThrow("前台处理日历星期1至少需要一个区间");
  });

  it("accumulates exact milliseconds across processing windows", () => {
    const result = onlineConfirmationDeadline(
      timedPolicy,
      "Asia/Shanghai",
      new Date("2026-09-15T09:30:15.250+08:00"),
      new Date("2026-09-16T14:00:00.000+08:00"),
    );

    expect(result).toEqual({
      deadline: new Date("2026-09-15T11:30:15.250+08:00"),
      accumulatedMs: 120 * 60_000,
      segments: [
        {
          startAt: new Date("2026-09-15T09:30:15.250+08:00"),
          endAt: new Date("2026-09-15T11:30:15.250+08:00"),
        },
      ],
      truncated: false,
    });
  });

  it("continues after a break and truncates at the earliest preparation", () => {
    const continued = onlineConfirmationDeadline(
      { ...timedPolicy, onlineHoldMinutes: 90 },
      "Asia/Shanghai",
      new Date("2026-09-15T11:30:00.000+08:00"),
      new Date("2026-09-15T15:00:00.000+08:00"),
    );
    expect(continued?.deadline).toEqual(
      new Date("2026-09-15T14:00:00.000+08:00"),
    );
    expect(continued?.truncated).toBe(false);

    const truncated = onlineConfirmationDeadline(
      { ...timedPolicy, onlineHoldMinutes: 240 },
      "Asia/Shanghai",
      new Date("2026-09-15T11:30:00.000+08:00"),
      new Date("2026-09-15T14:00:00.000+08:00"),
    );
    expect(truncated).toEqual({
      deadline: new Date("2026-09-15T14:00:00.000+08:00"),
      accumulatedMs: 90 * 60_000,
      segments: [
        {
          startAt: new Date("2026-09-15T11:30:00.000+08:00"),
          endAt: new Date("2026-09-15T12:00:00.000+08:00"),
        },
        {
          startAt: new Date("2026-09-15T13:00:00.000+08:00"),
          endAt: new Date("2026-09-15T14:00:00.000+08:00"),
        },
      ],
      truncated: true,
    });
  });

  it("rejects when no effective window exists before preparation", () => {
    expect(
      onlineConfirmationDeadline(
        timedPolicy,
        "Asia/Shanghai",
        new Date("2026-09-15T12:00:00.000+08:00"),
        new Date("2026-09-15T13:00:00.000+08:00"),
      ),
    ).toBeUndefined();
    expect(
      onlineConfirmationDeadline(
        timedPolicy,
        "Asia/Shanghai",
        new Date("2026-09-15T12:59:59.999+08:00"),
        new Date("2026-09-15T13:00:00.000+08:00"),
      ),
    ).toBeUndefined();
  });

  it("recomputes from submission time after the query crosses a window end", () => {
    const shortHold = { ...timedPolicy, onlineHoldMinutes: 1 };
    const preparation = new Date("2026-09-16T10:00:00.000+08:00");
    const atQuery = onlineConfirmationDeadline(
      shortHold,
      "Asia/Shanghai",
      new Date("2026-09-15T17:59:30.000+08:00"),
      preparation,
    );
    const atSubmission = onlineConfirmationDeadline(
      shortHold,
      "Asia/Shanghai",
      new Date("2026-09-15T18:00:15.000+08:00"),
      preparation,
    );

    expect(atQuery?.deadline).toEqual(
      new Date("2026-09-16T09:00:30.000+08:00"),
    );
    expect(atSubmission?.deadline).toEqual(
      new Date("2026-09-16T09:01:00.000+08:00"),
    );
  });
});
