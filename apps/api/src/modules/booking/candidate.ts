import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

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
  clientGuestId: Type.String({ minLength: 1, maxLength: 64 }),
  serviceItemId: Uuid,
  therapistResourceId: Uuid,
  serviceStartAt: IsoDateTime,
  serviceEndAt: IsoDateTime,
  durationMinutes: Type.Integer({ minimum: 1 }),
  quoteCents: Type.String({ pattern: "^\\d+$" }),
});

const BookingCandidateFields = {
  sessionId: Uuid,
  customerId: Uuid,
  storeId: Uuid,
  expiresAt: IsoDateTime,
  assignments: Type.Array(CandidateAssignmentSchema, {
    minItems: 1,
    maxItems: 8,
  }),
  quoteCents: Type.Integer({ minimum: 0 }),
};

export const BookingCandidateV1Schema = Type.Object({
  version: Type.Literal(1),
  ...BookingCandidateFields,
});

export const BookingCandidateV2Schema = Type.Object({
  version: Type.Literal(2),
  ...BookingCandidateFields,
  policySnapshot: Type.Object({
    revisionId: Uuid,
    publishedVersion: Type.Integer({ minimum: 1 }),
    onlineHoldMinutes: Type.Integer({ minimum: 1, maximum: 43_200 }),
  }),
});

export const BookingCandidateSchema = Type.Union([
  BookingCandidateV1Schema,
  BookingCandidateV2Schema,
]);

export type CandidateAssignment = Static<typeof CandidateAssignmentSchema>;
export type PublicCandidateAssignment = Static<
  typeof PublicCandidateAssignmentSchema
>;
export type BookingCandidateV1 = Static<typeof BookingCandidateV1Schema>;
export type BookingCandidateV2 = Static<typeof BookingCandidateV2Schema>;
export type BookingCandidate = BookingCandidateV1 | BookingCandidateV2;

function invalidCandidate(): never {
  throw new AppError(400, "CANDIDATE_INVALID", "预约候选凭据无效，请重新查询");
}

function encryptionKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function signBookingCandidate(
  candidate: BookingCandidate,
  secret: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(candidate), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function verifyBookingCandidate(token: string, secret: string) {
  const [version, encodedIv, encodedPayload, encodedTag, extra] =
    token.split(".");
  if (
    version !== "v1" ||
    !encodedIv ||
    !encodedPayload ||
    !encodedTag ||
    extra
  ) {
    return invalidCandidate();
  }

  let candidate: unknown;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(secret),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    candidate = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(encodedPayload, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    return invalidCandidate();
  }
  if (!Value.Check(BookingCandidateSchema, candidate)) {
    return invalidCandidate();
  }
  return candidate;
}
