// Phase 7 — scheduled report delivery + threshold alerts, per
// docs/BUILD-SPEC.md Phase 7: "This is the retention feature. A dashboard
// is visited twice; an email arrives every week."
//
// No real email-provider credentials exist yet (see email.ts) — delivery is
// proven against a deterministic mock transport, not a real inbox. This is
// the same category of gap as the missing Shopify Partner credentials
// (docs/PLAN.md Risk #1): everything here is real, runnable code, just not
// yet validated against a live external system.

import type { TenantClient } from "@plumbline/model";
import { registry, runMetric, runMetricTable, type Period } from "@plumbline/metrics";
import type { EmailMessage, EmailTransport } from "./email.js";
import { formatPeriodLabel, isDue, lastCompletedPeriod, type Cadence } from "./period.js";

export * from "./period.js";
export * from "./email.js";

export type ReportType = "sales_overview" | "profitability";

export interface ScheduledReportRow {
  id: string;
  accountId: string;
  storeId: string;
  reportType: ReportType;
  cadence: Cadence;
  recipientEmails: string[];
  active: boolean;
  lastSentAt: Date | null;
}

export type AlertKind = "metric_threshold" | "sku_velocity_drop";
export type Comparator = "below" | "above";

export interface AlertRuleRow {
  id: string;
  accountId: string;
  storeId: string;
  kind: AlertKind;
  metricId: string | null;
  comparator: Comparator | null;
  thresholdMinor: number | null;
  sku: string | null;
  velocityDropPercent: number | null;
  cadence: Cadence;
  recipientEmails: string[];
  active: boolean;
  lastEvaluatedAt: Date | null;
}

export interface DeliveryLogEntry {
  accountId: string;
  storeId: string;
  kind: "scheduled_report" | "alert";
  scheduledReportId?: string;
  alertRuleId?: string;
  status: "delivered" | "failed";
  attempt: number;
  errorMessage?: string;
  recipientEmails: string[];
  subject: string;
  periodFrom: Date;
  periodTo: Date;
}

/** Minimal, dependency-free money formatting — packages/report cannot import apps/web/lib/format.ts (packages don't depend on apps). */
function formatMoney(minorUnits: number, currency: string): string {
  const sign = minorUnits < 0 ? "-" : "";
  return `${sign}${(Math.abs(minorUnits) / 100).toFixed(2)} ${currency}`;
}

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

// Deliberately only the scalar Phase 5 metrics — table metrics (cohort
// retention, LTV-by-channel, discount profitability, returns-by-cohort)
// don't collapse into a short email body without a chart-like layout, which
// BUILD-SPEC's Phase 6/7 both explicitly rule out ("no chart builder").
// They stay a "view the full report" link, not inline email content.
const PROFITABILITY_SCALAR_METRIC_IDS = ["contribution_margin", "repeat_purchase_interval"];

function reportPathSlug(reportType: ReportType): string {
  return reportType === "sales_overview" ? "sales-overview" : "profitability";
}

/**
 * Builds `${reportBaseUrl}/reports/<slug>?year=YYYY&month=M`, matching how
 * apps/web's report pages read their query params (see Phase 6, commit
 * 4e360c8). Uses the store's own timezone to derive year/month from the
 * UTC period bounds, so the link lands on the same civil month the report
 * content was computed for.
 */
function reportLink(reportBaseUrl: string, reportType: ReportType, period: Period, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(
    period.from
  );
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `${reportBaseUrl}/reports/${reportPathSlug(reportType)}?year=${year}&month=${month}`;
}

export interface RenderedContent {
  subject: string;
  textBody: string;
}

/** Content generation independently re-runs the exact same registry SQL apps/web's report pages use (via runMetric) — never a second implementation of a metric, only a second renderer of its already-computed figure. */
export async function renderScheduledReportContent(
  tx: TenantClient,
  storeId: string,
  storeName: string,
  reportType: ReportType,
  cadence: Cadence,
  period: Period,
  currency: string,
  timeZone: string,
  reportBaseUrl: string
): Promise<RenderedContent> {
  const metricIds = reportType === "sales_overview" ? SALES_OVERVIEW_METRIC_IDS : PROFITABILITY_SCALAR_METRIC_IDS;
  const label = reportType === "sales_overview" ? "Sales overview" : "Profitability";
  const periodLabel = formatPeriodLabel(cadence, period, timeZone);

  const lines: string[] = [];
  for (const id of metricIds) {
    const def = registry.get(id);
    if (!def) continue;
    const value = await runMetric(id, tx, storeId, period);
    const display = def.currencyHandling !== "not-applicable" ? formatMoney(value, currency) : String(value);
    lines.push(`${def.name}: ${display}`);
  }

  const link = reportLink(reportBaseUrl, reportType, period, timeZone);
  return {
    subject: `${label} report for ${storeName} — ${periodLabel}`,
    textBody: `${label} — ${periodLabel}\n\n${lines.join("\n")}\n\nFull report: ${link}`,
  };
}

export interface DeliveryOutcome {
  status: "delivered" | "failed";
  attempts: number;
  logs: DeliveryLogEntry[];
}

const MAX_SEND_ATTEMPTS = 3;

async function sendWithRetry(
  transport: EmailTransport,
  message: EmailMessage,
  base: Omit<DeliveryLogEntry, "attempt" | "status" | "errorMessage">
): Promise<DeliveryOutcome> {
  const logs: DeliveryLogEntry[] = [];
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      await transport.send(message);
      logs.push({ ...base, attempt, status: "delivered" });
      return { status: "delivered", attempts: attempt, logs };
    } catch (err) {
      logs.push({ ...base, attempt, status: "failed", errorMessage: err instanceof Error ? err.message : String(err) });
      if (attempt === MAX_SEND_ATTEMPTS) {
        return { status: "failed", attempts: attempt, logs };
      }
    }
  }
  // Unreachable — the loop always returns by MAX_SEND_ATTEMPTS.
  return { status: "failed", attempts: MAX_SEND_ATTEMPTS, logs };
}

/**
 * Whether `report` is due, generates its content from the current registry
 * SQL, and sends it (with retry) — does NOT persist anything (no DeliveryLog
 * rows written, no lastSentAt update). Callers own persistence, since they
 * already hold an RLS-scoped `tx` for both the metric queries and the
 * writes, and packages/report has no opinion on how the caller's
 * transaction is structured.
 */
export async function deliverScheduledReport(params: {
  tx: TenantClient;
  transport: EmailTransport;
  report: ScheduledReportRow;
  storeName: string;
  currency: string;
  timeZone: string;
  now: Date;
  reportBaseUrl: string;
}): Promise<{ outcome: DeliveryOutcome; period: Period }> {
  const { tx, transport, report, storeName, currency, timeZone, now, reportBaseUrl } = params;
  const period = lastCompletedPeriod(report.cadence, now, timeZone);
  const content = await renderScheduledReportContent(
    tx,
    report.storeId,
    storeName,
    report.reportType,
    report.cadence,
    period,
    currency,
    timeZone,
    reportBaseUrl
  );
  const message: EmailMessage = { to: report.recipientEmails, subject: content.subject, textBody: content.textBody };
  const outcome = await sendWithRetry(transport, message, {
    accountId: report.accountId,
    storeId: report.storeId,
    kind: "scheduled_report",
    scheduledReportId: report.id,
    recipientEmails: report.recipientEmails,
    subject: content.subject,
    periodFrom: period.from,
    periodTo: period.to,
  });
  return { outcome, period };
}

export { isDue };

export interface AlertEvaluationResult {
  triggered: boolean;
  figureDisplay: string;
  thresholdDisplay: string;
}

/**
 * Evaluates one AlertRule's condition against real registry SQL (metric
 * thresholds) or the sku_units_sold metric compared across two consecutive
 * equal-length periods (velocity drop). Does not send or persist anything —
 * see deliverAlert for that, mirroring deliverScheduledReport's split.
 */
export async function evaluateAlertRule(params: {
  tx: TenantClient;
  rule: AlertRuleRow;
  currency: string;
  timeZone: string;
  now: Date;
}): Promise<{ result: AlertEvaluationResult; period: Period }> {
  const { tx, rule, currency, timeZone, now } = params;
  const period = lastCompletedPeriod(rule.cadence, now, timeZone);

  if (rule.kind === "metric_threshold") {
    if (!rule.metricId || !rule.comparator || rule.thresholdMinor === null) {
      throw new Error(`alert rule ${rule.id}: metric_threshold requires metricId, comparator, and thresholdMinor`);
    }
    const figureMinor = await runMetric(rule.metricId, tx, rule.storeId, period);
    const triggered = rule.comparator === "below" ? figureMinor < rule.thresholdMinor : figureMinor > rule.thresholdMinor;
    return {
      period,
      result: {
        triggered,
        figureDisplay: formatMoney(figureMinor, currency),
        thresholdDisplay: formatMoney(rule.thresholdMinor, currency),
      },
    };
  }

  // sku_velocity_drop
  if (!rule.sku || rule.velocityDropPercent === null) {
    throw new Error(`alert rule ${rule.id}: sku_velocity_drop requires sku and velocityDropPercent`);
  }
  const previousPeriod = lastCompletedPeriod(rule.cadence, period.from, timeZone);
  const [currentRows, previousRows] = await Promise.all([
    runMetricTable("sku_units_sold", tx, rule.storeId, period),
    runMetricTable("sku_units_sold", tx, rule.storeId, previousPeriod),
  ]);
  const currentUnits = Number((currentRows.find((r) => r.sku === rule.sku)?.units_sold as number | undefined) ?? 0);
  const previousUnits = Number((previousRows.find((r) => r.sku === rule.sku)?.units_sold as number | undefined) ?? 0);

  // No prior-period sales at all means "no baseline to drop from" — not a
  // trigger. Alerting "velocity dropped 100%" off a zero baseline would be
  // noise for a newly-listed SKU, not a signal.
  const dropPercent = previousUnits === 0 ? 0 : ((previousUnits - currentUnits) / previousUnits) * 100;
  const triggered = previousUnits > 0 && dropPercent >= rule.velocityDropPercent;

  return {
    period,
    result: {
      triggered,
      figureDisplay: `${currentUnits} units (was ${previousUnits}, ${dropPercent.toFixed(1)}% change)`,
      thresholdDisplay: `${rule.velocityDropPercent}% drop`,
    },
  };
}

/** Renders and sends the alert email if `evaluateAlertRule` found it triggered. Does not persist — see deliverScheduledReport's comment. */
export async function deliverAlert(params: {
  transport: EmailTransport;
  rule: AlertRuleRow;
  result: AlertEvaluationResult;
  period: Period;
  reportBaseUrl: string;
  timeZone: string;
}): Promise<DeliveryOutcome> {
  const { transport, rule, result, period, reportBaseUrl, timeZone } = params;
  const reportType: ReportType = rule.kind === "metric_threshold" && PROFITABILITY_SCALAR_METRIC_IDS.includes(rule.metricId ?? "")
    ? "profitability"
    : "sales_overview";
  const link = reportLink(reportBaseUrl, reportType, period, timeZone);
  const periodLabel = formatPeriodLabel(rule.cadence, period, timeZone);
  const what = rule.kind === "metric_threshold" ? (registry.get(rule.metricId ?? "")?.name ?? rule.metricId) : `SKU ${rule.sku} velocity`;

  const subject = `Alert: ${what} — ${result.figureDisplay} (threshold: ${result.thresholdDisplay})`;
  const textBody =
    `Alert triggered for ${what}.\n\n` +
    `Figure: ${result.figureDisplay}\n` +
    `Threshold: ${result.thresholdDisplay}\n` +
    `Period: ${periodLabel}\n\n` +
    `Full report: ${link}`;

  const message: EmailMessage = { to: rule.recipientEmails, subject, textBody };
  return sendWithRetry(transport, message, {
    accountId: rule.accountId,
    storeId: rule.storeId,
    kind: "alert",
    alertRuleId: rule.id,
    recipientEmails: rule.recipientEmails,
    subject,
    periodFrom: period.from,
    periodTo: period.to,
  });
}
