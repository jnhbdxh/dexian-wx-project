import {
  createCipheriv,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildWechatPaymentParameters,
  decryptWechatPayResource,
  WechatPayHttpGateway,
} from "../src/integrations/wechat/payment.js";

describe("WeChat Pay cryptography", () => {
  it("signs the exact Mini Program payment message", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const parameters = buildWechatPaymentParameters(
      "wx-test-app",
      "wx-prepay-id",
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "1720000000",
      "fixed-nonce",
    );

    expect(parameters).toMatchObject({
      timeStamp: "1720000000",
      nonceStr: "fixed-nonce",
      package: "prepay_id=wx-prepay-id",
      signType: "RSA",
    });
    expect(
      createVerify("RSA-SHA256")
        .update(
          "wx-test-app\n1720000000\nfixed-nonce\nprepay_id=wx-prepay-id\n",
        )
        .verify(publicKey, parameters.paySign, "base64"),
    ).toBe(true);
  });

  it("decrypts an API v3 AES-256-GCM resource", () => {
    const apiV3Key = "12345678901234567890123456789012";
    const nonce = randomBytes(12).toString("base64url").slice(0, 12);
    const associatedData = "transaction";
    const plaintext = JSON.stringify({ trade_state: "SUCCESS" });
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(apiV3Key),
      Buffer.from(nonce),
    );
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");

    expect(
      decryptWechatPayResource(apiV3Key, {
        algorithm: "AEAD_AES_256_GCM",
        ciphertext,
        nonce,
        associated_data: associatedData,
      }),
    ).toBe(plaintext);
  });

  it("verifies the raw callback before decrypting and mapping it", () => {
    const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wechatKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const directory = mkdtempSync(join(tmpdir(), "dexian-wechat-pay-"));
    const merchantKeyPath = join(directory, "merchant.pem");
    const wechatPublicKeyPath = join(directory, "wechat.pem");
    writeFileSync(
      merchantKeyPath,
      merchantKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    writeFileSync(
      wechatPublicKeyPath,
      wechatKeys.publicKey.export({ type: "spki", format: "pem" }),
    );

    try {
      const apiV3Key = "12345678901234567890123456789012";
      const resourceNonce = "123456789012";
      const associatedData = "transaction";
      const resourceValue = {
        appid: "wx-test-app",
        mchid: "1900000001",
        out_trade_no: "merchant-order-1",
        transaction_id: "wechat-transaction-1",
        trade_state: "SUCCESS",
        success_time: "2026-09-11T10:00:00+08:00",
        payer: { openid: "payer-open-id" },
        amount: { total: 32800, currency: "CNY" },
      };
      const cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(apiV3Key),
        Buffer.from(resourceNonce),
      );
      cipher.setAAD(Buffer.from(associatedData));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(resourceValue)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
      const body = JSON.stringify({
        event_type: "TRANSACTION.SUCCESS",
        resource: {
          algorithm: "AEAD_AES_256_GCM",
          ciphertext,
          nonce: resourceNonce,
          associated_data: associatedData,
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const callbackNonce = "callback-nonce";
      const signature = createSign("RSA-SHA256")
        .update(`${timestamp}\n${callbackNonce}\n${body}\n`)
        .sign(wechatKeys.privateKey, "base64");
      const gateway = new WechatPayHttpGateway({
        appId: "wx-test-app",
        merchantId: "1900000001",
        merchantCertificateSerial: "merchant-serial",
        merchantPrivateKeyPath: merchantKeyPath,
        wechatPayPublicKeyId: "PUB_KEY_ID_test",
        wechatPayPublicKeyPath: wechatPublicKeyPath,
        apiV3Key,
        notifyUrl: "https://example.test/notify",
        apiBaseUrl: "https://api.mch.weixin.qq.com",
        collectionGraceMinutes: 120,
      });

      expect(
        gateway.verifyAndDecryptNotification({
          body,
          timestamp,
          nonce: callbackNonce,
          signature,
          serial: "PUB_KEY_ID_test",
        }),
      ).toEqual({
        appId: "wx-test-app",
        merchantId: "1900000001",
        outTradeNo: "merchant-order-1",
        transactionId: "wechat-transaction-1",
        tradeState: "SUCCESS",
        successTime: "2026-09-11T10:00:00+08:00",
        payerOpenId: "payer-open-id",
        amountCents: 32800,
        currency: "CNY",
      });
      expect(() =>
        gateway.verifyAndDecryptNotification({
          body: `${body} `,
          timestamp,
          nonce: callbackNonce,
          signature,
          serial: "PUB_KEY_ID_test",
        }),
      ).toThrow("Invalid WeChat Pay signature");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
