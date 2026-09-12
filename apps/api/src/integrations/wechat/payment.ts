import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";

import type { WechatPayConfig } from "../../config/env.js";

const JSAPI_PATH = "/v3/pay/transactions/jsapi";

export interface WechatPayCreateInput {
  description: string;
  outTradeNo: string;
  amountCents: number;
  payerOpenId: string;
  attach: string;
  timeExpire: string;
}

export interface WechatPaymentParameters {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
}

export interface WechatPaymentNotification {
  appId: string;
  merchantId: string;
  outTradeNo: string;
  transactionId: string;
  tradeState: string;
  successTime: string;
  payerOpenId: string;
  amountCents: number;
  currency: string;
}

export interface WechatPayOrder {
  appId: string;
  merchantId: string;
  outTradeNo: string;
  tradeState: string;
  tradeStateDescription: string;
  transactionId?: string;
  successTime?: string;
  payerOpenId: string;
  amountCents: number;
  currency: string;
}

export interface WechatPayGateway {
  createJsapiPayment(
    input: WechatPayCreateInput,
  ): Promise<{ prepayId: string; paymentParameters: WechatPaymentParameters }>;
  buildPaymentParameters(prepayId: string): WechatPaymentParameters;
  queryPayment(outTradeNo: string): Promise<WechatPayOrder | null>;
  closePayment(outTradeNo: string): Promise<void>;
  verifyAndDecryptNotification(input: {
    body: string;
    timestamp: string;
    nonce: string;
    signature: string;
    serial: string;
  }): WechatPaymentNotification;
}

export class WechatPayRequestError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly channelCode: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function nonce() {
  return randomBytes(16).toString("hex");
}

function sign(message: string, privateKey: string) {
  return createSign("RSA-SHA256").update(message).sign(privateKey, "base64");
}

export function buildWechatPaymentParameters(
  appId: string,
  prepayId: string,
  privateKey: string,
  timestamp = String(Math.floor(Date.now() / 1_000)),
  nonceStr = nonce(),
): WechatPaymentParameters {
  const packageValue = `prepay_id=${prepayId}`;
  return {
    timeStamp: timestamp,
    nonceStr,
    package: packageValue,
    signType: "RSA",
    paySign: sign(
      `${appId}\n${timestamp}\n${nonceStr}\n${packageValue}\n`,
      privateKey,
    ),
  };
}

export function decryptWechatPayResource(
  apiV3Key: string,
  resource: {
    algorithm: string;
    ciphertext: string;
    nonce: string;
    associated_data?: string;
  },
) {
  if (resource.algorithm !== "AEAD_AES_256_GCM") {
    throw new Error("Unsupported WeChat Pay notification algorithm");
  }
  const encrypted = Buffer.from(resource.ciphertext, "base64");
  if (encrypted.length < 16) throw new Error("Invalid encrypted notification");
  const authTag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf8"),
    Buffer.from(resource.nonce, "utf8"),
  );
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(resource.associated_data ?? "", "utf8"));
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export class WechatPayHttpGateway implements WechatPayGateway {
  private readonly privateKey: string;
  private readonly wechatPayPublicKey: string;

  constructor(private readonly config: WechatPayConfig) {
    this.privateKey = readFileSync(config.merchantPrivateKeyPath, "utf8");
    this.wechatPayPublicKey = readFileSync(
      config.wechatPayPublicKeyPath,
      "utf8",
    );
  }

  async createJsapiPayment(input: WechatPayCreateInput) {
    const body = JSON.stringify({
      appid: this.config.appId,
      mchid: this.config.merchantId,
      description: input.description,
      out_trade_no: input.outTradeNo,
      notify_url: this.config.notifyUrl,
      amount: { total: input.amountCents, currency: "CNY" },
      payer: { openid: input.payerOpenId },
      attach: input.attach,
      time_expire: input.timeExpire,
    });
    const result = (await this.request("POST", JSAPI_PATH, body)) as {
      prepay_id?: string;
    };
    if (!result.prepay_id)
      throw new Error("WeChat Pay did not return prepay_id");

    return {
      prepayId: result.prepay_id,
      paymentParameters: buildWechatPaymentParameters(
        this.config.appId,
        result.prepay_id,
        this.privateKey,
      ),
    };
  }

  buildPaymentParameters(prepayId: string) {
    return buildWechatPaymentParameters(
      this.config.appId,
      prepayId,
      this.privateKey,
    );
  }

  async queryPayment(outTradeNo: string): Promise<WechatPayOrder | null> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.config.merchantId)}`;
    let value: {
      appid?: string;
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      trade_state_desc?: string;
      success_time?: string;
      payer?: { openid?: string };
      amount?: { total?: number; currency?: string };
    };
    try {
      value = (await this.request("GET", path, "")) as typeof value;
    } catch (error) {
      if (
        error instanceof WechatPayRequestError &&
        error.statusCode === 404 &&
        error.channelCode === "ORDER_NOT_EXIST"
      ) {
        return null;
      }
      throw error;
    }
    if (
      !value.appid ||
      !value.mchid ||
      !value.out_trade_no ||
      !value.trade_state ||
      !value.trade_state_desc ||
      !value.payer?.openid ||
      !Number.isInteger(value.amount?.total) ||
      !value.amount?.currency
    ) {
      throw new Error("WeChat Pay order query is missing required fields");
    }
    return {
      appId: value.appid,
      merchantId: value.mchid,
      outTradeNo: value.out_trade_no,
      tradeState: value.trade_state,
      tradeStateDescription: value.trade_state_desc,
      ...(value.transaction_id ? { transactionId: value.transaction_id } : {}),
      ...(value.success_time ? { successTime: value.success_time } : {}),
      payerOpenId: value.payer.openid,
      amountCents: value.amount.total!,
      currency: value.amount.currency,
    };
  }

  async closePayment(outTradeNo: string) {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    await this.request(
      "POST",
      path,
      JSON.stringify({ mchid: this.config.merchantId }),
    );
  }

  verifyAndDecryptNotification(input: {
    body: string;
    timestamp: string;
    nonce: string;
    signature: string;
    serial: string;
  }): WechatPaymentNotification {
    this.verifyWechatSignature(
      input.body,
      input.timestamp,
      input.nonce,
      input.signature,
      input.serial,
    );
    const envelope = JSON.parse(input.body) as {
      event_type?: string;
      resource?: {
        algorithm: string;
        ciphertext: string;
        nonce: string;
        associated_data?: string;
      };
    };
    if (envelope.event_type !== "TRANSACTION.SUCCESS" || !envelope.resource) {
      throw new Error("Unsupported WeChat Pay notification type");
    }
    const value = JSON.parse(
      decryptWechatPayResource(this.config.apiV3Key, envelope.resource),
    ) as {
      appid?: string;
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      success_time?: string;
      payer?: { openid?: string };
      amount?: { total?: number; currency?: string };
    };
    if (
      !value.appid ||
      !value.mchid ||
      !value.out_trade_no ||
      !value.transaction_id ||
      !value.trade_state ||
      !value.success_time ||
      !value.payer?.openid ||
      !Number.isInteger(value.amount?.total) ||
      !value.amount?.currency
    ) {
      throw new Error("WeChat Pay notification is missing required fields");
    }
    return {
      appId: value.appid,
      merchantId: value.mchid,
      outTradeNo: value.out_trade_no,
      transactionId: value.transaction_id,
      tradeState: value.trade_state,
      successTime: value.success_time,
      payerOpenId: value.payer.openid,
      amountCents: value.amount.total!,
      currency: value.amount.currency,
    };
  }

  private async request(method: "GET" | "POST", path: string, body: string) {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const requestNonce = nonce();
    const signature = sign(
      `${method}\n${path}\n${timestamp}\n${requestNonce}\n${body}\n`,
      this.privateKey,
    );
    const authorization =
      "WECHATPAY2-SHA256-RSA2048 " +
      `mchid="${this.config.merchantId}",nonce_str="${requestNonce}",` +
      `timestamp="${timestamp}",serial_no="${this.config.merchantCertificateSerial}",` +
      `signature="${signature}"`;

    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: authorization,
          "User-Agent": "dexian-api/0.1.0",
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new WechatPayRequestError(
        undefined,
        undefined,
        error instanceof Error ? error.message : "WeChat Pay request failed",
      );
    }

    const responseBody = await response.text();
    this.verifyWechatSignature(
      responseBody,
      response.headers.get("wechatpay-timestamp"),
      response.headers.get("wechatpay-nonce"),
      response.headers.get("wechatpay-signature"),
      response.headers.get("wechatpay-serial"),
    );
    const value = responseBody
      ? (JSON.parse(responseBody) as {
          code?: string;
          message?: string;
          [key: string]: unknown;
        })
      : {};
    if (!response.ok) {
      throw new WechatPayRequestError(
        response.status,
        value.code,
        value.message || `WeChat Pay returned HTTP ${response.status}`,
      );
    }
    return value;
  }

  private verifyWechatSignature(
    body: string,
    timestamp: string | null,
    responseNonce: string | null,
    signature: string | null,
    serial: string | null,
  ) {
    if (!timestamp || !responseNonce || !signature || !serial) {
      throw new Error("WeChat Pay signature headers are missing");
    }
    if (serial !== this.config.wechatPayPublicKeyId) {
      throw new Error("Unexpected WeChat Pay public key ID");
    }
    const timestampSeconds = Number(timestamp);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(Date.now() / 1_000 - timestampSeconds) > 300
    ) {
      throw new Error(
        "WeChat Pay signature timestamp is outside the allowed window",
      );
    }
    const valid = createVerify("RSA-SHA256")
      .update(`${timestamp}\n${responseNonce}\n${body}\n`)
      .verify(this.wechatPayPublicKey, signature, "base64");
    if (!valid) throw new Error("Invalid WeChat Pay signature");
  }
}
