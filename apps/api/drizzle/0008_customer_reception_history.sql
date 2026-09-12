CREATE INDEX "receptions_customer_created_idx" ON "receptions" USING btree ("customer_id","created_at","id");
