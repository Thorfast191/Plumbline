import type { PrismaClient } from "@plumbline/model";
import { buildPhase5Orders, saleFeeFor, PHASE5_CUSTOMERS, COGS_FIXTURE, SHIPPING_COST_FIXTURE, AD_SPEND_FIXTURE } from "./phase5-fixtures.js";

export const PHASE5_FIXTURE_SHOP_DOMAIN = "phase5-fixture.myshopify.com";
const PHASE5_FIXTURE_ACCOUNT_NAME = "Phase 5 Fixture Account";

export interface SeededPhase5 {
  accountId: string;
  storeId: string;
}

export async function cleanupPhase5Fixture(adminClient: PrismaClient): Promise<void> {
  const store = await adminClient.store.findUnique({ where: { shopDomain: PHASE5_FIXTURE_SHOP_DOMAIN } });
  if (!store) return;

  await adminClient.enrichShippingCost.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.enrichAdSpend.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.enrichCogs.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.refundLineItem.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.refund.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.transaction.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.orderLineItem.deleteMany({ where: { accountId: store.accountId } });
  // Break the customers.first_order_id -> orders cycle before deleting either side.
  await adminClient.customer.updateMany({ where: { accountId: store.accountId }, data: { firstOrderId: null } });
  await adminClient.order.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.customer.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.store.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.account.deleteMany({ where: { id: store.accountId } });
}

export async function seedPhase5Fixture(adminClient: PrismaClient): Promise<SeededPhase5> {
  const orders = buildPhase5Orders();

  const account = await adminClient.account.create({ data: { name: PHASE5_FIXTURE_ACCOUNT_NAME } });
  const store = await adminClient.store.create({
    data: {
      accountId: account.id,
      shopDomain: PHASE5_FIXTURE_SHOP_DOMAIN,
      shopCurrency: "USD",
      shopTimezone: "UTC",
      installedAt: new Date(),
    },
  });

  await adminClient.customer.createMany({
    data: PHASE5_CUSTOMERS.map((c) => ({
      id: c.id,
      accountId: account.id,
      storeId: store.id,
      shopifyCustomerId: c.shopifyCustomerId,
      // Set from each customer's earliest order below, after orders exist.
      createdAt: new Date(),
      currencyCode: "USD",
    })),
  });

  await adminClient.order.createMany({
    data: orders.map((o) => ({
      id: o.id,
      accountId: account.id,
      storeId: store.id,
      shopifyOrderId: o.id,
      customerId: o.customerId,
      createdAt: new Date(o.createdAt),
      processedAt: new Date(o.createdAt),
      test: false,
      currencyCode: "USD",
      presentmentCurrencyCode: "USD",
      grossSalesMinor: o.grossSalesMinor,
      discountsMinor: o.discountsMinor,
      shippingMinor: o.shippingMinor,
      taxesMinor: o.taxesMinor,
      currentSubtotalMinor: o.currentSubtotalMinor,
      currentTotalMinor: o.currentTotalMinor,
      displayFinancialStatus: o.refunds.length > 0 ? "PARTIALLY_REFUNDED" : "PAID",
      displayFulfillmentStatus: "FULFILLED",
      source: "backfill",
      sourceName: o.sourceName,
      referrerChannel: o.referrerChannel,
    })),
  });

  await adminClient.orderLineItem.createMany({
    data: orders.flatMap((o) =>
      o.lineItems.map((li) => ({
        id: li.id,
        accountId: account.id,
        orderId: o.id,
        shopifyLineItemId: li.id,
        sku: li.sku,
        quantity: li.quantity,
        priceMinor: li.priceMinor,
        discountMinor: 0,
        currencyCode: "USD",
      }))
    ),
  });

  await adminClient.transaction.createMany({
    data: orders.map((o) => ({
      id: `${o.id}-tx-sale`,
      accountId: account.id,
      storeId: store.id,
      orderId: o.id,
      shopifyTransactionId: `${o.id}-tx-sale`,
      kind: "sale",
      status: "success",
      amountMinor: o.currentTotalMinor,
      feeMinor: saleFeeFor(o),
      currencyCode: "USD",
      processedAt: new Date(o.createdAt),
    })),
  });

  const refundOrders = orders.filter((o) => o.refunds.length > 0);
  await adminClient.refund.createMany({
    data: refundOrders.flatMap((o) =>
      o.refunds.map((r) => ({
        id: r.id,
        accountId: account.id,
        storeId: store.id,
        orderId: o.id,
        shopifyRefundId: r.id,
        processedAt: new Date(r.processedAt),
        amountMinor: r.amountMinor,
        shippingRefundMinor: r.shippingRefundMinor,
        taxRefundMinor: r.taxRefundMinor,
        currencyCode: "USD",
      }))
    ),
  });
  await adminClient.refundLineItem.createMany({
    data: refundOrders.flatMap((o) =>
      o.refunds.flatMap((r) =>
        r.lineItems.map((rli) => ({
          id: rli.id,
          accountId: account.id,
          refundId: r.id,
          orderLineItemId: rli.orderLineItemId,
          quantity: rli.quantity,
          amountMinor: rli.amountMinor,
        }))
      )
    ),
  });

  // Backfill each customer's createdAt / firstOrderId from their earliest order now that orders exist.
  const ordersByCustomer = new Map<string, typeof orders>();
  for (const o of orders) {
    const list = ordersByCustomer.get(o.customerId) ?? [];
    list.push(o);
    ordersByCustomer.set(o.customerId, list);
  }
  for (const [customerId, custOrders] of ordersByCustomer) {
    const first = [...custOrders].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
    await adminClient.customer.update({
      where: { id: customerId },
      data: { createdAt: new Date(first.createdAt), firstOrderId: first.id },
    });
  }

  await adminClient.enrichCogs.createMany({
    data: COGS_FIXTURE.map((c, i) => ({
      id: `p5-cogs-${i}`,
      accountId: account.id,
      storeId: store.id,
      sku: c.sku,
      costMinor: c.costMinor,
      currencyCode: c.currencyCode,
      effectiveFrom: new Date(c.effectiveFrom),
      source: "csv_upload",
    })),
  });

  await adminClient.enrichShippingCost.createMany({
    data: SHIPPING_COST_FIXTURE.map((s, i) => ({
      id: `p5-ship-${i}`,
      accountId: account.id,
      storeId: store.id,
      costMinor: s.costMinor,
      currencyCode: s.currencyCode,
      effectiveFrom: new Date(s.effectiveFrom),
      source: "csv_upload",
    })),
  });

  await adminClient.enrichAdSpend.createMany({
    data: AD_SPEND_FIXTURE.map((a, i) => ({
      id: `p5-adspend-${i}`,
      accountId: account.id,
      storeId: store.id,
      channel: a.channel,
      date: new Date(a.date),
      spendMinor: a.spendMinor,
      currencyCode: a.currencyCode,
      source: "csv_upload",
    })),
  });

  return { accountId: account.id, storeId: store.id };
}
