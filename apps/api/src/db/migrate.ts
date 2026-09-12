import { migrate } from "drizzle-orm/node-postgres/migrator";

import { loadConfig } from "../config/env.js";
import { createDatabase } from "./client.js";
import { bridgePaymentMigration0006 } from "./payment-migration-bridge.js";

const config = loadConfig();
const database = createDatabase(config);

try {
  await bridgePaymentMigration0006(database.pool);
  await migrate(database.db, { migrationsFolder: "./drizzle" });
  console.log("Database migrations completed");
} finally {
  await database.pool.end();
}
