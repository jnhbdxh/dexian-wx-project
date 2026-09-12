import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { bridgePaymentMigration0006 } from "../src/db/payment-migration-bridge.js";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const expectedMigration0006Hash =
  "2e8efd8e2d4b5ecb932fac2bf691c249676753dfcd9ec6826a78793d37b848fc";

interface Journal {
  entries: Array<{ idx: number; when: number; tag: string }>;
}

async function applyMigrationsThrough0005(pool: Pool) {
  const journal = JSON.parse(
    await readFile(`${migrationsFolder}/meta/_journal.json`, "utf8"),
  ) as Journal;
  await pool.query("CREATE SCHEMA drizzle");
  await pool.query(`
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  for (const entry of journal.entries.filter((item) => item.idx <= 5)) {
    const sql = await readFile(`${migrationsFolder}/${entry.tag}.sql`, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [createHash("sha256").update(sql).digest("hex"), entry.when],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

describe.runIf(hasDatabase)("payment database upgrade", () => {
  it("migrates a populated 0005 database through the staged bridge", async () => {
    const sourceUrl = new URL(process.env.DATABASE_URL!);
    const databaseName = `dexian_payment_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = `/${databaseName}`;
    const adminPool = new Pool({ connectionString: adminUrl.toString() });
    let targetPool: Pool | undefined;
    try {
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
      targetPool = new Pool({ connectionString: targetUrl.toString() });
      await applyMigrationsThrough0005(targetPool);

      const [storeId, customerId, receptionId, orderId, paymentId] = Array.from(
        { length: 5 },
        () => randomUUID(),
      ) as [string, string, string, string, string];
      await targetPool.query(
        "INSERT INTO stores (id, name) VALUES ($1, '历史门店')",
        [storeId],
      );
      await targetPool.query(
        "INSERT INTO customers (id, display_name) VALUES ($1, '历史顾客')",
        [customerId],
      );
      await targetPool.query(
        `INSERT INTO receptions (
           id, store_id, customer_id, state, quote_cents
         ) VALUES ($1, $2, $3, 'confirmed', 32800)`,
        [receptionId, storeId, customerId],
      );
      await targetPool.query(
        `INSERT INTO orders (
           id, store_id, customer_id, reception_id, payable_cents,
           currency, quote_snapshot
         ) VALUES ($1, $2, $3, $4, 32800, 'CNY', '{}'::jsonb)`,
        [orderId, storeId, customerId, receptionId],
      );
      await targetPool.query(
        `INSERT INTO payment_transactions (
           id, order_id, channel, state, out_trade_no, amount_cents,
           currency, payer_open_id, prepay_id
         ) VALUES (
           $1, $2, 'wechat', 'processing', $3, 32800,
           'CNY', 'legacy-open-id', 'legacy-prepay-id'
         )`,
        [paymentId, orderId, paymentId.replaceAll("-", "")],
      );

      expect(await bridgePaymentMigration0006(targetPool)).toBe(true);
      await migrate(drizzle(targetPool), { migrationsFolder });

      const originalMigration = await readFile(
        `${migrationsFolder}/0006_classy_cloak.sql`,
      );
      expect(createHash("sha256").update(originalMigration).digest("hex")).toBe(
        expectedMigration0006Hash,
      );
      const upgraded = await targetPool.query<{
        collection_deadline: Date;
        state: string;
        prepay_id: string | null;
        prepay_expires_at: Date | null;
        last_error_code: string | null;
      }>(
        `SELECT orders.collection_deadline, payment.state,
                payment.prepay_id, payment.prepay_expires_at,
                payment.last_error_code
           FROM payment_transactions AS payment
           JOIN orders ON orders.id = payment.order_id
          WHERE payment.id = $1`,
        [paymentId],
      );
      expect(upgraded.rows[0]).toMatchObject({
        collection_deadline: expect.any(Date),
        state: "manual_review",
        prepay_id: null,
        prepay_expires_at: null,
        last_error_code: "LEGACY_COLLECTION_DEADLINE_UNKNOWN",
      });
      const migrationHashes = await targetPool.query<{ hash: string }>(
        `SELECT hash
           FROM drizzle.__drizzle_migrations
          ORDER BY created_at`,
      );
      expect(migrationHashes.rows.map((row) => row.hash)).toContain(
        expectedMigration0006Hash,
      );
      const permissions = await targetPool.query<{ count: string }>(
        `SELECT count(*)
           FROM permissions
          WHERE code IN ('payments.review.read', 'payments.review.reconcile')`,
      );
      expect(permissions.rows[0]?.count).toBe("2");
      expect(await bridgePaymentMigration0006(targetPool)).toBe(false);
    } finally {
      await targetPool?.end();
      await adminPool.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await adminPool.end();
    }
  });
});
