import { createHmac, timingSafeEqual } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { AppError } from "../../lib/app-error.js";

const IsoDateTime = Type.String({
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
});
const Uuid = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const NullableMinutes = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const BookingRuleSnapshotSchema = Type.Object({
  serviceConfigVersion: Type.Integer({ minimum: 1 }),
  storeConfigVersion: Type.Integer({ minimum: 1 }),
  serviceConfigured: Type.Object({
    prepareMinutes: NullableMinutes,
    therapistCleanupMinutes: NullableMinutes,
    facilityCleanupMinutes: NullableMinutes,
    restMinutes: NullableMinutes,
  }),
  storeDefaults: Type.Object({
    prepareMinutes: NullableMinutes,
    therapistCleanupMinutes: NullableMinutes,
    facilityCleanupMinutes: NullableMinutes,
    restMinutes: NullableMinutes,
  }),
  therapistMinimumRestMinutes: Type.Integer({ minimum: 0 }),
});

export const CandidateAssignmentSchema = Type.Object({
  clientGuestId: Type.String({ minLength: 1, maxLength: 64 }),
  serviceItemId: Uuid,
  therapistResourceId: Uuid,
  roomResourceId: Uuid,
  bedResourceId: Uuid,
  serviceStartAt: IsoDateTime,
  serviceEndAt: IsoDateTime,
  prepareStartAt: IsoDateTime,
  therapistWorkEndAt: IsoDateTime,
  facilityCleanupEndAt: IsoDateTime,
  restEndAt: IsoDateTime,
  durationMinutes: Type.Integer({ minimum: 1 }),
  prepareMinutes: Type.Integer({ minimum: 0 }),
  therapistCleanupMinutes: Type.Integer({ minimum: 0 }),
  facilityCleanupMinutes: Type.Integer({ minimum: 0 }),
  restMinutes: Type.Integer({ minimum: 0 }),
  quoteCents: Type.Integer({ minimum: 0 }),
  configVersion: Type.Integer({ minimum: 1 }),
  ruleSnapshot: BookingRuleSnapshotSchema,
});

export const PublicCandidateAssignmentSchema = Type.Object({
  ...CandidateAssignmentSchema.properties,
  quoteCents: Type.String({ pattern: "^\\d+$" }),
});

export const BookingCandidateSchema = Type.Object({
  version: Type.Literal(1),
  sessionId: Uuid,
  customerId: Uuid,
  storeId: Uuid,
  expiresAt: IsoDateTime,
  assignments: Type.Array(CandidateAssignmentSchema, {
    minItems: 1,
    maxItems: 8,
  }),
  quoteCents: Type.Integer({ minimum: 0 }),
});

export type CandidateAssignment = Static<typeof CandidateAssignmentSchema>;
export type PublicCandidateAssignment = Static<
  typeof PublicCandidateAssignmentSchema
>;
export type BookingCandidate = Static<typeof BookingCandidateSchema>;

function signature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

export function signBookingCandidate(
  candidate: BookingCandidate,
  secret: string,
) {
  const encodedPayload = Buffer.from(JSON.stringify(candidate)).toString(
    "base64url",
  );
  const encodedSignature = signature(encodedPayload, secret).toString(
    "base64url",
  );
  return `${encodedPayload}.${encodedSignature}`;
}

export function verifyBookingCandidate(token: string, secret: string) {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) {
    throw new AppError(
      400,
      "CANDIDATE_INVALID",
      "预约候选凭据无效，请重新查询",
    );
  }

  const expected = signature(encodedPayload, secret);
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new AppError(
      400,
      "CANDIDATE_INVALID",
      "预约候选凭据无效，请重新查询",
    );
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(
      400,
      "CANDIDATE_INVALID",
      "预约候选凭据无效，请重新查询",
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
  } catch {
    throw new AppError(
      400,
      "CANDIDATE_INVALID",
      "预约候选凭据无效，请重新查询",
    );
  }
  if (!Value.Check(BookingCandidateSchema, candidate)) {
    throw new AppError(
      400,
      "CANDIDATE_INVALID",
      "预约候选凭据无效，请重新查询",
    );
  }
  return candidate;
}
