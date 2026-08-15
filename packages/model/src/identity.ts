import { PrismaClient } from "@prisma/client";

/**
 * Store identity resolution (shop domain / store id -> account id) is the
 * one legitimate case where a lookup must happen *before* an account context
 * exists — e.g. a webhook arrives with only a shop domain, or a worker loop
 * needs to enumerate installed stores across all accounts. That is
 * necessarily a cross-tenant query, so it cannot go through the RLS-bound
 * `prisma` client from client.ts.
 *
 * This uses the same superuser/migrate connection as prisma/seed.ts for the
 * same reason: no narrower-privileged role exists yet. Flagged for Phase 8
 * hardening: a dedicated role granted SELECT only on
 * stores(id, account_id, shop_domain, ...) would be the correct production
 * design instead of reusing migration credentials at runtime.
 */
const migrateUrl = process.env.DATABASE_URL_MIGRATE;
if (!migrateUrl) {
  throw new Error("DATABASE_URL_MIGRATE is not set (see .env.example) — required for store identity resolution.");
}
const adminPrisma = new PrismaClient({ datasourceUrl: migrateUrl });

export interface StoreIdentity {
  id: string;
  accountId: string;
  shopDomain: string;
  shopCurrency: string;
  shopTimezone: string;
  installedAt: Date | null;
}

function toIdentity(store: {
  id: string;
  accountId: string;
  shopDomain: string;
  shopCurrency: string;
  shopTimezone: string;
  installedAt: Date | null;
}): StoreIdentity {
  return store;
}

export async function resolveStoreByDomain(shopDomain: string): Promise<StoreIdentity | null> {
  const store = await adminPrisma.store.findUnique({
    where: { shopDomain },
    select: { id: true, accountId: true, shopDomain: true, shopCurrency: true, shopTimezone: true, installedAt: true },
  });
  return store ? toIdentity(store) : null;
}

export async function resolveStoreById(storeId: string): Promise<StoreIdentity | null> {
  const store = await adminPrisma.store.findUnique({
    where: { id: storeId },
    select: { id: true, accountId: true, shopDomain: true, shopCurrency: true, shopTimezone: true, installedAt: true },
  });
  return store ? toIdentity(store) : null;
}

export async function listConnectedStores(): Promise<StoreIdentity[]> {
  const stores = await adminPrisma.store.findMany({
    where: { installedAt: { not: null } },
    select: { id: true, accountId: true, shopDomain: true, shopCurrency: true, shopTimezone: true, installedAt: true },
  });
  return stores.map(toIdentity);
}
