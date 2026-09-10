import { migrate } from "drizzle-orm/node-postgres/migrator";

import { loadConfig } from "../config/env.js";
import { createDatabase } from "./client.js";

const config = loadConfig();
const database = createDatabase(config);

try {
  await migrate(database.db, { migrationsFolder: "./drizzle" });
  console.log("Database migrations completed");
} finally {
  await database.pool.end();
}
