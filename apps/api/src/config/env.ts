import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

export type AppEnvironment = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: AppEnvironment;
  host: string;
  port: number;
  adminWebOrigin: string;
  databaseUrl: string;
  bookingTokenSecret: string;
  secureCookies: boolean;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`API_PORT must be an integer between 1 and 65535`);
  }
  return port;
}

export function loadConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppEnvironment;
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  const bookingTokenSecret = required("BOOKING_TOKEN_SECRET");
  if (bookingTokenSecret.length < 32) {
    throw new Error("BOOKING_TOKEN_SECRET must contain at least 32 characters");
  }

  return {
    nodeEnv,
    host: process.env.API_HOST?.trim() || "127.0.0.1",
    port: parsePort(process.env.API_PORT ?? "3000"),
    adminWebOrigin:
      process.env.ADMIN_WEB_ORIGIN?.trim() || "http://localhost:5173",
    databaseUrl: required("DATABASE_URL"),
    bookingTokenSecret,
    secureCookies: process.env.SESSION_COOKIE_SECURE === "true",
  };
}
