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
