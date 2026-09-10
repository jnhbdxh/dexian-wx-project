import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { AppConfig } from "../config/env.js";
import * as schema from "./schema.js";

export function createDatabase(config: AppConfig) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDatabase>;
