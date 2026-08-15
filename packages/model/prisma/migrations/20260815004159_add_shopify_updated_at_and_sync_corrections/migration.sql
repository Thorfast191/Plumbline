-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "shopify_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "sync_corrections" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_corrections_account_id_idx" ON "sync_corrections"("account_id");

-- CreateIndex
CREATE INDEX "sync_corrections_store_id_detected_at_idx" ON "sync_corrections"("store_id", "detected_at");

-- AddForeignKey
ALTER TABLE "sync_corrections" ADD CONSTRAINT "sync_corrections_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level tenant isolation, same pattern as every other tenant-scoped
-- table (see 20260815003202_add_account_id_and_rls). New tables created by
-- the migrate/superuser role inherit plumbline_app's SELECT/INSERT/UPDATE/
-- DELETE grant via the ALTER DEFAULT PRIVILEGES set up alongside that role,
-- so no explicit GRANT is needed here.
ALTER TABLE "sync_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_corrections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync_corrections"
  USING (account_id = current_setting('app.current_account_id', true));
