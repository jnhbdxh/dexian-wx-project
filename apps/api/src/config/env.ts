import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

export type AppEnvironment = "development" | "test" | "production";

export interface WechatMiniProgramConfig {
  appId: string;
  appSecret: string;
}

export interface WechatPayConfig {
  appId: string;
  merchantId: string;
  merchantCertificateSerial: string;
  merchantPrivateKeyPath: string;
  wechatPayPublicKeyId: string;
  wechatPayPublicKeyPath: string;
  apiV3Key: string;
  notifyUrl: string;
  apiBaseUrl: string;
  collectionGraceMinutes: number;
}

export interface AppConfig {
  nodeEnv: AppEnvironment;
  host: string;
  port: number;
  adminWebOrigin: string;
  databaseUrl: string;
  bookingTokenSecret: string;
  smsCodeSecret: string;
  secureCookies: boolean;
  wechatMiniProgram?: WechatMiniProgramConfig;
  wechatPay?: WechatPayConfig;
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

function parseNonnegativeInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return parsed;
}

function optionalGroup<T>(
  names: readonly string[],
  build: (values: Record<string, string>) => T,
): T | undefined {
  const values = Object.fromEntries(
    names.map((name) => [name, process.env[name]?.trim() ?? ""]),
  );
  if (names.every((name) => !values[name])) return undefined;

  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(
      `Integration configuration is incomplete: ${missing.join(", ")}`,
    );
  }
  return build(values);
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

  const smsCodeSecret =
    process.env.SMS_CODE_SECRET?.trim() ||
    (nodeEnv === "production"
      ? required("SMS_CODE_SECRET")
      : bookingTokenSecret);
  if (smsCodeSecret.length < 32) {
    throw new Error("SMS_CODE_SECRET must contain at least 32 characters");
  }

  const wechatMiniProgram = optionalGroup(
    ["WECHAT_MINIPROGRAM_APP_ID", "WECHAT_MINIPROGRAM_APP_SECRET"],
    (values) => ({
      appId: values.WECHAT_MINIPROGRAM_APP_ID!,
      appSecret: values.WECHAT_MINIPROGRAM_APP_SECRET!,
    }),
  );
  const wechatPay = optionalGroup(
    [
      "WECHAT_PAY_APP_ID",
      "WECHAT_PAY_MERCHANT_ID",
      "WECHAT_PAY_MERCHANT_CERT_SERIAL",
      "WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH",
      "WECHAT_PAY_PUBLIC_KEY_ID",
      "WECHAT_PAY_PUBLIC_KEY_PATH",
      "WECHAT_PAY_API_V3_KEY",
      "WECHAT_PAY_NOTIFY_URL",
      "PAYMENT_COLLECTION_GRACE_MINUTES",
    ],
    (values) => ({
      appId: values.WECHAT_PAY_APP_ID!,
      merchantId: values.WECHAT_PAY_MERCHANT_ID!,
      merchantCertificateSerial: values.WECHAT_PAY_MERCHANT_CERT_SERIAL!,
      merchantPrivateKeyPath: values.WECHAT_PAY_MERCHANT_PRIVATE_KEY_PATH!,
      wechatPayPublicKeyId: values.WECHAT_PAY_PUBLIC_KEY_ID!,
      wechatPayPublicKeyPath: values.WECHAT_PAY_PUBLIC_KEY_PATH!,
      apiV3Key: values.WECHAT_PAY_API_V3_KEY!,
      notifyUrl: values.WECHAT_PAY_NOTIFY_URL!,
      apiBaseUrl:
        process.env.WECHAT_PAY_API_BASE_URL?.trim() ||
        "https://api.mch.weixin.qq.com",
      collectionGraceMinutes: parseNonnegativeInteger(
        "PAYMENT_COLLECTION_GRACE_MINUTES",
        values.PAYMENT_COLLECTION_GRACE_MINUTES!,
      ),
    }),
  );

  if (wechatPay && wechatPay.apiV3Key.length !== 32) {
    throw new Error("WECHAT_PAY_API_V3_KEY must contain exactly 32 characters");
  }
  if (
    nodeEnv === "production" &&
    wechatPay &&
    !wechatPay.notifyUrl.startsWith("https://")
  ) {
    throw new Error("WECHAT_PAY_NOTIFY_URL must use HTTPS in production");
  }

  return {
    nodeEnv,
    host: process.env.API_HOST?.trim() || "127.0.0.1",
    port: parsePort(process.env.API_PORT ?? "3000"),
    adminWebOrigin:
      process.env.ADMIN_WEB_ORIGIN?.trim() || "http://localhost:5173",
    databaseUrl: required("DATABASE_URL"),
    bookingTokenSecret,
    smsCodeSecret,
    secureCookies: process.env.SESSION_COOKIE_SECURE === "true",
    ...(wechatMiniProgram ? { wechatMiniProgram } : {}),
    ...(wechatPay ? { wechatPay } : {}),
  };
}
