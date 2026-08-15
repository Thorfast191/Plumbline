import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { withAccountContextOn } from "../client.js";

// Two separate connections, deliberately using different roles:
//  - adminClient: superuser (DATABASE_URL_MIGRATE_TEST) — bypasses RLS by
//    Postgres design, used only to seed/clean fixtures.
//  - appClient: non-superuser (DATABASE_URL_TEST) — the role the real app
//    connects as, and the only one this test trusts to prove isolation.
const migrateUrl = process.env.DATABASE_URL_MIGRATE_TEST;
const appUrl = process.env.DATABASE_URL_TEST;

if (!migrateUrl || !appUrl) {
  throw new Error(
    "DATABASE_URL_MIGRATE_TEST and DATABASE_URL_TEST must be set (see .env / .env.example) to run the tenant isolation test."
  );
}

const adminClient = new PrismaClient({ datasourceUrl: migrateUrl });
const appClient = new PrismaClient({ datasourceUrl: appUrl });

let accountA: { id: string };
let accountB: { id: string };
let orderA: { id: string };
let orderB: { id: string };

beforeAll(async () => {
  accountA = await adminClient.account.create({ data: { name: "Tenant A" } });
  accountB = await adminClient.account.create({ data: { name: "Tenant B" } });

  const storeA = await adminClient.store.create({
    data: {
      accountId: accountA.id,
      shopDomain: "tenant-a.myshopify.com",
      shopCurrency: "USD",
      shopTimezone: "America/New_York",
    },
  });
  const storeB = await adminClient.store.create({
    data: {
      accountId: accountB.id,
      shopDomain: "tenant-b.myshopify.com",
      shopCurrency: "USD",
      shopTimezone: "America/New_York",
    },
  });

  const baseOrder = {
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
  };

  orderA = await adminClient.order.create({
    data: { ...baseOrder, accountId: accountA.id, storeId: storeA.id, shopifyOrderId: "1001" },
  });
  orderB = await adminClient.order.create({
    data: { ...baseOrder, accountId: accountB.id, storeId: storeB.id, shopifyOrderId: "2001" },
  });
});

afterAll(async () => {
  // Cascade-free schema, so delete children before parents. adminClient bypasses
  // RLS, so this cleans up both tenants regardless of session context.
  await adminClient.order.deleteMany({ where: { accountId: { in: [accountA.id, accountB.id] } } });
  await adminClient.store.deleteMany({ where: { accountId: { in: [accountA.id, accountB.id] } } });
  await adminClient.account.deleteMany({ where: { id: { in: [accountA.id, accountB.id] } } });
  await adminClient.$disconnect();
  await appClient.$disconnect();
});

describe("tenant isolation (Postgres RLS, non-superuser role)", () => {
  it("account A's session sees only A's orders, never B's", async () => {
    const orders = await withAccountContextOn(appClient, accountA.id, (tx) => tx.order.findMany());

    const ids = orders.map((o) => o.id);
    expect(ids).toContain(orderA.id);
    expect(ids).not.toContain(orderB.id);
  });

  it("account B's session sees only B's orders, never A's", async () => {
    const orders = await withAccountContextOn(appClient, accountB.id, (tx) => tx.order.findMany());

    const ids = orders.map((o) => o.id);
    expect(ids).toContain(orderB.id);
    expect(ids).not.toContain(orderA.id);
  });

  it("account A cannot fetch account B's order directly by id", async () => {
    const found = await withAccountContextOn(appClient, accountA.id, (tx) =>
      tx.order.findUnique({ where: { id: orderB.id } })
    );
    expect(found).toBeNull();
  });

  it("with no account context set, the app role sees zero rows (fail closed, not fail open)", async () => {
    const orders = await appClient.order.findMany();
    expect(orders).toHaveLength(0);
  });
});
