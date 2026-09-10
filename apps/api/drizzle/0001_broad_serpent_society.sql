CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TYPE "public"."allocation_segment_kind" AS ENUM('prepare', 'service', 'cleanup', 'rest');--> statement-breakpoint
CREATE TYPE "public"."allocation_state" AS ENUM('held', 'confirmed', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."reception_state" AS ENUM('pending', 'confirmed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('room', 'bed', 'therapist', 'equipment');--> statement-breakpoint
CREATE TYPE "public"."restriction_kind" AS ENUM('leave', 'meal_break', 'training', 'store_closed', 'equipment_fault', 'other_unavailable');--> statement-breakpoint
CREATE TABLE "business_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reception_guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"client_guest_id" text NOT NULL,
	"service_item_id" uuid NOT NULL,
	"therapist_resource_id" uuid NOT NULL,
	"room_resource_id" uuid NOT NULL,
	"bed_resource_id" uuid NOT NULL,
	"service_start_at" timestamp with time zone NOT NULL,
	"service_end_at" timestamp with time zone NOT NULL,
	"quote_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reception_guests_store_reception_id_unique" UNIQUE("store_id","reception_id","id"),
	CONSTRAINT "reception_guests_client_id_unique" UNIQUE("reception_id","client_guest_id"),
	CONSTRAINT "reception_guests_service_period_check" CHECK ("reception_guests"."service_end_at" > "reception_guests"."service_start_at")
);
--> statement-breakpoint
CREATE TABLE "receptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"state" "reception_state" NOT NULL,
	"confirmation_deadline" timestamp with time zone,
	"quote_cents" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receptions_store_id_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "receptions_deadline_state_check" CHECK (("receptions"."state" = 'pending' AND "receptions"."confirmation_deadline" IS NOT NULL) OR ("receptions"."state" <> 'pending' AND "receptions"."confirmation_deadline" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "resource_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"reception_guest_id" uuid,
	"segment_kind" "allocation_segment_kind" NOT NULL,
	"allocation_state" "allocation_state" NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"inactive_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_allocations_period_check" CHECK ("resource_allocations"."end_at" > "resource_allocations"."start_at"),
	CONSTRAINT "resource_allocations_expiry_state_check" CHECK (("resource_allocations"."allocation_state" = 'held' AND "resource_allocations"."expires_at" IS NOT NULL) OR ("resource_allocations"."allocation_state" <> 'held' AND "resource_allocations"."expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "resource_allocations" ADD COLUMN "occupied_range" tstzrange GENERATED ALWAYS AS (tstzrange("start_at", "end_at", '[)')) STORED;--> statement-breakpoint
ALTER TABLE "resource_allocations" ADD CONSTRAINT "normal_resource_allocation_no_overlap" EXCLUDE USING gist (
	"resource_id" WITH =,
	"occupied_range" WITH &&
) WHERE ("allocation_state" IN ('held', 'confirmed'));--> statement-breakpoint
CREATE TABLE "resource_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"resource_id" uuid,
	"restriction_kind" "restriction_kind" NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"reason_private" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_restrictions_period_check" CHECK ("resource_restrictions"."end_at" > "resource_restrictions"."start_at"),
	CONSTRAINT "resource_restrictions_scope_check" CHECK (("resource_restrictions"."restriction_kind" = 'store_closed' AND "resource_restrictions"."resource_id" IS NULL) OR ("resource_restrictions"."restriction_kind" <> 'store_closed' AND "resource_restrictions"."resource_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "resource_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"therapist_resource_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_shifts_period_check" CHECK ("resource_shifts"."end_at" > "resource_shifts"."start_at")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"parent_resource_id" uuid,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_store_id_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "resources_parent_not_self_check" CHECK ("resources"."parent_resource_id" IS NULL OR "resources"."parent_resource_id" <> "resources"."id")
);
--> statement-breakpoint
CREATE TABLE "service_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"prepare_minutes" integer DEFAULT 0 NOT NULL,
	"cleanup_minutes" integer DEFAULT 0 NOT NULL,
	"rest_minutes" integer DEFAULT 0 NOT NULL,
	"price_cents" integer NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_items_store_id_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "service_items_duration_positive_check" CHECK ("service_items"."duration_minutes" > 0),
	CONSTRAINT "service_items_nonnegative_offsets_check" CHECK ("service_items"."prepare_minutes" >= 0 AND "service_items"."cleanup_minutes" >= 0 AND "service_items"."rest_minutes" >= 0),
	CONSTRAINT "service_items_price_nonnegative_check" CHECK ("service_items"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "therapist_service_items" (
	"store_id" uuid NOT NULL,
	"therapist_resource_id" uuid NOT NULL,
	"service_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "therapist_service_items_therapist_resource_id_service_item_id_pk" PRIMARY KEY("therapist_resource_id","service_item_id")
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "lock_key" integer NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "stores_lock_key_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "timezone" text DEFAULT 'Asia/Shanghai' NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD CONSTRAINT "reception_guests_reception_fk" FOREIGN KEY ("store_id","reception_id") REFERENCES "public"."receptions"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD CONSTRAINT "reception_guests_service_fk" FOREIGN KEY ("store_id","service_item_id") REFERENCES "public"."service_items"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD CONSTRAINT "reception_guests_therapist_fk" FOREIGN KEY ("store_id","therapist_resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD CONSTRAINT "reception_guests_room_fk" FOREIGN KEY ("store_id","room_resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD CONSTRAINT "reception_guests_bed_fk" FOREIGN KEY ("store_id","bed_resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_resource_fk" FOREIGN KEY ("store_id","resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_reception_fk" FOREIGN KEY ("store_id","reception_id") REFERENCES "public"."receptions"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_guest_fk" FOREIGN KEY ("store_id","reception_id","reception_guest_id") REFERENCES "public"."reception_guests"("store_id","reception_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_restrictions" ADD CONSTRAINT "resource_restrictions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_restrictions" ADD CONSTRAINT "resource_restrictions_resource_fk" FOREIGN KEY ("store_id","resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_shifts" ADD CONSTRAINT "resource_shifts_therapist_fk" FOREIGN KEY ("store_id","therapist_resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_store_parent_fk" FOREIGN KEY ("store_id","parent_resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapist_service_items" ADD CONSTRAINT "therapist_service_items_therapist_fk" FOREIGN KEY ("store_id","therapist_resource_id") REFERENCES "public"."resources"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapist_service_items" ADD CONSTRAINT "therapist_service_items_service_fk" FOREIGN KEY ("store_id","service_item_id") REFERENCES "public"."service_items"("store_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "validate_resource_parent_type"() RETURNS trigger AS $$
DECLARE
	parent_type resource_type;
BEGIN
	IF NEW.resource_type = 'bed' THEN
		IF NEW.parent_resource_id IS NULL THEN
			RAISE EXCEPTION 'bed resource must belong to a room' USING ERRCODE = '23514';
		END IF;
		SELECT resource_type INTO parent_type
		FROM resources
		WHERE store_id = NEW.store_id AND id = NEW.parent_resource_id;
		IF parent_type IS DISTINCT FROM 'room'::resource_type THEN
			RAISE EXCEPTION 'bed parent resource must be a room in the same store' USING ERRCODE = '23514';
		END IF;
	ELSIF NEW.resource_type IN ('room', 'therapist') AND NEW.parent_resource_id IS NOT NULL THEN
		RAISE EXCEPTION 'room and therapist resources cannot have a parent' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "resources_parent_type_check"
AFTER INSERT OR UPDATE OF store_id, resource_type, parent_resource_id ON "resources"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_resource_parent_type"();--> statement-breakpoint
CREATE FUNCTION "validate_allocation_guest_scope"() RETURNS trigger AS $$
DECLARE
	allocated_resource_type resource_type;
BEGIN
	SELECT resource_type INTO allocated_resource_type
	FROM resources
	WHERE store_id = NEW.store_id AND id = NEW.resource_id;
	IF allocated_resource_type IN ('therapist', 'bed') AND NEW.reception_guest_id IS NULL THEN
		RAISE EXCEPTION 'therapist and bed allocations must belong to a reception guest' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "resource_allocations_guest_scope_check"
AFTER INSERT OR UPDATE OF store_id, resource_id, reception_guest_id ON "resource_allocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_allocation_guest_scope"();--> statement-breakpoint
CREATE UNIQUE INDEX "business_events_idempotency_unique" ON "business_events" USING btree ("actor_type","actor_id","operation_type","idempotency_key");--> statement-breakpoint
CREATE INDEX "receptions_pending_deadline_idx" ON "receptions" USING btree ("store_id","state","confirmation_deadline");--> statement-breakpoint
CREATE INDEX "resource_allocations_reception_idx" ON "resource_allocations" USING btree ("reception_id");--> statement-breakpoint
CREATE INDEX "resource_allocations_resource_period_idx" ON "resource_allocations" USING btree ("resource_id","start_at","end_at");--> statement-breakpoint
CREATE INDEX "resource_restrictions_lookup_idx" ON "resource_restrictions" USING btree ("store_id","resource_id","start_at","end_at");--> statement-breakpoint
CREATE INDEX "resource_shifts_lookup_idx" ON "resource_shifts" USING btree ("store_id","therapist_resource_id","start_at","end_at");--> statement-breakpoint
CREATE INDEX "resources_store_type_active_idx" ON "resources" USING btree ("store_id","resource_type","active");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_lock_key_unique" ON "stores" USING btree ("lock_key");
