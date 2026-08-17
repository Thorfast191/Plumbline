// Phase 5 deterministic fixture — separate from fixtures.ts (Phase 4's
// synthetic order set) on purpose: Phase 4's 32/32 recon suite is already
// passing and must not regress, so this file adds a second, independent,
// hand-reasoned dataset for the metrics that need customer/channel/SKU
// structure Phase 4 never needed (cohort retention, LTV, repeat purchase
// interval, discount profitability, contribution margin, returns by
// variant/cohort). Every figure below is reproducible by hand — see the
// per-metric vitest tests in packages/metrics/src/__tests__ for the
// worked arithmetic.

export interface Phase5LineItem {
  id: string;
  sku: string;
  priceMinor: number;
  quantity: number;
}

export interface Phase5Refund {
  id: string;
  processedAt: string;
  amountMinor: number;
  shippingRefundMinor: number;
  taxRefundMinor: number;
  lineItems: Array<{ id: string; orderLineItemId: string; quantity: number; amountMinor: number }>;
}

export interface Phase5Order {
  id: string;
  customerId: string;
  createdAt: string;
  // Best-effort channel bucket, one per order (see schema.prisma's comment
  // on Order.referrerChannel for why this is a heuristic, not a fact).
  referrerChannel: "meta" | "google" | "direct";
  sourceName: string;
  discountsMinor: number;
  shippingMinor: number;
  taxesMinor: number;
  grossSalesMinor: number;
  currentSubtotalMinor: number; // gross - discounts (post-discount, pre-tax/shipping revenue basis used for margin)
  currentTotalMinor: number;
  lineItems: Phase5LineItem[];
  refunds: Phase5Refund[];
}

export interface Phase5Customer {
  id: string;
  shopifyCustomerId: string;
}

function saleFee(amountMinor: number): number {
  return Math.floor(amountMinor * 0.029) + 30;
}

function iso(y: number, m1to12: number, d: number, h = 12): string {
  return new Date(Date.UTC(y, m1to12 - 1, d, h, 0, 0)).toISOString();
}

const SKU_A_PRICE = 10000;
const SKU_B_PRICE = 8000;

function plainOrder(params: {
  id: string;
  customerId: string;
  dateIso: string;
  sku: "SKU-A" | "SKU-B";
  channel: "meta" | "google" | "direct";
  discountsMinor?: number;
}): Phase5Order {
  const { id, customerId, dateIso, sku, channel, discountsMinor = 0 } = params;
  const priceMinor = sku === "SKU-A" ? SKU_A_PRICE : SKU_B_PRICE;
  const grossSalesMinor = priceMinor;
  const currentSubtotalMinor = grossSalesMinor - discountsMinor;
  const shippingMinor = 500;
  const taxesMinor = Math.floor(currentSubtotalMinor * 0.08);
  const currentTotalMinor = currentSubtotalMinor + shippingMinor + taxesMinor;

  return {
    id,
    customerId,
    createdAt: dateIso,
    referrerChannel: channel,
    sourceName: "web",
    discountsMinor,
    shippingMinor,
    taxesMinor,
    grossSalesMinor,
    currentSubtotalMinor,
    currentTotalMinor,
    lineItems: [{ id: `${id}-li0`, sku, priceMinor, quantity: 1 }],
    refunds: [],
  };
}

export const PHASE5_CUSTOMERS: Phase5Customer[] = [
  { id: "p5-cust-1", shopifyCustomerId: "p5-cust-1" },
  { id: "p5-cust-2", shopifyCustomerId: "p5-cust-2" },
  { id: "p5-cust-3", shopifyCustomerId: "p5-cust-3" },
  { id: "p5-cust-4", shopifyCustomerId: "p5-cust-4" },
  { id: "p5-cust-5", shopifyCustomerId: "p5-cust-5" },
  { id: "p5-cust-6", shopifyCustomerId: "p5-cust-6" },
];

/**
 * C1..C5 cover contribution margin, channel rollups, cohort retention,
 * LTV, repeat purchase interval, and discount profitability — all with NO
 * refunds, so those metrics' arithmetic doesn't interact with return
 * handling. C6's order+refund (dated well outside the [2025-01-01,
 * 2025-05-01) window every other test uses) is isolated on purpose so it
 * only shows up in the returns_by_variant_cohort test, which uses a wider
 * period.
 */
export function buildPhase5Orders(): Phase5Order[] {
  const orders: Phase5Order[] = [
    // C1 — meta — Jan cohort — orders in Jan, Feb, Apr
    plainOrder({ id: "p5-o1", customerId: "p5-cust-1", dateIso: iso(2025, 1, 10), sku: "SKU-A", channel: "meta" }),
    plainOrder({ id: "p5-o2", customerId: "p5-cust-1", dateIso: iso(2025, 2, 15), sku: "SKU-A", channel: "meta" }),
    plainOrder({ id: "p5-o3", customerId: "p5-cust-1", dateIso: iso(2025, 4, 1), sku: "SKU-B", channel: "meta" }),

    // C2 — google — Jan cohort — orders in Jan, Mar
    plainOrder({ id: "p5-o4", customerId: "p5-cust-2", dateIso: iso(2025, 1, 20), sku: "SKU-B", channel: "google" }),
    plainOrder({ id: "p5-o5", customerId: "p5-cust-2", dateIso: iso(2025, 3, 5), sku: "SKU-B", channel: "google" }),

    // C3 — direct — Jan cohort — single order, no repeat (churned)
    plainOrder({ id: "p5-o6", customerId: "p5-cust-3", dateIso: iso(2025, 1, 25), sku: "SKU-A", channel: "direct" }),

    // C4 — meta — Feb cohort — orders in Feb, Mar
    plainOrder({ id: "p5-o7", customerId: "p5-cust-4", dateIso: iso(2025, 2, 5), sku: "SKU-A", channel: "meta" }),
    plainOrder({ id: "p5-o8", customerId: "p5-cust-4", dateIso: iso(2025, 3, 10), sku: "SKU-A", channel: "meta" }),

    // C5 — google — Feb cohort — single discounted order (10% code discount)
    plainOrder({ id: "p5-o9", customerId: "p5-cust-5", dateIso: iso(2025, 2, 10), sku: "SKU-B", channel: "google", discountsMinor: 800 }),
  ];

  // C6 — direct — June, 2 units of SKU-A, one unit returned 4 days later.
  // Deliberately outside every other test's [2025-01-01, 2025-05-01) window.
  const o10Id = "p5-o10";
  const o10DateIso = iso(2025, 6, 1);
  const o10PriceMinor = SKU_A_PRICE;
  const o10Quantity = 2;
  const o10GrossSalesMinor = o10PriceMinor * o10Quantity;
  const o10CurrentSubtotalMinor = o10GrossSalesMinor;
  const o10ShippingMinor = 500;
  const o10TaxesMinor = Math.floor(o10CurrentSubtotalMinor * 0.08);
  const o10CurrentTotalMinor = o10CurrentSubtotalMinor + o10ShippingMinor + o10TaxesMinor;
  const o10RefundDateIso = iso(2025, 6, 5);

  orders.push({
    id: o10Id,
    customerId: "p5-cust-6",
    createdAt: o10DateIso,
    referrerChannel: "direct",
    sourceName: "web",
    discountsMinor: 0,
    shippingMinor: o10ShippingMinor,
    taxesMinor: o10TaxesMinor,
    grossSalesMinor: o10GrossSalesMinor,
    currentSubtotalMinor: o10CurrentSubtotalMinor,
    currentTotalMinor: o10CurrentTotalMinor,
    lineItems: [{ id: `${o10Id}-li0`, sku: "SKU-A", priceMinor: o10PriceMinor, quantity: o10Quantity }],
    refunds: [
      {
        id: `${o10Id}-refund0`,
        processedAt: o10RefundDateIso,
        amountMinor: o10PriceMinor, // 1 of 2 units returned
        shippingRefundMinor: 0,
        taxRefundMinor: 800,
        lineItems: [{ id: `${o10Id}-rli0`, orderLineItemId: `${o10Id}-li0`, quantity: 1, amountMinor: o10PriceMinor }],
      },
    ],
  });

  return orders;
}

/** Attaches the sale-transaction fee to every order — same 2.9%+$0.30 model as fixtures.ts, kept identical for consistency. */
export function saleFeeFor(order: Phase5Order): number {
  return saleFee(order.currentTotalMinor);
}

export const COGS_FIXTURE = [
  { sku: "SKU-A", costMinor: 4000, currencyCode: "USD", effectiveFrom: iso(2025, 1, 1, 0) },
  { sku: "SKU-B", costMinor: 3000, currencyCode: "USD", effectiveFrom: iso(2025, 1, 1, 0) },
];

export const SHIPPING_COST_FIXTURE = [{ costMinor: 500, currencyCode: "USD", effectiveFrom: iso(2025, 1, 1, 0) }];

export const AD_SPEND_FIXTURE = [
  { channel: "meta", date: iso(2025, 1, 10, 0), spendMinor: 20000, currencyCode: "USD" },
  { channel: "meta", date: iso(2025, 2, 5, 0), spendMinor: 20000, currencyCode: "USD" },
  { channel: "google", date: iso(2025, 1, 20, 0), spendMinor: 15000, currencyCode: "USD" },
  { channel: "google", date: iso(2025, 2, 10, 0), spendMinor: 15000, currencyCode: "USD" },
];

/** The window every metric except returns_by_variant_cohort is tested against. */
export const PHASE5_MAIN_PERIOD = { from: new Date("2025-01-01T00:00:00.000Z"), to: new Date("2025-05-01T00:00:00.000Z") };

/** Wide window covering C6's June order+refund, used only by returns_by_variant_cohort. */
export const PHASE5_WIDE_PERIOD = { from: new Date("2025-01-01T00:00:00.000Z"), to: new Date("2026-01-01T00:00:00.000Z") };
