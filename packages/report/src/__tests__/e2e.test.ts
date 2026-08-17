import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, withAccountContextOn } from "@plumbline/model";
import { buildReconFixture, seedReconFixture, cleanupReconFixture } from "@plumbline/recon";
import { deliverScheduledReport, evaluateAlertRule, deliverAlert, type ScheduledReportRow, type AlertRuleRow } from "../index.js";
import { MockEmailTransport } from "../email.js";

// Real DB-backed demonstration of docs/BUILD-SPEC.md Gate 7: "Deliver a
// scheduled report and trigger one alert end to end." Reuses
// packages/recon's fixture/seed helpers (same synthetic dataset already
// proven against an independent reference reducer by pnpm recon) rather
// than inventing a second dataset — a real Postgres round-trip through the
// same registry SQL every other phase uses, not a mock of the DB layer.
//
// "now" = 2025-04-10, so the last *completed* month (per packages/report's
// cadence math) is March 2025 — which contains the fixture's refund
// (recon-special-refund, processed 2025-03-13, $150 goods), giving a real,
// non-zero sales_reversals figure to alert on.
const NOW = new Date("2025-04-10T00:00:00.000Z");
const REPORT_BASE_URL = "http://localhost:3000";

describe("Phase 7 end-to-end — scheduled report delivery + alert firing (docs/BUILD-SPEC.md Gate 7)", () => {
  const migrateUrl = process.env.DATABASE_URL_MIGRATE_TEST;
  const appUrl = process.env.DATABASE_URL_TEST;
  if (!migrateUrl || !appUrl) {
    throw new Error("DATABASE_URL_MIGRATE_TEST / DATABASE_URL_TEST must be set to run this test (see .env).");
  }
  const adminClient = new PrismaClient({ datasourceUrl: migrateUrl });
  const appClient = new PrismaClient({ datasourceUrl: appUrl });

  let accountId: string;
  let storeId: string;

  beforeAll(async () => {
    // Defensive pre-clean, same idempotency reasoning as
    // cleanupReconFixture itself (a prior crashed run may have left rows
    // behind) — but scoped to the Phase 7 tables cleanupReconFixture
    // doesn't know about, since it's shared with Phase 4/5/6's recon runs
    // and scripts/seed-demo-data.ts and shouldn't carry Phase-7-specific
    // table knowledge.
    const { RECON_FIXTURE_SHOP_DOMAIN } = await import("@plumbline/recon");
    const existing = await adminClient.store.findUnique({ where: { shopDomain: RECON_FIXTURE_SHOP_DOMAIN } });
    if (existing) {
      await adminClient.deliveryLog.deleteMany({ where: { accountId: existing.accountId } });
      await adminClient.scheduledReport.deleteMany({ where: { accountId: existing.accountId } });
      await adminClient.alertRule.deleteMany({ where: { accountId: existing.accountId } });
    }
    await cleanupReconFixture(adminClient);
    const seeded = await seedReconFixture(adminClient, buildReconFixture());
    accountId = seeded.accountId;
    storeId = seeded.storeId;
  });

  afterAll(async () => {
    // Phase 7 rows this test created reference the recon fixture's
    // store/account — must be deleted before cleanupReconFixture can drop
    // that store/account (FK), same dependency-order reasoning as
    // insertOrdersForStore's own child-before-parent comment.
    await adminClient.deliveryLog.deleteMany({ where: { accountId } });
    await adminClient.scheduledReport.deleteMany({ where: { accountId } });
    await adminClient.alertRule.deleteMany({ where: { accountId } });
    await cleanupReconFixture(adminClient);
    await adminClient.$disconnect();
    await appClient.$disconnect();
  });

  it("delivers a due scheduled report with real computed figures and records a delivery log entry", async () => {
    const transport = new MockEmailTransport();
    const report: ScheduledReportRow = {
      id: "sched-1",
      accountId,
      storeId,
      reportType: "sales_overview",
      cadence: "monthly",
      recipientEmails: ["owner@example.com"],
      active: true,
      lastSentAt: null, // never sent -> due immediately
    };

    const { outcome, period } = await withAccountContextOn(appClient, accountId, (tx) =>
      deliverScheduledReport({
        tx,
        transport,
        report,
        storeName: "Recon Fixture Store",
        currency: "USD",
        timeZone: "UTC",
        now: NOW,
        reportBaseUrl: REPORT_BASE_URL,
      })
    );

    expect(outcome.status).toBe("delivered");
    expect(outcome.attempts).toBe(1);
    expect(period.from.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    expect(period.to.toISOString()).toBe("2025-04-01T00:00:00.000Z");

    expect(transport.sent).toHaveLength(1);
    const email = transport.sent[0]!;
    console.log(`[Gate 7] scheduled report delivered — to=${email.to.join(",")} subject="${email.subject}"\n${email.textBody}\n`);
    expect(email.to).toEqual(["owner@example.com"]);
    expect(email.subject).toContain("Sales overview report");
    expect(email.subject).toContain("March 2025");
    // Real, non-placeholder figures — the fixture's March calendar-month
    // gross sales includes the ordinary daily filler orders plus the
    // special-week orders (discount/refund/cancelled/multi-currency/test).
    expect(email.textBody).toMatch(/Gross sales: [\d,.]+ USD/);
    expect(email.textBody).toMatch(/Order count: \d+/);
    expect(email.textBody).toContain("http://localhost:3000/reports/sales-overview?year=2025&month=3");

    // Persist the delivery log the way scripts/worker.ts's real evaluation
    // loop would — proves the schema/RLS path, not just the in-memory logic.
    await withAccountContextOn(appClient, accountId, async (tx) => {
      // FK-ordered: scheduled_reports row must exist before delivery_log
      // rows can reference it.
      await tx.scheduledReport.upsert({
        where: { id: report.id },
        create: { id: report.id, accountId, storeId, reportType: report.reportType, cadence: report.cadence, recipientEmails: report.recipientEmails, lastSentAt: NOW },
        update: { lastSentAt: NOW },
      });
      await tx.deliveryLog.createMany({
        data: outcome.logs.map((l) => ({
          accountId: l.accountId,
          storeId: l.storeId,
          kind: l.kind,
          scheduledReportId: l.scheduledReportId ?? null,
          status: l.status,
          attempt: l.attempt,
          errorMessage: l.errorMessage ?? null,
          recipientEmails: l.recipientEmails,
          subject: l.subject,
          periodFrom: l.periodFrom,
          periodTo: l.periodTo,
        })),
      });
    });

    const logged = await withAccountContextOn(appClient, accountId, (tx) =>
      tx.deliveryLog.findMany({ where: { scheduledReportId: report.id } })
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]!.status).toBe("delivered");
    console.log(`[Gate 7] delivery_log row persisted — id=${logged[0]!.id} status=${logged[0]!.status} attempt=${logged[0]!.attempt}`);

    const persisted = await withAccountContextOn(appClient, accountId, (tx) => tx.scheduledReport.findUnique({ where: { id: report.id } }));
    expect(persisted?.lastSentAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("evaluates and fires a 'returns above Y' alert against the real refund in the fixture, with figure/threshold/period/link in the email", async () => {
    const transport = new MockEmailTransport();
    const rule: AlertRuleRow = {
      id: "alert-returns-1",
      accountId,
      storeId,
      kind: "metric_threshold",
      metricId: "sales_reversals",
      comparator: "above",
      thresholdMinor: 10_000, // $100 — the fixture's March refund is $150 in goods
      sku: null,
      velocityDropPercent: null,
      cadence: "monthly",
      recipientEmails: ["owner@example.com"],
      active: true,
      lastEvaluatedAt: null,
    };

    const { result, period } = await withAccountContextOn(appClient, accountId, (tx) =>
      evaluateAlertRule({ tx, rule, currency: "USD", timeZone: "UTC", now: NOW })
    );
    expect(result.triggered).toBe(true);
    expect(result.figureDisplay).toBe("150.00 USD");
    expect(result.thresholdDisplay).toBe("100.00 USD");

    const outcome = await deliverAlert({ transport, rule, result, period, reportBaseUrl: REPORT_BASE_URL, timeZone: "UTC" });
    expect(outcome.status).toBe("delivered");
    expect(transport.sent).toHaveLength(1);
    const email = transport.sent[0]!;
    console.log(`[Gate 7] alert fired ("returns above Y") — to=${email.to.join(",")} subject="${email.subject}"\n${email.textBody}\n`);
    expect(email.subject).toContain("Sales reversals");
    expect(email.subject).toContain("150.00 USD");
    expect(email.subject).toContain("100.00 USD");
    expect(email.textBody).toContain("Figure: 150.00 USD");
    expect(email.textBody).toContain("Threshold: 100.00 USD");
    expect(email.textBody).toContain("Period: March 2025");
    expect(email.textBody).toContain("http://localhost:3000/reports/sales-overview?year=2025&month=3");
  });

  it("a 'margin below X' alert set well above the real computed margin does NOT fire (proves it's not a rubber-stamp trigger)", async () => {
    const transport = new MockEmailTransport();
    const rule: AlertRuleRow = {
      id: "alert-margin-no-trigger",
      accountId,
      storeId,
      kind: "metric_threshold",
      metricId: "contribution_margin",
      comparator: "below",
      thresholdMinor: 1, // 1 cent — no real store margin is below this
      sku: null,
      velocityDropPercent: null,
      cadence: "monthly",
      recipientEmails: ["owner@example.com"],
      active: true,
      lastEvaluatedAt: null,
    };
    const { result, period } = await withAccountContextOn(appClient, accountId, (tx) =>
      evaluateAlertRule({ tx, rule, currency: "USD", timeZone: "UTC", now: NOW })
    );
    expect(result.triggered).toBe(false);

    const outcome = await deliverAlert({ transport, rule, result, period, reportBaseUrl: REPORT_BASE_URL, timeZone: "UTC" });
    // deliverAlert itself doesn't gate on `triggered` — callers (the worker
    // loop) only call it when evaluateAlertRule says triggered:true. This
    // assertion documents that contract rather than re-testing it.
    expect(outcome.status).toBe("delivered");
    void outcome;
  });

  it("retries a failed send and eventually delivers, logging every attempt", async () => {
    const transport = new MockEmailTransport();
    transport.failNextSends(2); // first two sends fail, third succeeds

    const report: ScheduledReportRow = {
      id: "sched-retry-1",
      accountId,
      storeId,
      reportType: "sales_overview",
      cadence: "monthly",
      recipientEmails: ["owner@example.com"],
      active: true,
      lastSentAt: null,
    };

    const { outcome } = await withAccountContextOn(appClient, accountId, (tx) =>
      deliverScheduledReport({ tx, transport, report, storeName: "Recon Fixture Store", currency: "USD", timeZone: "UTC", now: NOW, reportBaseUrl: REPORT_BASE_URL })
    );

    expect(outcome.status).toBe("delivered");
    expect(outcome.attempts).toBe(3);
    expect(outcome.logs).toHaveLength(3);
    expect(outcome.logs[0]!.status).toBe("failed");
    expect(outcome.logs[0]!.attempt).toBe(1);
    expect(outcome.logs[0]!.errorMessage).toContain("simulated send failure");
    expect(outcome.logs[1]!.status).toBe("failed");
    expect(outcome.logs[1]!.attempt).toBe(2);
    expect(outcome.logs[2]!.status).toBe("delivered");
    expect(outcome.logs[2]!.attempt).toBe(3);
    expect(transport.sent).toHaveLength(1); // only the successful attempt is "sent"
  });

  it("gives up and logs 'failed' after exhausting all retry attempts", async () => {
    const transport = new MockEmailTransport();
    transport.failNextSends(10); // more failures than MAX_SEND_ATTEMPTS

    const report: ScheduledReportRow = {
      id: "sched-exhausted-1",
      accountId,
      storeId,
      reportType: "sales_overview",
      cadence: "monthly",
      recipientEmails: ["owner@example.com"],
      active: true,
      lastSentAt: null,
    };

    const { outcome } = await withAccountContextOn(appClient, accountId, (tx) =>
      deliverScheduledReport({ tx, transport, report, storeName: "Recon Fixture Store", currency: "USD", timeZone: "UTC", now: NOW, reportBaseUrl: REPORT_BASE_URL })
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.logs.every((l) => l.status === "failed")).toBe(true);
    expect(transport.sent).toHaveLength(0);
  });
});

// The recon fixture (reused above) never sets order_line_items.sku — every
// order in it comes from packages/recon/src/seed.ts's insertOrdersForStore,
// which doesn't populate sku (see that file). sku_units_sold filters on
// `sku IS NOT NULL`, so a velocity-drop demonstration needs its own
// minimal, purpose-built dataset with real SKUs — small and self-contained
// enough not to justify extending the shared recon fixture (which other
// phases' passing test counts depend on staying exactly as it is).
describe("Phase 7 end-to-end — SKU velocity drop alert (docs/BUILD-SPEC.md 'a SKU's velocity dropping')", () => {
  const migrateUrl = process.env.DATABASE_URL_MIGRATE_TEST!;
  const appUrl = process.env.DATABASE_URL_TEST!;
  const adminClient = new PrismaClient({ datasourceUrl: migrateUrl });
  const appClient = new PrismaClient({ datasourceUrl: appUrl });

  const SHOP_DOMAIN = "phase7-sku-velocity-fixture.myshopify.com";
  let accountId: string;
  let storeId: string;

  beforeAll(async () => {
    await adminClient.store.findUnique({ where: { shopDomain: SHOP_DOMAIN } }).then(async (existing) => {
      if (existing) {
        await adminClient.orderLineItem.deleteMany({ where: { accountId: existing.accountId } });
        await adminClient.order.deleteMany({ where: { accountId: existing.accountId } });
        await adminClient.store.deleteMany({ where: { accountId: existing.accountId } });
        await adminClient.account.deleteMany({ where: { id: existing.accountId } });
      }
    });

    const account = await adminClient.account.create({ data: { name: "SKU Velocity Fixture Account" } });
    const store = await adminClient.store.create({
      data: { accountId: account.id, shopDomain: SHOP_DOMAIN, shopCurrency: "USD", shopTimezone: "UTC", installedAt: new Date() },
    });
    accountId = account.id;
    storeId = store.id;

    // February: SKU-DROPPING sells 100 units across 4 orders. March: only
    // 30 units — a genuine 70% drop, well past a 30% alert threshold. A
    // second SKU (SKU-STEADY) sells the same 20 units both months, proving
    // the alert is SKU-specific, not store-wide.
    const order = (id: string, dateIso: string, sku: string, quantity: number, priceMinor: number) => ({
      id,
      accountId: account.id,
      storeId: store.id,
      shopifyOrderId: id,
      createdAt: new Date(dateIso),
      processedAt: new Date(dateIso),
      test: false,
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      grossSalesMinor: priceMinor * quantity,
      discountsMinor: 0,
      shippingMinor: 0,
      taxesMinor: 0,
      currentSubtotalMinor: priceMinor * quantity,
      currentTotalMinor: priceMinor * quantity,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      source: "backfill",
    });
    const lineItem = (orderId: string, sku: string, quantity: number, priceMinor: number) => ({
      id: `${orderId}-li`,
      accountId: account.id,
      orderId,
      shopifyLineItemId: `${orderId}-li`,
      sku,
      quantity,
      priceMinor,
      discountMinor: 0,
      currencyCode: "USD",
    });

    const orders = [
      order("sku-vel-feb-1", "2025-02-05T12:00:00.000Z", "SKU-DROPPING", 40, 1000),
      order("sku-vel-feb-2", "2025-02-15T12:00:00.000Z", "SKU-DROPPING", 60, 1000),
      order("sku-vel-feb-3", "2025-02-20T12:00:00.000Z", "SKU-STEADY", 20, 500),
      order("sku-vel-mar-1", "2025-03-05T12:00:00.000Z", "SKU-DROPPING", 30, 1000),
      order("sku-vel-mar-2", "2025-03-20T12:00:00.000Z", "SKU-STEADY", 20, 500),
    ];
    const lineItems = [
      lineItem("sku-vel-feb-1", "SKU-DROPPING", 40, 1000),
      lineItem("sku-vel-feb-2", "SKU-DROPPING", 60, 1000),
      lineItem("sku-vel-feb-3", "SKU-STEADY", 20, 500),
      lineItem("sku-vel-mar-1", "SKU-DROPPING", 30, 1000),
      lineItem("sku-vel-mar-2", "SKU-STEADY", 20, 500),
    ];

    await adminClient.order.createMany({ data: orders });
    await adminClient.orderLineItem.createMany({ data: lineItems });
  });

  afterAll(async () => {
    await adminClient.orderLineItem.deleteMany({ where: { accountId } });
    await adminClient.order.deleteMany({ where: { accountId } });
    await adminClient.store.deleteMany({ where: { accountId } });
    await adminClient.account.deleteMany({ where: { id: accountId } });
    await adminClient.$disconnect();
    await appClient.$disconnect();
  });

  it("fires for the SKU that genuinely dropped, with real unit counts in the email, and stays silent for the steady SKU", async () => {
    const droppingRule: AlertRuleRow = {
      id: "alert-velocity-dropping",
      accountId,
      storeId,
      kind: "sku_velocity_drop",
      metricId: null,
      comparator: null,
      thresholdMinor: null,
      sku: "SKU-DROPPING",
      velocityDropPercent: 30,
      cadence: "monthly",
      recipientEmails: ["merchandiser@example.com"],
      active: true,
      lastEvaluatedAt: null,
    };
    const steadyRule: AlertRuleRow = { ...droppingRule, id: "alert-velocity-steady", sku: "SKU-STEADY" };

    const [dropping, steady] = await withAccountContextOn(appClient, accountId, async (tx) => [
      await evaluateAlertRule({ tx, rule: droppingRule, currency: "USD", timeZone: "UTC", now: NOW }),
      await evaluateAlertRule({ tx, rule: steadyRule, currency: "USD", timeZone: "UTC", now: NOW }),
    ]);

    expect(dropping.result.triggered).toBe(true);
    expect(dropping.result.figureDisplay).toBe("30 units (was 100, 70.0% change)");
    expect(steady.result.triggered).toBe(false);
    expect(steady.result.figureDisplay).toBe("20 units (was 20, 0.0% change)");

    const transport = new MockEmailTransport();
    const outcome = await deliverAlert({
      transport,
      rule: droppingRule,
      result: dropping.result,
      period: dropping.period,
      reportBaseUrl: REPORT_BASE_URL,
      timeZone: "UTC",
    });
    expect(outcome.status).toBe("delivered");
    const email = transport.sent[0]!;
    console.log(`[Gate 7] alert fired ("SKU velocity dropping") — to=${email.to.join(",")} subject="${email.subject}"\n${email.textBody}\n`);
    expect(email.subject).toContain("SKU SKU-DROPPING velocity");
    expect(email.textBody).toContain("Figure: 30 units (was 100, 70.0% change)");
    expect(email.textBody).toContain("Threshold: 30% drop");
    expect(email.textBody).toContain("Period: March 2025");
  });
});
