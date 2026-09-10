import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";
import type { Database } from "../src/db/client.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  adminWebOrigin: "http://localhost:5173",
  databaseUrl: "postgres://unused",
  bookingTokenSecret: "test-only-booking-token-secret-32-chars",
  secureCookies: false,
};

const database = {
  pool: { query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) },
  db: {},
} as unknown as Database;

describe("health routes", () => {
  it("reports the process as alive", async () => {
    const app = await buildApp({ config, database, logger: false });
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("checks database readiness", async () => {
    const app = await buildApp({ config, database, logger: false });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", database: "ok" });
    await app.close();
  });
});
