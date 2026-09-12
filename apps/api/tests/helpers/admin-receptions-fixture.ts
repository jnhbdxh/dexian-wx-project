import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db/client.js";
import { hashPassword, hashToken } from "../../src/lib/crypto.js";

export async function createAdminReceptionFixture(database: Database) {
  const id = randomUUID();
  const storeId = randomUUID();
  const customerId = randomUUID();
  const therapistId = randomUUID();
  const roomId = randomUUID();
  const bedId = randomUUID();
  const serviceId = randomUUID();
  const customerToken = `customer-${id}`;
  const password = `Test-only-${id}`;
  await database.pool.query(
    `INSERT INTO stores (id, name, default_prepare_minutes, default_therapist_cleanup_minutes,
    default_facility_cleanup_minutes, default_rest_minutes) VALUES ($1, $2, 10, 5, 15, 20)`,
    [storeId, `接待测试店-${id}`],
  );
  await database.pool.query(
    "INSERT INTO customers (id, display_name) VALUES ($1, '林女士（测试）')",
    [customerId],
  );
  await database.pool.query(
    "INSERT INTO customer_sessions (customer_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
    [customerId, hashToken(customerToken)],
  );
  await database.pool.query(
    "INSERT INTO resources (id, store_id, resource_type, name) VALUES ($1,$2,'therapist','小满'),($3,$2,'room','青竹房')",
    [therapistId, storeId, roomId],
  );
  await database.pool.query(
    "INSERT INTO resources (id,store_id,resource_type,parent_resource_id,name) VALUES ($1,$2,'bed',$3,'一号床')",
    [bedId, storeId, roomId],
  );
  await database.pool.query(
    `INSERT INTO service_items (id,store_id,name,duration_minutes,price_cents) VALUES ($1,$2,'舒缓护理',60,9500)`,
    [serviceId, storeId],
  );
  await database.pool.query(
    "INSERT INTO therapist_service_items (store_id,therapist_resource_id,service_item_id) VALUES ($1,$2,$3)",
    [storeId, therapistId, serviceId],
  );
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(15, 30, 0, 0);
  await database.pool.query(
    "INSERT INTO resource_shifts (store_id,therapist_resource_id,start_at,end_at) VALUES ($1,$2,$3,$4)",
    [
      storeId,
      therapistId,
      new Date(start.getTime() - 86400000),
      new Date(start.getTime() + 3 * 86400000),
    ],
  );
  const staffIds: string[] = [];
  async function staff(label: string, permissions: string[]) {
    const staffId = randomUUID();
    const roleId = randomUUID();
    const token = `staff-${staffId}`;
    const csrf = `csrf-${staffId}`;
    const username = `${label}-${id}`;
    staffIds.push(staffId);
    await database.pool.query(
      "INSERT INTO staff_users (id,store_id,username,password_hash,display_name) VALUES ($1,$2,$3,$4,$5)",
      [staffId, storeId, username, await hashPassword(password), label],
    );
    await database.pool.query(
      "INSERT INTO roles (id,store_id,code,name) VALUES ($1,$2,$3,$3)",
      [roleId, storeId, label],
    );
    for (const permission of permissions) {
      await database.pool.query(
        "INSERT INTO permissions (code,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
        [permission],
      );
      await database.pool.query(
        "INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,$2)",
        [roleId, permission],
      );
    }
    await database.pool.query(
      "INSERT INTO staff_role_assignments (staff_user_id,role_id) VALUES ($1,$2)",
      [staffId, roleId],
    );
    await database.pool.query(
      "INSERT INTO staff_sessions (staff_user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
      [staffId, hashToken(token), hashToken(csrf)],
    );
    return {
      staffId,
      username,
      csrf,
      headers: {
        cookie: `dexian_admin_session=${token}; dexian_admin_csrf=${csrf}`,
        "x-csrf-token": csrf,
      },
    };
  }
  const manager = await staff("值班店长", [
    "operations.overview.read",
    "receptions.confirm",
    "scheduling.leave.write",
    "payments.review.read",
    "payments.review.reconcile",
    "booking.policy.read",
    "booking.policy.write",
    "booking.policy.publish",
  ]);
  const reader = await staff("查询前台", ["operations.overview.read"]);
  const denied = await staff("无权限员工", []);
  async function cleanup() {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM business_events WHERE actor_id = ANY($1::uuid[]) OR actor_id IN (SELECT id FROM receptions WHERE store_id=$2)",
        [[customerId, ...staffIds], storeId],
      );
      await client.query("DELETE FROM resource_conflicts WHERE store_id=$1", [
        storeId,
      ]);
      await client.query("DELETE FROM resource_allocations WHERE store_id=$1", [
        storeId,
      ]);
      await client.query(
        "DELETE FROM payment_transactions WHERE order_id IN (SELECT id FROM orders WHERE store_id=$1)",
        [storeId],
      );
      await client.query("DELETE FROM orders WHERE store_id=$1", [storeId]);
      await client.query("DELETE FROM reception_guests WHERE store_id=$1", [
        storeId,
      ]);
      await client.query("DELETE FROM receptions WHERE store_id=$1", [storeId]);
      await client.query(
        "DELETE FROM resource_restrictions WHERE store_id=$1",
        [storeId],
      );
      await client.query("DELETE FROM resource_shifts WHERE store_id=$1", [
        storeId,
      ]);
      await client.query(
        "DELETE FROM therapist_service_items WHERE store_id=$1",
        [storeId],
      );
      await client.query("DELETE FROM service_items WHERE store_id=$1", [
        storeId,
      ]);
      await client.query(
        "DELETE FROM resources WHERE store_id=$1 AND parent_resource_id IS NOT NULL",
        [storeId],
      );
      await client.query("DELETE FROM resources WHERE store_id=$1", [storeId]);
      await client.query(
        "DELETE FROM login_audits WHERE actor_type='staff' AND actor_id=ANY($1::uuid[])",
        [staffIds],
      );
      await client.query(
        "DELETE FROM booking_policy_revisions WHERE store_id=$1",
        [storeId],
      );
      await client.query("DELETE FROM staff_users WHERE store_id=$1", [
        storeId,
      ]);
      await client.query("DELETE FROM roles WHERE store_id=$1", [storeId]);
      await client.query(
        "DELETE FROM customer_phone_bindings WHERE customer_id=$1",
        [customerId],
      );
      await client.query("DELETE FROM customer_sessions WHERE customer_id=$1", [
        customerId,
      ]);
      await client.query("DELETE FROM customers WHERE id=$1", [customerId]);
      await client.query("DELETE FROM stores WHERE id=$1", [storeId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    id,
    storeId,
    customerId,
    customerToken,
    therapistId,
    roomId,
    bedId,
    serviceId,
    start,
    manager,
    reader,
    denied,
    password,
    cleanup,
  };
}
