import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

// Phase 6 needs the report pages to render real, non-zero numbers in a
// running `next dev`, and Gate 6 explicitly asks to "verify an exported CSV
// matches the on-screen figures" — neither is checkable against an empty
// store. There is still no live Shopify store, so this seeds the same
// deterministic synthetic order set packages/recon already uses for
// reconciliation (packages/recon/src/fixtures.ts) into the persistent seed
// store from packages/model/prisma/seed.ts, instead of inventing a second
// fixture generator. This is demo data, not a merchant's real figures —
// every report page says so.
//
// Idempotent: deletes any previously-seeded orders for the seed account
// before reinserting, so re-running this script (e.g. after a schema
// change) doesn't hit a primary-key collision on the fixture's fixed order
// ids.
async function main(): Promise<void> {
  const migrateUrl = process.env.DATABASE_URL_MIGRATE;
  if (!migrateUrl) {
    console.error("DATABASE_URL_MIGRATE is not set (see .env.example).");
    process.exit(1);
  }

  const { PrismaClient } = await import("@plumbline/model");
  const { buildReconFixture, deleteOrdersForAccount, insertOrdersForStore } = await import("@plumbline/recon");

  const prisma = new PrismaClient({ datasourceUrl: migrateUrl });

  try {
    const store = await prisma.store.findUnique({ where: { shopDomain: "seed-store.myshopify.com" } });
    if (!store) {
      console.error('No seed store found. Run `pnpm --filter @plumbline/model run seed` first.');
      process.exit(1);
    }

    await deleteOrdersForAccount(prisma, store.accountId);
    const orders = buildReconFixture();
    await insertOrdersForStore(prisma, store.accountId, store.id, orders);

    console.log(`Seeded ${orders.length} demo orders into ${store.shopDomain} (account ${store.accountId}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
