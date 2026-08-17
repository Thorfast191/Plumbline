// DB-touching report queries. Kept separate from report-data.ts (pure
// shapes/CSV) so that file can be unit-tested without a database — see the
// comment there.
import { prisma, withAccountContextOn, resolveStoreByDomain, type StoreIdentity } from "@plumbline/model";
import { registry, runMetric, runMetricTable, type Period } from "@plumbline/metrics";
import type { ReportRow } from "./report-data.js";

export const SEED_SHOP_DOMAIN = "seed-store.myshopify.com";

const SALES_OVERVIEW_METRIC_IDS = [
  "gross_sales",
  "discounts",
  "sales_reversals",
  "net_sales",
  "shipping",
  "taxes",
  "total_sales",
  "order_count",
];

const PROFITABILITY_SCALAR_METRIC_IDS = ["contribution_margin", "repeat_purchase_interval"];
const PROFITABILITY_TABLE_METRIC_IDS = [
  "contribution_margin_by_channel",
  "cohort_retention_by_month",
  "ltv_by_channel_90d",
  "discount_profitability",
  "returns_by_variant_cohort",
];

export interface ReportTable {
  metricId: string;
  label: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export async function resolveReportStore(): Promise<StoreIdentity | null> {
  return resolveStoreByDomain(SEED_SHOP_DOMAIN);
}

async function scalarRows(
  metricIds: string[],
  storeId: string,
  accountId: string,
  period: Period,
  currency: string
): Promise<ReportRow[]> {
  return withAccountContextOn(prisma, accountId, async (tx) => {
    const rows: ReportRow[] = [];
    for (const id of metricIds) {
      const def = registry.get(id);
      if (!def) continue;
      const value = await runMetric(id, tx, storeId, period);
      rows.push(
        def.resultShape === "scalar" && def.currencyHandling !== "not-applicable"
          ? { metricId: id, label: def.name, kind: "money", minorUnits: value, currency }
          : { metricId: id, label: def.name, kind: "count", value }
      );
    }
    return rows;
  });
}

export async function getSalesOverviewRows(
  storeId: string,
  accountId: string,
  period: Period,
  currency: string
): Promise<ReportRow[]> {
  return scalarRows(SALES_OVERVIEW_METRIC_IDS, storeId, accountId, period, currency);
}

export async function getProfitabilityScalarRows(
  storeId: string,
  accountId: string,
  period: Period,
  currency: string
): Promise<ReportRow[]> {
  return scalarRows(PROFITABILITY_SCALAR_METRIC_IDS, storeId, accountId, period, currency);
}

export async function getProfitabilityTables(
  storeId: string,
  accountId: string,
  period: Period
): Promise<ReportTable[]> {
  return withAccountContextOn(prisma, accountId, async (tx) => {
    const tables: ReportTable[] = [];
    for (const id of PROFITABILITY_TABLE_METRIC_IDS) {
      const def = registry.get(id);
      if (!def) continue;
      const rows = await runMetricTable(id, tx, storeId, period);
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      tables.push({ metricId: id, label: def.name, columns, rows });
    }
    return tables;
  });
}
