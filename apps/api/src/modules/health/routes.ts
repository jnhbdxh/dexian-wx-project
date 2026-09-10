import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { Database } from "../../db/client.js";

interface HealthOptions {
  database: Database;
}

export const healthRoutes: FastifyPluginAsyncTypebox<HealthOptions> = async (
  app,
  options,
) => {
  app.get(
    "/health/live",
    {
      schema: {
        response: {
          200: Type.Object({ status: Type.Literal("ok") }),
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        response: {
          200: Type.Object({
            status: Type.Literal("ready"),
            database: Type.Literal("ok"),
          }),
        },
      },
    },
    async () => {
      await options.database.pool.query("select 1");
      return { status: "ready" as const, database: "ok" as const };
    },
  );
};
