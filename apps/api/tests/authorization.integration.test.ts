import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import {
  permissions,
  rolePermissions,
  roles,
  staffRoleAssignments,
  staffSessions,
  staffUsers,
  stores,
} from "../src/db/schema.js";
import { hashToken } from "../src/lib/crypto.js";
import { OPERATIONS_OVERVIEW_READ } from "../src/modules/operations/routes.js";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const suffix = randomUUID();
const allowedToken = `allowed-${suffix}`;
const deniedToken = `denied-${suffix}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let database: Database;
let storeId = "";
let roleId = "";
const userIds: string[] = [];

describe.runIf(hasDatabase)("operations authorization", () => {
  beforeAll(async () => {
    config = loadConfig();
    database = createDatabase(config);

    const [store] = await database.db
      .insert(stores)
      .values({ name: `鉴权测试门店-${suffix}` })
      .returning({ id: stores.id });
    if (!store) throw new Error("Failed to create authorization test store");
    storeId = store.id;

    const users = await database.db
      .insert(staffUsers)
      .values([
        {
          storeId,
          username: `allowed-${suffix}`,
          passwordHash: "not-used-by-this-test",
          displayName: "有权限员工",
        },
        {
          storeId,
          username: `denied-${suffix}`,
          passwordHash: "not-used-by-this-test",
          displayName: "无权限员工",
        },
      ])
      .returning({ id: staffUsers.id, username: staffUsers.username });
    userIds.push(...users.map((user) => user.id));

    const allowedUser = users.find((user) =>
      user.username.startsWith("allowed-"),
    );
    const deniedUser = users.find((user) =>
      user.username.startsWith("denied-"),
    );
    if (!allowedUser || !deniedUser) {
      throw new Error("Failed to create authorization test users");
    }

    const [role] = await database.db
      .insert(roles)
      .values({ storeId, code: "overview_reader", name: "工作台查看者" })
      .returning({ id: roles.id });
    if (!role) throw new Error("Failed to create authorization test role");
    roleId = role.id;

    await database.db
      .insert(permissions)
      .values({ code: OPERATIONS_OVERVIEW_READ, name: "查看今日工作台" })
      .onConflictDoNothing({ target: permissions.code });
    await database.db.insert(rolePermissions).values({
      roleId,
      permissionCode: OPERATIONS_OVERVIEW_READ,
    });
    await database.db.insert(staffRoleAssignments).values({
      staffUserId: allowedUser.id,
      roleId,
    });
    await database.db.insert(staffSessions).values([
      {
        staffUserId: allowedUser.id,
        tokenHash: hashToken(allowedToken),
        csrfTokenHash: hashToken(`csrf-${allowedToken}`),
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        staffUserId: deniedUser.id,
        tokenHash: hashToken(deniedToken),
        csrfTokenHash: hashToken(`csrf-${deniedToken}`),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    app = await buildApp({ config, database, logger: false });
  });

  afterAll(async () => {
    await app?.close();
    if (userIds.length > 0) {
      await database.db
        .delete(staffSessions)
        .where(inArray(staffSessions.staffUserId, userIds));
      await database.db
        .delete(staffRoleAssignments)
        .where(inArray(staffRoleAssignments.staffUserId, userIds));
    }
    if (roleId) {
      await database.db
        .delete(rolePermissions)
        .where(eq(rolePermissions.roleId, roleId));
      await database.db.delete(roles).where(eq(roles.id, roleId));
    }
    if (userIds.length > 0) {
      await database.db
        .delete(staffUsers)
        .where(inArray(staffUsers.id, userIds));
    }
    if (storeId) {
      await database.db.delete(stores).where(eq(stores.id, storeId));
    }
    const permissionCatalog = await database.db
      .select({ code: permissions.code })
      .from(permissions)
      .where(eq(permissions.code, OPERATIONS_OVERVIEW_READ));
    expect(permissionCatalog).toEqual([{ code: OPERATIONS_OVERVIEW_READ }]);
    await database.pool.end();
  });

  it("rejects a request without a session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/overview",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_REQUIRED");
  });

  it("protects reception queries with the same operations permission", async () => {
    const [anonymous, denied, allowed] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/admin/receptions?serviceDate=2026-09-11",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/admin/receptions?serviceDate=2026-09-11",
        headers: { cookie: `dexian_admin_session=${deniedToken}` },
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/admin/receptions?serviceDate=2026-09-11",
        headers: { cookie: `dexian_admin_session=${allowedToken}` },
      }),
    ]);

    expect(anonymous.statusCode).toBe(401);
    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      total: 0,
      items: [],
      nextCursor: null,
    });
  });

  it("rejects an authenticated employee without permission", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/overview",
      headers: { cookie: `dexian_admin_session=${deniedToken}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PERMISSION_DENIED");
  });

  it("allows an employee with the required permission", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/overview",
      headers: { cookie: `dexian_admin_session=${allowedToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().overview).toMatchObject({
      stage: "booking-confirmation",
      canConfirmReceptions: false,
      pendingConfirmations: [],
    });
    expect(response.json().overview.serverNow).toEqual(expect.any(String));
  });

  it("rejects a revoked session", async () => {
    await database.db
      .update(staffSessions)
      .set({ revokedAt: new Date() })
      .where(eq(staffSessions.tokenHash, hashToken(deniedToken)));

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/overview",
      headers: { cookie: `dexian_admin_session=${deniedToken}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_REQUIRED");
  });
});
