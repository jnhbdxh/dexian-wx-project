import { randomUUID } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import {
  customerSessions,
  customers,
  rolePermissions,
  roles,
  staffRoleAssignments,
  staffSessions,
  staffUsers,
  wechatIdentities,
} from "../../db/schema.js";
import { createToken, hashToken } from "../../lib/crypto.js";
import { AppError } from "../../lib/app-error.js";

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const CUSTOMER_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export const STAFF_SESSION_COOKIE = "dexian_admin_session";
export const STAFF_CSRF_COOKIE = "dexian_admin_csrf";

export async function createStaffSession(
  database: Database,
  staffUserId: string,
) {
  const token = createToken();
  const csrfToken = createToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await database.db.insert(staffSessions).values({
    staffUserId,
    tokenHash: hashToken(token),
    csrfTokenHash: hashToken(csrfToken),
    expiresAt,
  });

  return { token, csrfToken, expiresAt };
}

export async function findStaffSession(database: Database, token: string) {
  const [row] = await database.db
    .select({
      sessionId: staffSessions.id,
      csrfTokenHash: staffSessions.csrfTokenHash,
      expiresAt: staffSessions.expiresAt,
      staffUserId: staffUsers.id,
      storeId: staffUsers.storeId,
      username: staffUsers.username,
      displayName: staffUsers.displayName,
    })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffSessions.staffUserId, staffUsers.id))
    .where(
      and(
        eq(staffSessions.tokenHash, hashToken(token)),
        isNull(staffSessions.revokedAt),
        gt(staffSessions.expiresAt, new Date()),
        eq(staffUsers.active, true),
      ),
    )
    .limit(1);

  return row;
}

export async function revokeStaffSession(
  database: Database,
  sessionId: string,
) {
  await database.db
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(eq(staffSessions.id, sessionId));
}

export async function staffHasPermission(
  database: Database,
  staffUserId: string,
  storeId: string,
  permissionCode: string,
) {
  const [permission] = await database.db
    .select({ code: rolePermissions.permissionCode })
    .from(staffRoleAssignments)
    .innerJoin(
      roles,
      and(
        eq(staffRoleAssignments.roleId, roles.id),
        eq(roles.storeId, storeId),
      ),
    )
    .innerJoin(rolePermissions, eq(roles.id, rolePermissions.roleId))
    .where(
      and(
        eq(staffRoleAssignments.staffUserId, staffUserId),
        eq(rolePermissions.permissionCode, permissionCode),
      ),
    )
    .limit(1);

  return Boolean(permission);
}

export async function createDevelopmentCustomerSession(
  database: Database,
  externalId: string,
) {
  const appId = "development";
  const openId = `dev:${externalId}`;

  let [identity] = await database.db
    .select({ customerId: wechatIdentities.customerId })
    .from(wechatIdentities)
    .where(
      and(
        eq(wechatIdentities.appId, appId),
        eq(wechatIdentities.openId, openId),
      ),
    )
    .limit(1);

  if (!identity) {
    const [customer] = await database.db
      .insert(customers)
      .values({ displayName: `测试顾客 ${externalId}` })
      .returning({ id: customers.id });
    if (!customer) {
      throw new Error("Failed to create development customer");
    }
    [identity] = await database.db
      .insert(wechatIdentities)
      .values({ customerId: customer.id, appId, openId })
      .returning({ customerId: wechatIdentities.customerId });
  }

  if (!identity) {
    throw new Error("Failed to create development identity");
  }

  const token = createToken();
  const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_DURATION_MS);
  await database.db.insert(customerSessions).values({
    customerId: identity.customerId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return { token, customerId: identity.customerId, expiresAt };
}

export async function findCustomerSession(database: Database, token: string) {
  const [row] = await database.db
    .select({
      sessionId: customerSessions.id,
      customerId: customers.id,
      expiresAt: customerSessions.expiresAt,
    })
    .from(customerSessions)
    .innerJoin(customers, eq(customerSessions.customerId, customers.id))
    .where(
      and(
        eq(customerSessions.tokenHash, hashToken(token)),
        isNull(customerSessions.revokedAt),
        gt(customerSessions.expiresAt, new Date()),
        eq(customers.active, true),
      ),
    )
    .limit(1);

  return row;
}

export async function requireCustomerSession(
  database: Database,
  authorization: string | undefined,
) {
  const [scheme, token, extra] = authorization?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token || extra) {
    throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  }
  const session = await findCustomerSession(database, token);
  if (!session) {
    throw new AppError(401, "AUTH_REQUIRED", "登录已失效，请重新登录");
  }
  return session;
}

export async function createWechatCustomerSession(
  database: Database,
  appId: string,
  openId: string,
  unionId?: string,
) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ customer_id: string }>(
      `SELECT customer_id
         FROM wechat_identities
        WHERE app_id = $1 AND open_id = $2
        FOR UPDATE`,
      [appId, openId],
    );
    let customerId = existing.rows[0]?.customer_id;

    if (!customerId) {
      const candidateCustomerId = randomUUID();
      await client.query("INSERT INTO customers (id) VALUES ($1)", [
        candidateCustomerId,
      ]);
      const inserted = await client.query<{ customer_id: string }>(
        `INSERT INTO wechat_identities (customer_id, app_id, open_id, union_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (app_id, open_id) DO NOTHING
         RETURNING customer_id`,
        [candidateCustomerId, appId, openId, unionId ?? null],
      );
      customerId = inserted.rows[0]?.customer_id;
      if (!customerId) {
        await client.query("DELETE FROM customers WHERE id = $1", [
          candidateCustomerId,
        ]);
        const raced = await client.query<{ customer_id: string }>(
          `SELECT customer_id
             FROM wechat_identities
            WHERE app_id = $1 AND open_id = $2`,
          [appId, openId],
        );
        customerId = raced.rows[0]?.customer_id;
      }
    } else if (unionId) {
      await client.query(
        `UPDATE wechat_identities
            SET union_id = COALESCE(union_id, $3)
          WHERE app_id = $1 AND open_id = $2`,
        [appId, openId, unionId],
      );
    }

    if (!customerId) throw new Error("Failed to create WeChat identity");
    const token = createToken();
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_DURATION_MS);
    await client.query(
      `INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [customerId, hashToken(token), expiresAt],
    );
    await client.query("COMMIT");
    return { token, customerId, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
