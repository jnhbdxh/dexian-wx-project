CREATE TYPE "public"."booking_creation_mode" AS ENUM('legacy', 'paused_for_policy_activation', 'policy_enforced');--> statement-breakpoint
CREATE TYPE "public"."booking_policy_revision_kind" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "booking_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" "booking_policy_revision_kind" NOT NULL,
	"source_draft_revision_id" uuid,
	"published_version" integer,
	"base_published_version" integer,
	"payload" jsonb NOT NULL,
	"created_by_staff_id" uuid NOT NULL,
	"change_reason" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_policy_revisions_state_check" CHECK (("booking_policy_revisions"."kind" = 'draft' AND "booking_policy_revisions"."source_draft_revision_id" IS NULL AND "booking_policy_revisions"."published_version" IS NULL AND "booking_policy_revisions"."published_at" IS NULL)
        OR ("booking_policy_revisions"."kind" = 'published' AND "booking_policy_revisions"."published_version" IS NOT NULL AND "booking_policy_revisions"."published_version" > 0
          AND "booking_policy_revisions"."source_draft_revision_id" IS NOT NULL AND "booking_policy_revisions"."published_at" IS NOT NULL
          AND length(trim("booking_policy_revisions"."change_reason")) > 0)),
	CONSTRAINT "booking_policy_revisions_base_version_check" CHECK ("booking_policy_revisions"."base_published_version" IS NULL OR "booking_policy_revisions"."base_published_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "business_events" ADD COLUMN "request_payload" jsonb;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "booking_creation_mode" "booking_creation_mode" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_policy_revisions" ADD CONSTRAINT "booking_policy_revisions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_policy_revisions" ADD CONSTRAINT "booking_policy_revisions_created_by_fk" FOREIGN KEY ("store_id","created_by_staff_id") REFERENCES "public"."staff_users"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_policy_revisions_store_published_unique" ON "booking_policy_revisions" USING btree ("store_id","published_version") WHERE "booking_policy_revisions"."published_version" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "booking_policy_revisions_store_kind_created_idx" ON "booking_policy_revisions" USING btree ("store_id","kind","created_at","id");--> statement-breakpoint
INSERT INTO "permissions" ("code", "name") VALUES
  ('booking.policy.read', '查看预约政策'),
  ('booking.policy.write', '编辑预约政策草稿'),
  ('booking.policy.publish', '发布预约政策')
ON CONFLICT DO NOTHING;
