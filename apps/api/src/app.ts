import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import {
  TypeBoxTypeProvider,
  type FastifyPluginAsyncTypebox,
} from "@fastify/type-provider-typebox";
import Fastify from "fastify";

import type { AppConfig } from "./config/env.js";
import type { Database } from "./db/client.js";
import {
  ConsoleSmsGateway,
  type SmsGateway,
} from "./integrations/sms/gateway.js";
import {
  WechatMiniProgramHttpGateway,
  type WechatMiniProgramGateway,
} from "./integrations/wechat/miniprogram.js";
import {
  WechatPayHttpGateway,
  type WechatPayGateway,
} from "./integrations/wechat/payment.js";
import { AppError } from "./lib/app-error.js";
import { adminAuthRoutes } from "./modules/auth/admin-routes.js";
import { customerAuthRoutes } from "./modules/auth/customer-routes.js";
import { bookingRoutes } from "./modules/booking/routes.js";
import { bookingPolicyRoutes } from "./modules/booking-policy/routes.js";
import { healthRoutes } from "./modules/health/routes.js";
import { operationsRoutes } from "./modules/operations/routes.js";
import { adminReceptionRoutes } from "./modules/operations/reception-routes.js";
import { paymentRoutes } from "./modules/payment/routes.js";
import { schedulingRoutes } from "./modules/scheduling/routes.js";
import { verificationRoutes } from "./modules/verification/routes.js";

export interface AppOptions {
  config: AppConfig;
  database: Database;
  logger?: boolean;
  smsGateway?: SmsGateway;
  wechatMiniProgramGateway?: WechatMiniProgramGateway;
  wechatPayGateway?: WechatPayGateway;
}

const rootRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              name: { type: "string" },
              stage: { type: "string" },
            },
            required: ["name", "stage"],
          },
        },
      },
    },
    async () => ({ name: "dexian-api", stage: "stage-0" }),
  );
};

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: "x-request-id",
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cookie);
  await app.register(cors, {
    origin: options.config.adminWebOrigin,
    credentials: true,
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError =
      error instanceof Error ? error : new Error("Unknown request error");
    const possibleStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode =
      typeof possibleStatus === "number" ? possibleStatus : 500;
    request.log.error({ error: normalizedError }, "Request failed");
    return reply.code(statusCode).send({
      code:
        error instanceof AppError
          ? error.code
          : statusCode >= 500
            ? "INTERNAL_ERROR"
            : "REQUEST_INVALID",
      message:
        error instanceof AppError
          ? error.message
          : statusCode >= 500
            ? "系统暂时无法处理，请稍后重试"
            : normalizedError.message,
      requestId: request.id,
      details: error instanceof AppError ? error.details : {},
    });
  });

  await app.register(rootRoutes);
  await app.register(healthRoutes, { database: options.database });
  const smsGateway =
    options.smsGateway ??
    (options.config.nodeEnv === "development"
      ? new ConsoleSmsGateway()
      : undefined);
  const wechatMiniProgramGateway =
    options.wechatMiniProgramGateway ??
    (options.config.wechatMiniProgram
      ? new WechatMiniProgramHttpGateway(options.config.wechatMiniProgram)
      : undefined);
  const wechatPayGateway =
    options.wechatPayGateway ??
    (options.config.wechatPay
      ? new WechatPayHttpGateway(options.config.wechatPay)
      : undefined);

  await app.register(adminAuthRoutes, options);
  await app.register(operationsRoutes, { database: options.database });
  await app.register(adminReceptionRoutes, { database: options.database });
  await app.register(customerAuthRoutes, {
    ...options,
    ...(wechatMiniProgramGateway ? { wechatMiniProgramGateway } : {}),
  });
  await app.register(bookingRoutes, options);
  await app.register(bookingPolicyRoutes, options);
  await app.register(schedulingRoutes, options);
  await app.register(verificationRoutes, {
    ...options,
    ...(smsGateway ? { smsGateway } : {}),
  });
  await app.register(paymentRoutes, {
    ...options,
    ...(wechatPayGateway ? { wechatPayGateway } : {}),
  });

  return app;
}
