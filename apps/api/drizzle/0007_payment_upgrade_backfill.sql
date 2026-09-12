UPDATE "payment_transactions"
   SET "prepay_id" = NULL,
       "prepay_expires_at" = NULL
 WHERE "prepay_expires_at" = '-infinity'::timestamptz;--> statement-breakpoint
INSERT INTO "permissions" ("code", "name") VALUES
  ('payments.review.read', '查看异常支付'),
  ('payments.review.reconcile', '重新查询异常支付')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "roles"."id", "permission"."code"
  FROM "roles"
 CROSS JOIN (VALUES
   ('payments.review.read'),
   ('payments.review.reconcile')
 ) AS "permission"("code")
 WHERE "roles"."code" = 'store_admin'
ON CONFLICT DO NOTHING;
