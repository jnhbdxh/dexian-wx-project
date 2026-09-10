import { and, eq } from "drizzle-orm";

import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import {
  permissions,
  rolePermissions,
  roles,
  staffRoleAssignments,
  staffUsers,
  stores,
} from "../db/schema.js";
import { hashPassword } from "../lib/crypto.js";
import { OPERATIONS_OVERVIEW_READ } from "../modules/operations/routes.js";
import { SCHEDULING_LEAVE_WRITE } from "../modules/scheduling/routes.js";
import { RECEPTIONS_CONFIRM } from "../modules/booking/routes.js";

const storeName = process.env.BOOTSTRAP_STORE_NAME?.trim();
const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

if (!storeName || !username || !password) {
  throw new Error(
    "BOOTSTRAP_STORE_NAME, BOOTSTRAP_ADMIN_USERNAME, and BOOTSTRAP_ADMIN_PASSWORD are required",
  );
}

const config = loadConfig();
const database = createDatabase(config);

try {
  await database.db.transaction(async (tx) => {
    let [store] = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.name, storeName))
      .limit(1);
    if (!store) {
      [store] = await tx
        .insert(stores)
        .values({ name: storeName })
        .returning({ id: stores.id });
    }
    if (!store) throw new Error("Failed to create store");

    const existingUser = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(eq(staffUsers.username, username))
      .limit(1);
    if (existingUser.length > 0) {
      throw new Error(`Admin username already exists: ${username}`);
    }

    const [role] = await tx
      .insert(roles)
      .values({ storeId: store.id, code: "store_admin", name: "门店管理员" })
      .onConflictDoUpdate({
        target: [roles.storeId, roles.code],
        set: { name: "门店管理员", updatedAt: new Date() },
      })
      .returning({ id: roles.id });
    if (!role) throw new Error("Failed to create administrator role");

    const permissionList = [
      { code: OPERATIONS_OVERVIEW_READ, name: "查看今日工作台" },
      { code: RECEPTIONS_CONFIRM, name: "确认接待" },
      { code: SCHEDULING_LEAVE_WRITE, name: "登记请假" },
      { code: "system.manage", name: "系统管理" },
      { code: "staff.manage", name: "员工管理" },
    ];
    await tx
      .insert(permissions)
      .values(permissionList)
      .onConflictDoNothing({ target: permissions.code });

    for (const permission of permissionList) {
      await tx
        .insert(rolePermissions)
        .values({ roleId: role.id, permissionCode: permission.code })
        .onConflictDoNothing();
    }

    const [user] = await tx
      .insert(staffUsers)
      .values({
        storeId: store.id,
        username,
        passwordHash: await hashPassword(password),
        displayName: "初始管理员",
      })
      .returning({ id: staffUsers.id });
    if (!user) throw new Error("Failed to create administrator");

    await tx.insert(staffRoleAssignments).values({
      staffUserId: user.id,
      roleId: role.id,
    });
  });

  console.log(`Created local administrator: ${username}`);
} finally {
  await database.pool.end();
}
