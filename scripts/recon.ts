import { config } from "dotenv";
import { resolve } from "node:path";
import type { PrismaClient as PrismaClientType } from "@plumbline/model";
import type { runSyntheticRecon as RunSyntheticRecon, ReconCheckResult } from "@plumbline/recon";

config({ path: resolve(import.meta.dirname, "../.env") });

// Real Shopify credentials don't exist yet (see .env.example /
// docs/PLAN.md Risk #1), so there is no live platform figure to reconcile
// against. This CLI runs the synthetic-fixture harness instead: it seeds
// packages/recon/src/fixtures.ts's deterministic order set into the TEST
// database, computes each of the 8 baseline metrics via packages/metrics'
// real SQL, and compares against packages/recon/src/reference.ts's
// independent reducer over the same raw fixture data. Agreement between
// those two separately-implemented code paths is the strongest check
// available without a live store; it is NOT the same as matching Shopify's
// actual admin UI, which remains unverified until real credentials exist.
//
// Dynamic imports, not static: @plumbline/model reads DATABASE_URL_MIGRATE
// at module load time (see packages/model/src/identity.ts), so the config()
// call above must run first (same reasoning as scripts/worker.ts).
async function main(): Promise<void> {
  console.log(
    "[recon] real-Shopify-admin reconciliation is UNVERIFIED — no live Shopify credentials exist yet. " +
      "This run proves internal consistency between two independent code paths (SQL over synced tables " +
      "vs. a plain-TypeScript reducer over raw synthetic fixtures) computing the same hand-reasoned dataset.\n"
  );

  const migrateTestUrl = process.env.DATABASE_URL_MIGRATE_TEST;
  const testUrl = process.env.DATABASE_URL_TEST;
  if (!migrateTestUrl || !testUrl) {
    console.error("DATABASE_URL_MIGRATE_TEST and DATABASE_URL_TEST must be set (see .env / .env.example) to run pnpm recon.");
    process.exit(1);
  }

  const { PrismaClient } = await import("@plumbline/model");
  const { runSyntheticRecon } = (await import("@plumbline/recon")) as { runSyntheticRecon: typeof RunSyntheticRecon };

  const adminClient: PrismaClientType = new PrismaClient({ datasourceUrl: migrateTestUrl });
  const appClient: PrismaClientType = new PrismaClient({ datasourceUrl: testUrl });

  try {
    const { results, allPassed } = await runSyntheticRecon({ adminClient, appClient });
    printReport(results);

    if (!allPassed) {
      console.error("\n[recon] FAILED — at least one check has a nonzero delta. Per CLAUDE.md, this is a bug, not a warning.");
      process.exit(1);
    }
    console.log("\n[recon] all checks passed (delta = 0 on every check, every period).");
  } finally {
    await adminClient.$disconnect();
    await appClient.$disconnect();
  }
}

function printReport(results: ReconCheckResult[]): void {
  const byPeriod = new Map<string, ReconCheckResult[]>();
  for (const r of results) {
    const key = `${r.period.from.toISOString()} .. ${r.period.to.toISOString()}`;
    byPeriod.set(key, [...(byPeriod.get(key) ?? []), r]);
  }

  for (const [period, checks] of byPeriod) {
    console.log(`\nPeriod: ${period}`);
    for (const c of checks) {
      const status = c.passed ? "PASS" : "FAIL";
      console.log(
        `  [${status}] ${c.checkName.padEnd(28)} ours=${String(c.ourFigureMinor).padStart(10)}  theirs=${String(
          c.theirFigureMinor
        ).padStart(10)}  delta=${String(c.deltaMinor)}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
