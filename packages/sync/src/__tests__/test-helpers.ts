import { PrismaClient } from "@prisma/client";
import { ShopifyClient } from "@plumbline/connector";
import { withAccountContextOn, type TenantClient } from "@plumbline/model";
import { startMockShopifyServer, type MockShopifyServerHandle } from "./mock-shopify-server.js";
import { generateSyntheticOrders, type SyntheticOrder } from "./fixtures.js";

// vitest.setup.ts has already redirected DATABASE_URL/DATABASE_URL_MIGRATE to
// the *_TEST variants, so the shared @plumbline/model singleton (used by
// backfill.ts/incremental.ts/webhooks.ts/repair.ts/status.ts via
// withAccountContext) already targets plumbline_test. Here we only need our
// own explicit clients for direct-SQL test assertions/fixture setup.
export const adminClient = new PrismaClient({ datasourceUrl: requireEnv("DATABASE_URL_MIGRATE_TEST") });
export const appClient = new PrismaClient({ datasourceUrl: requireEnv("DATABASE_URL_TEST") });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set (see .env / .env.example) to run sync tests.`);
  return v;
}

export async function withTenant<T>(accountId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
  return withAccountContextOn(appClient, accountId, fn);
}

export interface TestTenant {
  accountId: string;
  storeId: string;
  shopDomain: string;
}

let counter = 0;

export async function createTestTenant(label: string): Promise<TestTenant> {
  counter += 1;
  const tag = `${label}-${Date.now()}-${counter}`;
  const account = await adminClient.account.create({ data: { name: `Test Account ${tag}` } });
  const store = await adminClient.store.create({
    data: {
      accountId: account.id,
      shopDomain: `${tag}.myshopify.com`,
      shopCurrency: "USD",
      shopTimezone: "America/New_York",
      installedAt: new Date(),
    },
  });
  return { accountId: account.id, storeId: store.id, shopDomain: store.shopDomain };
}

export async function cleanupTestTenant(tenant: TestTenant): Promise<void> {
  // Order.customerId <-> Customer.firstOrderId is a circular FK (Phase 5) —
  // both sides must be nulled before either table can be emptied, same
  // reasoning as packages/model/src/deletion.ts's deleteAccountData.
  await adminClient.order.updateMany({ where: { accountId: tenant.accountId }, data: { customerId: null } });
  await adminClient.customer.updateMany({ where: { accountId: tenant.accountId }, data: { firstOrderId: null } });
  await adminClient.refundLineItem.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.refund.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.discount.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.transaction.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.orderLineItem.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.syncCorrection.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.webhookEvent.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.syncState.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.order.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.customer.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.store.deleteMany({ where: { accountId: tenant.accountId } });
  await adminClient.account.deleteMany({ where: { id: tenant.accountId } });
}

const WEBHOOK_SECRET = "test-webhook-secret";

export function makeTestConnectorAndServer(
  orders: SyntheticOrder[]
): Promise<{ handle: MockShopifyServerHandle; client: ShopifyClient }> {
  return startMockShopifyServer(orders).then((handle) => {
    const client = new ShopifyClient({
      shop: "test-shop.myshopify.com",
      apiVersion: "2026-01",
      apiKey: "test-key",
      apiSecret: WEBHOOK_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      accessToken: "test-offline-token",
      graphqlEndpointOverride: handle.url,
    });
    return { handle, client };
  });
}

export function generateDataset(count: number, tag: string): SyntheticOrder[] {
  return generateSyntheticOrders({
    count,
    startDate: new Date("2023-01-01T00:00:00.000Z"),
    endDate: new Date("2025-01-01T00:00:00.000Z"),
    storeTag: tag,
    seed: 7,
  });
}

export { WEBHOOK_SECRET };
