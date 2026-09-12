ALTER TYPE "public"."payment_transaction_state" ADD VALUE 'manual_review';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "collection_deadline" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "prepay_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "check_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_transactions_reconcile_idx" ON "payment_transactions" USING btree ("state","next_check_at");--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_prepay_pair_check" CHECK (("payment_transactions"."prepay_id" IS NULL) = ("payment_transactions"."prepay_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_lease_pair_check" CHECK (("payment_transactions"."lease_token" IS NULL) = ("payment_transactions"."lease_until" IS NULL));--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_check_attempts_nonnegative_check" CHECK ("payment_transactions"."check_attempts" >= 0);