CREATE TYPE "public"."payment_transaction_state" AS ENUM('created', 'processing', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."phone_verification_purpose" AS ENUM('bind_phone');--> statement-breakpoint
CREATE TABLE "customer_phone_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"verification_id" uuid NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"payable_cents" integer NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"quote_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_payable_positive_check" CHECK ("orders"."payable_cents" > 0),
	CONSTRAINT "orders_currency_check" CHECK ("orders"."currency" = 'CNY')
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"channel" text DEFAULT 'wechat' NOT NULL,
	"state" "payment_transaction_state" NOT NULL,
	"out_trade_no" text NOT NULL,
	"channel_transaction_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"payer_open_id" text NOT NULL,
	"prepay_id" text,
	"succeeded_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transactions_amount_positive_check" CHECK ("payment_transactions"."amount_cents" > 0),
	CONSTRAINT "payment_transactions_currency_check" CHECK ("payment_transactions"."currency" = 'CNY'),
	CONSTRAINT "payment_transactions_channel_check" CHECK ("payment_transactions"."channel" = 'wechat'),
	CONSTRAINT "payment_transactions_success_check" CHECK (("payment_transactions"."state" = 'succeeded' AND "payment_transactions"."channel_transaction_id" IS NOT NULL AND "payment_transactions"."succeeded_at" IS NOT NULL)
        OR ("payment_transactions"."state" <> 'succeeded' AND "payment_transactions"."succeeded_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sms_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"purpose" "phone_verification_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"attempts_remaining" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_send_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_verifications_attempts_nonnegative_check" CHECK ("sms_verifications"."attempts_remaining" >= 0)
);
--> statement-breakpoint
ALTER TABLE "customer_phone_bindings" ADD CONSTRAINT "customer_phone_bindings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_phone_bindings" ADD CONSTRAINT "customer_phone_bindings_verification_id_sms_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."sms_verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reception_id_receptions_id_fk" FOREIGN KEY ("reception_id") REFERENCES "public"."receptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_verifications" ADD CONSTRAINT "sms_verifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_phone_bindings_active_customer_unique" ON "customer_phone_bindings" USING btree ("customer_id") WHERE "customer_phone_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_phone_bindings_active_phone_unique" ON "customer_phone_bindings" USING btree ("phone") WHERE "customer_phone_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_phone_bindings_verification_unique" ON "customer_phone_bindings" USING btree ("verification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reception_unique" ON "orders" USING btree ("reception_id");--> statement-breakpoint
CREATE INDEX "orders_customer_created_idx" ON "orders" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_order_channel_unique" ON "payment_transactions" USING btree ("order_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_out_trade_no_unique" ON "payment_transactions" USING btree ("out_trade_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_channel_id_unique" ON "payment_transactions" USING btree ("channel_transaction_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_state_updated_idx" ON "payment_transactions" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "sms_verifications_customer_created_idx" ON "sms_verifications" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "sms_verifications_phone_created_idx" ON "sms_verifications" USING btree ("phone","created_at");