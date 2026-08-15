// The normalised shape every sync path (backfill/incremental/webhook/repair)
// converges on before handing off to upsert.ts — this convergence is what
// makes double-counting avoidance a property of the upsert key rather than
// of coordinating which path runs when (docs/PLAN.md §10).

export interface OrderBundle {
  id: string; // Shopify gid — the natural key
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
  lineItems: LineItemBundle[];
  discounts: DiscountBundle[];
  transactions: TransactionBundle[];
  refunds: RefundBundle[];
}

export interface LineItemBundle {
  id: string;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  quantity: number;
  priceMinor: number;
  discountMinor: number;
  currencyCode: string;
}

export interface DiscountBundle {
  id: string;
  applicationType: string;
  code: string | null;
  amountMinor: number;
  currencyCode: string;
}

export interface TransactionBundle {
  id: string;
  kind: string;
  status: string;
  amountMinor: number;
  feeMinor: number | null;
  currencyCode: string;
  processedAt: string;
}

export interface RefundBundle {
  id: string;
  processedAt: string;
  amountMinor: number;
  shippingRefundMinor: number;
  taxRefundMinor: number;
  currencyCode: string;
  lineItems: RefundLineItemBundle[];
}

export interface RefundLineItemBundle {
  id: string;
  orderLineItemId: string;
  quantity: number;
  amountMinor: number;
}

export type SyncSource = "backfill" | "incremental" | "webhook" | "repair";
