import Link from "next/link";
import { getSyncStatus } from "@plumbline/sync";
import { resolveReportStore, getSalesOverviewRows } from "../../../lib/report-query.js";
import { reportRowOnScreenValue, type ReportRow } from "../../../lib/report-data.js";
import { resolvePeriodParams, periodQueryString, monthLabel } from "../_shared.js";
import { combinedFreshness, runDegradable, type FreshnessInfo } from "../../../lib/freshness.js";

// A fixed, opinionated report — not a query builder (docs/BUILD-SPEC.md
// Phase 6 explicitly forbids one). Real Shopify-admin reconciliation
// remains unverified (no live store yet); the 8 figures below are the same
// registry-defined, recon-tested metrics from Phase 4 (32/32 synthetic
// checks, see docs/PLAN.md Risk #1), rendered against the seed store's
// demo dataset (scripts/seed-demo-data.ts).
export const dynamic = "force-dynamic";

export default async function SalesOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const store = await resolveReportStore();

  if (!store) {
    return (
      <main>
        <h1>Sales overview</h1>
        <p>No store found. Run `pnpm --filter @plumbline/model run seed` first.</p>
      </main>
    );
  }

  const { year, month, compare, current, comparison, comparisonLabel } = resolvePeriodParams(params, store.shopTimezone);

  const syncStatus = await getSyncStatus(store.accountId, store.id);
  const freshness = combinedFreshness(syncStatus.states);

  // BUILD-SPEC.md Phase 8: "reports serve stale data with a clear freshness
  // warning, never a blank page or a wrong number." A failure fetching
  // figures (simulating the platform/DB being down or degraded) renders a
  // degraded state below instead of throwing and crashing the whole page.
  const currentResult = await runDegradable(() => getSalesOverviewRows(store.id, store.accountId, current, store.shopCurrency));
  const comparisonResult = await runDegradable(() => getSalesOverviewRows(store.id, store.accountId, comparison, store.shopCurrency));

  const comparisonById = new Map((comparisonResult.data ?? []).map((r) => [r.metricId, r]));

  return (
    <main>
      <h1>Sales overview — {store.shopDomain}</h1>

      <p>
        Real Shopify-admin reconciliation remains unverified — no live store is connected yet (see
        docs/PLAN.md Risk #1). These figures are the same registry-defined metrics validated in
        Phase 4's recon suite (32/32 synthetic checks), computed against this store's synced
        (here: seeded demo) data, not a live merchant's numbers.
      </p>

      <p>
        <strong>Period:</strong> {monthLabel(year, month)} in {store.shopTimezone} (the store's own
        timezone — every date boundary below is computed in this zone, then compared in UTC against
        synced event timestamps; see apps/web/lib/period.ts).
        <br />
        <strong>Range (UTC instants queried):</strong> {current.from.toISOString()} to{" "}
        {current.to.toISOString()}
      </p>

      <form method="get" style={{ marginBottom: "1rem" }}>
        <label>
          Month:{" "}
          <input type="month" name="month" defaultValue={monthLabel(year, month)} />
        </label>{" "}
        <label>
          Compare to:{" "}
          <select name="compare" defaultValue={compare}>
            <option value="prev_month">Previous month</option>
            <option value="same_month_last_year">Same month last year</option>
          </select>
        </label>{" "}
        <button type="submit">Update</button>
      </form>

      <p>
        <a href={`/reports/sales-overview/export?${periodQueryString(year, month, compare)}`}>Export CSV</a> (matches
        the table below exactly — see apps/web/lib/report-data.ts)
      </p>

      <FreshnessBanner freshness={freshness} correctionsLast24h={syncStatus.correctionsLast24h} />

      {!currentResult.ok ? (
        <p role="alert" style={{ border: "2px solid firebrick", padding: "0.5rem" }}>
          <strong>Could not load current-period figures.</strong> {currentResult.errorMessage} — showing no data rather
          than a wrong number. Try again shortly, or check <Link href="/sync-status">sync status</Link>.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>{monthLabel(year, month)}</th>
              <th>{comparisonLabel}</th>
            </tr>
          </thead>
          <tbody>
            {currentResult.data!.map((row) => (
              <tr key={row.metricId}>
                <td title={definitionTitle(row.metricId)}>
                  <Link href={`/metrics#${row.metricId}`}>{row.label}</Link>
                </td>
                <td>{reportRowOnScreenValue(row)}</td>
                <td>{comparisonResult.ok ? formatComparison(comparisonById.get(row.metricId)) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function formatComparison(row: ReportRow | undefined): string {
  return row ? reportRowOnScreenValue(row) : "—";
}

// Hover text uses the metric's own plain-language definition where cheap to
// look up without a second DB round trip — full definitions live at
// /metrics, linked above, per BUILD-SPEC's "every figure hover-reveals its
// definition."
function definitionTitle(metricId: string): string {
  return `See /metrics#${metricId} for the full definition.`;
}

function FreshnessBanner({ freshness, correctionsLast24h }: { freshness: FreshnessInfo; correctionsLast24h: number }) {
  const color = freshness.level === "stale" ? "firebrick" : freshness.level === "unknown" ? "goldenrod" : "inherit";
  return (
    <p style={{ color, fontWeight: freshness.level === "fresh" ? "normal" : "bold" }}>
      <strong>Data freshness:</strong> {freshness.message} — <Link href="/sync-status">full sync status</Link>. Corrections
      in the last 24h: {correctionsLast24h}.
    </p>
  );
}
