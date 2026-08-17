import { describe, expect, it } from "vitest";
import { evaluateAlertRule, type AlertRuleRow } from "../index.js";
import type { TenantClient } from "@plumbline/model";

// A fake tx lets these tests prove the comparator/percentage-drop logic in
// evaluateAlertRule in isolation, without a Postgres connection — the SQL
// itself (packages/metrics' registry) is proven separately by pnpm recon
// and the DB-backed end-to-end test in e2e.test.ts. Here we only care that
// "figure below/above threshold" and "percent drop >= configured drop" are
// computed correctly, including the exact-boundary cases.
function fakeTx(scalarValue: number): TenantClient {
  return {
    $queryRawUnsafe: async () => [{ value: String(scalarValue) }],
  } as unknown as TenantClient;
}

function fakeTableTx(bySku: { current: Record<string, number>; previous: Record<string, number> }): TenantClient {
  let call = 0;
  return {
    $queryRawUnsafe: async () => {
      call += 1;
      // runMetricTable is called twice by evaluateAlertRule for
      // sku_velocity_drop: current period first, then previous period.
      const source = call === 1 ? bySku.current : bySku.previous;
      return Object.entries(source).map(([sku, units_sold]) => ({ sku, units_sold }));
    },
  } as unknown as TenantClient;
}

const baseRule: Omit<AlertRuleRow, "kind" | "metricId" | "comparator" | "thresholdMinor" | "sku" | "velocityDropPercent"> = {
  id: "rule-1",
  accountId: "acct-1",
  storeId: "store-1",
  cadence: "monthly",
  recipientEmails: ["merchant@example.com"],
  active: true,
  lastEvaluatedAt: null,
};

const now = new Date("2025-04-10T00:00:00.000Z");

describe("evaluateAlertRule — metric_threshold ('margin below X', 'returns above Y')", () => {
  it("triggers when the figure is genuinely below a 'below' threshold", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "metric_threshold", metricId: "contribution_margin", comparator: "below", thresholdMinor: 100_000, sku: null, velocityDropPercent: null };
    const { result } = await evaluateAlertRule({ tx: fakeTx(50_000), rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(true);
    expect(result.figureDisplay).toBe("500.00 USD");
    expect(result.thresholdDisplay).toBe("1000.00 USD");
  });

  it("does NOT trigger when the figure equals the threshold exactly ('below' is strict, not <=)", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "metric_threshold", metricId: "contribution_margin", comparator: "below", thresholdMinor: 100_000, sku: null, velocityDropPercent: null };
    const { result } = await evaluateAlertRule({ tx: fakeTx(100_000), rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(false);
  });

  it("does NOT trigger when the figure is above a 'below' threshold", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "metric_threshold", metricId: "contribution_margin", comparator: "below", thresholdMinor: 100_000, sku: null, velocityDropPercent: null };
    const { result } = await evaluateAlertRule({ tx: fakeTx(150_000), rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(false);
  });

  it("'above' comparator triggers when the figure exceeds the threshold ('returns above Y')", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "metric_threshold", metricId: "sales_reversals", comparator: "above", thresholdMinor: 50_000, sku: null, velocityDropPercent: null };
    const { result } = await evaluateAlertRule({ tx: fakeTx(75_000), rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(true);
  });

  it("'above' comparator does NOT trigger at exact equality (strict >, not >=)", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "metric_threshold", metricId: "sales_reversals", comparator: "above", thresholdMinor: 50_000, sku: null, velocityDropPercent: null };
    const { result } = await evaluateAlertRule({ tx: fakeTx(50_000), rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(false);
  });
});

describe("evaluateAlertRule — sku_velocity_drop", () => {
  it("triggers when units sold dropped by at least the configured percentage", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "sku_velocity_drop", metricId: null, comparator: null, thresholdMinor: null, sku: "SKU-1", velocityDropPercent: 30 };
    const tx = fakeTableTx({ current: { "SKU-1": 60 }, previous: { "SKU-1": 100 } }); // 40% drop
    const { result } = await evaluateAlertRule({ tx, rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(true);
    expect(result.figureDisplay).toContain("60 units");
  });

  it("does NOT trigger when the drop is smaller than the threshold", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "sku_velocity_drop", metricId: null, comparator: null, thresholdMinor: null, sku: "SKU-1", velocityDropPercent: 30 };
    const tx = fakeTableTx({ current: { "SKU-1": 85 }, previous: { "SKU-1": 100 } }); // 15% drop
    const { result } = await evaluateAlertRule({ tx, rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(false);
  });

  it("triggers at exactly the threshold percentage (drop >= threshold, inclusive)", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "sku_velocity_drop", metricId: null, comparator: null, thresholdMinor: null, sku: "SKU-1", velocityDropPercent: 30 };
    const tx = fakeTableTx({ current: { "SKU-1": 70 }, previous: { "SKU-1": 100 } }); // exactly 30% drop
    const { result } = await evaluateAlertRule({ tx, rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(true);
  });

  it("does NOT trigger off a zero-sales baseline — no prior sales means no velocity to drop from, not a 100% drop alert", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "sku_velocity_drop", metricId: null, comparator: null, thresholdMinor: null, sku: "SKU-NEW", velocityDropPercent: 30 };
    const tx = fakeTableTx({ current: { "SKU-NEW": 5 }, previous: {} });
    const { result } = await evaluateAlertRule({ tx, rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(false);
  });

  it("a SKU that increased in velocity never triggers", async () => {
    const rule: AlertRuleRow = { ...baseRule, kind: "sku_velocity_drop", metricId: null, comparator: null, thresholdMinor: null, sku: "SKU-1", velocityDropPercent: 30 };
    const tx = fakeTableTx({ current: { "SKU-1": 150 }, previous: { "SKU-1": 100 } });
    const { result } = await evaluateAlertRule({ tx, rule, currency: "USD", timeZone: "UTC", now });
    expect(result.triggered).toBe(false);
  });
});
