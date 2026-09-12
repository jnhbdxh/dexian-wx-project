import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AppError } from "../src/lib/app-error.js";
import {
  signBookingCandidate,
  verifyBookingCandidate,
  type BookingCandidate,
  type BookingCandidateV2,
} from "../src/modules/booking/candidate.js";

const secret = "test-only-booking-candidate-secret-32-chars";

function candidate(): BookingCandidate {
  const serviceStartAt = new Date(Date.now() + 3_600_000);
  const serviceEndAt = new Date(serviceStartAt.getTime() + 3_600_000);
  return {
    version: 1,
    sessionId: randomUUID(),
    customerId: randomUUID(),
    storeId: randomUUID(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    quoteCents: 9_500,
    assignments: [
      {
        clientGuestId: "guest-1",
        serviceItemId: randomUUID(),
        therapistResourceId: randomUUID(),
        roomResourceId: randomUUID(),
        bedResourceId: randomUUID(),
        prepareStartAt: new Date(
          serviceStartAt.getTime() - 900_000,
        ).toISOString(),
        serviceStartAt: serviceStartAt.toISOString(),
        serviceEndAt: serviceEndAt.toISOString(),
        therapistWorkEndAt: new Date(
          serviceEndAt.getTime() + 1_200_000,
        ).toISOString(),
        facilityCleanupEndAt: new Date(
          serviceEndAt.getTime() + 600_000,
        ).toISOString(),
        restEndAt: new Date(serviceEndAt.getTime() + 3_000_000).toISOString(),
        durationMinutes: 60,
        prepareMinutes: 15,
        therapistCleanupMinutes: 20,
        facilityCleanupMinutes: 10,
        restMinutes: 30,
        quoteCents: 9_500,
        configVersion: 1,
        ruleSnapshot: {
          serviceConfigVersion: 1,
          storeConfigVersion: 1,
          serviceConfigured: {
            prepareMinutes: 15,
            therapistCleanupMinutes: 20,
            facilityCleanupMinutes: 10,
            restMinutes: 30,
          },
          storeDefaults: {
            prepareMinutes: 10,
            therapistCleanupMinutes: 10,
            facilityCleanupMinutes: 15,
            restMinutes: 20,
          },
          therapistMinimumRestMinutes: 25,
        },
      },
    ],
  };
}

describe("booking candidate token", () => {
  it("round-trips an opaque authenticated candidate", () => {
    const expected = candidate();
    const token = signBookingCandidate(expected, secret);

    expect(token).not.toContain(expected.assignments[0]!.roomResourceId);
    expect(token).not.toContain(expected.assignments[0]!.bedResourceId);
    for (const part of token.split(".").slice(1)) {
      expect(Buffer.from(part!, "base64url").toString("utf8")).not.toContain(
        expected.assignments[0]!.roomResourceId,
      );
    }
    expect(verifyBookingCandidate(token, secret)).toEqual(expected);
  });

  it("decodes both legacy and policy-aware candidates", () => {
    const legacy = candidate();
    const current: BookingCandidateV2 = {
      ...legacy,
      version: 2,
      policySnapshot: {
        revisionId: randomUUID(),
        publishedVersion: 3,
        onlineHoldMinutes: 120,
      },
    };

    expect(
      verifyBookingCandidate(signBookingCandidate(legacy, secret), secret)
        .version,
    ).toBe(1);
    expect(
      verifyBookingCandidate(signBookingCandidate(current, secret), secret),
    ).toEqual(current);
  });

  it("rejects modified ciphertext", () => {
    const token = signBookingCandidate(candidate(), secret);
    const [version, iv, payload, tag] = token.split(".");
    const replacement = payload!.startsWith("A") ? "B" : "A";
    const modified = `${version}.${iv}.${replacement}${payload!.slice(1)}.${tag}`;

    try {
      verifyBookingCandidate(modified, secret);
      throw new Error("Expected the modified token to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CANDIDATE_INVALID");
    }
  });
});
