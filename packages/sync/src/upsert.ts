import type { TenantClient } from "@plumbline/model";
import type { OrderBundle, SyncSource } from "./types.js";

export interface UpsertResult {
  applied: boolean; // false when skipped by last-write-wins (an older update arrived after a newer one)
  correctedFields: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
}

const TRACKED_FIELDS = [
  "displayFinancialStatus",
  "displayFulfillmentStatus",
  "currentSubtotalMinor",
  "currentTotalMinor",
  "cancelledAt",
] as const;

function fieldValueAsString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * The single convergence point for backfill/incremental/webhook/repair
 * (docs/PLAN.md §10). Idempotent: re-running with the same bundle produces
 * the same final row set, never duplicates, because every write is keyed on
 * the Shopify natural id, not an auto-increment insert.
 *
 * Last-write-wins by `updatedAt`: if the stored order's `shopifyUpdatedAt` is
 * already >= the incoming bundle's `updatedAt`, the write is skipped rather
 * than blindly overwritten — this is what gives out-of-order webhook
 * tolerance (docs/BUILD-SPEC.md Phase 3).
 */
export async function upsertOrderBundle(
  tx: TenantClient,
  params: { accountId: string; storeId: string; source: SyncSource; bundle: OrderBundle }
): Promise<UpsertResult> {
  const { accountId, storeId, source, bundle } = params;

  const existing = await tx.order.findUnique({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: bundle.id } },
  });

  if (existing?.shopifyUpdatedAt && new Date(bundle.updatedAt) < existing.shopifyUpdatedAt) {
    return { applied: false, correctedFields: [] };
  }

  const correctedFields: UpsertResult["correctedFields"] = [];
  if (existing) {
    for (const field of TRACKED_FIELDS) {
      const oldValue = fieldValueAsString(existing[field]);
      const newValue = fieldValueAsString(
        field === "cancelledAt" ? bundle.cancelledAt : (bundle as unknown as Record<string, unknown>)[field]
      );
      if (oldValue !== newValue) correctedFields.push({ field, oldValue, newValue });
    }
  }

  const orderData = {
    accountId,
    storeId,
    shopifyOrderId: bundle.id,
    createdAt: new Date(bundle.createdAt),
    processedAt: new Date(bundle.processedAt),
    cancelledAt: bundle.cancelledAt ? new Date(bundle.cancelledAt) : null,
    closedAt: bundle.closedAt ? new Date(bundle.closedAt) : null,
    test: bundle.test,
    currencyCode: bundle.currencyCode,
    presentmentCurrencyCode: bundle.presentmentCurrencyCode,
    grossSalesMinor: bundle.grossSalesMinor,
    discountsMinor: bundle.discountsMinor,
    shippingMinor: bundle.shippingMinor,
    taxesMinor: bundle.taxesMinor,
    currentSubtotalMinor: bundle.currentSubtotalMinor,
    currentTotalMinor: bundle.currentTotalMinor,
    displayFinancialStatus: bundle.displayFinancialStatus,
    displayFulfillmentStatus: bundle.displayFulfillmentStatus,
    shopifyUpdatedAt: new Date(bundle.updatedAt),
    source,
  };

  const order = await tx.order.upsert({
    where: { storeId_shopifyOrderId: { storeId, shopifyOrderId: bundle.id } },
    create: orderData,
    update: orderData,
  });

  const lineItemIdByShopifyId = new Map<string, string>();
  for (const li of bundle.lineItems) {
    const row = await tx.orderLineItem.upsert({
      where: { orderId_shopifyLineItemId: { orderId: order.id, shopifyLineItemId: li.id } },
      create: {
        accountId,
        orderId: order.id,
        shopifyLineItemId: li.id,
        productId: li.productId,
        variantId: li.variantId,
        sku: li.sku,
        quantity: li.quantity,
        priceMinor: li.priceMinor,
        discountMinor: li.discountMinor,
        currencyCode: li.currencyCode,
      },
      update: {
        productId: li.productId,
        variantId: li.variantId,
        sku: li.sku,
        quantity: li.quantity,
        priceMinor: li.priceMinor,
        discountMinor: li.discountMinor,
        currencyCode: li.currencyCode,
      },
    });
    lineItemIdByShopifyId.set(li.id, row.id);
  }

  // Discount rows have no Shopify natural id in the canonical schema
  // (docs/PLAN.md §9) — delete+recreate per order is idempotent (same final
  // state on re-run) even though it isn't a keyed upsert.
  await tx.discount.deleteMany({ where: { orderId: order.id } });
  if (bundle.discounts.length > 0) {
    await tx.discount.createMany({
      data: bundle.discounts.map((d) => ({
        accountId,
        orderId: order.id,
        applicationType: d.applicationType,
        code: d.code,
        amountMinor: d.amountMinor,
        currencyCode: d.currencyCode,
      })),
    });
  }

  for (const t of bundle.transactions) {
    await tx.transaction.upsert({
      where: { storeId_shopifyTransactionId: { storeId, shopifyTransactionId: t.id } },
      create: {
        accountId,
        storeId,
        orderId: order.id,
        shopifyTransactionId: t.id,
        kind: t.kind,
        status: t.status,
        amountMinor: t.amountMinor,
        feeMinor: t.feeMinor,
        currencyCode: t.currencyCode,
        processedAt: new Date(t.processedAt),
      },
      update: {
        kind: t.kind,
        status: t.status,
        amountMinor: t.amountMinor,
        feeMinor: t.feeMinor,
        currencyCode: t.currencyCode,
        processedAt: new Date(t.processedAt),
      },
    });
  }

  for (const r of bundle.refunds) {
    const refundRow = await tx.refund.upsert({
      where: { storeId_shopifyRefundId: { storeId, shopifyRefundId: r.id } },
      create: {
        accountId,
        storeId,
        orderId: order.id,
        shopifyRefundId: r.id,
        processedAt: new Date(r.processedAt),
        amountMinor: r.amountMinor,
        shippingRefundMinor: r.shippingRefundMinor,
        taxRefundMinor: r.taxRefundMinor,
        currencyCode: r.currencyCode,
      },
      update: {
        processedAt: new Date(r.processedAt),
        amountMinor: r.amountMinor,
        shippingRefundMinor: r.shippingRefundMinor,
        taxRefundMinor: r.taxRefundMinor,
        currencyCode: r.currencyCode,
      },
    });

    await tx.refundLineItem.deleteMany({ where: { refundId: refundRow.id } });
    if (r.lineItems.length > 0) {
      await tx.refundLineItem.createMany({
        data: r.lineItems.map((rli) => {
          const orderLineItemId = lineItemIdByShopifyId.get(rli.orderLineItemId);
          if (!orderLineItemId) {
            throw new Error(
              `RefundLineItem ${rli.id} references line item ${rli.orderLineItemId}, which was not present in this bundle's lineItems`
            );
          }
          return {
            accountId,
            refundId: refundRow.id,
            orderLineItemId,
            quantity: rli.quantity,
            amountMinor: rli.amountMinor,
          };
        }),
      });
    }
  }

  return { applied: true, correctedFields };
}
