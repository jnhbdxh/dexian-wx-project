import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { loginAudits } from "../../db/schema.js";
import {
  type WechatMiniProgramGateway,
  WechatMiniProgramRequestError,
} from "../../integrations/wechat/miniprogram.js";
import { AppError } from "../../lib/app-error.js";
import {
  createDevelopmentCustomerSession,
  createWechatCustomerSession,
} from "./service.js";

interface CustomerAuthOptions {
  config: AppConfig;
  database: Database;
  wechatMiniProgramGateway?: WechatMiniProgramGateway;
}

export const customerAuthRoutes: FastifyPluginAsyncTypebox<
  CustomerAuthOptions
> = async (app, options) => {
  app.post(
    "/api/v1/customer/auth/wechat-login",
    {
      schema: {
        body: Type.Object({
          code: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        response: {
          200: Type.Object({
            accessToken: Type.String(),
            customerId: Type.String({ format: "uuid" }),
            expiresAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      if (
        !options.config.wechatMiniProgram ||
        !options.wechatMiniProgramGateway
      ) {
        throw new AppError(
          503,
          "WECHAT_LOGIN_NOT_CONFIGURED",
          "微信登录尚未配置，请联系管理员",
        );
      }
      let result;
      try {
        result = await options.wechatMiniProgramGateway.exchangeCode(
          request.body.code,
        );
      } catch (error) {
        await options.database.db.insert(loginAudits).values({
          actorType: "customer",
          identifier: "wechat_code",
          succeeded: false,
          requestId: request.id,
          ipAddress: request.ip,
        });
        if (
          error instanceof WechatMiniProgramRequestError &&
          error.kind === "credential"
        ) {
          throw new AppError(
            401,
            "WECHAT_LOGIN_FAILED",
            "微信登录凭证无效或已过期，请重新进入小程序",
            { channelCode: error.channelCode },
          );
        }
        throw new AppError(
          503,
          "WECHAT_LOGIN_UNAVAILABLE",
          "微信登录服务暂时不可用，请稍后重试",
          {
            channelCode:
              error instanceof WechatMiniProgramRequestError
                ? error.channelCode
                : undefined,
          },
        );
      }
      const session = await createWechatCustomerSession(
        options.database,
        options.config.wechatMiniProgram.appId,
        result.openId,
        result.unionId,
      );
      await options.database.db.insert(loginAudits).values({
        actorType: "customer",
        actorId: session.customerId,
        identifier: "wechat_openid",
        succeeded: true,
        requestId: request.id,
        ipAddress: request.ip,
      });
      return {
        accessToken: session.token,
        customerId: session.customerId,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  if (options.config.nodeEnv === "production") return;

  app.post(
    "/api/v1/customer/auth/dev-login",
    {
      schema: {
        body: Type.Object({
          externalId: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^[A-Za-z0-9_-]+$",
          }),
        }),
        response: {
          200: Type.Object({
            accessToken: Type.String(),
            customerId: Type.String({ format: "uuid" }),
            expiresAt: Type.String({ format: "date-time" }),
          }),
        },
      },
    },
    async (request) => {
      const session = await createDevelopmentCustomerSession(
        options.database,
        request.body.externalId,
      );
      return {
        accessToken: session.token,
        customerId: session.customerId,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );
};
