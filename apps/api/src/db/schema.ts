import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const bookingCreationMode = pgEnum("booking_creation_mode", [
  "legacy",
  "paused_for_policy_activation",
  "policy_enforced",
]);
export const bookingPolicyRevisionKind = pgEnum(
  "booking_policy_revision_kind",
  ["draft", "published"],
);

export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    lockKey: integer("lock_key").generatedAlwaysAsIdentity(),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    bookingConfigVersion: integer("booking_config_version")
      .notNull()
      .default(1),
    bookingCreationMode: bookingCreationMode("booking_creation_mode")
      .notNull()
      .default("legacy"),
    defaultPrepareMinutes: integer("default_prepare_minutes"),
    defaultTherapistCleanupMinutes: integer(
      "default_therapist_cleanup_minutes",
    ),
    defaultFacilityCleanupMinutes: integer("default_facility_cleanup_minutes"),
    defaultRestMinutes: integer("default_rest_minutes"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("stores_lock_key_unique").on(table.lockKey),
    check(
      "stores_booking_defaults_nonnegative_check",
      sql`(${table.defaultPrepareMinutes} IS NULL OR ${table.defaultPrepareMinutes} >= 0)
        AND (${table.defaultTherapistCleanupMinutes} IS NULL OR ${table.defaultTherapistCleanupMinutes} >= 0)
        AND (${table.defaultFacilityCleanupMinutes} IS NULL OR ${table.defaultFacilityCleanupMinutes} >= 0)
        AND (${table.defaultRestMinutes} IS NULL OR ${table.defaultRestMinutes} >= 0)`,
    ),
  ],
);

export const staffUsers = pgTable(
  "staff_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("staff_users_username_unique").on(table.username),
    unique("staff_users_store_id_id_unique").on(table.storeId, table.id),
  ],
);

export const bookingPolicyRevisions = pgTable(
  "booking_policy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    kind: bookingPolicyRevisionKind("kind").notNull(),
    sourceDraftRevisionId: uuid("source_draft_revision_id"),
    publishedVersion: integer("published_version"),
    basePublishedVersion: integer("base_published_version"),
    payload: jsonb("payload").notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    changeReason: text("change_reason"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId, table.createdByStaffId],
      foreignColumns: [staffUsers.storeId, staffUsers.id],
      name: "booking_policy_revisions_created_by_fk",
    }).onDelete("restrict"),
    uniqueIndex("booking_policy_revisions_store_published_unique")
      .on(table.storeId, table.publishedVersion)
      .where(sql`${table.publishedVersion} IS NOT NULL`),
    index("booking_policy_revisions_store_kind_created_idx").on(
      table.storeId,
      table.kind,
      table.createdAt,
      table.id,
    ),
    check(
      "booking_policy_revisions_state_check",
      sql`(${table.kind} = 'draft' AND ${table.sourceDraftRevisionId} IS NULL AND ${table.publishedVersion} IS NULL AND ${table.publishedAt} IS NULL)
        OR (${table.kind} = 'published' AND ${table.publishedVersion} IS NOT NULL AND ${table.publishedVersion} > 0
          AND ${table.sourceDraftRevisionId} IS NOT NULL AND ${table.publishedAt} IS NOT NULL
          AND length(trim(${table.changeReason})) > 0)`,
    ),
    check(
      "booking_policy_revisions_base_version_check",
      sql`${table.basePublishedVersion} IS NULL OR ${table.basePublishedVersion} > 0`,
    ),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("roles_store_code_unique").on(table.storeId, table.code),
  ],
);

export const permissions = pgTable("permissions", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionCode: text("permission_code")
      .notNull()
      .references(() => permissions.code, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionCode] })],
);

export const staffRoleAssignments = pgTable(
  "staff_role_assignments",
  {
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.staffUserId, table.roleId] })],
);

export const staffSessions = pgTable(
  "staff_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("staff_sessions_token_hash_unique").on(table.tokenHash),
    index("staff_sessions_user_expires_idx").on(
      table.staffUserId,
      table.expiresAt,
    ),
  ],
);

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const wechatIdentities = pgTable(
  "wechat_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    appId: text("app_id").notNull(),
    openId: text("open_id").notNull(),
    unionId: text("union_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("wechat_identities_app_open_unique").on(
      table.appId,
      table.openId,
    ),
  ],
);

export const customerSessions = pgTable(
  "customer_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_sessions_token_hash_unique").on(table.tokenHash),
  ],
);

export const phoneVerificationPurpose = pgEnum("phone_verification_purpose", [
  "bind_phone",
]);

export const smsVerifications = pgTable(
  "sms_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    purpose: phoneVerificationPurpose("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    attemptsRemaining: integer("attempts_remaining").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    nextSendAt: timestamp("next_send_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    ...timestamps,
  },
  (table) => [
    check(
      "sms_verifications_attempts_nonnegative_check",
      sql`${table.attemptsRemaining} >= 0`,
    ),
    index("sms_verifications_customer_created_idx").on(
      table.customerId,
      table.createdAt,
    ),
    index("sms_verifications_phone_created_idx").on(
      table.phone,
      table.createdAt,
    ),
  ],
);

export const customerPhoneBindings = pgTable(
  "customer_phone_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    phone: text("phone").notNull(),
    verificationId: uuid("verification_id")
      .notNull()
      .references(() => smsVerifications.id, { onDelete: "restrict" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("customer_phone_bindings_active_customer_unique")
      .on(table.customerId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("customer_phone_bindings_active_phone_unique")
      .on(table.phone)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("customer_phone_bindings_verification_unique").on(
      table.verificationId,
    ),
  ],
);

export const loginAudits = pgTable(
  "login_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    identifier: text("identifier"),
    succeeded: boolean("succeeded").notNull(),
    requestId: text("request_id").notNull(),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("login_audits_actor_created_idx").on(table.actorId, table.createdAt),
  ],
);

export type StaffUser = typeof staffUsers.$inferSelect;

export const resourceType = pgEnum("resource_type", [
  "room",
  "bed",
  "therapist",
  "equipment",
]);
export const restrictionKind = pgEnum("restriction_kind", [
  "leave",
  "meal_break",
  "training",
  "store_closed",
  "equipment_fault",
  "other_unavailable",
]);
export const receptionState = pgEnum("reception_state", [
  "pending",
  "confirmed",
  "expired",
  "invalidated",
  "cancelled",
]);
export const resourceConflictStatus = pgEnum("resource_conflict_status", [
  "pending",
  "resolved",
]);
export const allocationSegmentKind = pgEnum("allocation_segment_kind", [
  "prepare",
  "service",
  "cleanup",
  "rest",
]);
export const allocationState = pgEnum("allocation_state", [
  "held",
  "confirmed",
  "inactive",
]);

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    resourceType: resourceType("resource_type").notNull(),
    parentResourceId: uuid("parent_resource_id"),
    name: text("name").notNull(),
    minimumRestMinutes: integer("minimum_rest_minutes").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique("resources_store_id_id_unique").on(table.storeId, table.id),
    foreignKey({
      columns: [table.storeId, table.parentResourceId],
      foreignColumns: [table.storeId, table.id],
      name: "resources_store_parent_fk",
    }).onDelete("restrict"),
    check(
      "resources_parent_not_self_check",
      sql`${table.parentResourceId} IS NULL OR ${table.parentResourceId} <> ${table.id}`,
    ),
    check(
      "resources_minimum_rest_nonnegative_check",
      sql`${table.minimumRestMinutes} >= 0`,
    ),
    index("resources_store_type_active_idx").on(
      table.storeId,
      table.resourceType,
      table.active,
    ),
  ],
);

export const serviceItems = pgTable(
  "service_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    prepareMinutes: integer("prepare_minutes"),
    therapistCleanupMinutes: integer("cleanup_minutes"),
    facilityCleanupMinutes: integer("facility_cleanup_minutes"),
    restMinutes: integer("rest_minutes"),
    priceCents: integer("price_cents").notNull(),
    configVersion: integer("config_version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique("service_items_store_id_id_unique").on(table.storeId, table.id),
    check(
      "service_items_duration_positive_check",
      sql`${table.durationMinutes} > 0`,
    ),
    check(
      "service_items_nonnegative_offsets_check",
      sql`(${table.prepareMinutes} IS NULL OR ${table.prepareMinutes} >= 0)
        AND (${table.therapistCleanupMinutes} IS NULL OR ${table.therapistCleanupMinutes} >= 0)
        AND (${table.facilityCleanupMinutes} IS NULL OR ${table.facilityCleanupMinutes} >= 0)
        AND (${table.restMinutes} IS NULL OR ${table.restMinutes} >= 0)`,
    ),
    check(
      "service_items_price_nonnegative_check",
      sql`${table.priceCents} >= 0`,
    ),
  ],
);

export const therapistServiceItems = pgTable(
  "therapist_service_items",
  {
    storeId: uuid("store_id").notNull(),
    therapistResourceId: uuid("therapist_resource_id").notNull(),
    serviceItemId: uuid("service_item_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.therapistResourceId, table.serviceItemId],
    }),
    foreignKey({
      columns: [table.storeId, table.therapistResourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "therapist_service_items_therapist_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.serviceItemId],
      foreignColumns: [serviceItems.storeId, serviceItems.id],
      name: "therapist_service_items_service_fk",
    }).onDelete("restrict"),
  ],
);

export const resourceShifts = pgTable(
  "resource_shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    therapistResourceId: uuid("therapist_resource_id").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    published: boolean("published").notNull().default(true),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.storeId, table.therapistResourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "resource_shifts_therapist_fk",
    }).onDelete("restrict"),
    check(
      "resource_shifts_period_check",
      sql`${table.endAt} > ${table.startAt}`,
    ),
    index("resource_shifts_lookup_idx").on(
      table.storeId,
      table.therapistResourceId,
      table.startAt,
      table.endAt,
    ),
  ],
);

export const resourceRestrictions = pgTable(
  "resource_restrictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    resourceId: uuid("resource_id"),
    restrictionKind: restrictionKind("restriction_kind").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    active: boolean("active").notNull().default(true),
    reasonPrivate: text("reason_private"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("resource_restrictions_store_id_id_unique").on(
      table.storeId,
      table.id,
    ),
    foreignKey({
      columns: [table.storeId, table.resourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "resource_restrictions_resource_fk",
    }).onDelete("restrict"),
    check(
      "resource_restrictions_period_check",
      sql`${table.endAt} > ${table.startAt}`,
    ),
    check(
      "resource_restrictions_scope_check",
      sql`(${table.restrictionKind} = 'store_closed' AND ${table.resourceId} IS NULL) OR (${table.restrictionKind} <> 'store_closed' AND ${table.resourceId} IS NOT NULL)`,
    ),
    index("resource_restrictions_lookup_idx").on(
      table.storeId,
      table.resourceId,
      table.startAt,
      table.endAt,
    ),
  ],
);

export const receptions = pgTable(
  "receptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    state: receptionState("state").notNull(),
    confirmationDeadline: timestamp("confirmation_deadline", {
      withTimezone: true,
    }),
    quoteCents: integer("quote_cents").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("receptions_store_id_id_unique").on(table.storeId, table.id),
    check(
      "receptions_deadline_state_check",
      sql`(${table.state} = 'pending' AND ${table.confirmationDeadline} IS NOT NULL) OR (${table.state} <> 'pending' AND ${table.confirmationDeadline} IS NULL)`,
    ),
    index("receptions_pending_deadline_idx").on(
      table.storeId,
      table.state,
      table.confirmationDeadline,
    ),
    index("receptions_customer_created_idx").on(
      table.customerId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const receptionGuests = pgTable(
  "reception_guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    receptionId: uuid("reception_id").notNull(),
    clientGuestId: text("client_guest_id").notNull(),
    serviceItemId: uuid("service_item_id").notNull(),
    serviceItemNameSnapshot: text("service_item_name_snapshot"),
    therapistResourceId: uuid("therapist_resource_id").notNull(),
    roomResourceId: uuid("room_resource_id").notNull(),
    bedResourceId: uuid("bed_resource_id").notNull(),
    serviceStartAt: timestamp("service_start_at", {
      withTimezone: true,
    }).notNull(),
    serviceEndAt: timestamp("service_end_at", { withTimezone: true }).notNull(),
    quoteCents: integer("quote_cents").notNull(),
    serviceConfigVersion: integer("service_config_version").notNull(),
    storeConfigVersion: integer("store_config_version").notNull(),
    durationMinutesSnapshot: integer("duration_minutes_snapshot").notNull(),
    prepareMinutesSnapshot: integer("prepare_minutes_snapshot").notNull(),
    therapistCleanupMinutesSnapshot: integer(
      "therapist_cleanup_minutes_snapshot",
    ).notNull(),
    facilityCleanupMinutesSnapshot: integer(
      "facility_cleanup_minutes_snapshot",
    ).notNull(),
    restMinutesSnapshot: integer("rest_minutes_snapshot").notNull(),
    ruleSnapshot: jsonb("rule_snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("reception_guests_store_reception_id_unique").on(
      table.storeId,
      table.receptionId,
      table.id,
    ),
    unique("reception_guests_client_id_unique").on(
      table.receptionId,
      table.clientGuestId,
    ),
    foreignKey({
      columns: [table.storeId, table.receptionId],
      foreignColumns: [receptions.storeId, receptions.id],
      name: "reception_guests_reception_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.serviceItemId],
      foreignColumns: [serviceItems.storeId, serviceItems.id],
      name: "reception_guests_service_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.therapistResourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "reception_guests_therapist_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.roomResourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "reception_guests_room_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.bedResourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "reception_guests_bed_fk",
    }).onDelete("restrict"),
    check(
      "reception_guests_service_period_check",
      sql`${table.serviceEndAt} > ${table.serviceStartAt}`,
    ),
  ],
);

export const resourceAllocations = pgTable(
  "resource_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    receptionId: uuid("reception_id").notNull(),
    receptionGuestId: uuid("reception_guest_id"),
    segmentKind: allocationSegmentKind("segment_kind").notNull(),
    allocationState: allocationState("allocation_state").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    inactiveReason: text("inactive_reason"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.storeId, table.resourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "resource_allocations_resource_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.receptionId],
      foreignColumns: [receptions.storeId, receptions.id],
      name: "resource_allocations_reception_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.receptionId, table.receptionGuestId],
      foreignColumns: [
        receptionGuests.storeId,
        receptionGuests.receptionId,
        receptionGuests.id,
      ],
      name: "resource_allocations_guest_fk",
    }).onDelete("restrict"),
    check(
      "resource_allocations_period_check",
      sql`${table.endAt} > ${table.startAt}`,
    ),
    check(
      "resource_allocations_expiry_state_check",
      sql`(${table.allocationState} = 'held' AND ${table.expiresAt} IS NOT NULL) OR (${table.allocationState} <> 'held' AND ${table.expiresAt} IS NULL)`,
    ),
    index("resource_allocations_reception_idx").on(table.receptionId),
    index("resource_allocations_resource_period_idx").on(
      table.resourceId,
      table.startAt,
      table.endAt,
    ),
  ],
);

export const resourceConflicts = pgTable(
  "resource_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    restrictionId: uuid("restriction_id").notNull(),
    receptionId: uuid("reception_id").notNull(),
    status: resourceConflictStatus("status").notNull().default("pending"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByStaffId: uuid("resolved_by_staff_id"),
    resolutionNote: text("resolution_note"),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("resource_conflicts_store_id_id_unique").on(table.storeId, table.id),
    unique("resource_conflicts_restriction_reception_unique").on(
      table.restrictionId,
      table.receptionId,
    ),
    foreignKey({
      columns: [table.storeId, table.resourceId],
      foreignColumns: [resources.storeId, resources.id],
      name: "resource_conflicts_resource_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.restrictionId],
      foreignColumns: [resourceRestrictions.storeId, resourceRestrictions.id],
      name: "resource_conflicts_restriction_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.receptionId],
      foreignColumns: [receptions.storeId, receptions.id],
      name: "resource_conflicts_reception_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.storeId, table.resolvedByStaffId],
      foreignColumns: [staffUsers.storeId, staffUsers.id],
      name: "resource_conflicts_resolved_by_fk",
    }).onDelete("restrict"),
    check(
      "resource_conflicts_resolution_state_check",
      sql`(${table.status} = 'pending' AND ${table.resolvedAt} IS NULL AND ${table.resolvedByStaffId} IS NULL)
        OR (${table.status} = 'resolved' AND ${table.resolvedAt} IS NOT NULL AND ${table.resolvedByStaffId} IS NOT NULL)`,
    ),
    index("resource_conflicts_store_status_detected_idx").on(
      table.storeId,
      table.status,
      table.detectedAt,
    ),
  ],
);

export const businessEvents = pgTable(
  "business_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    operationType: text("operation_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    requestPayload: jsonb("request_payload"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("business_events_idempotency_unique").on(
      table.actorType,
      table.actorId,
      table.operationType,
      table.idempotencyKey,
    ),
  ],
);

export const paymentTransactionState = pgEnum("payment_transaction_state", [
  "created",
  "processing",
  "succeeded",
  "failed",
  "unknown",
  "manual_review",
]);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    receptionId: uuid("reception_id")
      .notNull()
      .references(() => receptions.id, { onDelete: "restrict" }),
    payableCents: integer("payable_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    quoteSnapshot: jsonb("quote_snapshot").notNull(),
    collectionDeadline: timestamp("collection_deadline", {
      withTimezone: true,
    }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("orders_reception_unique").on(table.receptionId),
    check("orders_payable_positive_check", sql`${table.payableCents} > 0`),
    check("orders_currency_check", sql`${table.currency} = 'CNY'`),
    index("orders_customer_created_idx").on(table.customerId, table.createdAt),
  ],
);

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    channel: text("channel").notNull().default("wechat"),
    state: paymentTransactionState("state").notNull(),
    outTradeNo: text("out_trade_no").notNull(),
    channelTransactionId: text("channel_transaction_id"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CNY"),
    payerOpenId: text("payer_open_id").notNull(),
    prepayId: text("prepay_id"),
    prepayExpiresAt: timestamp("prepay_expires_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    checkAttempts: integer("check_attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("payment_transactions_order_channel_unique").on(
      table.orderId,
      table.channel,
    ),
    uniqueIndex("payment_transactions_out_trade_no_unique").on(
      table.outTradeNo,
    ),
    uniqueIndex("payment_transactions_channel_id_unique").on(
      table.channelTransactionId,
    ),
    check(
      "payment_transactions_amount_positive_check",
      sql`${table.amountCents} > 0`,
    ),
    check(
      "payment_transactions_currency_check",
      sql`${table.currency} = 'CNY'`,
    ),
    check(
      "payment_transactions_channel_check",
      sql`${table.channel} = 'wechat'`,
    ),
    check(
      "payment_transactions_success_check",
      sql`(${table.state} = 'succeeded' AND ${table.channelTransactionId} IS NOT NULL AND ${table.succeededAt} IS NOT NULL)
        OR (${table.state} <> 'succeeded' AND ${table.succeededAt} IS NULL)`,
    ),
    check(
      "payment_transactions_prepay_pair_check",
      sql`(${table.prepayId} IS NULL) = (${table.prepayExpiresAt} IS NULL)`,
    ),
    check(
      "payment_transactions_lease_pair_check",
      sql`(${table.leaseToken} IS NULL) = (${table.leaseUntil} IS NULL)`,
    ),
    check(
      "payment_transactions_check_attempts_nonnegative_check",
      sql`${table.checkAttempts} >= 0`,
    ),
    index("payment_transactions_state_updated_idx").on(
      table.state,
      table.updatedAt,
    ),
    index("payment_transactions_reconcile_idx").on(
      table.state,
      table.nextCheckAt,
    ),
  ],
);
