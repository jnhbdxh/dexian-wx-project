import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { createDevelopmentCustomerSession } from "./service.js";

interface CustomerAuthOptions {
  config: AppConfig;
  database: Database;
}

export const customerAuthRoutes: FastifyPluginAsyncTypebox<
  CustomerAuthOptions
> = async (app, options) => {
  if (options.config.nodeEnv === "production") {
    return;
  }

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
