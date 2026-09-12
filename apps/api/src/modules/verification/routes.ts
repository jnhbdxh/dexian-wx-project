import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { SmsGateway } from "../../integrations/sms/gateway.js";
import { AppError } from "../../lib/app-error.js";
import { requireCustomerSession } from "../auth/service.js";
import { confirmPhoneVerification, sendPhoneVerification } from "./service.js";

interface VerificationOptions {
  config: AppConfig;
  database: Database;
  smsGateway?: SmsGateway;
}

const Uuid = Type.String({ format: "uuid" });

export const verificationRoutes: FastifyPluginAsyncTypebox<
  VerificationOptions
> = async (app, options) => {
  app.post(
    "/api/v1/customer/phone-verifications",
    {
      schema: {
        body: Type.Object({
          phone: Type.String({ minLength: 11, maxLength: 24 }),
        }),
        response: {
          202: Type.Object({
            verificationId: Uuid,
            expiresAt: Type.String({ format: "date-time" }),
            nextSendAt: Type.String({ format: "date-time" }),
            debugCode: Type.Optional(Type.String({ pattern: "^\\d{6}$" })),
          }),
        },
      },
    },
    async (request, reply) => {
      const identity = await requireCustomerSession(
        options.database,
        request.headers.authorization,
      );
      if (!options.smsGateway) {
        throw new AppError(
          503,
          "SMS_NOT_CONFIGURED",
          "短信服务尚未配置，请联系管理员",
        );
      }
      const result = await sendPhoneVerification(
        options.database,
        options.smsGateway,
        options.config.smsCodeSecret,
        identity.customerId,
        request.body.phone,
      );
      return reply.code(202).send({
        verificationId: result.verificationId,
        expiresAt: result.expiresAt.toISOString(),
        nextSendAt: result.nextSendAt.toISOString(),
        ...(options.config.nodeEnv === "development"
          ? { debugCode: result.code }
          : {}),
      });
    },
  );

  app.post(
    "/api/v1/customer/phone-verifications/:verificationId/confirm",
    {
      schema: {
        params: Type.Object({ verificationId: Uuid }),
        body: Type.Object({
          code: Type.String({ pattern: "^\\d{6}$" }),
        }),
        response: {
          200: Type.Object({
            bindingId: Uuid,
            phone: Type.String(),
            verifiedAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      const identity = await requireCustomerSession(
        options.database,
        request.headers.authorization,
      );
      const result = await confirmPhoneVerification(
        options.database,
        options.config.smsCodeSecret,
        identity.customerId,
        request.params.verificationId,
        request.body.code,
      );
      return { ...result, verifiedAt: result.verifiedAt.toISOString() };
    },
  );
};
