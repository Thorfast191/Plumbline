import { config } from "dotenv";
import { resolve } from "node:path";
import type { listConnectedStores as ListConnectedStores } from "@plumbline/model";
import type { createShopifyClientFromEnv as CreateShopifyClientFromEnv } from "@plumbline/connector";
import type { runIncrementalSync as RunIncrementalSync, runRepairPass as RunRepairPass } from "@plumbline/sync";

config({ path: resolve(import.meta.dirname, "../.env") });

// Dynamic imports, not static — static imports are hoisted and would
// evaluate @plumbline/model (which reads DATABASE_URL_MIGRATE at module load
// time, see packages/model/src/identity.ts) before the dotenv config() call
// above has a chance to populate process.env. (This script runs under tsx's
// default CJS mode, so top-level await isn't available — hence main().)
let listConnectedStores: typeof ListConnectedStores;
let createShopifyClientFromEnv: typeof CreateShopifyClientFromEnv;
let runIncrementalSync: typeof RunIncrementalSync;
let runRepairPass: typeof RunRepairPass;

// Deliberately a plain Node loop, not a queue system — CLAUDE.md's
// minimalism rule ("do not scaffold unrequested features"). Real Shopify
// Partner credentials do not exist yet (see .env.example), so today this
// loop will find zero connected stores and idle; it is still real,
// runnable code, not a stub — it will do real work the moment a store is
// installed.
const INCREMENTAL_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const REPAIR_INTERVAL_MS = 60 * 60 * 1000; // hourly, trailing 48h window (docs/PLAN.md §10)
const REPAIR_TRAILING_WINDOW_HOURS = 48;

let shuttingDown = false;
process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

async function runIncrementalForAllStores(): Promise<void> {
  const stores = await listConnectedStores();
  if (stores.length === 0) {
    console.log(`[worker] incremental sync: no connected stores yet`);
    return;
  }
  for (const store of stores) {
    try {
      const client = createShopifyClientFromEnv(store.shopDomain);
      const result = await runIncrementalSync({
        connector: client,
        accountId: store.accountId,
        storeId: store.id,
        resource: "orders",
      });
      console.log(
        `[worker] incremental sync ${store.shopDomain}: fetched=${result.ordersFetched} upserted=${result.ordersUpserted}`
      );
    } catch (err) {
      console.error(`[worker] incremental sync failed for ${store.shopDomain}:`, err);
    }
  }
}

async function runRepairForAllStores(): Promise<void> {
  const stores = await listConnectedStores();
  if (stores.length === 0) {
    console.log(`[worker] repair loop: no connected stores yet`);
    return;
  }
  for (const store of stores) {
    try {
      const client = createShopifyClientFromEnv(store.shopDomain);
      const result = await runRepairPass({
        connector: client,
        accountId: store.accountId,
        storeId: store.id,
        trailingWindowHours: REPAIR_TRAILING_WINDOW_HOURS,
      });
      console.log(
        `[worker] repair pass ${store.shopDomain}: checked=${result.ordersChecked} corrections=${result.correctionCount}`
      );
    } catch (err) {
      console.error(`[worker] repair pass failed for ${store.shopDomain}:`, err);
    }
  }
}

async function loop(name: string, intervalMs: number, fn: () => Promise<void>): Promise<void> {
  while (!shuttingDown) {
    await fn().catch((err) => console.error(`[worker] ${name} threw:`, err));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main(): Promise<void> {
  ({ listConnectedStores } = await import("@plumbline/model"));
  ({ createShopifyClientFromEnv } = await import("@plumbline/connector"));
  ({ runIncrementalSync, runRepairPass } = await import("@plumbline/sync"));

  console.log(
    `[worker] starting: incremental every ${INCREMENTAL_INTERVAL_MS / 1000}s, repair every ${REPAIR_INTERVAL_MS / 1000}s`
  );
  await Promise.all([
    loop("incremental", INCREMENTAL_INTERVAL_MS, runIncrementalForAllStores),
    loop("repair", REPAIR_INTERVAL_MS, runRepairForAllStores),
  ]);
  console.log("[worker] shut down cleanly");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
