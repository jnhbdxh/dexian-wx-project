import { and, eq } from "drizzle-orm";

import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { permissions, rolePermissions, roles } from "../db/schema.js";
import {
  BOOKING_POLICY_PUBLISH,
  BOOKING_POLICY_READ,
  BOOKING_POLICY_WRITE,
} from "../modules/booking-policy/routes.js";

const storeId = process.env.BOOKING_POLICY_GRANT_STORE_ID?.trim();
const roleCode = process.env.BOOKING_POLICY_GRANT_ROLE_CODE?.trim();
if (!storeId || !roleCode) {
  throw new Error(
    "BOOKING_POLICY_GRANT_STORE_ID and BOOKING_POLICY_GRANT_ROLE_CODE are required",
  );
}

const permissionList = [
  { code: BOOKING_POLICY_READ, name: "查看预约政策" },
  { code: BOOKING_POLICY_WRITE, name: "编辑预约政策草稿" },
  { code: BOOKING_POLICY_PUBLISH, name: "发布预约政策" },
];
const config = loadConfig();
const database = createDatabase(config);

try {
  await database.db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.storeId, storeId), eq(roles.code, roleCode)))
      .limit(1);
    if (!role) {
      throw new Error(`Role ${roleCode} was not found in store ${storeId}`);
    }
    await tx
      .insert(permissions)
      .values(permissionList)
      .onConflictDoNothing({ target: permissions.code });
    await tx
      .insert(rolePermissions)
      .values(
        permissionList.map((permission) => ({
          roleId: role.id,
          permissionCode: permission.code,
        })),
      )
      .onConflictDoNothing();
  });
  console.log(`Granted booking policy permissions to ${storeId}/${roleCode}`);
} finally {
  await database.pool.end();
}
