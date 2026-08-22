import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookHmac } from "@plumbline/connector";
import { handleWebhook } from "../webhooks.js";
import { adminClient, cleanupTestTenant, createTestTenant, WEBHOOK_SECRET, type TestTenant } from "./test-helpers.js";

// Phase 8 — docs/BUILD-SPEC.md: mandatory Shopify compliance webhooks
// (customers/data_request, customers/redact, shop/redact) plus
// app/uninstalled, exercised with realistic payload shapes and real HMAC
// verification (reusing the same signing helper as Phase 3's webhook tests).
function sign(rawBody: Buffer): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");
}

function verify(rawBody: Buffer, hmacHeader: string): boolean {
  return verifyWebhookHmac(rawBody, hmacHeader, WEBHOOK_SECRET);
}

describe("compliance webhooks (docs/BUILD-SPEC.md Phase 8)", () => {
  let tenant: TestTenant;

  beforeEach(async () => {
    tenant = await createTestTenant("compliance");
  });

  afterEach(async () => {
    // shop/redact tests delete the tenant themselves; cleanup must tolerate that.
    const stillExists = await adminClient.account.findUnique({ where: { id: tenant.accountId } });
    if (stillExists) await cleanupTestTenant(tenant);
  });

  it("app/uninstalled sets Store.uninstalledAt", async () => {
    const payload = { id: 12345, name: tenant.shopDomain, domain: tenant.shopDomain };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "app/uninstalled",
      webhookId: "wh-uninstall-1",
      rawBody,
      hmacHeader: sign(rawBody),
      verifyHmac: verify,
    });

    expect(result.status).toBe("processed");
    const store = await adminClient.store.findUniqueOrThrow({ where: { id: tenant.storeId } });
    expect(store.uninstalledAt).not.toBeNull();
  });

  it("customers/redact anonymizes the named customer without deleting order history", async () => {
    const customer = await adminClient.customer.create({
      data: {
        accountId: tenant.accountId,
        storeId: tenant.storeId,
        shopifyCustomerId: "555666777",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        currencyCode: "USD",
      },
    });
    const order = await adminClient.order.create({
      data: {
        accountId: tenant.accountId,
        storeId: tenant.storeId,
        shopifyOrderId: "redact-order-1",
        customerId: customer.id,
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

    const payload = {
      shop_id: 999,
      shop_domain: tenant.shopDomain,
      customer: { id: 555666777, email: "customer@example.com" },
      orders_to_redact: [],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "customers/redact",
      webhookId: "wh-redact-1",
      rawBody,
      hmacHeader: sign(rawBody),
      verifyHmac: verify,
    });

    expect(result.status).toBe("processed");
    const reloaded = await adminClient.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(reloaded.shopifyCustomerId).toBe("redacted-555666777");

    const orderStillExists = await adminClient.order.findUnique({ where: { id: order.id } });
    expect(orderStillExists).not.toBeNull();
  });

  it("customers/data_request is verified, logged, and processed without any automated export (Shopify allows manual fulfillment)", async () => {
    const payload = {
      shop_id: 999,
      shop_domain: tenant.shopDomain,
      customer: { id: 111222333, email: "customer@example.com" },
      orders_requested: [],
    };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "customers/data_request",
      webhookId: "wh-data-request-1",
      rawBody,
      hmacHeader: sign(rawBody),
      verifyHmac: verify,
    });

    expect(result.status).toBe("processed");
    const event = await adminClient.webhookEvent.findUniqueOrThrow({
      where: { storeId_shopifyWebhookId: { storeId: tenant.storeId, shopifyWebhookId: "wh-data-request-1" } },
    });
    expect(event.topic).toBe("customers/data_request");
    expect(event.status).toBe("processed");
  });

  it("shop/redact deletes the entire account — every tenant-scoped row, not just orders", async () => {
    await adminClient.enrichCogs.create({
      data: { accountId: tenant.accountId, storeId: tenant.storeId, sku: "SKU-X", costMinor: 100, currencyCode: "USD", effectiveFrom: new Date("2026-01-01T00:00:00Z"), source: "csv_upload" },
    });
    await adminClient.order.create({
      data: {
        accountId: tenant.accountId,
        storeId: tenant.storeId,
        shopifyOrderId: "shop-redact-order-1",
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

    const payload = { shop_id: 999, shop_domain: tenant.shopDomain };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "shop/redact",
      webhookId: "wh-shop-redact-1",
      rawBody,
      hmacHeader: sign(rawBody),
      verifyHmac: verify,
    });

    expect(result.status).toBe("processed");
    const account = await adminClient.account.findUnique({ where: { id: tenant.accountId } });
    expect(account).toBeNull();
    const store = await adminClient.store.findUnique({ where: { id: tenant.storeId } });
    expect(store).toBeNull();
    const orders = await adminClient.order.count({ where: { accountId: tenant.accountId } });
    expect(orders).toBe(0);
    const cogs = await adminClient.enrichCogs.count({ where: { accountId: tenant.accountId } });
    expect(cogs).toBe(0);
  });

  it("an invalid HMAC on a compliance webhook is rejected before any redaction/deletion happens", async () => {
    const payload = { shop_id: 999, shop_domain: tenant.shopDomain };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "shop/redact",
      webhookId: "wh-shop-redact-bad-hmac",
      rawBody,
      hmacHeader: "not-a-real-signature",
      verifyHmac: verify,
    });

    expect(result.status).toBe("invalid_hmac");
    const account = await adminClient.account.findUnique({ where: { id: tenant.accountId } });
    expect(account).not.toBeNull(); // still exists — nothing was deleted
  });
});
