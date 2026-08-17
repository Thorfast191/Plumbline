// Pure data shapes + CSV serialization for report pages. Deliberately has
// no dependency on @plumbline/model or a database connection — importing
// @plumbline/model triggers a PrismaClient connection at module load time
// (see packages/model/src/client.ts), which this file must stay free of so
// it can be unit-tested (apps/web/lib/__tests__/csv-export.test.ts) without
// a database. Actual metric querying lives in report-query.ts.
import { toCsv } from "./csv.js";
import { formatCount, formatMoney } from "./format.js";

export type ReportRow =
  | { metricId: string; label: string; kind: "money"; minorUnits: number; currency: string }
  | { metricId: string; label: string; kind: "count"; value: number };

export function reportRowOnScreenValue(row: ReportRow): string {
  return row.kind === "money" ? formatMoney(row.minorUnits, row.currency) : formatCount(row.value);
}

/**
 * The CSV export — built from the exact same ReportRow objects and the
 * exact same formatCount/formatMoney calls (via reportRowOnScreenValue) the
 * report page uses to render its table, so the two cannot drift. Per
 * docs/BUILD-SPEC.md Phase 6: "Export to CSV matching what is on screen
 * exactly."
 */
export function reportRowsToCsv(rows: ReportRow[]): string {
  return toCsv(
    ["Metric", "Value"],
    rows.map((r) => [r.label, reportRowOnScreenValue(r)])
  );
}

/**
 * Table-shaped metrics (e.g. cohort retention, LTV by channel) return
 * arbitrary column sets per metric.SQL — this renders their raw row values
 * as strings the same way for both the on-screen table and its CSV export,
 * called from a single place in each report page/route so they can't drift.
 */
export function tableRowsToCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return toCsv(
    columns,
    rows.map((row) => columns.map((c) => String(row[c] ?? "")))
  );
}
