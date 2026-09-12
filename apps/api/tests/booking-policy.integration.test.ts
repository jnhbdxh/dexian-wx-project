import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import type {
  BookingPolicyPayloadV1,
  BookingPolicyPayloadV2,
} from "../src/modules/booking-policy/domain.js";
import { verifyBookingCandidate } from "../src/modules/booking/candidate.js";
import { createAdminReceptionFixture } from "./helpers/admin-receptions-fixture.js";

const openEveryDay: BookingPolicyPayloadV2 = {
  version: 2,
  maxAdvanceDays: 14,
  minimumLeadMinutes: 0,
  startGridMinutes: 30,
  onlineHoldMinutes: 120,
  onsiteHoldMinutes: 45,
  weeklyRules: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    intervals: [{ startMinute: 0, endMinute: 0, endDayOffset: 1 as const }],
  })),
  dateExceptions: [],
  processingWeeklyRules: Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    intervals: [{ startMinute: 0, endMinute: 0, endDayOffset: 1 as const }],
  })),
  processingDateExceptions: [],
};

const closedEveryDay: BookingPolicyPayloadV2 = {
  ...openEveryDay,
  weeklyRules: [],
};

function shanghaiDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function addDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

describe("booking policy integration", () => {
  let database: ReturnType<typeof createDatabase>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fixture: Awaited<ReturnType<typeof createAdminReceptionFixture>>;
  let legacyReceptionId: string;
  let closedDraftRevisionId: string;
  let openDraftRevisionId: string;
  let publishKey: string;
  let legacyHoldKey: string;
  let legacyCandidateToken: string;
  let unusedCandidateToken: string;

  beforeAll(async () => {
    database = createDatabase(loadConfig());
    fixture = await createAdminReceptionFixture(database);
    app = await buildApp({ config: loadConfig(), database, logger: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (fixture) await fixture.cleanup();
    if (database) await database.pool.end();
  });

  async function saveDraft(
    payload: BookingPolicyPayloadV2,
    key = randomUUID(),
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/drafts",
      headers: { ...fixture.manager.headers, "idempotency-key": key },
      payload: {
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
        basePublishedVersion: null,
        payload,
      },
    });
  }

  it("returns an empty range before the first policy is published", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/booking/start-options?storeId=${fixture.storeId}&serviceDate=${shanghaiDate(fixture.start)}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      policyVersion: null,
      dateRange: null,
      queriedDate: { status: "policy_unpublished" },
      starts: [],
    });
  });

  it("reads V1 history but requires a new V2 revision before preview or publish", async () => {
    const legacyPayload: BookingPolicyPayloadV1 = {
      maxAdvanceDays: 7,
      minimumLeadMinutes: 30,
      startGridMinutes: 30,
      weeklyRules: openEveryDay.weeklyRules,
      dateExceptions: [],
    };
    const inserted = await database.pool.query<{ id: string }>(
      `INSERT INTO booking_policy_revisions (
         store_id, kind, base_published_version, payload, created_by_staff_id
       ) VALUES ($1, 'draft', NULL, $2::jsonb, $3) RETURNING id`,
      [fixture.storeId, JSON.stringify(legacyPayload), fixture.manager.staffId],
    );
    const draftRevisionId = inserted.rows[0]!.id;
    const legacySaveInput = {
      initiatingStaffUserId: fixture.manager.staffId,
      initiatingStoreId: fixture.storeId,
      basePublishedVersion: null,
      payload: legacyPayload,
    };

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/admin/booking-policy/draft-revisions/${draftRevisionId}`,
      headers: fixture.manager.headers,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().payload).toEqual(legacyPayload);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/preview",
      headers: fixture.manager.headers,
      payload: { draftRevisionId },
    });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().code).toBe("BOOKING_POLICY_V2_REQUIRED");

    const publish = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/publish",
      headers: { ...fixture.manager.headers, "idempotency-key": randomUUID() },
      payload: {
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
        draftRevisionId,
        basePublishedVersion: null,
        changeReason: "旧草稿不得直接发布",
      },
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.json().code).toBe("BOOKING_POLICY_V2_REQUIRED");

    const newLegacySave = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/drafts",
      headers: {
        ...fixture.manager.headers,
        "idempotency-key": randomUUID(),
      },
      payload: legacySaveInput,
    });
    expect(newLegacySave.statusCode).toBe(409);
    expect(newLegacySave.json().code).toBe("BOOKING_POLICY_V2_REQUIRED");

    const recoveryKey = randomUUID();
    const normalized = JSON.stringify(canonical(legacySaveInput));
    await database.pool.query(
      `INSERT INTO business_events (
         actor_type, actor_id, operation_type, idempotency_key,
         request_hash, request_payload, response
       ) VALUES ('staff', $1, 'booking_policy.draft.save', $2, $3, $4::jsonb, $5::jsonb)`,
      [
        fixture.manager.staffId,
        recoveryKey,
        createHash("sha256").update(normalized).digest("hex"),
        normalized,
        JSON.stringify({
          draftRevisionId,
          createdAt: new Date().toISOString(),
        }),
      ],
    );
    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/drafts",
      headers: { ...fixture.manager.headers, "idempotency-key": recoveryKey },
      payload: legacySaveInput,
    });
    expect(recovered.statusCode, recovered.body).toBe(201);
    expect(recovered.json().draftRevisionId).toBe(draftRevisionId);
  });

  it("checks the idempotency request before validating changed draft content", async () => {
    const key = randomUUID();
    const first = await saveDraft(openEveryDay, key);
    expect(first.statusCode, first.body).toBe(201);

    const invalid = await saveDraft(
      {
        ...openEveryDay,
        weeklyRules: [
          {
            weekday: 1,
            intervals: [{ startMinute: 600, endMinute: 500, endDayOffset: 0 }],
          },
        ],
      },
      key,
    );
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("previews current-version differences and natural-day cross-midnight results", async () => {
    const workspace = await app.inject({
      method: "GET",
      url: "/api/v1/admin/booking-policy",
      headers: fixture.manager.headers,
    });
    const today = shanghaiDate(new Date(workspace.json().serverNow));
    const nextDate = addDate(today, 1);
    const closedDate = addDate(today, 2);
    const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    const draft = await saveDraft({
      ...openEveryDay,
      maxAdvanceDays: 2,
      minimumLeadMinutes: 30,
      startGridMinutes: 15,
      weeklyRules: [
        {
          weekday,
          intervals: [{ startMinute: 1_380, endMinute: 120, endDayOffset: 1 }],
        },
      ],
      dateExceptions: [
        { serviceDate: closedDate, kind: "closed", intervals: [] },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/preview",
      headers: fixture.manager.headers,
      payload: { draftRevisionId: draft.json().draftRevisionId },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "weeklyRules" }),
        expect.objectContaining({ field: "dateExceptions" }),
      ]),
    );
    expect(response.json().expandedDays).toEqual([
      expect.objectContaining({ serviceDate: today, status: "open" }),
      expect.objectContaining({
        serviceDate: nextDate,
        status: "open",
        sources: ["previous_day_carry"],
      }),
      expect.objectContaining({
        serviceDate: closedDate,
        status: "closed",
        sources: ["date_exception"],
      }),
    ]);
  });

  it("protects existing receptions and requires a drained first activation", async () => {
    const availability = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${fixture.customerToken}` },
      payload: {
        storeId: fixture.storeId,
        assignments: [
          {
            clientGuestId: "policy-existing",
            serviceItemId: fixture.serviceId,
            therapistResourceId: fixture.therapistId,
            serviceStartAt: fixture.start.toISOString(),
          },
        ],
      },
    });
    expect(availability.statusCode, availability.body).toBe(200);
    legacyCandidateToken = availability.json().candidateToken;
    legacyHoldKey = randomUUID();
    const hold = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${fixture.customerToken}`,
        "idempotency-key": legacyHoldKey,
      },
      payload: { candidateToken: legacyCandidateToken },
    });
    expect(hold.statusCode, hold.body).toBe(201);
    legacyReceptionId = hold.json().receptionId;
    await database.pool.query(
      `UPDATE reception_guests
          SET service_item_name_snapshot = '政策影响历史项目'
        WHERE reception_id = $1`,
      [legacyReceptionId],
    );

    const closedDraft = await saveDraft(closedEveryDay);
    closedDraftRevisionId = closedDraft.json().draftRevisionId;
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/preview",
      headers: fixture.manager.headers,
      payload: { draftRevisionId: closedDraftRevisionId },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      canPublish: false,
      user: {
        id: fixture.manager.staffId,
        storeId: fixture.storeId,
      },
      changes: expect.arrayContaining([
        expect.objectContaining({ field: "weeklyRules" }),
      ]),
      expandedDays: expect.arrayContaining([
        expect.objectContaining({ status: "closed", intervals: [] }),
      ]),
      impacts: [
        expect.objectContaining({
          receptionId: legacyReceptionId,
          serviceItemName: "政策影响历史项目",
        }),
      ],
    });

    const unusedAvailability = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${fixture.customerToken}` },
      payload: {
        storeId: fixture.storeId,
        assignments: [
          {
            clientGuestId: "unused-candidate",
            serviceItemId: fixture.serviceId,
            therapistResourceId: fixture.therapistId,
            serviceStartAt: new Date(
              fixture.start.getTime() + 3 * 60 * 60_000,
            ).toISOString(),
          },
        ],
      },
    });
    expect(unusedAvailability.statusCode, unusedAvailability.body).toBe(200);
    unusedCandidateToken = unusedAvailability.json().candidateToken;

    const openDraft = await saveDraft(openEveryDay);
    openDraftRevisionId = openDraft.json().draftRevisionId;
    const noPausePublish = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/publish",
      headers: { ...fixture.manager.headers, "idempotency-key": randomUUID() },
      payload: {
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
        draftRevisionId: openDraftRevisionId,
        basePublishedVersion: null,
        changeReason: "首次启用真实营业时间",
      },
    });
    expect(noPausePublish.json().code).toBe(
      "BOOKING_POLICY_ACTIVATION_PAUSE_REQUIRED",
    );

    const racedReceptionId = randomUUID();
    const inFlight = await database.pool.connect();
    await inFlight.query("BEGIN");
    await inFlight.query("SELECT id FROM stores WHERE id=$1 FOR SHARE", [
      fixture.storeId,
    ]);
    await inFlight.query(
      `INSERT INTO receptions
        (id,store_id,customer_id,state,confirmation_deadline,quote_cents)
       VALUES ($1,$2,$3,'pending',now()+interval '10 minutes',9500)`,
      [racedReceptionId, fixture.storeId, fixture.customerId],
    );
    await inFlight.query(
      `INSERT INTO reception_guests
        (store_id,reception_id,client_guest_id,service_item_id,
         therapist_resource_id,room_resource_id,bed_resource_id,
         service_start_at,service_end_at,quote_cents,service_config_version,
         store_config_version,duration_minutes_snapshot,prepare_minutes_snapshot,
         therapist_cleanup_minutes_snapshot,facility_cleanup_minutes_snapshot,
         rest_minutes_snapshot,rule_snapshot)
       VALUES ($1,$2,'activation-race',$3,$4,$5,$6,$7,$8,9500,1,1,60,10,5,15,20,'{}')`,
      [
        fixture.storeId,
        racedReceptionId,
        fixture.serviceId,
        fixture.therapistId,
        fixture.roomId,
        fixture.bedId,
        fixture.start,
        new Date(fixture.start.getTime() + 60 * 60_000),
      ],
    );
    let pauseSettled = false;
    const pausePromise = app
      .inject({
        method: "POST",
        url: "/api/v1/admin/booking-policy/activation/pause",
        headers: {
          ...fixture.manager.headers,
          "idempotency-key": randomUUID(),
        },
        payload: {
          initiatingStaffUserId: fixture.manager.staffId,
          initiatingStoreId: fixture.storeId,
        },
      })
      .then((response) => {
        pauseSettled = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pauseSettled).toBe(false);
    await inFlight.query("COMMIT");
    inFlight.release();
    const pause = await pausePromise;
    expect(pause.json().bookingCreationMode).toBe(
      "paused_for_policy_activation",
    );

    const replayWhilePaused = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${fixture.customerToken}`,
        "idempotency-key": legacyHoldKey,
      },
      payload: { candidateToken: legacyCandidateToken },
    });
    expect(replayWhilePaused.statusCode, replayWhilePaused.body).toBe(201);
    expect(replayWhilePaused.json().receptionId).toBe(legacyReceptionId);

    const blockedPublishKey = randomUUID();
    const blockedPublish = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/publish",
      headers: {
        ...fixture.manager.headers,
        "idempotency-key": blockedPublishKey,
      },
      payload: {
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
        draftRevisionId: closedDraftRevisionId,
        basePublishedVersion: null,
        changeReason: "不得漏掉切换期间的在途预约",
      },
    });
    expect(blockedPublish.json()).toMatchObject({
      code: "BOOKING_POLICY_EXISTING_RECEPTIONS",
      details: {
        impacts: expect.arrayContaining([
          expect.objectContaining({ receptionId: racedReceptionId }),
        ]),
      },
    });

    await database.pool.query(
      `UPDATE receptions SET state = 'expired', confirmation_deadline = NULL
        WHERE id = ANY($1::uuid[])`,
      [[legacyReceptionId, racedReceptionId]],
    );
    const replayedFailure = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/publish",
      headers: {
        ...fixture.manager.headers,
        "idempotency-key": blockedPublishKey,
      },
      payload: {
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
        draftRevisionId: closedDraftRevisionId,
        basePublishedVersion: null,
        changeReason: "不得漏掉切换期间的在途预约",
      },
    });
    expect(replayedFailure.statusCode).toBe(409);
    expect(replayedFailure.json()).toMatchObject({
      code: "BOOKING_POLICY_EXISTING_RECEPTIONS",
      details: blockedPublish.json().details,
    });

    publishKey = randomUUID();
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/publish",
      headers: { ...fixture.manager.headers, "idempotency-key": publishKey },
      payload: {
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
        draftRevisionId: openDraftRevisionId,
        basePublishedVersion: null,
        changeReason: "首次启用真实营业时间",
      },
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().publishedVersion).toBe(1);

    const staleCandidate = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${fixture.customerToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: { candidateToken: unusedCandidateToken },
    });
    expect(staleCandidate.statusCode).toBe(409);
    expect(staleCandidate.json().code).toBe("CANDIDATE_CHANGED");
  });

  it("checks the request hash before replaying a successful publish", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/booking-policy/publish",
      headers: { ...fixture.manager.headers, "idempotency-key": publishKey },
      payload: {
        initiatingStaffUserId: fixture.manager.staffId,
        initiatingStoreId: fixture.storeId,
        draftRevisionId: openDraftRevisionId,
        basePublishedVersion: null,
        changeReason: "不同原因不得重放成功结果",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("returns policy-derived starts and immutable history after activation", async () => {
    const serviceDate = shanghaiDate(fixture.start);
    const starts = await app.inject({
      method: "GET",
      url: `/api/v1/booking/start-options?storeId=${fixture.storeId}&serviceDate=${serviceDate}&serviceItemId=${fixture.serviceId}`,
    });
    expect(starts.statusCode, starts.body).toBe(200);
    expect(starts.json().policyVersion).toBe(1);
    expect(starts.json().dateRange).not.toBeNull();
    expect(starts.json().starts.length).toBeGreaterThan(0);

    const history = await app.inject({
      method: "GET",
      url: "/api/v1/admin/booking-policy/versions",
      headers: fixture.manager.headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().user).toMatchObject({
      id: fixture.manager.staffId,
      storeId: fixture.storeId,
    });
    expect(history.json().items).toEqual([
      expect.objectContaining({
        publishedVersion: 1,
        sourceDraftRevisionId: openDraftRevisionId,
      }),
    ]);
  });

  it("returns a stable reason code when no confirmation window exists", async () => {
    await database.pool.query(
      `UPDATE booking_policy_revisions
          SET payload = $2::jsonb
        WHERE store_id = $1 AND kind = 'published'`,
      [
        fixture.storeId,
        JSON.stringify({ ...openEveryDay, processingWeeklyRules: [] }),
      ],
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/availability/queries",
        headers: { authorization: `Bearer ${fixture.customerToken}` },
        payload: {
          storeId: fixture.storeId,
          assignments: [
            {
              clientGuestId: "no-confirmation-window",
              serviceItemId: fixture.serviceId,
              therapistResourceId: fixture.therapistId,
              serviceStartAt: new Date(
                fixture.start.getTime() + 6 * 60 * 60_000,
              ).toISOString(),
            },
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        available: false,
        reasonCode: "BOOKING_CONFIRMATION_WINDOW_UNAVAILABLE",
        reason: "服务准备开始前没有前台可处理线上申请的时间",
      });
    } finally {
      await database.pool.query(
        `UPDATE booking_policy_revisions
            SET payload = $2::jsonb
          WHERE store_id = $1 AND kind = 'published'`,
        [fixture.storeId, JSON.stringify(openEveryDay)],
      );
    }
  });

  it("creates V2 holds from database time and gives every allocation one deadline", async () => {
    const serviceStartAt = new Date(fixture.start.getTime() + 6 * 60 * 60_000);
    const availability = await app.inject({
      method: "POST",
      url: "/api/v1/availability/queries",
      headers: { authorization: `Bearer ${fixture.customerToken}` },
      payload: {
        storeId: fixture.storeId,
        assignments: [
          {
            clientGuestId: "policy-v2-deadline",
            serviceItemId: fixture.serviceId,
            therapistResourceId: fixture.therapistId,
            serviceStartAt: serviceStartAt.toISOString(),
          },
        ],
      },
    });
    expect(availability.statusCode, availability.body).toBe(200);
    const candidate = verifyBookingCandidate(
      availability.json().candidateToken,
      loadConfig().bookingTokenSecret,
    );
    if (candidate.version !== 2) throw new Error("Expected a V2 candidate");
    expect(candidate).toMatchObject({
      version: 2,
      policySnapshot: { publishedVersion: 1, onlineHoldMinutes: 120 },
    });

    const before = await database.pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/receptions",
      headers: {
        authorization: `Bearer ${fixture.customerToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: { candidateToken: availability.json().candidateToken },
    });
    const after = await database.pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    expect(created.statusCode, created.body).toBe(201);
    const deadline = new Date(created.json().confirmationDeadline);
    expect(deadline.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.now.getTime() + 120 * 60_000,
    );
    expect(deadline.getTime()).toBeLessThanOrEqual(
      after.rows[0]!.now.getTime() + 120 * 60_000,
    );

    const stored = await database.pool.query<{
      confirmation_deadline: Date;
      allocation_deadlines: string;
      allocation_count: string;
    }>(
      `SELECT reception.confirmation_deadline,
              count(DISTINCT allocation.expires_at)::text AS allocation_deadlines,
              count(allocation.id)::text AS allocation_count
         FROM receptions reception
         JOIN resource_allocations allocation
           ON allocation.reception_id = reception.id
        WHERE reception.id = $1
        GROUP BY reception.id`,
      [created.json().receptionId],
    );
    expect(stored.rows[0]?.confirmation_deadline).toEqual(deadline);
    expect(stored.rows[0]?.allocation_deadlines).toBe("1");
    expect(Number(stored.rows[0]?.allocation_count)).toBeGreaterThan(0);

    const snapshots = await database.pool.query<{
      rule_snapshot: {
        confirmationHoldComputation?: {
          version: number;
          mode: string;
          policyRevisionId: string;
          policyPublishedVersion: number;
          configuredMinutes: number;
          calculationStartedAt: string;
          earliestPrepareAt: string;
          accumulatedMilliseconds: number;
          truncated: boolean;
          deadline: string;
          processingSegments: Array<{ startAt: string; endAt: string }>;
        };
      };
    }>(
      `SELECT rule_snapshot
         FROM reception_guests
        WHERE reception_id = $1`,
      [created.json().receptionId],
    );
    expect(snapshots.rows).not.toHaveLength(0);
    for (const row of snapshots.rows) {
      expect(row.rule_snapshot.confirmationHoldComputation).toMatchObject({
        version: 2,
        mode: "online",
        policyRevisionId: candidate.policySnapshot.revisionId,
        policyPublishedVersion: 1,
        configuredMinutes: 120,
        accumulatedMilliseconds: 120 * 60_000,
        truncated: false,
        deadline: created.json().confirmationDeadline,
      });
      expect(
        row.rule_snapshot.confirmationHoldComputation?.processingSegments,
      ).toEqual([
        {
          startAt:
            row.rule_snapshot.confirmationHoldComputation?.calculationStartedAt,
          endAt: created.json().confirmationDeadline,
        },
      ]);
    }
  });
});
