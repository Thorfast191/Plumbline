import { PrismaClient } from "@prisma/client";

/**
 * Store identity resolution (shop domain / store id -> account id) is the
 * one legitimate case where a lookup must happen *before* an account context
 * exists — e.g. a webhook arrives with only a shop domain, or a worker loop
 * needs to enumerate installed stores across all accounts. That is
 * necessarily a cross-tenant query, so it cannot go through the RLS-bound
 * `prisma` client from client.ts.
 *
 * Phase 8 hardening: this used to reuse the DATABASE_URL_MIGRATE superuser
 * connection purely because no narrower role existed. It now connects as
 * `plumbline_identity` (DATABASE_URL_IDENTITY — see
 * scripts/provision-identity-role.ts and .env.example), a role granted
 * SELECT only on `stores`, nothing else, on every other table. It still
 * needs BYPASSRLS (the cross-tenant read is the point), but it can no
 * longer write anything anywhere, unlike the migrate role it replaced.
 */
const identityUrl = process.env.DATABASE_URL_IDENTITY;
if (!identityUrl) {
  throw new Error("DATABASE_URL_IDENTITY is not set (see .env.example) — required for store identity resolution.");
}
const identityPrisma = new PrismaClient({ datasourceUrl: identityUrl });

export interface StoreIdentity {
  id: string;
  accountId: string;
  shopDomain: string;
  shopCurrency: string;
  shopTimezone: string;
  installedAt: Date | null;
  uninstalledAt: Date | null;
}

function toIdentity(store: StoreIdentity): StoreIdentity {
  return store;
}

const SELECT = {
  id: true,
  accountId: true,
  shopDomain: true,
  shopCurrency: true,
  shopTimezone: true,
  installedAt: true,
  uninstalledAt: true,
} as const;

export async function resolveStoreByDomain(shopDomain: string): Promise<StoreIdentity | null> {
  const store = await identityPrisma.store.findUnique({ where: { shopDomain }, select: SELECT });
  return store ? toIdentity(store) : null;
}

export async function resolveStoreById(storeId: string): Promise<StoreIdentity | null> {
  const store = await identityPrisma.store.findUnique({ where: { id: storeId }, select: SELECT });
  return store ? toIdentity(store) : null;
}

export async function listConnectedStores(): Promise<StoreIdentity[]> {
  const stores = await identityPrisma.store.findMany({ where: { installedAt: { not: null } }, select: SELECT });
  return stores.map(toIdentity);
}
