// Synthetic Shopify order dataset for Phase 3 tests. Real Shopify Partner
// credentials do not exist yet (docs/PLAN.md Risk #1 remains open) — this
// generates a large, varied dataset so the sync pipeline's *mechanics*
// (windowing, streaming JSONL parse, idempotent upsert, out-of-order/repair
// handling) are genuinely exercised, without claiming to reproduce Shopify's
// exact GraphQL response shapes (that fidelity work is Phase 2's connector,
// already built against real docs — see docs/PLAN.md §6). Field names here
// are the flat, already-normalised shape our mapping layer expects, tagged
// with `__type` so the streaming parser can dispatch without guessing.

export interface SyntheticOrder {
  __type: "Order";
  id: string; // gid://shopify/Order/{n}
  createdAt: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  closedAt: string | null;
  test: boolean;
  currencyCode: string;
  presentmentCurrencyCode: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  grossSalesMinor: number;
  discountsMinor: number;
  shippingMinor: number;
  taxesMinor: number;
  currentSubtotalMinor: number;
  currentTotalMinor: number;
  lineItems: SyntheticLineItem[];
  discounts: SyntheticDiscount[];
  transactions: SyntheticTransaction[];
  refunds: SyntheticRefund[];
}

export interface SyntheticLineItem {
  __type: "LineItem";
  id: string;
  productId: string;
  variantId: string;
  sku: string;
  quantity: number;
  priceMinor: number;
  discountMinor: number;
  currencyCode: string;
}

export interface SyntheticDiscount {
  __type: "Discount";
  id: string;
  applicationType: "code" | "automatic" | "script";
  code: string | null;
  amountMinor: number;
  currencyCode: string;
}

export interface SyntheticTransaction {
  __type: "Transaction";
  id: string;
  kind: "sale" | "capture" | "refund" | "void";
  status: string;
  amountMinor: number;
  feeMinor: number | null;
  currencyCode: string;
  processedAt: string;
}

export interface SyntheticRefund {
  __type: "Refund";
  id: string;
  processedAt: string;
  amountMinor: number;
  shippingRefundMinor: number;
  taxRefundMinor: number;
  currencyCode: string;
  lineItems: SyntheticRefundLineItem[];
}

export interface SyntheticRefundLineItem {
  __type: "RefundLineItem";
  id: string;
  orderLineItemId: string;
  quantity: number;
  amountMinor: number;
}

export interface GenerateOptions {
  count: number;
  startDate: Date;
  endDate: Date;
  seed?: number;
  storeTag: string; // disambiguates ids across parallel test suites
}

const CURRENCIES = ["USD", "USD", "USD", "EUR", "GBP"]; // mostly USD, some multi-currency

// Deterministic PRNG so a test run is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSyntheticOrders(opts: GenerateOptions): SyntheticOrder[] {
  const rand = mulberry32(opts.seed ?? 42);
  const spanMs = opts.endDate.getTime() - opts.startDate.getTime();
  const orders: SyntheticOrder[] = [];

  for (let i = 0; i < opts.count; i++) {
    const createdAt = new Date(opts.startDate.getTime() + Math.floor(rand() * spanMs));
    const currency = CURRENCIES[Math.floor(rand() * CURRENCIES.length)] ?? "USD";
    const isTest = rand() < 0.01; // ~1% test orders
    const isCancelled = !isTest && rand() < 0.02; // ~2% cancelled
    const hasRefund = !isTest && !isCancelled && rand() < 0.08; // ~8% partially/fully refunded
    const lineItemCount = 1 + Math.floor(rand() * 3);

    const unitPrice = 500 + Math.floor(rand() * 9500); // 5.00–99.99 in minor units
    const lineItems: SyntheticLineItem[] = Array.from({ length: lineItemCount }, (_, li) => ({
      __type: "LineItem" as const,
      id: `gid://shopify/LineItem/${opts.storeTag}-${i}-${li}`,
      productId: `gid://shopify/Product/${opts.storeTag}-p${i % 500}`,
      variantId: `gid://shopify/ProductVariant/${opts.storeTag}-v${i % 500}-${li}`,
      sku: `SKU-${i % 500}-${li}`,
      quantity: 1 + Math.floor(rand() * 3),
      priceMinor: unitPrice,
      discountMinor: 0,
      currencyCode: currency,
    }));

    const grossSalesMinor = lineItems.reduce((sum, li) => sum + li.priceMinor * li.quantity, 0);
    const hasDiscount = rand() < 0.2;
    const discountsMinor = hasDiscount ? Math.floor(grossSalesMinor * 0.1) : 0;
    const shippingMinor = rand() < 0.5 ? 0 : 500 + Math.floor(rand() * 1000);
    const taxesMinor = Math.floor((grossSalesMinor - discountsMinor) * 0.08);
    const netTotal = grossSalesMinor - discountsMinor + shippingMinor + taxesMinor;

    const discounts: SyntheticDiscount[] = hasDiscount
      ? [
          {
            __type: "Discount" as const,
            id: `gid://shopify/DiscountApplication/${opts.storeTag}-${i}`,
            applicationType: rand() < 0.5 ? "code" : "automatic",
            code: rand() < 0.5 ? `SAVE10-${i % 20}` : null,
            amountMinor: discountsMinor,
            currencyCode: currency,
          },
        ]
      : [];

    const transactions: SyntheticTransaction[] = isCancelled
      ? []
      : [
          {
            __type: "Transaction" as const,
            id: `gid://shopify/OrderTransaction/${opts.storeTag}-${i}-sale`,
            kind: "sale",
            status: "success",
            amountMinor: netTotal,
            feeMinor: Math.floor(netTotal * 0.029) + 30,
            currencyCode: currency,
            processedAt: createdAt.toISOString(),
          },
        ];

    let currentTotalMinor = netTotal;
    let currentSubtotalMinor = grossSalesMinor - discountsMinor;
    const refunds: SyntheticRefund[] = [];
    if (hasRefund) {
      const refundedLine = lineItems[0]!;
      const refundAmount = refundedLine.priceMinor;
      const refundedAt = new Date(createdAt.getTime() + 3 * 24 * 60 * 60 * 1000);
      refunds.push({
        __type: "Refund" as const,
        id: `gid://shopify/Refund/${opts.storeTag}-${i}`,
        processedAt: refundedAt.toISOString(),
        amountMinor: refundAmount,
        shippingRefundMinor: 0,
        taxRefundMinor: 0,
        currencyCode: currency,
        lineItems: [
          {
            __type: "RefundLineItem" as const,
            id: `gid://shopify/RefundLineItem/${opts.storeTag}-${i}-0`,
            orderLineItemId: refundedLine.id,
            quantity: 1,
            amountMinor: refundAmount,
          },
        ],
      });
      currentTotalMinor -= refundAmount;
      currentSubtotalMinor -= refundAmount;
    }

    const displayFinancialStatus = isCancelled
      ? "VOIDED"
      : refunds.length > 0
        ? currentTotalMinor <= 0
          ? "REFUNDED"
          : "PARTIALLY_REFUNDED"
        : "PAID";

    orders.push({
      __type: "Order",
      id: `gid://shopify/Order/${opts.storeTag}-${i}`,
      createdAt: createdAt.toISOString(),
      processedAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      cancelledAt: isCancelled ? new Date(createdAt.getTime() + 60_000).toISOString() : null,
      closedAt: null,
      test: isTest,
      currencyCode: currency,
      presentmentCurrencyCode: currency,
      displayFinancialStatus,
      displayFulfillmentStatus: rand() < 0.7 ? "FULFILLED" : "UNFULFILLED",
      grossSalesMinor,
      discountsMinor,
      shippingMinor,
      taxesMinor,
      currentSubtotalMinor,
      currentTotalMinor,
      lineItems,
      discounts,
      transactions,
      refunds,
    });
  }

  return orders;
}

/** Flattens an order + its nested children into Shopify bulk-export JSONL line order: parent, then each child group, then each refund's own children. */
export function orderToJsonlLines(order: SyntheticOrder): string[] {
  const { lineItems, discounts, transactions, refunds, ...orderFields } = order;
  const lines: string[] = [JSON.stringify(orderFields)];

  for (const li of lineItems) lines.push(JSON.stringify({ ...li, __parentId: order.id }));
  for (const d of discounts) lines.push(JSON.stringify({ ...d, __parentId: order.id }));
  for (const t of transactions) lines.push(JSON.stringify({ ...t, __parentId: order.id }));
  for (const r of refunds) {
    const { lineItems: refundLineItems, ...refundFields } = r;
    lines.push(JSON.stringify({ ...refundFields, __parentId: order.id }));
    for (const rli of refundLineItems) lines.push(JSON.stringify({ ...rli, __parentId: r.id }));
  }

  return lines;
}

export function ordersToJsonl(orders: SyntheticOrder[]): string {
  return orders.flatMap(orderToJsonlLines).join("\n") + "\n";
}
