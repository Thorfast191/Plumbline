import Link from "next/link";
import { getSyncStatus } from "@plumbline/sync";
import { registry } from "@plumbline/metrics";
import { resolveReportStore, getProfitabilityScalarRows, getProfitabilityTables } from "../../../lib/report-query.js";
import { reportRowOnScreenValue } from "../../../lib/report-data.js";
import { resolvePeriodParams, periodQueryString, monthLabel } from "../_shared.js";

// A fixed, opinionated report (not a query builder) for Phase 5's
// differentiated metrics. None of these have a comparable Shopify admin
// figure (see each metric's nonReconciliationReason in /metrics), and
// several depend on merchant-uploaded COGS/shipping-cost/ad-spend data
// that doesn't exist for any real merchant yet (see estimatedInputs on
// each metric) — this page says so before showing a single number.
export const dynamic = "force-dynamic";

export default async function ProfitabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const store = await resolveReportStore();

  if (!store) {
    return (
      <main>
        <h1>Profitability</h1>
        <p>No store found. Run `pnpm --filter @plumbline/model run seed` first.</p>
      </main>
    );
  }

  const { year, month, current } = resolvePeriodParams(params, store.shopTimezone);

  const [scalarRows, tables, syncStatus] = await Promise.all([
    getProfitabilityScalarRows(store.id, store.accountId, current, store.shopCurrency),
    getProfitabilityTables(store.id, store.accountId, current),
    getSyncStatus(store.accountId, store.id),
  ]);

  return (
    <main>
      <h1>Profitability — {store.shopDomain}</h1>

      <p>
        <strong>No live Shopify store is connected</strong> (see docs/PLAN.md Risk #1) — figures below
        are computed against this store's seeded demo data. None of these metrics has a comparable
        Shopify admin figure (see each metric's definition at <Link href="/metrics">/metrics</Link>).
        Contribution margin, margin by channel, and discount profitability additionally depend on
        merchant-uploaded COGS/shipping-cost data that has not been uploaded for this store — those
        figures are demonstrations of correct mechanics on synthetic input, not validated numbers.
        Cohort retention, LTV by channel, and returns-by-cohort require orders linked to a customer
        record; the seeded demo dataset does not link orders to customers, so those tables are
        expected to render empty here (a real synced store's orders are linked, per
        packages/sync/src/upsert.ts).
      </p>

      <p>
        <strong>Period:</strong> {monthLabel(year, month)} in {store.shopTimezone}.{" "}
        <strong>Range (UTC instants queried):</strong> {current.from.toISOString()} to{" "}
        {current.to.toISOString()}
      </p>

      <form method="get" style={{ marginBottom: "1rem" }}>
        <label>
          Month: <input type="month" name="month" defaultValue={monthLabel(year, month)} />
        </label>{" "}
        <button type="submit">Update</button>
      </form>

      <p>
        <a href={`/reports/profitability/export?${periodQueryString(year, month, "prev_month")}`}>Export CSV</a>
      </p>

      <p>
        <strong>Data freshness:</strong> <Link href="/sync-status">full sync status</Link>. Corrections
        in the last 24h: {syncStatus.correctionsLast24h}.
      </p>

      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>{monthLabel(year, month)}</th>
          </tr>
        </thead>
        <tbody>
          {scalarRows.map((row) => (
            <tr key={row.metricId}>
              <td title={`See /metrics#${row.metricId} for the full definition.`}>
                <Link href={`/metrics#${row.metricId}`}>{row.label}</Link>
                {(registry.get(row.metricId)?.estimatedInputs.length ?? 0) > 0 ? " *" : ""}
              </td>
              <td>{reportRowOnScreenValue(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>* depends on merchant-uploaded/estimated data — see /metrics for which inputs.</p>

      {tables.map((table) => (
        <section key={table.metricId}>
          <h2 title={`See /metrics#${table.metricId} for the full definition.`}>
            <Link href={`/metrics#${table.metricId}`}>{table.label}</Link>
            {(registry.get(table.metricId)?.estimatedInputs.length ?? 0) > 0 ? " *" : ""}
          </h2>
          {table.rows.length === 0 ? (
            <p>No data for this period.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {table.columns.map((c) => (
                      <td key={c}>{String(row[c] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </main>
  );
}
