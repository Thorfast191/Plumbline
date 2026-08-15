/*
  Warnings:

  - Added the required column `account_id` to the `discounts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `account_id` to the `order_line_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `account_id` to the `refund_line_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `account_id` to the `sync_state` table without a default value. This is not possible if the table is not empty.
  - Added the required column `account_id` to the `webhook_events` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "discounts" ADD COLUMN     "account_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "order_line_items" ADD COLUMN     "account_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "refund_line_items" ADD COLUMN     "account_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "sync_state" ADD COLUMN     "account_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "account_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "discounts_account_id_idx" ON "discounts"("account_id");

-- CreateIndex
CREATE INDEX "order_line_items_account_id_idx" ON "order_line_items"("account_id");

-- CreateIndex
CREATE INDEX "refund_line_items_account_id_idx" ON "refund_line_items"("account_id");

-- CreateIndex
CREATE INDEX "sync_state_account_id_idx" ON "sync_state"("account_id");

-- CreateIndex
CREATE INDEX "webhook_events_account_id_idx" ON "webhook_events"("account_id");

-- Row-level tenant isolation (docs/BUILD-SPEC.md Gate 2 / docs/PLAN.md §9).
-- Every tenant-scoped table is filtered on account_id via the session-local
-- setting `app.current_account_id`, set per-request by
-- packages/model/src/client.ts withAccountContext(). This is enforced by
-- Postgres itself, not just application code, so a bug in a query builder
-- cannot leak another account's rows.
--
-- FORCE ROW LEVEL SECURITY (not just ENABLE) so even the table owner is
-- subject to the policy — the app connects as a normal role, not a
-- superuser, in any environment where isolation actually matters.

ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stores" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stores"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "orders"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "order_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_line_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_line_items"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refunds"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "refund_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refund_line_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refund_line_items"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "discounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "discounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "discounts"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "transactions"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customers"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "webhook_events"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "sync_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync_state"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "enrich_cogs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrich_cogs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "enrich_cogs"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "enrich_ad_spend" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrich_ad_spend" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "enrich_ad_spend"
  USING (account_id = current_setting('app.current_account_id', true));
