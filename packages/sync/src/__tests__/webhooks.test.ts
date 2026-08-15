import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookHmac } from "@plumbline/connector";
import { handleWebhook } from "../webhooks.js";
import { adminClient, cleanupTestTenant, createTestTenant, WEBHOOK_SECRET, type TestTenant } from "./test-helpers.js";
import type { OrderBundle } from "../types.js";

function sign(rawBody: Buffer): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");
}

function verify(rawBody: Buffer, hmacHeader: string): boolean {
  return verifyWebhookHmac(rawBody, hmacHeader, WEBHOOK_SECRET);
}

function makeOrderPayload(overrides: Partial<OrderBundle>): OrderBundle {
  return {
    id: "gid://shopify/Order/wh-test-1",
    createdAt: "2024-06-01T00:00:00.000Z",
    processedAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    cancelledAt: null,
    closedAt: null,
    test: false,
    currencyCode: "USD",
    presentmentCurrencyCode: "USD",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    grossSalesMinor: 5000,
    discountsMinor: 0,
    shippingMinor: 500,
    taxesMinor: 400,
    currentSubtotalMinor: 5000,
    currentTotalMinor: 5900,
    lineItems: [
      {
        id: "gid://shopify/LineItem/wh-test-1-0",
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1",
        sku: "SKU-1",
        quantity: 1,
        priceMinor: 5000,
        discountMinor: 0,
        currencyCode: "USD",
      },
    ],
    discounts: [],
    transactions: [],
    refunds: [],
    ...overrides,
  };
}

describe("webhook intake — dedup and out-of-order tolerance (docs/BUILD-SPEC.md Phase 3)", () => {
  let tenant: TestTenant;

  beforeEach(async () => {
    tenant = await createTestTenant("webhooks");
  });

  afterEach(async () => {
    await cleanupTestTenant(tenant);
  });

  it("rejects an invalid HMAC without touching the database", async () => {
    const payload = makeOrderPayload({});
    const rawBody = Buffer.from(JSON.stringify(payload));

    const result = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "orders/create",
      webhookId: "wh-bad-hmac",
      rawBody,
      hmacHeader: "not-a-real-signature",
      verifyHmac: verify,
    });

    expect(result.status).toBe("invalid_hmac");
    const count = await adminClient.order.count({ where: { storeId: tenant.storeId } });
    expect(count).toBe(0);
  });

  it("an orders/updated webhook delivered BEFORE the orders/create webhook still wins if it is newer (out-of-order tolerance)", async () => {
    const older = makeOrderPayload({
      updatedAt: "2024-06-01T00:00:00.000Z",
      displayFinancialStatus: "PAID",
      currentTotalMinor: 5900,
    });
    const newer = makeOrderPayload({
      updatedAt: "2024-06-03T00:00:00.000Z", // later than `older`, despite topic name suggesting otherwise
      displayFinancialStatus: "PARTIALLY_REFUNDED",
      currentTotalMinor: 3900,
    });

    const newerBody = Buffer.from(JSON.stringify(newer));
    const olderBody = Buffer.from(JSON.stringify(older));

    // Deliver the update BEFORE the create — Shopify makes no ordering guarantee (docs/PLAN.md §5).
    const first = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "orders/updated",
      webhookId: "wh-update-first",
      rawBody: newerBody,
      hmacHeader: sign(newerBody),
      verifyHmac: verify,
    });
    const second = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "orders/create",
      webhookId: "wh-create-second",
      rawBody: olderBody,
      hmacHeader: sign(olderBody),
      verifyHmac: verify,
    });

    expect(first.status).toBe("processed");
    expect(second.status).toBe("processed"); // received fine, just didn't overwrite

    const order = await adminClient.order.findUniqueOrThrow({
      where: { storeId_shopifyOrderId: { storeId: tenant.storeId, shopifyOrderId: newer.id } },
    });

    expect(order.displayFinancialStatus).toBe("PARTIALLY_REFUNDED");
    expect(order.currentTotalMinor).toBe(3900);

    const events = await adminClient.webhookEvent.count({ where: { storeId: tenant.storeId } });
    expect(events).toBe(2); // both deliveries recorded, even though only one changed the order
  });

  it("delivering the same webhook id twice is processed once, second is marked duplicate", async () => {
    const payload = makeOrderPayload({});
    const rawBody = Buffer.from(JSON.stringify(payload));
    const hmacHeader = sign(rawBody);

    const first = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "orders/create",
      webhookId: "wh-dup-1",
      rawBody,
      hmacHeader,
      verifyHmac: verify,
    });
    const second = await handleWebhook({
      shopDomain: tenant.shopDomain,
      topic: "orders/create",
      webhookId: "wh-dup-1", // same id, simulating Shopify's at-least-once redelivery
      rawBody,
      hmacHeader,
      verifyHmac: verify,
    });

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");

    const events = await adminClient.webhookEvent.findMany({
      where: { storeId: tenant.storeId, shopifyWebhookId: "wh-dup-1" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("processed");
  });
});
