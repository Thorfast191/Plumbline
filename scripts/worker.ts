import { config } from "dotenv";
import { resolve } from "node:path";
import type { listConnectedStores as ListConnectedStores, prisma as Prisma, withAccountContextOn as WithAccountContextOn } from "@plumbline/model";
import type { createShopifyClientFromEnv as CreateShopifyClientFromEnv } from "@plumbline/connector";
import type { runIncrementalSync as RunIncrementalSync, runRepairPass as RunRepairPass } from "@plumbline/sync";
import type {
  deliverScheduledReport as DeliverScheduledReport,
  evaluateAlertRule as EvaluateAlertRule,
  deliverAlert as DeliverAlert,
  isDue as IsDue,
  ConsoleEmailTransport as ConsoleEmailTransportType,
  ScheduledReportRow,
  AlertRuleRow,
  Cadence,
  DeliveryLogEntry,
} from "@plumbline/report";

config({ path: resolve(import.meta.dirname, "../.env") });

// Dynamic imports, not static — static imports are hoisted and would
// evaluate @plumbline/model (which reads DATABASE_URL_MIGRATE at module load
// time, see packages/model/src/identity.ts) before the dotenv config() call
// above has a chance to populate process.env. (This script runs under tsx's
// default CJS mode, so top-level await isn't available — hence main().)
let listConnectedStores: typeof ListConnectedStores;
let prisma: typeof Prisma;
let withAccountContextOn: typeof WithAccountContextOn;
let createShopifyClientFromEnv: typeof CreateShopifyClientFromEnv;
let runIncrementalSync: typeof RunIncrementalSync;
let runRepairPass: typeof RunRepairPass;
let deliverScheduledReport: typeof DeliverScheduledReport;
let evaluateAlertRule: typeof EvaluateAlertRule;
let deliverAlert: typeof DeliverAlert;
let isDue: typeof IsDue;
let ConsoleEmailTransport: typeof ConsoleEmailTransportType;

// Deliberately a plain Node loop, not a queue system — CLAUDE.md's
// minimalism rule ("do not scaffold unrequested features"). Real Shopify
// Partner credentials do not exist yet (see .env.example), so today this
// loop will find zero connected stores and idle; it is still real,
// runnable code, not a stub — it will do real work the moment a store is
// installed.
const INCREMENTAL_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const REPAIR_INTERVAL_MS = 60 * 60 * 1000; // hourly, trailing 48h window (docs/PLAN.md §10)
const REPAIR_TRAILING_WINDOW_HOURS = 48;
// Scheduled reports/alerts are weekly/monthly, so an hourly check is far
// more frequent than needed to hit any due date — packages/report's isDue
// is what actually gates whether anything fires, not this interval. Hourly
// just bounds worst-case lateness to under an hour, same reasoning as the
// repair loop's cadence.
const REPORT_AND_ALERT_INTERVAL_MS = 60 * 60 * 1000;

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

function toDeliveryLogRow(l: DeliveryLogEntry) {
  return {
    accountId: l.accountId,
    storeId: l.storeId,
    kind: l.kind,
    scheduledReportId: l.scheduledReportId ?? null,
    alertRuleId: l.alertRuleId ?? null,
    status: l.status,
    attempt: l.attempt,
    errorMessage: l.errorMessage ?? null,
    recipientEmails: l.recipientEmails,
    subject: l.subject,
    periodFrom: l.periodFrom,
    periodTo: l.periodTo,
  };
}

async function runScheduledReportsForAllStores(): Promise<void> {
  const stores = await listConnectedStores();
  if (stores.length === 0) {
    console.log(`[worker] scheduled reports: no connected stores yet`);
    return;
  }
  const transport = new ConsoleEmailTransport();
  const reportBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const now = new Date();

  for (const store of stores) {
    try {
      const reports = await withAccountContextOn(prisma, store.accountId, (tx) =>
        tx.scheduledReport.findMany({ where: { storeId: store.id, active: true } })
      );
      for (const r of reports) {
        const report: ScheduledReportRow = {
          id: r.id,
          accountId: r.accountId,
          storeId: r.storeId,
          reportType: r.reportType as ScheduledReportRow["reportType"],
          cadence: r.cadence as Cadence,
          recipientEmails: r.recipientEmails,
          active: r.active,
          lastSentAt: r.lastSentAt,
        };
        if (!isDue(report.cadence, report.lastSentAt, now, store.shopTimezone)) continue;

        const { outcome, period } = await withAccountContextOn(prisma, store.accountId, (tx) =>
          deliverScheduledReport({
            tx,
            transport,
            report,
            storeName: store.shopDomain,
            currency: store.shopCurrency,
            timeZone: store.shopTimezone,
            now,
            reportBaseUrl,
          })
        );
        await withAccountContextOn(prisma, store.accountId, async (tx) => {
          await tx.deliveryLog.createMany({ data: outcome.logs.map(toDeliveryLogRow) });
          if (outcome.status === "delivered") {
            await tx.scheduledReport.update({ where: { id: report.id }, data: { lastSentAt: now } });
          }
        });
        console.log(
          `[worker] scheduled report ${report.reportType} for ${store.shopDomain}: status=${outcome.status} attempts=${outcome.attempts} period=${period.from.toISOString()}..${period.to.toISOString()}`
        );
      }
    } catch (err) {
      console.error(`[worker] scheduled report evaluation failed for ${store.shopDomain}:`, err);
    }
  }
}

async function runAlertEvaluationForAllStores(): Promise<void> {
  const stores = await listConnectedStores();
  if (stores.length === 0) {
    console.log(`[worker] alert evaluation: no connected stores yet`);
    return;
  }
  const transport = new ConsoleEmailTransport();
  const reportBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const now = new Date();

  for (const store of stores) {
    try {
      const rules = await withAccountContextOn(prisma, store.accountId, (tx) =>
        tx.alertRule.findMany({ where: { storeId: store.id, active: true } })
      );
      for (const r of rules) {
        const rule: AlertRuleRow = {
          id: r.id,
          accountId: r.accountId,
          storeId: r.storeId,
          kind: r.kind as AlertRuleRow["kind"],
          metricId: r.metricId,
          comparator: r.comparator as AlertRuleRow["comparator"],
          thresholdMinor: r.thresholdMinor,
          sku: r.sku,
          velocityDropPercent: r.velocityDropPercent,
          cadence: r.cadence as Cadence,
          recipientEmails: r.recipientEmails,
          active: r.active,
          lastEvaluatedAt: r.lastEvaluatedAt,
        };
        if (!isDue(rule.cadence, rule.lastEvaluatedAt, now, store.shopTimezone)) continue;

        const { result, period } = await withAccountContextOn(prisma, store.accountId, (tx) =>
          evaluateAlertRule({ tx, rule, currency: store.shopCurrency, timeZone: store.shopTimezone, now })
        );

        if (result.triggered) {
          const outcome = await deliverAlert({ transport, rule, result, period, reportBaseUrl, timeZone: store.shopTimezone });
          await withAccountContextOn(prisma, store.accountId, (tx) => tx.deliveryLog.createMany({ data: outcome.logs.map(toDeliveryLogRow) }));
          console.log(`[worker] alert ${rule.id} for ${store.shopDomain}: TRIGGERED figure=${result.figureDisplay} threshold=${result.thresholdDisplay}`);
        } else {
          console.log(`[worker] alert ${rule.id} for ${store.shopDomain}: not triggered (figure=${result.figureDisplay} threshold=${result.thresholdDisplay})`);
        }

        await withAccountContextOn(prisma, store.accountId, (tx) => tx.alertRule.update({ where: { id: rule.id }, data: { lastEvaluatedAt: now } }));
      }
    } catch (err) {
      console.error(`[worker] alert evaluation failed for ${store.shopDomain}:`, err);
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
  ({ listConnectedStores, prisma, withAccountContextOn } = await import("@plumbline/model"));
  ({ createShopifyClientFromEnv } = await import("@plumbline/connector"));
  ({ runIncrementalSync, runRepairPass } = await import("@plumbline/sync"));
  ({ deliverScheduledReport, evaluateAlertRule, deliverAlert, isDue, ConsoleEmailTransport } = await import("@plumbline/report"));

  console.log(
    `[worker] starting: incremental every ${INCREMENTAL_INTERVAL_MS / 1000}s, repair every ${REPAIR_INTERVAL_MS / 1000}s, ` +
      `scheduled reports/alerts checked every ${REPORT_AND_ALERT_INTERVAL_MS / 1000}s`
  );
  await Promise.all([
    loop("incremental", INCREMENTAL_INTERVAL_MS, runIncrementalForAllStores),
    loop("repair", REPAIR_INTERVAL_MS, runRepairForAllStores),
    loop("scheduled-reports", REPORT_AND_ALERT_INTERVAL_MS, runScheduledReportsForAllStores),
    loop("alert-evaluation", REPORT_AND_ALERT_INTERVAL_MS, runAlertEvaluationForAllStores),
  ]);
  console.log("[worker] shut down cleanly");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
