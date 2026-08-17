// Phase 4 — see docs/PLAN.md §11, CLAUDE.md "Non-negotiable rules": every
// metric has a written definition (this file) and a recon test
// (packages/recon). `sql` below is not documentation of a separate
// implementation — it is the literal query `runMetric` executes (see
// bottom of this file), so the registry and the executed code cannot drift.

export type RefundHandling = "on-refund-processed-date" | "excluded" | "not-applicable";
export type CurrencyHandling = "shop-currency-only" | "converted-at-read-time" | "not-applicable";

export type ResultShape = "scalar" | "table";

export interface MetricDefinition {
  id: string;
  name: string;
  plainLanguageDefinition: string;
  inclusions: string[];
  exclusions: string[];
  timestampUsed: string; // must state which field/timezone basis, per CLAUDE.md
  refundHandling: RefundHandling;
  currencyHandling: CurrencyHandling;
  sql: string;
  dependsOn: string[];
  version: number;
  owner: string;
  /** null only when the platform has no comparable figure — must be documented, per CLAUDE.md. */
  reconciliationTargetDescription: string | null;
  /**
   * Required, non-empty whenever reconciliationTargetDescription is null.
   * Phase 5's differentiated metrics (contribution margin, cohort
   * retention, LTV, etc.) have no platform-reported equivalent — per
   * CLAUDE.md: "Where it does not [have a comparable figure], the
   * definition must state that explicitly so the merchant knows why it
   * differs." metrics-lint enforces this pairing.
   */
  nonReconciliationReason: string | null;
  /**
   * Inputs this metric depends on that are merchant-supplied or estimated
   * rather than platform-synced fact (e.g. uploaded COGS, an estimated
   * flat shipping cost, a channel-attribution heuristic). Empty array
   * means the metric is built entirely from synced platform data. Per
   * BUILD-SPEC.md Phase 5: "Where a metric depends on estimated or
   * user-supplied inputs, the UI must say so."
   */
  estimatedInputs: string[];
  /**
   * "scalar" metrics return one number via runMetric. "table" metrics
   * return multiple rows (e.g. one row per channel or per cohort month)
   * via runMetricTable — forcing a metric like cohort retention into a
   * single number would misrepresent what it actually is.
   */
  resultShape: ResultShape;
}

export interface MetricRegistry {
  register(def: MetricDefinition): void;
  get(id: string): MetricDefinition | undefined;
  all(): MetricDefinition[];
}

export class InMemoryMetricRegistry implements MetricRegistry {
  private readonly defs = new Map<string, MetricDefinition>();

  register(def: MetricDefinition): void {
    if (this.defs.has(def.id)) {
      throw new Error(`metric "${def.id}" already registered — versions bump in place, ids don't get reused`);
    }
    this.defs.set(def.id, def);
  }

  get(id: string): MetricDefinition | undefined {
    return this.defs.get(id);
  }

  all(): MetricDefinition[] {
    return [...this.defs.values()];
  }
}

export interface Period {
  from: Date;
  to: Date; // exclusive
}

// Every metric here is scoped by store_id and time-bounded by [$2, $3). Test
// orders (test = true) and, where Shopify's own definition implies no
// revenue was realized, cancelled/voided orders (cancelled_at IS NOT NULL)
// are excluded — see docs/BUILD-SPEC.md Section 0 assumption note and
// docs/PLAN.md §8. Refund-derived figures book on the refund's
// processed_at, never the order's created_at, per Shopify's own documented
// behavior (docs/PLAN.md §7): "returns are booked on refund-processed
// date, not order date."

// Every `created_at`/`processed_at` comparison below is wrapped in
// `AT TIME ZONE 'UTC'`. The underlying columns are `TIMESTAMP(3)` (no
// timezone, see packages/model/prisma/schema.prisma) — passed a JS Date
// parameter, Postgres/node-postgres would otherwise reinterpret the naive
// column value using the connection's session TimeZone setting, silently
// shifting every boundary comparison whenever that session default isn't
// UTC. Phase 5's SQL already does this (packages/recon's Phase-5 boundary
// test caught the bug there); this Phase 6 pass retrofits the original
// Phase 4 metrics for consistency, per CLAUDE.md's per-layer timezone rule.
// Confirmed dormant until now only because the Phase 4 synthetic fixture
// places every order at noon UTC, far from any day boundary — `pnpm recon`
// still passes 32/32 zero-delta after this change (see Phase 6 report).
const GROSS_SALES_SQL = `
SELECT COALESCE(SUM(gross_sales_minor), 0)::text AS value
FROM orders
WHERE store_id = $1
  AND test = false
  AND cancelled_at IS NULL
  AND (created_at AT TIME ZONE 'UTC') >= $2
  AND (created_at AT TIME ZONE 'UTC') < $3
`.trim();

const DISCOUNTS_SQL = `
SELECT COALESCE(SUM(discounts_minor), 0)::text AS value
FROM orders
WHERE store_id = $1
  AND test = false
  AND cancelled_at IS NULL
  AND (created_at AT TIME ZONE 'UTC') >= $2
  AND (created_at AT TIME ZONE 'UTC') < $3
`.trim();

const ORDER_COUNT_SQL = `
SELECT COUNT(*)::text AS value
FROM orders
WHERE store_id = $1
  AND test = false
  AND cancelled_at IS NULL
  AND (created_at AT TIME ZONE 'UTC') >= $2
  AND (created_at AT TIME ZONE 'UTC') < $3
`.trim();

// No cancelled_at filter here, deliberately: a refund is booked on its own
// processed_at regardless of what later happened to the order it belongs
// to, and Shopify's sales-reversals figure is not defined in terms of the
// order's current status. Test orders are still excluded.
const SALES_REVERSALS_SQL = `
SELECT COALESCE(SUM(r.amount_minor), 0)::text AS value
FROM refunds r
JOIN orders o ON o.id = r.order_id
WHERE r.store_id = $1
  AND o.test = false
  AND (r.processed_at AT TIME ZONE 'UTC') >= $2
  AND (r.processed_at AT TIME ZONE 'UTC') < $3
`.trim();

const NET_SALES_SQL = `
WITH gross AS (${GROSS_SALES_SQL.replace("value", "amt")}),
     disc AS (${DISCOUNTS_SQL.replace("value", "amt")}),
     rev AS (${SALES_REVERSALS_SQL.replace("value", "amt")})
SELECT (gross.amt::bigint - disc.amt::bigint - rev.amt::bigint)::text AS value
FROM gross, disc, rev
`.trim();

const SHIPPING_SQL = `
WITH sale_side AS (
  SELECT COALESCE(SUM(shipping_minor), 0) AS amt
  FROM orders
  WHERE store_id = $1 AND test = false AND cancelled_at IS NULL
    AND (created_at AT TIME ZONE 'UTC') >= $2 AND (created_at AT TIME ZONE 'UTC') < $3
),
refund_side AS (
  SELECT COALESCE(SUM(r.shipping_refund_minor), 0) AS amt
  FROM refunds r JOIN orders o ON o.id = r.order_id
  WHERE r.store_id = $1 AND o.test = false
    AND (r.processed_at AT TIME ZONE 'UTC') >= $2 AND (r.processed_at AT TIME ZONE 'UTC') < $3
)
SELECT (sale_side.amt::bigint - refund_side.amt::bigint)::text AS value
FROM sale_side, refund_side
`.trim();

const TAXES_SQL = `
WITH sale_side AS (
  SELECT COALESCE(SUM(taxes_minor), 0) AS amt
  FROM orders
  WHERE store_id = $1 AND test = false AND cancelled_at IS NULL
    AND (created_at AT TIME ZONE 'UTC') >= $2 AND (created_at AT TIME ZONE 'UTC') < $3
),
refund_side AS (
  SELECT COALESCE(SUM(r.tax_refund_minor), 0) AS amt
  FROM refunds r JOIN orders o ON o.id = r.order_id
  WHERE r.store_id = $1 AND o.test = false
    AND (r.processed_at AT TIME ZONE 'UTC') >= $2 AND (r.processed_at AT TIME ZONE 'UTC') < $3
)
SELECT (sale_side.amt::bigint - refund_side.amt::bigint)::text AS value
FROM sale_side, refund_side
`.trim();

// Fees are gated by the same test/cancelled exclusion as gross sales
// (nested under the same order in the reference reducer, docs/PLAN.md §7),
// but time-bounded by the transaction's own processed_at, not the order's
// created_at.
const FEES_SQL = `
SELECT COALESCE(SUM(t.fee_minor), 0)::text AS amt
FROM transactions t
JOIN orders o ON o.id = t.order_id
WHERE t.store_id = $1
  AND o.test = false
  AND o.cancelled_at IS NULL
  AND t.kind = 'sale'
  AND t.fee_minor IS NOT NULL
  AND (t.processed_at AT TIME ZONE 'UTC') >= $2
  AND (t.processed_at AT TIME ZONE 'UTC') < $3
`.trim();

const TOTAL_SALES_SQL = `
WITH gross AS (${GROSS_SALES_SQL.replace("value", "amt")}),
     disc AS (${DISCOUNTS_SQL.replace("value", "amt")}),
     rev AS (${SALES_REVERSALS_SQL.replace("value", "amt")}),
     shipping AS (
       WITH sale_side AS (
         SELECT COALESCE(SUM(shipping_minor), 0) AS amt
         FROM orders
         WHERE store_id = $1 AND test = false AND cancelled_at IS NULL
           AND (created_at AT TIME ZONE 'UTC') >= $2 AND (created_at AT TIME ZONE 'UTC') < $3
       ),
       refund_side AS (
         SELECT COALESCE(SUM(r.shipping_refund_minor), 0) AS amt
         FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE r.store_id = $1 AND o.test = false
           AND (r.processed_at AT TIME ZONE 'UTC') >= $2 AND (r.processed_at AT TIME ZONE 'UTC') < $3
       )
       SELECT (sale_side.amt - refund_side.amt) AS amt FROM sale_side, refund_side
     ),
     taxes AS (
       WITH sale_side AS (
         SELECT COALESCE(SUM(taxes_minor), 0) AS amt
         FROM orders
         WHERE store_id = $1 AND test = false AND cancelled_at IS NULL
           AND (created_at AT TIME ZONE 'UTC') >= $2 AND (created_at AT TIME ZONE 'UTC') < $3
       ),
       refund_side AS (
         SELECT COALESCE(SUM(r.tax_refund_minor), 0) AS amt
         FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE r.store_id = $1 AND o.test = false
           AND (r.processed_at AT TIME ZONE 'UTC') >= $2 AND (r.processed_at AT TIME ZONE 'UTC') < $3
       )
       SELECT (sale_side.amt - refund_side.amt) AS amt FROM sale_side, refund_side
     ),
     fees AS (${FEES_SQL})
SELECT (gross.amt::bigint - disc.amt::bigint - rev.amt::bigint + taxes.amt::bigint + shipping.amt::bigint + fees.amt::bigint)::text AS value
FROM gross, disc, rev, taxes, shipping, fees
`.trim();

const OWNER = "Plumbline core (unassigned — no named metric owner confirmed by the user yet; flag at final review)";

const RECON_TARGET_PREFIX = "Shopify Admin -> Analytics -> Reports -> Sales report, same store/period, figure: ";

export const registry: MetricRegistry = new InMemoryMetricRegistry();

registry.register({
  id: "gross_sales",
  name: "Gross sales",
  plainLanguageDefinition:
    "Equates to product selling price times ordered quantity. Gross sales does not include discounts, sales reversals, taxes, shipping, or fees. (Shopify's own definition, docs/PLAN.md §7.)",
  inclusions: ["Line item price x quantity for every non-test, non-cancelled order created in the period"],
  exclusions: ["Test orders", "Cancelled/voided orders", "Discounts", "Taxes", "Shipping", "Fees"],
  timestampUsed: "orders.created_at (order placement date), compared in UTC. Store-timezone-aware boundary aggregation is a Phase 6 concern — see docs/PLAN.md §8 (unverified: Shopify's own report timezone basis).",
  refundHandling: "not-applicable",
  currencyHandling: "shop-currency-only",
  sql: GROSS_SALES_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Gross sales",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

registry.register({
  id: "discounts",
  name: "Discounts",
  plainLanguageDefinition:
    "Equates to product discount plus the product's proportional share of a cart-wide discount. Shown as a reduction against gross sales. (Shopify's own definition, docs/PLAN.md §7.)",
  inclusions: ["Code discounts", "Automatic discounts", "Script discounts, for every non-test, non-cancelled order created in the period"],
  exclusions: ["Test orders", "Cancelled/voided orders"],
  timestampUsed: "orders.created_at (order placement date), compared in UTC.",
  refundHandling: "not-applicable",
  currencyHandling: "shop-currency-only",
  sql: DISCOUNTS_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Discounts",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

registry.register({
  id: "sales_reversals",
  name: "Sales reversals (returns)",
  plainLanguageDefinition:
    "The value of goods returned by a customer. (Shopify's own definition, docs/PLAN.md §7.) Booked on the date the return was processed, not the order date — shipping and tax refunds are tracked separately and are not part of this figure.",
  inclusions: ["Refunded goods amount (excludes shipping/tax refund portions) for refunds processed in the period, on non-test orders"],
  exclusions: ["Test orders", "Shipping refund amount", "Tax refund amount"],
  timestampUsed: "refunds.processed_at (return processed date, not order date), compared in UTC.",
  refundHandling: "on-refund-processed-date",
  currencyHandling: "shop-currency-only",
  sql: SALES_REVERSALS_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Sales reversals (returns)",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

registry.register({
  id: "net_sales",
  name: "Net sales",
  plainLanguageDefinition:
    "Equates to gross sales minus discounts minus sales reversals. Net sales does not include shipping charges or taxes. (Shopify's own definition, docs/PLAN.md §7.)",
  inclusions: ["gross_sales - discounts - sales_reversals, each computed over the same period window per its own timestamp basis"],
  exclusions: ["Shipping", "Taxes", "Fees"],
  timestampUsed: "Composed from gross_sales (orders.created_at) and sales_reversals (refunds.processed_at) — see those definitions. Both bounded to the same UTC period window.",
  refundHandling: "on-refund-processed-date",
  currencyHandling: "shop-currency-only",
  sql: NET_SALES_SQL,
  dependsOn: ["gross_sales", "discounts", "sales_reversals"],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Net sales",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

registry.register({
  id: "shipping",
  name: "Shipping",
  plainLanguageDefinition:
    "Shipping charges collected on orders, net of shipping refunded on returns. Positive on the sale date, negative on the refund date. (Shopify's own definition, docs/PLAN.md §7.)",
  inclusions: ["Shipping charged on non-test, non-cancelled orders created in the period", "minus shipping refunded on refunds processed in the period"],
  exclusions: ["Test orders", "Cancelled/voided orders (sale side only)"],
  timestampUsed: "orders.created_at for charges, refunds.processed_at for shipping refunds. Both compared in UTC.",
  refundHandling: "on-refund-processed-date",
  currencyHandling: "shop-currency-only",
  sql: SHIPPING_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Shipping",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

registry.register({
  id: "taxes",
  name: "Taxes",
  plainLanguageDefinition:
    "Tax applied to items and shipping, net of tax refunded on returns. Positive on the sale date, negative on the refund date. (Shopify's own definition, docs/PLAN.md §7.)",
  inclusions: ["Taxes charged on non-test, non-cancelled orders created in the period", "minus tax refunded on refunds processed in the period"],
  exclusions: ["Test orders", "Cancelled/voided orders (sale side only)"],
  timestampUsed: "orders.created_at for charges, refunds.processed_at for tax refunds. Both compared in UTC.",
  refundHandling: "on-refund-processed-date",
  currencyHandling: "shop-currency-only",
  sql: TAXES_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Taxes",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

registry.register({
  id: "total_sales",
  name: "Total sales",
  plainLanguageDefinition:
    "Equates to gross sales minus discounts minus sales reversals plus taxes plus shipping charges plus fees. (Shopify's own definition, docs/PLAN.md §7 — verbatim quote.)",
  inclusions: ["gross_sales - discounts - sales_reversals + taxes + shipping + payment-processing fees on sale transactions"],
  exclusions: ["Test orders", "Cancelled/voided orders"],
  timestampUsed: "Composed — see gross_sales, discounts, sales_reversals, taxes, shipping. Fees are bounded by transactions.processed_at. All compared in UTC.",
  refundHandling: "on-refund-processed-date",
  currencyHandling: "shop-currency-only",
  sql: TOTAL_SALES_SQL,
  dependsOn: ["gross_sales", "discounts", "sales_reversals", "taxes", "shipping"],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Total sales",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

registry.register({
  id: "order_count",
  name: "Order count",
  plainLanguageDefinition: "The number of non-test, non-cancelled orders placed in the period.",
  inclusions: ["Every non-test, non-cancelled order created in the period"],
  exclusions: ["Test orders", "Cancelled/voided orders"],
  timestampUsed: "orders.created_at (order placement date), compared in UTC.",
  refundHandling: "not-applicable",
  currencyHandling: "not-applicable",
  sql: ORDER_COUNT_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: RECON_TARGET_PREFIX + "Order count (Orders report)",
  nonReconciliationReason: null,
  estimatedInputs: [],
  resultShape: "scalar",
});

/**
 * Executes exactly the SQL stored on the metric's own definition — the
 * registry is the single source of truth, there is no parallel "real" query
 * living somewhere else that could drift from what's displayed to the
 * merchant. `tx` must already be RLS-scoped (see packages/model's
 * withAccountContextOn) since these queries filter by store_id but rely on
 * the database's own account_id policy for tenant isolation.
 */
export async function runMetric(
  id: string,
  tx: { $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T> },
  storeId: string,
  period: Period
): Promise<number> {
  const def = registry.get(id);
  if (!def) {
    throw new Error(`unknown metric: ${id}`);
  }
  const rows = await tx.$queryRawUnsafe<Array<{ value: string }>>(def.sql, storeId, period.from, period.to);
  return Number(rows[0]?.value ?? "0");
}

/**
 * Same contract as runMetric but for `resultShape: "table"` metrics — the
 * SQL returns multiple rows/columns (e.g. one row per cohort month or
 * channel) instead of a single scalar `value` column.
 */
export async function runMetricTable(
  id: string,
  tx: { $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T> },
  storeId: string,
  period: Period
): Promise<Array<Record<string, unknown>>> {
  const def = registry.get(id);
  if (!def) {
    throw new Error(`unknown metric: ${id}`);
  }
  return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(def.sql, storeId, period.from, period.to);
}

// ---------------------------------------------------------------------------
// Phase 5 — "the metrics that justify the product" (docs/BUILD-SPEC.md
// Phase 5). None of these have a comparable Shopify admin figure (no
// platform report shows contribution margin, cohort retention, LTV, repeat
// purchase interval, discount profitability, or returns by variant/cohort),
// so each sets reconciliationTargetDescription: null and documents why via
// nonReconciliationReason, per the standing rule in CLAUDE.md. Several also
// depend on merchant-uploaded COGS/shipping-cost/ad-spend data (see
// packages/enrich) rather than platform-synced fact — those set
// estimatedInputs so the UI can flag it, per BUILD-SPEC Phase 5: "Where a
// metric depends on estimated or user-supplied inputs, the UI must say so."
//
// Three CTEs (line-item COGS, estimated shipping cost, payment fees) are
// shared across every per-order-margin metric below. Each looks up the
// MOST RECENT enrich row with effective_from <= the order's created_at —
// same versioning pattern as Shopify's own historical-price handling, so a
// COGS change doesn't retroactively alter a margin already reported.

const LINE_COGS_CTE = `
line_cogs AS (
  SELECT oli.order_id,
         SUM(oli.quantity * COALESCE((
           SELECT ec.cost_minor FROM enrich_cogs ec
           WHERE ec.store_id = $1 AND ec.sku = oli.sku AND ec.effective_from <= o2.created_at
           ORDER BY ec.effective_from DESC LIMIT 1
         ), 0)) AS cogs_minor
  FROM order_line_items oli
  JOIN orders o2 ON o2.id = oli.order_id
  WHERE oli.order_id IN (SELECT id FROM order_scope)
  GROUP BY oli.order_id
)`.trim();

const SHIP_COST_CTE = `
ship_cost AS (
  SELECT os.id AS order_id, COALESCE((
    SELECT esc.cost_minor FROM enrich_shipping_cost esc
    WHERE esc.store_id = $1 AND esc.effective_from <= os.created_at
    ORDER BY esc.effective_from DESC LIMIT 1
  ), 0) AS cost_minor
  FROM order_scope os
)`.trim();

const FEES_CTE = `
fees AS (
  SELECT t.order_id, COALESCE(SUM(t.fee_minor), 0) AS fee_minor
  FROM transactions t
  WHERE t.order_id IN (SELECT id FROM order_scope) AND t.kind = 'sale' AND t.fee_minor IS NOT NULL
  GROUP BY t.order_id
)`.trim();

const MARGIN_INPUTS_NOTE =
  "Margin = current_subtotal_minor (revenue after discount, before tax/shipping) minus matched COGS minus an estimated flat shipping cost minus the sale transaction's payment fee. " +
  "Known limitation, stated plainly: refunded/returned amounts are NOT netted out of this figure in this version — a fully or partially refunded order still shows its original margin. " +
  "See returns_by_variant_cohort for return volume/value separately.";

const CONTRIBUTION_MARGIN_SQL = `
WITH order_scope AS (
  SELECT o.id, o.current_subtotal_minor, o.created_at
  FROM orders o
  WHERE o.store_id = $1 AND o.test = false AND o.cancelled_at IS NULL
    AND (o.created_at AT TIME ZONE 'UTC') >= $2 AND (o.created_at AT TIME ZONE 'UTC') < $3
),
${LINE_COGS_CTE},
${SHIP_COST_CTE},
${FEES_CTE}
SELECT COALESCE(SUM(
  os.current_subtotal_minor - COALESCE(lc.cogs_minor, 0) - COALESCE(sc.cost_minor, 0) - COALESCE(f.fee_minor, 0)
), 0)::text AS value
FROM order_scope os
LEFT JOIN line_cogs lc ON lc.order_id = os.id
LEFT JOIN ship_cost sc ON sc.order_id = os.id
LEFT JOIN fees f ON f.order_id = os.id
`.trim();

registry.register({
  id: "contribution_margin",
  name: "Contribution margin",
  plainLanguageDefinition:
    "Revenue minus cost of goods sold, minus an estimated shipping cost, minus payment processing fees, summed across every non-test, non-cancelled order created in the period. " +
    MARGIN_INPUTS_NOTE,
  inclusions: ["Every non-test, non-cancelled order's (post-discount subtotal - matched COGS - estimated shipping cost - payment fee), summed over the period"],
  exclusions: ["Test orders", "Cancelled/voided orders", "Ad spend (see contribution_margin_by_channel, where ad spend is attributable)", "Refund netting (see limitation note above)"],
  timestampUsed: "orders.created_at (order placement date), compared in UTC.",
  refundHandling: "excluded",
  currencyHandling: "shop-currency-only",
  sql: CONTRIBUTION_MARGIN_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "No Shopify admin report shows contribution margin — it requires merchant-supplied COGS and shipping-cost data the platform doesn't have.",
  estimatedInputs: ["COGS (merchant-uploaded via CSV, packages/enrich)", "Shipping cost (merchant-uploaded flat estimate via CSV, packages/enrich)"],
  resultShape: "scalar",
});

const CONTRIBUTION_MARGIN_BY_CHANNEL_SQL = `
WITH order_scope AS (
  SELECT o.id, o.current_subtotal_minor, o.created_at, COALESCE(o.referrer_channel, 'unknown') AS channel
  FROM orders o
  WHERE o.store_id = $1 AND o.test = false AND o.cancelled_at IS NULL
    AND (o.created_at AT TIME ZONE 'UTC') >= $2 AND (o.created_at AT TIME ZONE 'UTC') < $3
),
${LINE_COGS_CTE},
${SHIP_COST_CTE},
${FEES_CTE},
order_margins AS (
  SELECT os.id, os.channel,
    (os.current_subtotal_minor - COALESCE(lc.cogs_minor, 0) - COALESCE(sc.cost_minor, 0) - COALESCE(f.fee_minor, 0)) AS margin_minor
  FROM order_scope os
  LEFT JOIN line_cogs lc ON lc.order_id = os.id
  LEFT JOIN ship_cost sc ON sc.order_id = os.id
  LEFT JOIN fees f ON f.order_id = os.id
),
channel_margins AS (
  SELECT channel, SUM(margin_minor) AS contribution_margin_minor
  FROM order_margins GROUP BY channel
),
channel_ad_spend AS (
  SELECT channel, COALESCE(SUM(spend_minor), 0) AS ad_spend_minor
  FROM enrich_ad_spend
  WHERE store_id = $1 AND (date AT TIME ZONE 'UTC') >= $2 AND (date AT TIME ZONE 'UTC') < $3
  GROUP BY channel
)
SELECT cm.channel AS channel,
       cm.contribution_margin_minor::text AS contribution_margin_minor,
       COALESCE(cas.ad_spend_minor, 0)::text AS ad_spend_minor,
       (cm.contribution_margin_minor - COALESCE(cas.ad_spend_minor, 0))::text AS net_after_ad_spend_minor
FROM channel_margins cm
LEFT JOIN channel_ad_spend cas ON cas.channel = cm.channel
ORDER BY cm.channel
`.trim();

registry.register({
  id: "contribution_margin_by_channel",
  name: "Contribution margin by channel",
  plainLanguageDefinition:
    "Contribution margin (see contribution_margin) grouped by the order's attributed acquisition channel, minus that channel's ad spend for the same period. " +
    "Channel attribution is a heuristic derived from Shopify's referrer/UTM data at sync time, not a guaranteed-accurate assignment — a multi-touch customer journey collapses to one bucket. " +
    MARGIN_INPUTS_NOTE,
  inclusions: ["Per-channel sum of order-level contribution margin", "minus that channel's enrich_ad_spend rows dated within the period"],
  exclusions: ["Test orders", "Cancelled/voided orders", "Refund netting (see limitation note above)"],
  timestampUsed: "orders.created_at for margin, enrich_ad_spend.date for spend. Both compared in UTC.",
  refundHandling: "excluded",
  currencyHandling: "shop-currency-only",
  sql: CONTRIBUTION_MARGIN_BY_CHANNEL_SQL,
  dependsOn: ["contribution_margin"],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "No Shopify admin report shows margin-by-channel net of ad spend — it requires merchant-supplied COGS, shipping cost, and ad spend, plus a channel-attribution heuristic Shopify doesn't compute for you.",
  estimatedInputs: [
    "COGS (merchant-uploaded via CSV, packages/enrich)",
    "Shipping cost (merchant-uploaded flat estimate via CSV, packages/enrich)",
    "Ad spend (merchant-uploaded via CSV, packages/enrich)",
    "Channel attribution (heuristic derived from referrer/UTM data, not guaranteed-accurate)",
  ],
  resultShape: "table",
});

const COHORT_RETENTION_BY_MONTH_SQL = `
WITH cust_orders AS (
  SELECT o.id, o.customer_id, o.created_at
  FROM orders o
  WHERE o.store_id = $1 AND o.test = false AND o.cancelled_at IS NULL AND o.customer_id IS NOT NULL
),
cohorts AS (
  SELECT customer_id, date_trunc('month', MIN(created_at)) AS cohort_month
  FROM cust_orders GROUP BY customer_id
),
cohort_sizes AS (
  SELECT cohort_month, COUNT(*) AS cohort_size FROM cohorts GROUP BY cohort_month
),
offsets AS (
  SELECT c.cohort_month, co.customer_id,
    (EXTRACT(YEAR FROM date_trunc('month', co.created_at)) - EXTRACT(YEAR FROM c.cohort_month)) * 12
      + (EXTRACT(MONTH FROM date_trunc('month', co.created_at)) - EXTRACT(MONTH FROM c.cohort_month)) AS months_since_first_order
  FROM cust_orders co
  JOIN cohorts c ON c.customer_id = co.customer_id
  GROUP BY c.cohort_month, co.customer_id, date_trunc('month', co.created_at)
)
SELECT o.cohort_month AS cohort_month,
       o.months_since_first_order::int AS months_since_first_order,
       cs.cohort_size::int AS cohort_size,
       COUNT(DISTINCT o.customer_id)::int AS active_customer_count,
       ROUND(COUNT(DISTINCT o.customer_id)::numeric / cs.cohort_size, 4)::text AS retention_rate
FROM offsets o
JOIN cohort_sizes cs ON cs.cohort_month = o.cohort_month
WHERE (o.cohort_month AT TIME ZONE 'UTC') >= $2 AND (o.cohort_month AT TIME ZONE 'UTC') < $3
GROUP BY o.cohort_month, o.months_since_first_order, cs.cohort_size
ORDER BY o.cohort_month, o.months_since_first_order
`.trim();

registry.register({
  id: "cohort_retention_by_month",
  name: "Cohort retention by first-order month",
  plainLanguageDefinition:
    "For each monthly cohort (customers grouped by the calendar month of their first non-test, non-cancelled order), the share of that cohort placing at least one order in each subsequent calendar month. " +
    "The period filters which cohorts are included (by first-order month), not which activity is counted — a cohort's retention is tracked forward regardless of the period's end date.",
  inclusions: ["Customers whose first order fell in a cohort month within the period", "Every subsequent month in which they placed a non-test, non-cancelled order"],
  exclusions: ["Test orders", "Cancelled/voided orders", "Customers with no linked customer_id (e.g. guest checkouts not yet matched to a customer record)"],
  timestampUsed: "orders.created_at, bucketed to calendar month in UTC. Store-timezone-aware month bucketing is a Phase 6 concern.",
  refundHandling: "not-applicable",
  currencyHandling: "not-applicable",
  sql: COHORT_RETENTION_BY_MONTH_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "Shopify's admin has no cohort retention report — this requires linking every order to a customer and tracking repeat behavior over time, which no single platform report exposes.",
  estimatedInputs: [],
  resultShape: "table",
});

const LTV_BY_CHANNEL_90D_SQL = `
WITH cust_orders AS (
  SELECT o.id, o.customer_id, o.created_at, o.current_subtotal_minor, COALESCE(o.referrer_channel, 'unknown') AS channel
  FROM orders o
  WHERE o.store_id = $1 AND o.test = false AND o.cancelled_at IS NULL AND o.customer_id IS NOT NULL
),
first_orders AS (
  SELECT customer_id,
         MIN(created_at) AS first_order_at,
         (ARRAY_AGG(channel ORDER BY created_at))[1] AS channel
  FROM cust_orders GROUP BY customer_id
),
cohort AS (
  SELECT customer_id, channel, first_order_at
  FROM first_orders
  WHERE (first_order_at AT TIME ZONE 'UTC') >= $2 AND (first_order_at AT TIME ZONE 'UTC') < $3
),
revenue_in_window AS (
  SELECT c.customer_id, c.channel, SUM(co.current_subtotal_minor) AS revenue_minor
  FROM cohort c
  JOIN cust_orders co ON co.customer_id = c.customer_id
    AND co.created_at >= c.first_order_at
    AND co.created_at < c.first_order_at + INTERVAL '90 days'
  GROUP BY c.customer_id, c.channel
)
SELECT channel AS channel,
       COUNT(*)::int AS customer_count,
       SUM(revenue_minor)::text AS cumulative_revenue_minor,
       ROUND(SUM(revenue_minor)::numeric / COUNT(*), 2)::text AS ltv_minor
FROM revenue_in_window
GROUP BY channel
ORDER BY channel
`.trim();

registry.register({
  id: "ltv_by_channel_90d",
  name: "90-day LTV by acquisition channel",
  plainLanguageDefinition:
    "For customers whose first order fell within the period, total revenue (post-discount subtotal) from that customer in the 90 days starting at their first order, averaged per customer, grouped by the channel of their first order. " +
    "This is a 90-DAY figure, not a lifetime figure — the maturity window is in the metric's own name and id deliberately, so it can't be misread as lifetime value. " +
    "Channel is a heuristic derived from referrer/UTM data, not a guaranteed-accurate attribution.",
  inclusions: ["Revenue from every order (any channel) placed by the customer in the 90 days following their first order", "Grouped by the channel of the customer's FIRST order only"],
  exclusions: ["Test orders", "Cancelled/voided orders", "Revenue beyond the 90-day window", "Customers with no linked customer_id"],
  timestampUsed: "orders.created_at, compared in UTC. 90-day window is calendar days from the customer's first order timestamp.",
  refundHandling: "excluded",
  currencyHandling: "shop-currency-only",
  sql: LTV_BY_CHANNEL_90D_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "Shopify's admin has no LTV-by-channel report — it requires linking orders to customers and to a channel-attribution heuristic the platform doesn't compute.",
  estimatedInputs: ["Channel attribution (heuristic derived from referrer/UTM data, not guaranteed-accurate)"],
  resultShape: "table",
});

const REPEAT_PURCHASE_INTERVAL_SQL = `
WITH cust_orders AS (
  SELECT o.customer_id, o.created_at
  FROM orders o
  WHERE o.store_id = $1 AND o.test = false AND o.cancelled_at IS NULL AND o.customer_id IS NOT NULL
    AND (o.created_at AT TIME ZONE 'UTC') >= $2 AND (o.created_at AT TIME ZONE 'UTC') < $3
),
ordered AS (
  SELECT customer_id, created_at,
    LAG(created_at) OVER (PARTITION BY customer_id ORDER BY created_at) AS prev_created_at
  FROM cust_orders
),
gaps AS (
  SELECT EXTRACT(EPOCH FROM (created_at - prev_created_at)) / 86400.0 AS gap_days
  FROM ordered WHERE prev_created_at IS NOT NULL
)
SELECT COALESCE(ROUND(AVG(gap_days)::numeric, 4), 0)::text AS value
FROM gaps
`.trim();

registry.register({
  id: "repeat_purchase_interval",
  name: "Repeat purchase interval",
  plainLanguageDefinition:
    "The average number of days between a customer's consecutive orders, pooled across every consecutive order pair (not averaged per customer first) for customers with 2+ orders in the period.",
  inclusions: ["Every gap between two consecutive non-test, non-cancelled orders from the same customer, both orders within the period"],
  exclusions: ["Test orders", "Cancelled/voided orders", "A customer's first order (has no prior order to measure a gap from)", "Customers with no linked customer_id"],
  timestampUsed: "orders.created_at, compared in UTC.",
  refundHandling: "not-applicable",
  currencyHandling: "not-applicable",
  sql: REPEAT_PURCHASE_INTERVAL_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "Shopify's admin has no repeat-purchase-interval report — it requires linking orders to customers and computing time-between-orders, which no platform report exposes.",
  estimatedInputs: [],
  resultShape: "scalar",
});

const DISCOUNT_PROFITABILITY_SQL = `
WITH order_scope AS (
  SELECT o.id, o.current_subtotal_minor, o.discounts_minor, o.created_at,
    CASE WHEN o.discounts_minor > 0 THEN 'discounted' ELSE 'full_price' END AS order_type
  FROM orders o
  WHERE o.store_id = $1 AND o.test = false AND o.cancelled_at IS NULL
    AND (o.created_at AT TIME ZONE 'UTC') >= $2 AND (o.created_at AT TIME ZONE 'UTC') < $3
),
${LINE_COGS_CTE},
${SHIP_COST_CTE},
${FEES_CTE},
order_margins AS (
  SELECT os.id, os.order_type, os.current_subtotal_minor,
    (os.current_subtotal_minor - COALESCE(lc.cogs_minor, 0) - COALESCE(sc.cost_minor, 0) - COALESCE(f.fee_minor, 0)) AS margin_minor
  FROM order_scope os
  LEFT JOIN line_cogs lc ON lc.order_id = os.id
  LEFT JOIN ship_cost sc ON sc.order_id = os.id
  LEFT JOIN fees f ON f.order_id = os.id
)
SELECT order_type AS order_type,
       COUNT(*)::int AS order_count,
       SUM(current_subtotal_minor)::text AS revenue_minor,
       SUM(margin_minor)::text AS margin_minor,
       ROUND(SUM(margin_minor)::numeric / NULLIF(SUM(current_subtotal_minor), 0), 4)::text AS margin_rate
FROM order_margins
GROUP BY order_type
ORDER BY order_type
`.trim();

registry.register({
  id: "discount_profitability",
  name: "Discount profitability",
  plainLanguageDefinition:
    "Contribution margin (see contribution_margin) split by whether the order carried a discount (discounts_minor > 0) or not, so a merchant can see whether discounted orders are actually profitable, not just whether they generated revenue. " +
    MARGIN_INPUTS_NOTE,
  inclusions: ["Every non-test, non-cancelled order in the period, bucketed into 'discounted' or 'full_price'"],
  exclusions: ["Test orders", "Cancelled/voided orders", "Refund netting (see limitation note above)"],
  timestampUsed: "orders.created_at, compared in UTC.",
  refundHandling: "excluded",
  currencyHandling: "shop-currency-only",
  sql: DISCOUNT_PROFITABILITY_SQL,
  dependsOn: ["contribution_margin"],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "No Shopify admin report splits margin by discounted-vs-full-price — it requires merchant-supplied COGS and shipping cost.",
  estimatedInputs: ["COGS (merchant-uploaded via CSV, packages/enrich)", "Shipping cost (merchant-uploaded flat estimate via CSV, packages/enrich)"],
  resultShape: "table",
});

const RETURNS_BY_VARIANT_COHORT_SQL = `
WITH cust_orders AS (
  SELECT o.id, o.customer_id, o.created_at
  FROM orders o
  WHERE o.store_id = $1 AND o.test = false AND o.customer_id IS NOT NULL
),
cohorts AS (
  SELECT customer_id, date_trunc('month', MIN(created_at)) AS cohort_month
  FROM cust_orders GROUP BY customer_id
),
refund_rows AS (
  SELECT oli.sku AS sku, c.cohort_month AS cohort_month, rli.quantity AS quantity, rli.amount_minor AS amount_minor
  FROM refund_line_items rli
  JOIN order_line_items oli ON oli.id = rli.order_line_item_id
  JOIN refunds r ON r.id = rli.refund_id
  JOIN orders o ON o.id = r.order_id
  JOIN cohorts c ON c.customer_id = o.customer_id
  WHERE r.store_id = $1 AND o.test = false
    AND (r.processed_at AT TIME ZONE 'UTC') >= $2 AND (r.processed_at AT TIME ZONE 'UTC') < $3
)
SELECT sku, cohort_month,
       COUNT(*)::int AS return_count,
       SUM(quantity)::int AS returned_units,
       SUM(amount_minor)::text AS returned_value_minor
FROM refund_rows
GROUP BY sku, cohort_month
ORDER BY cohort_month, sku
`.trim();

registry.register({
  id: "returns_by_variant_cohort",
  name: "Returns by variant and cohort",
  plainLanguageDefinition:
    "Refunded goods (excludes shipping/tax refund portions, same convention as sales_reversals), grouped by the SKU returned and by the returning customer's first-order-month cohort. " +
    "Booked on the refund's processed date, not the original order date.",
  inclusions: ["Refund line items processed in the period, joined to the SKU on the original order line item and the customer's cohort month"],
  exclusions: ["Test orders", "Shipping refund amount", "Tax refund amount", "Refund line items with no linked customer_id"],
  timestampUsed: "refunds.processed_at (return processed date, not order date), compared in UTC.",
  refundHandling: "on-refund-processed-date",
  currencyHandling: "shop-currency-only",
  sql: RETURNS_BY_VARIANT_COHORT_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "Shopify's admin has no returns-by-variant-and-cohort report — it requires linking refund line items to both SKU and customer cohort simultaneously.",
  estimatedInputs: [],
  resultShape: "table",
});

// Phase 7 — packages/report's SKU-velocity-drop alert (docs/BUILD-SPEC.md:
// "a SKU's velocity dropping") needs units sold per SKU for a period; this
// metric is that figure. "Velocity" itself is defined by the alert
// evaluator, not here: it compares this metric's output for two
// consecutive equal-length periods for the same SKU and computes a percent
// change — this metric only ever reports one period's units, by design,
// so it composes with periods of any length rather than baking in a
// specific comparison window.
const SKU_UNITS_SOLD_SQL = `
SELECT oli.sku AS sku, SUM(oli.quantity)::int AS units_sold
FROM order_line_items oli
JOIN orders o ON o.id = oli.order_id
WHERE o.store_id = $1 AND o.test = false AND o.cancelled_at IS NULL
  AND oli.sku IS NOT NULL
  AND (o.created_at AT TIME ZONE 'UTC') >= $2 AND (o.created_at AT TIME ZONE 'UTC') < $3
GROUP BY oli.sku
ORDER BY oli.sku
`.trim();

registry.register({
  id: "sku_units_sold",
  name: "Units sold by SKU",
  plainLanguageDefinition:
    "Total quantity ordered per SKU, for non-test, non-cancelled orders created in the period. Line items with no SKU recorded are excluded, not bucketed under a placeholder.",
  inclusions: ["order_line_items.quantity, summed per SKU, for orders created in the period"],
  exclusions: ["Test orders", "Cancelled/voided orders", "Line items with no SKU"],
  timestampUsed: "orders.created_at (order placement date), compared in UTC.",
  refundHandling: "excluded",
  currencyHandling: "not-applicable",
  sql: SKU_UNITS_SOLD_SQL,
  dependsOn: [],
  version: 1,
  owner: OWNER,
  reconciliationTargetDescription: null,
  nonReconciliationReason: "Shopify's admin reports units sold in aggregate, not per-SKU-per-arbitrary-period in a form this pipeline can query without hitting the live API at request time — see CLAUDE.md's 'never compute metrics from live API calls at request time' rule.",
  estimatedInputs: [],
  resultShape: "table",
});
