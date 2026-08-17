-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "recipient_emails" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "metric_id" TEXT,
    "comparator" TEXT,
    "threshold_minor" INTEGER,
    "sku" TEXT,
    "velocity_drop_percent" INTEGER,
    "cadence" TEXT NOT NULL,
    "recipient_emails" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_evaluated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_log" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduled_report_id" TEXT,
    "alert_rule_id" TEXT,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error_message" TEXT,
    "recipient_emails" TEXT[],
    "subject" TEXT NOT NULL,
    "period_from" TIMESTAMP(3) NOT NULL,
    "period_to" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_reports_account_id_idx" ON "scheduled_reports"("account_id");

-- CreateIndex
CREATE INDEX "scheduled_reports_store_id_active_idx" ON "scheduled_reports"("store_id", "active");

-- CreateIndex
CREATE INDEX "alert_rules_account_id_idx" ON "alert_rules"("account_id");

-- CreateIndex
CREATE INDEX "alert_rules_store_id_active_idx" ON "alert_rules"("store_id", "active");

-- CreateIndex
CREATE INDEX "delivery_log_account_id_idx" ON "delivery_log"("account_id");

-- CreateIndex
CREATE INDEX "delivery_log_store_id_created_at_idx" ON "delivery_log"("store_id", "created_at");

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_scheduled_report_id_fkey" FOREIGN KEY ("scheduled_report_id") REFERENCES "scheduled_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_alert_rule_id_fkey" FOREIGN KEY ("alert_rule_id") REFERENCES "alert_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row-level tenant isolation, same pattern as every other tenant-scoped
-- table (see 20260815003202_add_account_id_and_rls).
ALTER TABLE "scheduled_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scheduled_reports"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "alert_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "alert_rules"
  USING (account_id = current_setting('app.current_account_id', true));

ALTER TABLE "delivery_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "delivery_log"
  USING (account_id = current_setting('app.current_account_id', true));
