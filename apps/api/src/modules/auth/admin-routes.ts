import { and, eq } from "drizzle-orm";
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { loginAudits, staffUsers } from "../../db/schema.js";
import { hashToken, verifyPassword } from "../../lib/crypto.js";
import {
  createStaffSession,
  findStaffSession,
  revokeStaffSession,
  STAFF_CSRF_COOKIE,
  STAFF_SESSION_COOKIE,
} from "./service.js";

interface AdminAuthOptions {
  config: AppConfig;
  database: Database;
}

const UserResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
  storeId: Type.String({ format: "uuid" }),
  username: Type.String(),
  displayName: Type.String(),
});

const ErrorResponse = Type.Object({
  code: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});

export const adminAuthRoutes: FastifyPluginAsyncTypebox<
  AdminAuthOptions
> = async (app, options) => {
  app.post(
    "/api/v1/admin/auth/login",
    {
      schema: {
        body: Type.Object({
          username: Type.String({ minLength: 1, maxLength: 100 }),
          password: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        response: {
          200: Type.Object({ user: UserResponse }),
          401: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const [user] = await options.database.db
        .select()
        .from(staffUsers)
        .where(
          and(
            eq(staffUsers.username, request.body.username),
            eq(staffUsers.active, true),
          ),
        )
        .limit(1);

      const passwordValid =
        user &&
        (await verifyPassword(request.body.password, user.passwordHash));

      await options.database.db.insert(loginAudits).values({
        actorType: "staff",
        actorId: passwordValid ? user.id : null,
        identifier: request.body.username,
        succeeded: Boolean(passwordValid),
        requestId: request.id,
        ipAddress: request.ip,
      });

      if (!user || !passwordValid) {
        return reply.code(401).send({
          code: "INVALID_CREDENTIALS",
          message: "账号或密码错误",
          requestId: request.id,
          details: {},
        });
      }

      const session = await createStaffSession(options.database, user.id);
      const cookieOptions = {
        httpOnly: true,
        sameSite: "strict" as const,
        secure: options.config.secureCookies,
        path: "/",
        expires: session.expiresAt,
      };
      reply.setCookie(STAFF_SESSION_COOKIE, session.token, cookieOptions);
      reply.setCookie(STAFF_CSRF_COOKIE, session.csrfToken, {
        ...cookieOptions,
        httpOnly: false,
      });

      return {
        user: {
          id: user.id,
          storeId: user.storeId,
          username: user.username,
          displayName: user.displayName,
        },
      };
    },
  );

  app.get(
    "/api/v1/admin/session",
    {
      schema: {
        response: {
          200: Type.Object({ user: UserResponse }),
          401: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[STAFF_SESSION_COOKIE];
      const session = token
        ? await findStaffSession(options.database, token)
        : undefined;
      if (!session) {
        return reply.code(401).send({
          code: "AUTH_REQUIRED",
          message: "请先登录",
          requestId: request.id,
          details: {},
        });
      }
      return {
        user: {
          id: session.staffUserId,
          storeId: session.storeId,
          username: session.username,
          displayName: session.displayName,
        },
      };
    },
  );

  app.post(
    "/api/v1/admin/auth/logout",
    {
      schema: {
        response: {
          204: Type.Null(),
          403: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[STAFF_SESSION_COOKIE];
      const csrfToken = request.headers["x-csrf-token"];
      const session = token
        ? await findStaffSession(options.database, token)
        : undefined;
      if (!session) {
        return reply.code(204).send(null);
      }
      if (
        typeof csrfToken !== "string" ||
        request.cookies[STAFF_CSRF_COOKIE] !== csrfToken ||
        hashToken(csrfToken) !== session.csrfTokenHash
      ) {
        return reply.code(403).send({
          code: "CSRF_INVALID",
          message: "页面状态已失效，请刷新后重试",
          requestId: request.id,
          details: {},
        });
      }
      await revokeStaffSession(options.database, session.sessionId);
      reply.clearCookie(STAFF_SESSION_COOKIE, { path: "/" });
      reply.clearCookie(STAFF_CSRF_COOKIE, { path: "/" });
      return reply.code(204).send(null);
    },
  );
};
