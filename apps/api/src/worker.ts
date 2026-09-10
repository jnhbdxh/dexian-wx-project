import { loadConfig } from "./config/env.js";
import { createDatabase } from "./db/client.js";

const config = loadConfig();
const database = createDatabase(config);

await database.pool.query("select 1");
console.log("Stage 0 worker is ready; business jobs are not enabled yet");

const heartbeat = setInterval(() => undefined, 60_000);

const shutdown = async () => {
  clearInterval(heartbeat);
  await database.pool.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
