import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBackfill } from "../backfill.js";
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

describe("backfill — 10,000+ order dataset (docs/BUILD-SPEC.md Gate 3)", () => {
  let tenant: TestTenant;
  let server: MockShopifyServerHandle;
  let client: ShopifyClient;
  const ORDER_COUNT = 10_500;

  beforeEach(async () => {
    tenant = await createTestTenant("backfill-10k");
    const dataset = generateDataset(ORDER_COUNT, tenant.storeId);
    ({ handle: server, client } = await makeTestConnectorAndServer(dataset));
  });

  afterEach(async () => {
    await server.close();
    await cleanupTestTenant(tenant);
  });

  it("backfills the full range, reporting real duration and row counts", async () => {
    const result = await runBackfill({
      connector: client,
      accountId: tenant.accountId,
      storeId: tenant.storeId,
      resource: "orders",
      from: FROM,
      to: TO,
      chunkDays: 90,
      concurrency: 12,
      pollIntervalMs: 50,
    });

    const dbCount = await adminClient.order.count({ where: { storeId: tenant.storeId } });
    const lineItemCount = await adminClient.orderLineItem.count({ where: { accountId: tenant.accountId } });

    // eslint-disable-next-line no-console
    console.log(
      `[backfill 10k+ test] orders=${ORDER_COUNT} windows=${result.windowsProcessed} ` +
        `ordersUpserted=${result.ordersUpserted} durationMs=${result.durationMs} ` +
        `dbOrderCount=${dbCount} lineItems=${lineItemCount}`
    );

    expect(result.ordersUpserted).toBe(ORDER_COUNT);
    expect(dbCount).toBe(ORDER_COUNT);
    expect(result.windowsTotal).toBeGreaterThan(1);
  }, 120_000);

  it("re-running the same window with the watermark reset produces zero duplicate orders", async () => {
    const first = await runBackfill({
      connector: client,
      accountId: tenant.accountId,
      storeId: tenant.storeId,
      resource: "orders",
      from: FROM,
      to: TO,
      chunkDays: 730, // a single window covering the whole range
      concurrency: 12,
      pollIntervalMs: 50,
    });
    expect(first.ordersUpserted).toBe(ORDER_COUNT);

    const countAfterFirst = await adminClient.order.count({ where: { storeId: tenant.storeId } });

    // Force full re-processing by resetting the watermark, rather than
    // relying on the resume-skip logic — this isolates the actual idempotent
    // upsert behavior (docs/BUILD-SPEC.md Phase 3).
    await adminClient.syncState.updateMany({
      where: { storeId: tenant.storeId, resource: "orders", kind: "backfill" },
      data: { watermarkAt: FROM },
    });

    const second = await runBackfill({
      connector: client,
      accountId: tenant.accountId,
      storeId: tenant.storeId,
      resource: "orders",
      from: FROM,
      to: TO,
      chunkDays: 730,
      concurrency: 12,
      pollIntervalMs: 50,
    });

    const countAfterSecond = await adminClient.order.count({ where: { storeId: tenant.storeId } });

    // eslint-disable-next-line no-console
    console.log(
      `[idempotency double-run test] countAfterFirst=${countAfterFirst} ` +
        `secondRunOrdersProcessed=${second.ordersUpserted} countAfterSecond=${countAfterSecond} ` +
        `duplicateCount=${countAfterSecond - countAfterFirst}`
    );

    expect(second.ordersUpserted).toBe(ORDER_COUNT); // fully reprocessed...
    expect(countAfterSecond).toBe(countAfterFirst); // ...but zero net-new rows
    expect(countAfterSecond).toBe(ORDER_COUNT);
  }, 120_000);
});

describe("backfill — crash resume", () => {
  let tenant: TestTenant;
  let server: MockShopifyServerHandle;
  let client: ShopifyClient;
  const ORDER_COUNT = 400;

  beforeEach(async () => {
    tenant = await createTestTenant("backfill-resume");
    const dataset = generateDataset(ORDER_COUNT, tenant.storeId);
    ({ handle: server, client } = await makeTestConnectorAndServer(dataset));
  });

  afterEach(async () => {
    await server.close();
    await cleanupTestTenant(tenant);
  });

  it("resumes from the last persisted watermark instead of restarting after a simulated crash", async () => {
    const CRASH_AFTER_WINDOW_INDEX = 1;

    await expect(
      runBackfill({
        connector: client,
        accountId: tenant.accountId,
        storeId: tenant.storeId,
        resource: "orders",
        from: FROM,
        to: TO,
        chunkDays: 180, // ~4 windows over the 2-year range
        concurrency: 8,
        pollIntervalMs: 50,
        afterWindow: (windowIndex) => {
          if (windowIndex === CRASH_AFTER_WINDOW_INDEX) {
            throw new Error("simulated crash mid-backfill");
          }
        },
      })
    ).rejects.toThrow("simulated crash mid-backfill");

    const countAfterCrash = await adminClient.order.count({ where: { storeId: tenant.storeId } });
    const stateAfterCrash = await adminClient.syncState.findUniqueOrThrow({
      where: { storeId_resource_kind: { storeId: tenant.storeId, resource: "orders", kind: "backfill" } },
    });

    expect(countAfterCrash).toBeGreaterThan(0);
    expect(countAfterCrash).toBeLessThan(ORDER_COUNT);
    expect(stateAfterCrash.watermarkAt).not.toBeNull();
    expect(stateAfterCrash.watermarkAt!.getTime()).toBeLessThan(TO.getTime());

    const resumed = await runBackfill({
      connector: client,
      accountId: tenant.accountId,
      storeId: tenant.storeId,
      resource: "orders",
      from: FROM,
      to: TO,
      chunkDays: 180,
      concurrency: 8,
      pollIntervalMs: 50,
    });

    const countAfterResume = await adminClient.order.count({ where: { storeId: tenant.storeId } });

    // eslint-disable-next-line no-console
    console.log(
      `[crash-resume test] countAfterCrash=${countAfterCrash} ` +
        `windowsSkippedOnResume=${resumed.windowsSkippedAlreadyDone} countAfterResume=${countAfterResume}`
    );

    expect(resumed.windowsSkippedAlreadyDone).toBeGreaterThan(0); // proves it didn't restart from scratch
    expect(countAfterResume).toBe(ORDER_COUNT); // and ended up complete, with no duplicates
  }, 60_000);
});
