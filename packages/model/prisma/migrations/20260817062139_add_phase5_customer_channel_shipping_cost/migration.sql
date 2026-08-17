-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_id" TEXT,
ADD COLUMN     "referrer_channel" TEXT,
ADD COLUMN     "source_name" TEXT;

-- CreateTable
CREATE TABLE "enrich_shipping_cost" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "cost_minor" INTEGER NOT NULL,
    "currency_code" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "enrich_shipping_cost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrich_shipping_cost_account_id_idx" ON "enrich_shipping_cost"("account_id");

-- CreateIndex
CREATE INDEX "enrich_shipping_cost_store_id_effective_from_idx" ON "enrich_shipping_cost"("store_id", "effective_from");

-- CreateIndex
CREATE INDEX "orders_store_id_customer_id_idx" ON "orders"("store_id", "customer_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrich_shipping_cost" ADD CONSTRAINT "enrich_shipping_cost_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrich_shipping_cost" ADD CONSTRAINT "enrich_shipping_cost_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level tenant isolation, same pattern as every other tenant-scoped
-- table (see 20260815003202_add_account_id_and_rls).
ALTER TABLE "enrich_shipping_cost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrich_shipping_cost" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "enrich_shipping_cost"
  USING (account_id = current_setting('app.current_account_id', true));
