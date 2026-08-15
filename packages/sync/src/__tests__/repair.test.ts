import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBackfill } from "../backfill.js";
import { runRepairPass } from "../repair.js";
import {
  adminClient,
  cleanupTestTenant,
  createTestTenant,
  generateDataset,
  makeTestConnectorAndServer,
  type TestTenant,
} from "./test-helpers.js";
import type { MockShopifyServerHandle } from "./mock-shopify-server.js";
import type { ShopifyClient } from "@plumbline/connector";

const FROM = new Date("2023-01-01T00:00:00.000Z");
const TO = new Date("2025-01-01T00:00:00.000Z");

describe("repair loop — catches drift from silently missed/dropped webhooks (docs/BUILD-SPEC.md Phase 3)", () => {
  let tenant: TestTenant;
  let server: MockShopifyServerHandle;
  let client: ShopifyClient;
  const ORDER_COUNT = 25;

  beforeEach(async () => {
    tenant = await createTestTenant("repair");
    const dataset = generateDataset(ORDER_COUNT, tenant.storeId);
    ({ handle: server, client } = await makeTestConnectorAndServer(dataset));

    await runBackfill({
      connector: client,
      accountId: tenant.accountId,
      storeId: tenant.storeId,
      resource: "orders",
      from: FROM,
      to: TO,
      chunkDays: 730,
      pollIntervalMs: 50,
    });
  });

  afterEach(async () => {
    await server.close();
    await cleanupTestTenant(tenant);
  });

  it("finds and logs corrections for orders Shopify changed but no webhook ever announced", async () => {
    const dbOrdersBefore = await adminClient.order.findMany({
      where: { storeId: tenant.storeId },
      orderBy: { shopifyOrderId: "asc" },
      take: 3,
    });
    expect(dbOrdersBefore).toHaveLength(3);

    // Simulate 3 dropped webhooks: Shopify's own record moved on, ours didn't.
    for (const order of dbOrdersBefore) {
      server.mutateOrder(order.shopifyOrderId, {
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        currentTotalMinor: Math.max(0, order.currentTotalMinor - 500),
      });
    }

    const result = await runRepairPass({
      connector: client,
      accountId: tenant.accountId,
      storeId: tenant.storeId,
      trailingWindowHours: 24,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[repair loop test] ordersChecked=${result.ordersChecked} correctionCount=${result.correctionCount}`
    );

    expect(result.ordersChecked).toBe(3); // only the mutated orders fall inside the trailing window
    expect(result.correctionCount).toBeGreaterThanOrEqual(3); // at least one field each

    const corrections = await adminClient.syncCorrection.findMany({ where: { storeId: tenant.storeId } });
    expect(corrections.length).toBe(result.correctionCount);
    expect(corrections.some((c) => c.field === "displayFinancialStatus" && c.newValue === "PARTIALLY_REFUNDED")).toBe(
      true
    );

    const dbOrdersAfter = await adminClient.order.findMany({
      where: { id: { in: dbOrdersBefore.map((o) => o.id) } },
    });
    for (const before of dbOrdersBefore) {
      const after = dbOrdersAfter.find((o) => o.id === before.id)!;
      expect(after.displayFinancialStatus).toBe("PARTIALLY_REFUNDED");
      expect(after.currentTotalMinor).toBe(Math.max(0, before.currentTotalMinor - 500));
    }
  }, 30_000);

  it("reports zero corrections when nothing has drifted", async () => {
    const result = await runRepairPass({
      connector: client,
      accountId: tenant.accountId,
      storeId: tenant.storeId,
      trailingWindowHours: 24,
    });

    expect(result.ordersChecked).toBe(0); // nothing touched in the trailing 24h
    expect(result.correctionCount).toBe(0);
  });
});
