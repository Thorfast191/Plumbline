import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

config({ path: resolve(import.meta.dirname, "../../../.env") });

// Seeds via the migrate/superuser connection since RLS would otherwise
// reject an insert made with no account context set. Real inserts happen
// through packages/sync via withAccountContext once a store is connected.
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_MIGRATE });

async function main() {
  const account = await prisma.account.upsert({
    where: { id: "seed-account-1" },
    update: {},
    create: { id: "seed-account-1", name: "Seed Account" },
  });

  await prisma.store.upsert({
    where: { shopDomain: "seed-store.myshopify.com" },
    update: {},
    create: {
      accountId: account.id,
      shopDomain: "seed-store.myshopify.com",
      shopCurrency: "USD",
      shopTimezone: "America/New_York",
      // No real OAuth token exists yet — Shopify Partner app credentials
      // are not configured (see .env.example). This store is not connected;
      // installedAt stays null until a real OAuth install completes.
      accessTokenEncrypted: "PENDING_REAL_SHOPIFY_OAUTH",
      installedAt: null,
    },
  });

  console.log(`Seeded account ${account.id} with store seed-store.myshopify.com (not yet connected to Shopify).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
