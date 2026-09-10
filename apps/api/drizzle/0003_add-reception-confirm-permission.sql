INSERT INTO "permissions" ("code", "name")
VALUES ('receptions.confirm', '确认接待')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
SELECT "id", 'receptions.confirm'
FROM "roles"
WHERE "code" = 'store_admin'
ON CONFLICT DO NOTHING;
