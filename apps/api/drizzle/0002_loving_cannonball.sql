DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "reception_guests" LIMIT 1) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Migration 0002 requires an empty reception_guests table',
			DETAIL = 'Historical booking rule snapshots cannot be reconstructed safely from current configuration.',
			HINT = 'Do not delete or fabricate history. Stop deployment and prepare a separately reviewed backfill migration from trustworthy source data.';
	END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "service_items" DROP CONSTRAINT "service_items_nonnegative_offsets_check";--> statement-breakpoint
ALTER TABLE "service_items" ALTER COLUMN "prepare_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "service_items" ALTER COLUMN "prepare_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "service_items" ALTER COLUMN "cleanup_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "service_items" ALTER COLUMN "cleanup_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "service_items" ALTER COLUMN "rest_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "service_items" ALTER COLUMN "rest_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "service_config_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "store_config_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "duration_minutes_snapshot" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "prepare_minutes_snapshot" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "therapist_cleanup_minutes_snapshot" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "facility_cleanup_minutes_snapshot" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "rest_minutes_snapshot" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reception_guests" ADD COLUMN "rule_snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "minimum_rest_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "facility_cleanup_minutes" integer;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "booking_config_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "default_prepare_minutes" integer;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "default_therapist_cleanup_minutes" integer;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "default_facility_cleanup_minutes" integer;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "default_rest_minutes" integer;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_minimum_rest_nonnegative_check" CHECK ("resources"."minimum_rest_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_nonnegative_offsets_check" CHECK (("service_items"."prepare_minutes" IS NULL OR "service_items"."prepare_minutes" >= 0)
        AND ("service_items"."cleanup_minutes" IS NULL OR "service_items"."cleanup_minutes" >= 0)
        AND ("service_items"."facility_cleanup_minutes" IS NULL OR "service_items"."facility_cleanup_minutes" >= 0)
        AND ("service_items"."rest_minutes" IS NULL OR "service_items"."rest_minutes" >= 0));--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_booking_defaults_nonnegative_check" CHECK (("stores"."default_prepare_minutes" IS NULL OR "stores"."default_prepare_minutes" >= 0)
        AND ("stores"."default_therapist_cleanup_minutes" IS NULL OR "stores"."default_therapist_cleanup_minutes" >= 0)
        AND ("stores"."default_facility_cleanup_minutes" IS NULL OR "stores"."default_facility_cleanup_minutes" >= 0)
        AND ("stores"."default_rest_minutes" IS NULL OR "stores"."default_rest_minutes" >= 0));
