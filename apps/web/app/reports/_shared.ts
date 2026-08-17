// Shared helpers for the two Phase 6 report pages. Not a "report builder" —
// BUILD-SPEC.md Phase 6 explicitly forbids that. This is just the small bit
// of query-param parsing and comparison-period selection two fixed report
// pages both need, so it isn't duplicated between them.
import { monthPeriod, previousMonth, sameMonthPreviousYear, type Period } from "../../lib/period.js";

export type CompareMode = "prev_month" | "same_month_last_year";

export interface ResolvedPeriodParams {
  year: number;
  month: number;
  compare: CompareMode;
  current: Period;
  comparison: Period;
  comparisonLabel: string;
}

// The demo/seed store's data (scripts/seed-demo-data.ts) only covers
// calendar year 2025 — default here so the reports show real numbers out of
// the box instead of an empty period around today's actual date.
const DEFAULT_YEAR = 2025;
const DEFAULT_MONTH = 6;

export function resolvePeriodParams(
  searchParams: Record<string, string | string[] | undefined>,
  timeZone: string
): ResolvedPeriodParams {
  const monthParam = typeof searchParams.month === "string" ? searchParams.month : undefined;
  let year = DEFAULT_YEAR;
  let month = DEFAULT_MONTH;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [y, m] = monthParam.split("-").map(Number);
    year = y!;
    month = m!;
  }

  const compare: CompareMode = searchParams.compare === "same_month_last_year" ? "same_month_last_year" : "prev_month";

  const current = monthPeriod(year, month, timeZone);
  const comparisonTarget = compare === "prev_month" ? previousMonth(year, month) : sameMonthPreviousYear(year, month);
  const comparison = monthPeriod(comparisonTarget.year, comparisonTarget.month1to12, timeZone);
  const comparisonLabel =
    compare === "prev_month"
      ? `Previous month (${monthLabel(comparisonTarget.year, comparisonTarget.month1to12)})`
      : `Same month last year (${monthLabel(comparisonTarget.year, comparisonTarget.month1to12)})`;

  return { year, month, compare, current, comparison, comparisonLabel };
}

export function monthLabel(year: number, month1to12: number): string {
  return `${year}-${String(month1to12).padStart(2, "0")}`;
}

export function periodQueryString(year: number, month: number, compare: CompareMode): string {
  return `month=${monthLabel(year, month)}&compare=${compare}`;
}
