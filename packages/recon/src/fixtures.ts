// Phase 4 deterministic fixture for reconciliation. Real Shopify credentials
// still don't exist (docs/PLAN.md Risk #1), so this is the recon
// counterpart to packages/sync's synthetic dataset: a small, hand-reasoned
// (not randomised) order set spanning calendar year 2025, built specifically
// so the four Gate-4 period types (single day / month / year / a period
// containing a refund + a cancellation + a discount + a multi-currency
// order) are all exercised with known, auditable data.

export interface ReconLineItem {
  id: string;
  priceMinor: number;
  quantity: number;
}

export interface ReconDiscount {
  id: string;
  applicationType: "code" | "automatic";
  code: string | null;
  amountMinor: number;
}

export interface ReconTransaction {
  id: string;
  kind: "sale" | "refund";
  amountMinor: number;
  feeMinor: number | null;
  processedAt: string;
}

export interface ReconRefund {
  id: string;
  processedAt: string;
  amountMinor: number;
  shippingRefundMinor: number;
  taxRefundMinor: number;
  lineItems: Array<{ id: string; orderLineItemId: string; quantity: number; amountMinor: number }>;
}

export interface ReconOrder {
  id: string;
  createdAt: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
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
  lineItems: ReconLineItem[];
  discounts: ReconDiscount[];
  transactions: ReconTransaction[];
  refunds: ReconRefund[];
}

function saleFee(amountMinor: number): number {
  return Math.floor(amountMinor * 0.029) + 30;
}

function plainOrder(dayIndex: number, dateIso: string, slot: number): ReconOrder {
  const priceMinor = 10000 + ((dayIndex + slot * 3) % 7) * 100;
  const quantity = 1 + (slot % 2);
  const grossSalesMinor = priceMinor * quantity;
  const shippingMinor = (dayIndex + slot) % 2 === 0 ? 500 : 0;
  const taxesMinor = Math.floor(grossSalesMinor * 0.08);
  const currentTotalMinor = grossSalesMinor + shippingMinor + taxesMinor;
  const id = `recon-plain-${dayIndex}-${slot}`;

  return {
    id,
    createdAt: dateIso,
    processedAt: dateIso,
    updatedAt: dateIso,
    cancelledAt: null,
    test: false,
    currencyCode: "USD",
    presentmentCurrencyCode: "USD",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    grossSalesMinor,
    discountsMinor: 0,
    shippingMinor,
    taxesMinor,
    currentSubtotalMinor: grossSalesMinor,
    currentTotalMinor,
    lineItems: [{ id: `${id}-li0`, priceMinor, quantity }],
    discounts: [],
    transactions: [
      { id: `${id}-tx-sale`, kind: "sale", amountMinor: currentTotalMinor, feeMinor: saleFee(currentTotalMinor), processedAt: dateIso },
    ],
    refunds: [],
  };
}

function isoDay(year: number, month1to12: number, day: number, hour = 12): string {
  return new Date(Date.UTC(year, month1to12 - 1, day, hour, 0, 0)).toISOString();
}

/** The narrow window Gate 4 asks for: one period containing a refund, a cancellation, a discount, and a multi-currency order (plus a test order, to prove exclusion isn't accidental). */
export const SPECIAL_PERIOD = {
  from: new Date("2025-03-10T00:00:00.000Z"),
  to: new Date("2025-03-17T00:00:00.000Z"), // exclusive
};

export const SINGLE_DAY_PERIOD = {
  from: new Date("2025-06-15T00:00:00.000Z"),
  to: new Date("2025-06-16T00:00:00.000Z"),
};

export const MONTH_PERIOD = {
  from: new Date("2025-06-01T00:00:00.000Z"),
  to: new Date("2025-07-01T00:00:00.000Z"),
};

export const YEAR_PERIOD = {
  from: new Date("2025-01-01T00:00:00.000Z"),
  to: new Date("2026-01-01T00:00:00.000Z"),
};

function specialOrders(): ReconOrder[] {
  const discountOrder: ReconOrder = (() => {
    const priceMinor = 20000;
    const grossSalesMinor = priceMinor;
    const discountsMinor = 2000; // 10% code discount
    const shippingMinor = 500;
    const taxesMinor = Math.floor((grossSalesMinor - discountsMinor) * 0.08);
    const currentSubtotalMinor = grossSalesMinor - discountsMinor;
    const currentTotalMinor = currentSubtotalMinor + shippingMinor + taxesMinor;
    const id = "recon-special-discount";
    const dateIso = isoDay(2025, 3, 11, 12);
    return {
      id,
      createdAt: dateIso,
      processedAt: dateIso,
      updatedAt: dateIso,
      cancelledAt: null,
      test: false,
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      grossSalesMinor,
      discountsMinor,
      shippingMinor,
      taxesMinor,
      currentSubtotalMinor,
      currentTotalMinor,
      lineItems: [{ id: `${id}-li0`, priceMinor, quantity: 1 }],
      discounts: [{ id: `${id}-disc0`, applicationType: "code", code: "SAVE10-WEEK", amountMinor: discountsMinor }],
      transactions: [{ id: `${id}-tx-sale`, kind: "sale", amountMinor: currentTotalMinor, feeMinor: saleFee(currentTotalMinor), processedAt: dateIso }],
      refunds: [],
    };
  })();

  const refundOrder: ReconOrder = (() => {
    const priceMinor = 15000;
    const grossSalesMinor = priceMinor;
    const shippingMinor = 500;
    const taxesMinor = Math.floor(grossSalesMinor * 0.08);
    const saleTotalMinor = grossSalesMinor + shippingMinor + taxesMinor;
    const id = "recon-special-refund";
    const createdIso = isoDay(2025, 3, 11, 9);
    const refundIso = isoDay(2025, 3, 13, 10); // still inside the special window
    return {
      id,
      createdAt: createdIso,
      processedAt: createdIso,
      updatedAt: refundIso,
      cancelledAt: null,
      test: false,
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      displayFinancialStatus: "REFUNDED",
      displayFulfillmentStatus: "FULFILLED",
      grossSalesMinor,
      discountsMinor: 0,
      shippingMinor,
      taxesMinor,
      currentSubtotalMinor: 0,
      currentTotalMinor: 0,
      lineItems: [{ id: `${id}-li0`, priceMinor, quantity: 1 }],
      discounts: [],
      transactions: [
        { id: `${id}-tx-sale`, kind: "sale", amountMinor: saleTotalMinor, feeMinor: saleFee(saleTotalMinor), processedAt: createdIso },
        { id: `${id}-tx-refund`, kind: "refund", amountMinor: saleTotalMinor, feeMinor: null, processedAt: refundIso },
      ],
      refunds: [
        {
          id: `${id}-refund0`,
          processedAt: refundIso,
          amountMinor: grossSalesMinor, // goods portion only — shipping/tax refunded separately, per docs/PLAN.md §7
          shippingRefundMinor: shippingMinor,
          taxRefundMinor: taxesMinor,
          lineItems: [{ id: `${id}-rli0`, orderLineItemId: `${id}-li0`, quantity: 1, amountMinor: grossSalesMinor }],
        },
      ],
    };
  })();

  const cancelledOrder: ReconOrder = (() => {
    const priceMinor = 5000;
    const id = "recon-special-cancelled";
    const dateIso = isoDay(2025, 3, 12, 8);
    return {
      id,
      createdAt: dateIso,
      processedAt: dateIso,
      updatedAt: dateIso,
      cancelledAt: isoDay(2025, 3, 12, 8),
      test: false,
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      displayFinancialStatus: "VOIDED",
      displayFulfillmentStatus: "UNFULFILLED",
      grossSalesMinor: priceMinor,
      discountsMinor: 0,
      shippingMinor: 0,
      taxesMinor: Math.floor(priceMinor * 0.08),
      currentSubtotalMinor: priceMinor,
      currentTotalMinor: priceMinor,
      lineItems: [{ id: `${id}-li0`, priceMinor, quantity: 1 }],
      discounts: [],
      transactions: [], // never captured — cancelled before payment, per docs/PLAN.md §8
      refunds: [],
    };
  })();

  const multiCurrencyOrder: ReconOrder = (() => {
    const priceMinor = 8000;
    const grossSalesMinor = priceMinor;
    const shippingMinor = 500;
    const taxesMinor = Math.floor(grossSalesMinor * 0.08);
    const currentTotalMinor = grossSalesMinor + shippingMinor + taxesMinor;
    const id = "recon-special-multicurrency";
    const dateIso = isoDay(2025, 3, 14, 15);
    return {
      id,
      createdAt: dateIso,
      processedAt: dateIso,
      updatedAt: dateIso,
      cancelledAt: null,
      test: false,
      // Shop currency (what our figures are booked/reconciled in, per
      // docs/PLAN.md §7/§8) stays USD; presentment currency is what the
      // customer actually saw at checkout — they diverge here on purpose.
      currencyCode: "USD",
      presentmentCurrencyCode: "EUR",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      grossSalesMinor,
      discountsMinor: 0,
      shippingMinor,
      taxesMinor,
      currentSubtotalMinor: grossSalesMinor,
      currentTotalMinor,
      lineItems: [{ id: `${id}-li0`, priceMinor, quantity: 1 }],
      discounts: [],
      transactions: [{ id: `${id}-tx-sale`, kind: "sale", amountMinor: currentTotalMinor, feeMinor: saleFee(currentTotalMinor), processedAt: dateIso }],
      refunds: [],
    };
  })();

  const testOrder: ReconOrder = (() => {
    const priceMinor = 999_999;
    const id = "recon-special-test";
    const dateIso = isoDay(2025, 3, 15, 10);
    return {
      id,
      createdAt: dateIso,
      processedAt: dateIso,
      updatedAt: dateIso,
      cancelledAt: null,
      test: true, // must be excluded from every one of the 8 baseline metrics
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      grossSalesMinor: priceMinor,
      discountsMinor: 5000,
      shippingMinor: 500,
      taxesMinor: Math.floor(priceMinor * 0.08),
      currentSubtotalMinor: priceMinor - 5000,
      currentTotalMinor: priceMinor - 5000 + 500 + Math.floor(priceMinor * 0.08),
      lineItems: [{ id: `${id}-li0`, priceMinor, quantity: 1 }],
      discounts: [{ id: `${id}-disc0`, applicationType: "automatic", code: null, amountMinor: 5000 }],
      transactions: [{ id: `${id}-tx-sale`, kind: "sale", amountMinor: priceMinor, feeMinor: saleFee(priceMinor), processedAt: dateIso }],
      refunds: [],
    };
  })();

  return [discountOrder, refundOrder, cancelledOrder, multiCurrencyOrder, testOrder];
}

/** Full deterministic order set for calendar year 2025 (2 filler orders/day, 365 days) plus the five special-week orders above. Not randomised — every figure is reproducible from this function alone. */
export function buildReconFixture(): ReconOrder[] {
  const orders: ReconOrder[] = [];
  const start = Date.UTC(2025, 0, 1);
  for (let d = 0; d < 365; d++) {
    const date = new Date(start + d * 86_400_000);
    const iso = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12)).toISOString();
    orders.push(plainOrder(d, iso, 0));
    orders.push(plainOrder(d, iso, 1));
  }
  orders.push(...specialOrders());
  return orders;
}
