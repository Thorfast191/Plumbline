// Phase 4 work — see docs/PLAN.md §11, CLAUDE.md reconciliation-pass-rate north star.

import type { PrismaClient } from "@plumbline/model";
import { withAccountContextOn } from "@plumbline/model";
import { registry, runMetric } from "@plumbline/metrics";
import { buildReconFixture, SINGLE_DAY_PERIOD, MONTH_PERIOD, YEAR_PERIOD, SPECIAL_PERIOD } from "./fixtures.js";
import { computeReferenceFigures, type ReferenceFigures } from "./reference.js";
import { cleanupReconFixture, seedReconFixture } from "./seed.js";

export interface ReconCheckResult {
  checkName: string;
  storeId: string;
  period: { from: Date; to: Date };
  ourFigureMinor: number;
  theirFigureMinor: number | null; // null when platform has no comparable figure (Phase-4b metrics)
  deltaMinor: number | null;
  passed: boolean;
}

export interface ReconRunner {
  /** Any nonzero delta is a failure, never a warning — CLAUDE.md. */
  runAll(storeId: string, period: { from: Date; to: Date }): Promise<ReconCheckResult[]>;
}

/**
 * Real Shopify credentials don't exist yet (docs/PLAN.md Risk #1), so
 * there is no live "platform's own reported figure" to reconcile against.
 * This runner reconciles two INDEPENDENT code paths computing the same
 * synthetic, hand-reasoned data: packages/metrics' SQL over the synced
 * schema, vs. packages/recon/reference.ts's plain-TypeScript reducer over
 * the raw pre-sync fixture. Agreement between two separate implementations
 * is the strongest check possible without a live store — it is NOT the
 * same as matching Shopify's actual admin UI, which remains unverified.
 */
export class SyntheticFixtureReconRunner {
  constructor(private readonly appClient: PrismaClient) {}

  /**
   * Deliberately not `implements ReconRunner`: the production interface
   * above assumes a live platform figure reachable from storeId+period
   * alone. This harness also needs accountId to set RLS context (no live
   * store is connected, so there's no webhook-style lookup path yet) — see
   * packages/model/src/identity.ts for why that resolution is normally a
   * cross-tenant lookup. Once live credentials exist and a real
   * "platform figure" source is wired up, ReconRunner is the interface to
   * implement against synced (not seeded) data.
   */
  async runAll(storeId: string, period: { from: Date; to: Date }, accountId: string): Promise<ReconCheckResult[]> {
    const reference = computeReferenceFigures(buildReconFixture(), period);

    return withAccountContextOn(this.appClient, accountId, async (tx) => {
      const results: ReconCheckResult[] = [];
      for (const def of registry.all()) {
        const ourFigureMinor = await runMetric(def.id, tx, storeId, period);
        const theirFigureMinor = mapMetricToReference(def.id, reference);
        const deltaMinor = ourFigureMinor - theirFigureMinor;
        results.push({
          checkName: def.name,
          storeId,
          period,
          ourFigureMinor,
          theirFigureMinor,
          deltaMinor,
          passed: deltaMinor === 0,
        });
      }
      return results;
    });
  }
}

function mapMetricToReference(metricId: string, ref: ReferenceFigures): number {
  switch (metricId) {
    case "gross_sales":
      return ref.grossSalesMinor;
    case "discounts":
      return ref.discountsMinor;
    case "sales_reversals":
      return ref.salesReversalsMinor;
    case "net_sales":
      return ref.netSalesMinor;
    case "shipping":
      return ref.shippingMinor;
    case "taxes":
      return ref.taxesMinor;
    case "total_sales":
      return ref.totalSalesMinor;
    case "order_count":
      return ref.orderCount;
    default:
      throw new Error(`no reference mapping for metric "${metricId}" — every registered metric needs a recon check`);
  }
}

export interface SyntheticReconReport {
  results: ReconCheckResult[];
  allPassed: boolean;
}

export const RECON_PERIODS: Record<string, { from: Date; to: Date }> = {
  "single day (2025-06-15)": SINGLE_DAY_PERIOD,
  "month (2025-06)": MONTH_PERIOD,
  "year (2025)": YEAR_PERIOD,
  "special week (refund + cancellation + discount + multi-currency + test order, 2025-03-10..17)": SPECIAL_PERIOD,
};

/** Every metric id this recon suite exercises — used by `pnpm metrics:lint` to enforce "no metric ships without a recon test". */
export const RECON_CHECK_METRIC_IDS: string[] = registry.all().map((d) => d.id);

/**
 * Full orchestration for `pnpm recon`: clean any stale fixture data,
 * seed fresh, run every metric against every required period, clean up,
 * and report. Runs against the TEST database — callers must pass clients
 * already pointed at DATABASE_URL_MIGRATE_TEST / DATABASE_URL_TEST.
 */
export async function runSyntheticRecon(params: {
  adminClient: PrismaClient; // DATABASE_URL_MIGRATE_TEST — bypasses RLS, seeds/cleans only
  appClient: PrismaClient; // DATABASE_URL_TEST — the role that runs metric SQL, RLS-scoped
}): Promise<SyntheticReconReport> {
  const { adminClient, appClient } = params;
  await cleanupReconFixture(adminClient); // in case a prior run crashed mid-way

  const fixture = buildReconFixture();
  const { accountId, storeId } = await seedReconFixture(adminClient, fixture);

  try {
    const runner = new SyntheticFixtureReconRunner(appClient);
    const results: ReconCheckResult[] = [];
    for (const [, period] of Object.entries(RECON_PERIODS)) {
      const periodResults = await runner.runAll(storeId, period, accountId);
      results.push(...periodResults);
    }
    return { results, allPassed: results.every((r) => r.passed) };
  } finally {
    await cleanupReconFixture(adminClient);
  }
}

export class NotImplementedReconRunner implements ReconRunner {
  async runAll(): Promise<ReconCheckResult[]> {
    throw new Error("not implemented — Phase 4");
  }
}
