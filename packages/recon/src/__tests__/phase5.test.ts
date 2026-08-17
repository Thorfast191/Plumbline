import { PrismaClient } from "@plumbline/model";
import { withAccountContextOn } from "@plumbline/model";
import { runMetric, runMetricTable } from "@plumbline/metrics";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { cleanupPhase5Fixture, seedPhase5Fixture } from "../phase5-seed.js";
import { PHASE5_MAIN_PERIOD, PHASE5_WIDE_PERIOD } from "../phase5-fixtures.js";

// Phase 5 metrics have no live Shopify store and no platform figure to
// reconcile against (contribution margin, cohort retention, LTV, etc. are
// not reported by Shopify at all — see each metric's nonReconciliationReason
// in packages/metrics). Correctness here means the SQL matches numbers
// worked out by hand against packages/recon/src/phase5-fixtures.ts's small,
// auditable dataset — see the comments on each expectation below for the
// arithmetic.

const migrateUrl = process.env.DATABASE_URL_MIGRATE_TEST;
const appUrl = process.env.DATABASE_URL_TEST;
if (!migrateUrl || !appUrl) {
  throw new Error("DATABASE_URL_MIGRATE_TEST and DATABASE_URL_TEST must be set (see .env / .env.example) to run Phase 5 metric tests.");
}

const adminClient = new PrismaClient({ datasourceUrl: migrateUrl });
const appClient = new PrismaClient({ datasourceUrl: appUrl });

let accountId: string;
let storeId: string;

beforeAll(async () => {
  await cleanupPhase5Fixture(adminClient);
  const seeded = await seedPhase5Fixture(adminClient);
  accountId = seeded.accountId;
  storeId = seeded.storeId;
});

afterAll(async () => {
  await cleanupPhase5Fixture(adminClient);
  await adminClient.$disconnect();
  await appClient.$disconnect();
});

describe("contribution_margin", () => {
  it("sums to 41760 minor units over the main period", async () => {
    // O1 5143 + O2 5143 + O3 4205 + O4 4205 + O5 4205 + O6 5143 + O7 5143 + O8 5143 + O9 3430 = 41760
    const value = await withAccountContextOn(appClient, accountId, (tx) => runMetric("contribution_margin", tx, storeId, PHASE5_MAIN_PERIOD));
    expect(value).toBe(41760);
  });
});

describe("contribution_margin_by_channel", () => {
  it("matches hand-computed margin/ad-spend/net per channel", async () => {
    const rows = await withAccountContextOn(appClient, accountId, (tx) => runMetricTable("contribution_margin_by_channel", tx, storeId, PHASE5_MAIN_PERIOD));
    const byChannel = new Map(rows.map((r) => [r.channel as string, r]));

    // meta: O1+O2+O3+O7+O8 = 5143+5143+4205+5143+5143 = 24777; ad spend 20000+20000=40000; net -15223
    expect(Number(byChannel.get("meta")?.contribution_margin_minor)).toBe(24777);
    expect(Number(byChannel.get("meta")?.ad_spend_minor)).toBe(40000);
    expect(Number(byChannel.get("meta")?.net_after_ad_spend_minor)).toBe(-15223);

    // google: O4+O5+O9 = 4205+4205+3430 = 11840; ad spend 15000+15000=30000; net -18160
    expect(Number(byChannel.get("google")?.contribution_margin_minor)).toBe(11840);
    expect(Number(byChannel.get("google")?.ad_spend_minor)).toBe(30000);
    expect(Number(byChannel.get("google")?.net_after_ad_spend_minor)).toBe(-18160);

    // direct: O6 = 5143; no ad spend rows for 'direct' in the fixture; net 5143
    expect(Number(byChannel.get("direct")?.contribution_margin_minor)).toBe(5143);
    expect(Number(byChannel.get("direct")?.ad_spend_minor)).toBe(0);
    expect(Number(byChannel.get("direct")?.net_after_ad_spend_minor)).toBe(5143);
  });
});

describe("cohort_retention_by_month", () => {
  it("matches hand-computed retention grid for the Jan and Feb 2025 cohorts", async () => {
    const rows = await withAccountContextOn(appClient, accountId, (tx) => runMetricTable("cohort_retention_by_month", tx, storeId, PHASE5_MAIN_PERIOD));
    const key = (r: Record<string, unknown>) => `${new Date(r.cohort_month as string).toISOString().slice(0, 7)}:${r.months_since_first_order}`;
    const byKey = new Map(rows.map((r) => [key(r), r]));

    // Jan cohort (C1, C2, C3 — cohort_size 3): month0=3/3, month1=1/3 (C1 only), month2=1/3 (C2 only), month3=1/3 (C1 only)
    expect(Number(byKey.get("2025-01:0")?.cohort_size)).toBe(3);
    expect(Number(byKey.get("2025-01:0")?.active_customer_count)).toBe(3);
    expect(Number(byKey.get("2025-01:1")?.active_customer_count)).toBe(1);
    expect(Number(byKey.get("2025-01:2")?.active_customer_count)).toBe(1);
    expect(Number(byKey.get("2025-01:3")?.active_customer_count)).toBe(1);

    // Feb cohort (C4, C5 — cohort_size 2): month0=2/2, month1=1/2 (C4 only)
    expect(Number(byKey.get("2025-02:0")?.cohort_size)).toBe(2);
    expect(Number(byKey.get("2025-02:0")?.active_customer_count)).toBe(2);
    expect(Number(byKey.get("2025-02:1")?.active_customer_count)).toBe(1);
  });
});

describe("ltv_by_channel_90d", () => {
  it("matches hand-computed 90-day cumulative revenue per channel", async () => {
    const rows = await withAccountContextOn(appClient, accountId, (tx) => runMetricTable("ltv_by_channel_90d", tx, storeId, PHASE5_MAIN_PERIOD));
    const byChannel = new Map(rows.map((r) => [r.channel as string, r]));

    // meta: C1 (Jan10 window, O1+O2+O3=28000) + C4 (Feb5 window, O7+O8=20000) = 48000 / 2 customers = 24000
    expect(Number(byChannel.get("meta")?.customer_count)).toBe(2);
    expect(Number(byChannel.get("meta")?.cumulative_revenue_minor)).toBe(48000);
    expect(Number(byChannel.get("meta")?.ltv_minor)).toBe(24000);

    // google: C2 (Jan20 window, O4+O5=16000) + C5 (Feb10 window, O9=7200) = 23200 / 2 = 11600
    expect(Number(byChannel.get("google")?.customer_count)).toBe(2);
    expect(Number(byChannel.get("google")?.cumulative_revenue_minor)).toBe(23200);
    expect(Number(byChannel.get("google")?.ltv_minor)).toBe(11600);

    // direct: C3 (Jan25 window, O6=10000) / 1 = 10000
    expect(Number(byChannel.get("direct")?.customer_count)).toBe(1);
    expect(Number(byChannel.get("direct")?.cumulative_revenue_minor)).toBe(10000);
    expect(Number(byChannel.get("direct")?.ltv_minor)).toBe(10000);
  });
});

describe("repeat_purchase_interval", () => {
  it("averages 39.5 days across the 4 consecutive-order gaps", async () => {
    // C1: Jan10->Feb15 = 36d, Feb15->Apr1 = 45d. C2: Jan20->Mar5 = 44d. C4: Feb5->Mar10 = 33d.
    // pooled avg = (36+45+44+33)/4 = 39.5
    const value = await withAccountContextOn(appClient, accountId, (tx) => runMetric("repeat_purchase_interval", tx, storeId, PHASE5_MAIN_PERIOD));
    expect(value).toBeCloseTo(39.5, 4);
  });
});

describe("discount_profitability", () => {
  it("splits discounted vs full-price orders with matching margin figures", async () => {
    const rows = await withAccountContextOn(appClient, accountId, (tx) => runMetricTable("discount_profitability", tx, storeId, PHASE5_MAIN_PERIOD));
    const byType = new Map(rows.map((r) => [r.order_type as string, r]));

    // discounted: O9 only — revenue 7200, margin 3430
    expect(Number(byType.get("discounted")?.order_count)).toBe(1);
    expect(Number(byType.get("discounted")?.revenue_minor)).toBe(7200);
    expect(Number(byType.get("discounted")?.margin_minor)).toBe(3430);

    // full_price: everything else — 8 orders, revenue 74000, margin 38330
    expect(Number(byType.get("full_price")?.order_count)).toBe(8);
    expect(Number(byType.get("full_price")?.revenue_minor)).toBe(74000);
    expect(Number(byType.get("full_price")?.margin_minor)).toBe(38330);
  });
});

describe("returns_by_variant_cohort", () => {
  it("attributes C6's single-unit return to SKU-A / June 2025 cohort", async () => {
    const rows = await withAccountContextOn(appClient, accountId, (tx) => runMetricTable("returns_by_variant_cohort", tx, storeId, PHASE5_WIDE_PERIOD));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku).toBe("SKU-A");
    expect(new Date(rows[0]?.cohort_month as string).toISOString().slice(0, 7)).toBe("2025-06");
    expect(Number(rows[0]?.return_count)).toBe(1);
    expect(Number(rows[0]?.returned_units)).toBe(1);
    expect(Number(rows[0]?.returned_value_minor)).toBe(10000);
  });
});
