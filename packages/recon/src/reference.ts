import type { ReconOrder } from "./fixtures.js";

export interface Period {
  from: Date;
  to: Date; // exclusive
}

export interface ReferenceFigures {
  grossSalesMinor: number;
  discountsMinor: number;
  salesReversalsMinor: number;
  netSalesMinor: number;
  shippingMinor: number;
  taxesMinor: number;
  totalSalesMinor: number;
  orderCount: number;
}

function inPeriod(iso: string, period: Period): boolean {
  const t = new Date(iso).getTime();
  return t >= period.from.getTime() && t < period.to.getTime();
}

/**
 * Independent of packages/metrics' SQL: this walks the raw synthetic source
 * records directly (not the normalised DB) and implements Shopify's own
 * verbatim Finance-report formulas from docs/PLAN.md §7 in plain TypeScript.
 * Two genuinely separate implementations (SQL over synced tables vs. this
 * reducer over pre-sync source data) agreeing is what makes a recon check
 * meaningful rather than circular.
 *
 * Real Shopify-admin figures remain unverified (docs/PLAN.md Risk #1/§13) —
 * this is the reference figure until live credentials exist.
 */
export function computeReferenceFigures(orders: ReconOrder[], period: Period): ReferenceFigures {
  let grossSalesMinor = 0;
  let discountsMinor = 0;
  let shippingSaleSideMinor = 0;
  let taxesSaleSideMinor = 0;
  let feesMinor = 0;
  let orderCount = 0;

  for (const order of orders) {
    if (order.test) continue; // test orders excluded from every figure, per docs/PLAN.md §8
    if (order.cancelledAt !== null) continue; // no revenue realized on a voided order — see docs/BUILD-SPEC.md Section 0 assumption note

    if (inPeriod(order.createdAt, period)) {
      grossSalesMinor += order.grossSalesMinor;
      discountsMinor += order.discountsMinor;
      shippingSaleSideMinor += order.shippingMinor;
      taxesSaleSideMinor += order.taxesMinor;
      orderCount += 1;
    }

    for (const tx of order.transactions) {
      if (tx.kind === "sale" && tx.feeMinor !== null && inPeriod(tx.processedAt, period)) {
        feesMinor += tx.feeMinor;
      }
    }
  }

  let salesReversalsMinor = 0;
  let shippingRefundSideMinor = 0;
  let taxRefundSideMinor = 0;
  for (const order of orders) {
    if (order.test) continue;
    for (const refund of order.refunds) {
      if (!inPeriod(refund.processedAt, period)) continue;
      salesReversalsMinor += refund.amountMinor; // goods only — shipping/tax refunds tracked separately, per §7
      shippingRefundSideMinor += refund.shippingRefundMinor;
      taxRefundSideMinor += refund.taxRefundMinor;
    }
  }

  const shippingMinor = shippingSaleSideMinor - shippingRefundSideMinor;
  const taxesMinor = taxesSaleSideMinor - taxRefundSideMinor;
  const netSalesMinor = grossSalesMinor - discountsMinor - salesReversalsMinor;
  const totalSalesMinor = grossSalesMinor - discountsMinor - salesReversalsMinor + taxesMinor + shippingMinor + feesMinor;

  return {
    grossSalesMinor,
    discountsMinor,
    salesReversalsMinor,
    netSalesMinor,
    shippingMinor,
    taxesMinor,
    totalSalesMinor,
    orderCount,
  };
}
