CREATE TYPE "public"."resource_conflict_status" AS ENUM('pending', 'resolved');--> statement-breakpoint
ALTER TYPE "public"."reception_state" ADD VALUE 'invalidated' BEFORE 'cancelled';--> statement-breakpoint
ALTER TABLE "resource_restrictions" ADD CONSTRAINT "resource_restrictions_store_id_id_unique" UNIQUE("store_id","id");--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_store_id_id_unique" UNIQUE("store_id","id");--> statement-breakpoint
CREATE TABLE "resource_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"restriction_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"status" "resource_conflict_status" DEFAULT 'pending' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_staff_id" uuid,
	"resolution_note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_conflicts_store_id_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "resource_conflicts_restriction_reception_unique" UNIQUE("restriction_id","reception_id"),
	CONSTRAINT "resource_conflicts_resolution_state_check" CHECK (("resource_conflicts"."status" = 'pending' AND "resource_conflicts"."resolved_at" IS NULL AND "resource_conflicts"."resolved_by_staff_id" IS NULL)
        OR ("resource_conflicts"."status" = 'resolved' AND "resource_conflicts"."resolved_at" IS NOT NULL AND "resource_conflicts"."resolved_by_staff_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "resource_conflicts" ADD CONSTRAINT "resource_conflicts_resource_fk" FOREIGN KEY ("store_id","resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_conflicts" ADD CONSTRAINT "resource_conflicts_restriction_fk" FOREIGN KEY ("store_id","restriction_id") REFERENCES "public"."resource_restrictions"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_conflicts" ADD CONSTRAINT "resource_conflicts_reception_fk" FOREIGN KEY ("store_id","reception_id") REFERENCES "public"."receptions"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_conflicts" ADD CONSTRAINT "resource_conflicts_resolved_by_fk" FOREIGN KEY ("store_id","resolved_by_staff_id") REFERENCES "public"."staff_users"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resource_conflicts_store_status_detected_idx" ON "resource_conflicts" USING btree ("store_id","status","detected_at");--> statement-breakpoint
INSERT INTO "permissions" ("code", "name")
VALUES ('scheduling.leave.write', '登记请假')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'scheduling.leave.write'
FROM "roles"
WHERE "code" = 'store_admin'
ON CONFLICT DO NOTHING;
