// Phase 4 — see docs/PLAN.md §11, CLAUDE.md "Non-negotiable rules": every
// metric has a written definition (this file) and a recon test
// (packages/recon). `sql` below is not documentation of a separate
// implementation — it is the literal query `runMetric` executes (see
// bottom of this file), so the registry and the executed code cannot drift.

export type RefundHandling = "on-refund-processed-date" | "excluded" | "not-applicable";
export type CurrencyHandling = "shop-currency-only" | "converted-at-read-time" | "not-applicable";

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

const GROSS_SALES_SQL = `
SELECT COALESCE(SUM(gross_sales_minor), 0)::text AS value
FROM orders
WHERE store_id = $1
  AND test = false
  AND cancelled_at IS NULL
  AND created_at >= $2
  AND created_at < $3
`.trim();

const DISCOUNTS_SQL = `
SELECT COALESCE(SUM(discounts_minor), 0)::text AS value
FROM orders
WHERE store_id = $1
  AND test = false
  AND cancelled_at IS NULL
  AND created_at >= $2
  AND created_at < $3
`.trim();

const ORDER_COUNT_SQL = `
SELECT COUNT(*)::text AS value
FROM orders
WHERE store_id = $1
  AND test = false
  AND cancelled_at IS NULL
  AND created_at >= $2
  AND created_at < $3
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
  AND r.processed_at >= $2
  AND r.processed_at < $3
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
    AND created_at >= $2 AND created_at < $3
),
refund_side AS (
  SELECT COALESCE(SUM(r.shipping_refund_minor), 0) AS amt
  FROM refunds r JOIN orders o ON o.id = r.order_id
  WHERE r.store_id = $1 AND o.test = false
    AND r.processed_at >= $2 AND r.processed_at < $3
)
SELECT (sale_side.amt::bigint - refund_side.amt::bigint)::text AS value
FROM sale_side, refund_side
`.trim();

const TAXES_SQL = `
WITH sale_side AS (
  SELECT COALESCE(SUM(taxes_minor), 0) AS amt
  FROM orders
  WHERE store_id = $1 AND test = false AND cancelled_at IS NULL
    AND created_at >= $2 AND created_at < $3
),
refund_side AS (
  SELECT COALESCE(SUM(r.tax_refund_minor), 0) AS amt
  FROM refunds r JOIN orders o ON o.id = r.order_id
  WHERE r.store_id = $1 AND o.test = false
    AND r.processed_at >= $2 AND r.processed_at < $3
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
  AND t.processed_at >= $2
  AND t.processed_at < $3
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
           AND created_at >= $2 AND created_at < $3
       ),
       refund_side AS (
         SELECT COALESCE(SUM(r.shipping_refund_minor), 0) AS amt
         FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE r.store_id = $1 AND o.test = false
           AND r.processed_at >= $2 AND r.processed_at < $3
       )
       SELECT (sale_side.amt - refund_side.amt) AS amt FROM sale_side, refund_side
     ),
     taxes AS (
       WITH sale_side AS (
         SELECT COALESCE(SUM(taxes_minor), 0) AS amt
         FROM orders
         WHERE store_id = $1 AND test = false AND cancelled_at IS NULL
           AND created_at >= $2 AND created_at < $3
       ),
       refund_side AS (
         SELECT COALESCE(SUM(r.tax_refund_minor), 0) AS amt
         FROM refunds r JOIN orders o ON o.id = r.order_id
         WHERE r.store_id = $1 AND o.test = false
           AND r.processed_at >= $2 AND r.processed_at < $3
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
