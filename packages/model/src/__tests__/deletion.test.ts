import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { deleteAccountData, redactCustomer } from "../deletion.js";

// Real cross-tenant test: seeds two accounts each with a full graph of
// tenant-scoped rows (order, line item, refund + its line item, discount,
// transaction, customer with a first-order back-reference, webhook event,
// sync state/correction, all three enrich tables, a scheduled report, an
// alert rule, and a delivery log referencing both), deletes one account,
// and asserts every one of its rows is gone across every table while the
// sibling account's rows are completely untouched (docs/BUILD-SPEC.md
// Phase 8: "a merchant requests deletion, everything goes").
const migrateUrl = process.env.DATABASE_URL_MIGRATE_TEST;
if (!migrateUrl) {
  throw new Error("DATABASE_URL_MIGRATE_TEST must be set to run the deletion test.");
}
const adminClient = new PrismaClient({ datasourceUrl: migrateUrl });

async function seedFullTenant(domainPrefix: string) {
  const account = await adminClient.account.create({ data: { name: `${domainPrefix} account` } });
  const store = await adminClient.store.create({
    data: {
      accountId: account.id,
      shopDomain: `${domainPrefix}.myshopify.com`,
      shopCurrency: "USD",
      shopTimezone: "UTC",
    },
  });
  const order = await adminClient.order.create({
    data: {
      accountId: account.id,
      storeId: store.id,
      shopifyOrderId: `${domainPrefix}-order-1`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      processedAt: new Date("2026-01-01T00:00:00Z"),
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      grossSalesMinor: 1000,
      discountsMinor: 0,
      shippingMinor: 0,
      taxesMinor: 0,
      currentSubtotalMinor: 1000,
      currentTotalMinor: 1000,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      source: "backfill",
    },
  });
  const lineItem = await adminClient.orderLineItem.create({
    data: {
      accountId: account.id,
      orderId: order.id,
      shopifyLineItemId: `${domainPrefix}-li-1`,
      quantity: 1,
      priceMinor: 1000,
      discountMinor: 0,
      currencyCode: "USD",
    },
  });
  const refund = await adminClient.refund.create({
    data: {
      accountId: account.id,
      storeId: store.id,
      orderId: order.id,
      shopifyRefundId: `${domainPrefix}-refund-1`,
      processedAt: new Date("2026-01-02T00:00:00Z"),
      amountMinor: 500,
      shippingRefundMinor: 0,
      taxRefundMinor: 0,
      currencyCode: "USD",
    },
  });
  await adminClient.refundLineItem.create({
    data: { accountId: account.id, refundId: refund.id, orderLineItemId: lineItem.id, quantity: 1, amountMinor: 500 },
  });
  await adminClient.discount.create({
    data: { accountId: account.id, orderId: order.id, applicationType: "code", code: "SAVE", amountMinor: 100, currencyCode: "USD" },
  });
  await adminClient.transaction.create({
    data: {
      accountId: account.id,
      storeId: store.id,
      orderId: order.id,
      shopifyTransactionId: `${domainPrefix}-tx-1`,
      kind: "sale",
      status: "success",
      amountMinor: 1000,
      currencyCode: "USD",
      processedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const customer = await adminClient.customer.create({
    data: {
      accountId: account.id,
      storeId: store.id,
      shopifyCustomerId: `${domainPrefix}-cust-1`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      currencyCode: "USD",
      firstOrderId: order.id,
    },
  });
  await adminClient.order.update({ where: { id: order.id }, data: { customerId: customer.id } });
  await adminClient.webhookEvent.create({
    data: { accountId: account.id, storeId: store.id, shopifyWebhookId: `${domainPrefix}-wh-1`, topic: "orders/create", payloadHash: "abc", status: "processed" },
  });
  await adminClient.syncState.create({
    data: { accountId: account.id, storeId: store.id, resource: "orders", kind: "incremental", status: "idle" },
  });
  await adminClient.syncCorrection.create({
    data: { accountId: account.id, storeId: store.id, resource: "orders", resourceId: order.id, field: "grossSalesMinor", oldValue: "900", newValue: "1000" },
  });
  await adminClient.enrichCogs.create({
    data: { accountId: account.id, storeId: store.id, sku: "SKU-1", costMinor: 200, currencyCode: "USD", effectiveFrom: new Date("2026-01-01T00:00:00Z"), source: "csv_upload" },
  });
  await adminClient.enrichAdSpend.create({
    data: { accountId: account.id, storeId: store.id, channel: "meta", date: new Date("2026-01-01T00:00:00Z"), spendMinor: 500, currencyCode: "USD", source: "csv_upload" },
  });
  await adminClient.enrichShippingCost.create({
    data: { accountId: account.id, storeId: store.id, costMinor: 300, currencyCode: "USD", effectiveFrom: new Date("2026-01-01T00:00:00Z"), source: "csv_upload" },
  });
  const scheduledReport = await adminClient.scheduledReport.create({
    data: { accountId: account.id, storeId: store.id, reportType: "sales_overview", cadence: "weekly", recipientEmails: ["owner@example.com"] },
  });
  const alertRule = await adminClient.alertRule.create({
    data: { accountId: account.id, storeId: store.id, kind: "metric_threshold", metricId: "sales_reversals", comparator: "above", thresholdMinor: 100, cadence: "weekly", recipientEmails: ["owner@example.com"] },
  });
  await adminClient.deliveryLog.create({
    data: {
      accountId: account.id,
      storeId: store.id,
      kind: "scheduled_report",
      scheduledReportId: scheduledReport.id,
      status: "delivered",
      recipientEmails: ["owner@example.com"],
      subject: "test",
      periodFrom: new Date("2026-01-01T00:00:00Z"),
      periodTo: new Date("2026-01-08T00:00:00Z"),
    },
  });
  await adminClient.deliveryLog.create({
    data: {
      accountId: account.id,
      storeId: store.id,
      kind: "alert",
      alertRuleId: alertRule.id,
      status: "delivered",
      recipientEmails: ["owner@example.com"],
      subject: "test alert",
      periodFrom: new Date("2026-01-01T00:00:00Z"),
      periodTo: new Date("2026-01-08T00:00:00Z"),
    },
  });

  return { accountId: account.id, storeId: store.id, customerShopifyId: `${domainPrefix}-cust-1` };
}

async function countAllTenantRows(accountId: string): Promise<number> {
  const [
    orders, lineItems, refunds, refundLineItems, discounts, transactions, customers,
    webhookEvents, syncStates, syncCorrections, enrichCogs, enrichAdSpend, enrichShippingCost,
    scheduledReports, alertRules, deliveryLogs, stores, accounts,
  ] = await Promise.all([
    adminClient.order.count({ where: { accountId } }),
    adminClient.orderLineItem.count({ where: { accountId } }),
    adminClient.refund.count({ where: { accountId } }),
    adminClient.refundLineItem.count({ where: { accountId } }),
    adminClient.discount.count({ where: { accountId } }),
    adminClient.transaction.count({ where: { accountId } }),
    adminClient.customer.count({ where: { accountId } }),
    adminClient.webhookEvent.count({ where: { accountId } }),
    adminClient.syncState.count({ where: { accountId } }),
    adminClient.syncCorrection.count({ where: { accountId } }),
    adminClient.enrichCogs.count({ where: { accountId } }),
    adminClient.enrichAdSpend.count({ where: { accountId } }),
    adminClient.enrichShippingCost.count({ where: { accountId } }),
    adminClient.scheduledReport.count({ where: { accountId } }),
    adminClient.alertRule.count({ where: { accountId } }),
    adminClient.deliveryLog.count({ where: { accountId } }),
    adminClient.store.count({ where: { accountId } }),
    adminClient.account.count({ where: { id: accountId } }),
  ]);
  return (
    orders + lineItems + refunds + refundLineItems + discounts + transactions + customers +
    webhookEvents + syncStates + syncCorrections + enrichCogs + enrichAdSpend + enrichShippingCost +
    scheduledReports + alertRules + deliveryLogs + stores + accounts
  );
}

let deleteMe: Awaited<ReturnType<typeof seedFullTenant>>;
let keepMe: Awaited<ReturnType<typeof seedFullTenant>>;

beforeAll(async () => {
  deleteMe = await seedFullTenant("gdpr-delete-me");
  keepMe = await seedFullTenant("gdpr-keep-me");
});

afterAll(async () => {
  // deleteMe should already be gone; clean up keepMe (children first).
  await adminClient.deliveryLog.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.alertRule.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.scheduledReport.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.enrichShippingCost.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.enrichAdSpend.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.enrichCogs.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.syncCorrection.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.syncState.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.webhookEvent.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.order.updateMany({ where: { accountId: keepMe.accountId }, data: { customerId: null } });
  await adminClient.customer.updateMany({ where: { accountId: keepMe.accountId }, data: { firstOrderId: null } });
  await adminClient.refundLineItem.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.refund.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.discount.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.transaction.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.orderLineItem.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.order.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.customer.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.store.deleteMany({ where: { accountId: keepMe.accountId } });
  await adminClient.account.deleteMany({ where: { id: keepMe.accountId } });
  await adminClient.$disconnect();
});

describe("deleteAccountData — GDPR deletion cascade (docs/BUILD-SPEC.md Phase 8)", () => {
  it("removes every row across every tenant-scoped table for the deleted account, and nothing for the sibling account", async () => {
    const beforeKeepCount = await countAllTenantRows(keepMe.accountId);
    expect(beforeKeepCount).toBeGreaterThan(0);

    const report = await deleteAccountData(adminClient, deleteMe.accountId);

    expect(report.deletedCounts.orders).toBe(1);
    expect(report.deletedCounts.orderLineItems).toBe(1);
    expect(report.deletedCounts.refunds).toBe(1);
    expect(report.deletedCounts.refundLineItems).toBe(1);
    expect(report.deletedCounts.discounts).toBe(1);
    expect(report.deletedCounts.transactions).toBe(1);
    expect(report.deletedCounts.customers).toBe(1);
    expect(report.deletedCounts.webhookEvents).toBe(1);
    expect(report.deletedCounts.syncStates).toBe(1);
    expect(report.deletedCounts.syncCorrections).toBe(1);
    expect(report.deletedCounts.enrichCogs).toBe(1);
    expect(report.deletedCounts.enrichAdSpend).toBe(1);
    expect(report.deletedCounts.enrichShippingCost).toBe(1);
    expect(report.deletedCounts.scheduledReports).toBe(1);
    expect(report.deletedCounts.alertRules).toBe(1);
    expect(report.deletedCounts.deliveryLogs).toBe(2);
    expect(report.deletedCounts.stores).toBe(1);
    expect(report.deletedCounts.accounts).toBe(1);

    const afterDeleteCount = await countAllTenantRows(deleteMe.accountId);
    expect(afterDeleteCount).toBe(0);

    const afterKeepCount = await countAllTenantRows(keepMe.accountId);
    expect(afterKeepCount).toBe(beforeKeepCount);
  });
});

describe("redactCustomer — Shopify customers/redact compliance webhook target", () => {
  it("anonymizes the customer's Shopify identifier without deleting order/financial history", async () => {
    const result = await redactCustomer(adminClient, {
      accountId: keepMe.accountId,
      storeId: keepMe.storeId,
      shopifyCustomerId: keepMe.customerShopifyId,
    });
    expect(result.redacted).toBe(true);

    const customer = await adminClient.customer.findFirst({ where: { accountId: keepMe.accountId } });
    expect(customer?.shopifyCustomerId).toBe(`redacted-${keepMe.customerShopifyId}`);

    const orderStillExists = await adminClient.order.findFirst({ where: { accountId: keepMe.accountId } });
    expect(orderStillExists).not.toBeNull();
  });

  it("is idempotent — redacting an already-redacted customer matches zero rows instead of double-prefixing", async () => {
    const result = await redactCustomer(adminClient, {
      accountId: keepMe.accountId,
      storeId: keepMe.storeId,
      shopifyCustomerId: keepMe.customerShopifyId, // original id no longer matches post-redaction
    });
    expect(result.redacted).toBe(false);
  });
});
