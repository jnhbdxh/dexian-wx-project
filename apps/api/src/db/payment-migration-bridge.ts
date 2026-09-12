import type { Pool } from "pg";

const PAYMENT_MIGRATION_LOCK_KEY = 2_026_091_106;
const PAYMENT_MIGRATION_0005_HASH =
  "e8d91475634022eef4945cfae1a45f7eeb0e5cd0a91fad83bd0bf3eb85453fc8";
const PAYMENT_MIGRATION_0005_CREATED_AT = "1789091648954";
const PAYMENT_MIGRATION_0006_HASH =
  "2e8efd8e2d4b5ecb932fac2bf691c249676753dfcd9ec6826a78793d37b848fc";
const PAYMENT_MIGRATION_0006_CREATED_AT = "1789094460740";

export async function bridgePaymentMigration0006(pool: Pool) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [
      PAYMENT_MIGRATION_LOCK_KEY,
    ]);
    const table = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS table_name",
    );
    if (!table.rows[0]?.table_name) return false;

    const latest = await client.query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at
         FROM drizzle.__drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    const migration = latest.rows[0];
    if (migration?.created_at !== PAYMENT_MIGRATION_0005_CREATED_AT) {
      return false;
    }
    if (migration.hash !== PAYMENT_MIGRATION_0005_HASH) {
      throw new Error(
        "Migration 0005 hash does not match the supported payment upgrade path",
      );
    }

    // PostgreSQL requires the enum addition to commit before a later
    // transaction can store the new value.
    await client.query(
      `ALTER TYPE "public"."payment_transaction_state"
         ADD VALUE IF NOT EXISTS 'manual_review'`,
    );

    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(`
      ALTER TABLE "orders"
        ADD COLUMN "collection_deadline" timestamp with time zone;
      ALTER TABLE "payment_transactions"
        ADD COLUMN "prepay_expires_at" timestamp with time zone,
        ADD COLUMN "next_check_at" timestamp with time zone,
        ADD COLUMN "check_attempts" integer DEFAULT 0 NOT NULL,
        ADD COLUMN "lease_token" uuid,
        ADD COLUMN "lease_until" timestamp with time zone;

      UPDATE "orders"
         SET "collection_deadline" = COALESCE(
           (
             SELECT MAX("reception_guests"."service_end_at")
               FROM "reception_guests"
              WHERE "reception_guests"."reception_id" = "orders"."reception_id"
           ),
           "orders"."created_at"
         );

      UPDATE "payment_transactions"
         SET "prepay_id" = NULL,
             "prepay_expires_at" = NULL;

      UPDATE "payment_transactions"
         SET "state" = 'manual_review',
             "next_check_at" = NULL,
             "last_error_code" = 'LEGACY_COLLECTION_DEADLINE_UNKNOWN',
             "last_error_message" = '历史订单的收款宽限时间尚未确认，需要人工复核',
             "updated_at" = clock_timestamp()
       WHERE "state" IN ('created', 'processing', 'unknown');

      ALTER TABLE "orders"
        ALTER COLUMN "collection_deadline" SET NOT NULL;
      CREATE INDEX "payment_transactions_reconcile_idx"
        ON "payment_transactions" USING btree ("state", "next_check_at");
      ALTER TABLE "payment_transactions"
        ADD CONSTRAINT "payment_transactions_prepay_pair_check"
          CHECK (("prepay_id" IS NULL) = ("prepay_expires_at" IS NULL)),
        ADD CONSTRAINT "payment_transactions_lease_pair_check"
          CHECK (("lease_token" IS NULL) = ("lease_until" IS NULL)),
        ADD CONSTRAINT "payment_transactions_check_attempts_nonnegative_check"
          CHECK ("check_attempts" >= 0);

      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES ('${PAYMENT_MIGRATION_0006_HASH}', ${PAYMENT_MIGRATION_0006_CREATED_AT});
    `);
    await client.query("COMMIT");
    transactionOpen = false;
    return true;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [
      PAYMENT_MIGRATION_LOCK_KEY,
    ]);
    client.release();
  }
}
