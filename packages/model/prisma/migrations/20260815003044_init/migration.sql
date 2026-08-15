-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "shop_currency" TEXT NOT NULL,
    "shop_timezone" TEXT NOT NULL,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT,
    "installed_at" TIMESTAMP(3),
    "uninstalled_at" TIMESTAMP(3),

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "currency_code" TEXT NOT NULL,
    "presentment_currency_code" TEXT NOT NULL,
    "gross_sales_minor" INTEGER NOT NULL,
    "discounts_minor" INTEGER NOT NULL,
    "shipping_minor" INTEGER NOT NULL,
    "taxes_minor" INTEGER NOT NULL,
    "current_subtotal_minor" INTEGER NOT NULL,
    "current_total_minor" INTEGER NOT NULL,
    "display_financial_status" TEXT NOT NULL,
    "display_fulfillment_status" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shopify_line_item_id" TEXT NOT NULL,
    "product_id" TEXT,
    "variant_id" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL,
    "currency_code" TEXT NOT NULL,

    CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shopify_refund_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "shipping_refund_minor" INTEGER NOT NULL,
    "tax_refund_minor" INTEGER NOT NULL,
    "currency_code" TEXT NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_line_items" (
    "id" TEXT NOT NULL,
    "refund_id" TEXT NOT NULL,
    "order_line_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount_minor" INTEGER NOT NULL,

    CONSTRAINT "refund_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discounts" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "application_type" TEXT NOT NULL,
    "code" TEXT,
    "amount_minor" INTEGER NOT NULL,
    "currency_code" TEXT NOT NULL,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shopify_transaction_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "fee_minor" INTEGER,
    "currency_code" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shopify_customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "first_order_id" TEXT,
    "currency_code" TEXT NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "shopify_webhook_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cursor" TEXT,
    "watermark_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrich_cogs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "cost_minor" INTEGER NOT NULL,
    "currency_code" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "enrich_cogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrich_ad_spend" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "spend_minor" INTEGER NOT NULL,
    "currency_code" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "enrich_ad_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_shop_domain_key" ON "stores"("shop_domain");

-- CreateIndex
CREATE INDEX "stores_account_id_idx" ON "stores"("account_id");

-- CreateIndex
CREATE INDEX "orders_store_id_created_at_idx" ON "orders"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_store_id_processed_at_idx" ON "orders"("store_id", "processed_at");

-- CreateIndex
CREATE INDEX "orders_account_id_idx" ON "orders"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_store_id_shopify_order_id_key" ON "orders"("store_id", "shopify_order_id");

-- CreateIndex
CREATE INDEX "order_line_items_order_id_idx" ON "order_line_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_items_order_id_shopify_line_item_id_key" ON "order_line_items"("order_id", "shopify_line_item_id");

-- CreateIndex
CREATE INDEX "refunds_store_id_processed_at_idx" ON "refunds"("store_id", "processed_at");

-- CreateIndex
CREATE INDEX "refunds_account_id_idx" ON "refunds"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_store_id_shopify_refund_id_key" ON "refunds"("store_id", "shopify_refund_id");

-- CreateIndex
CREATE INDEX "refund_line_items_refund_id_idx" ON "refund_line_items"("refund_id");

-- CreateIndex
CREATE INDEX "discounts_order_id_idx" ON "discounts"("order_id");

-- CreateIndex
CREATE INDEX "transactions_account_id_idx" ON "transactions"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_store_id_shopify_transaction_id_key" ON "transactions"("store_id", "shopify_transaction_id");

-- CreateIndex
CREATE INDEX "customers_account_id_idx" ON "customers"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_store_id_shopify_customer_id_key" ON "customers"("store_id", "shopify_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_store_id_shopify_webhook_id_key" ON "webhook_events"("store_id", "shopify_webhook_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_state_store_id_resource_kind_key" ON "sync_state"("store_id", "resource", "kind");

-- CreateIndex
CREATE INDEX "enrich_cogs_account_id_idx" ON "enrich_cogs"("account_id");

-- CreateIndex
CREATE INDEX "enrich_cogs_store_id_sku_idx" ON "enrich_cogs"("store_id", "sku");

-- CreateIndex
CREATE INDEX "enrich_ad_spend_account_id_idx" ON "enrich_ad_spend"("account_id");

-- CreateIndex
CREATE INDEX "enrich_ad_spend_store_id_channel_date_idx" ON "enrich_ad_spend"("store_id", "channel", "date");

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_line_items" ADD CONSTRAINT "refund_line_items_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_line_items" ADD CONSTRAINT "refund_line_items_order_line_item_id_fkey" FOREIGN KEY ("order_line_item_id") REFERENCES "order_line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_first_order_id_fkey" FOREIGN KEY ("first_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrich_cogs" ADD CONSTRAINT "enrich_cogs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrich_cogs" ADD CONSTRAINT "enrich_cogs_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrich_ad_spend" ADD CONSTRAINT "enrich_ad_spend_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrich_ad_spend" ADD CONSTRAINT "enrich_ad_spend_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
