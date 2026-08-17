import type { PrismaClient } from "@plumbline/model";
import type { ReconOrder } from "./fixtures.js";

// Stable, well-known identifiers so a crashed prior run can always be
// cleaned up before a fresh one starts — recon must be repeatable, not just
// "clean if it happened to finish", per CLAUDE.md's idempotency rule
// applied here to the test harness itself.
export const RECON_FIXTURE_SHOP_DOMAIN = "recon-fixture.myshopify.com";
const RECON_FIXTURE_ACCOUNT_NAME = "Recon Fixture Account";

export interface SeededRecon {
  accountId: string;
  storeId: string;
}

/**
 * Deletes any previously seeded recon fixture data. Safe to call whether or
 * not a prior run left data behind (crash mid-run, etc). Uses `adminClient`
 * (the migrate/superuser connection, same as packages/model/prisma/seed.ts)
 * because RLS would otherwise reject reads/deletes with no account context.
 */
export async function cleanupReconFixture(adminClient: PrismaClient): Promise<void> {
  const store = await adminClient.store.findUnique({ where: { shopDomain: RECON_FIXTURE_SHOP_DOMAIN } });
  if (!store) return;

  await deleteOrdersForAccount(adminClient, store.accountId);
  await adminClient.store.deleteMany({ where: { accountId: store.accountId } });
  await adminClient.account.deleteMany({ where: { id: store.accountId } });
}

/**
 * Deletes every order (and its dependent rows) for one account, leaving the
 * account/store themselves intact. Shared by cleanupReconFixture (which
 * additionally drops the throwaway account/store) and
 * scripts/seed-demo-data.ts (which reseeds the persistent seed store and
 * must not delete it).
 */
export async function deleteOrdersForAccount(adminClient: PrismaClient, accountId: string): Promise<void> {
  await adminClient.refundLineItem.deleteMany({ where: { accountId } });
  await adminClient.refund.deleteMany({ where: { accountId } });
  await adminClient.transaction.deleteMany({ where: { accountId } });
  await adminClient.discount.deleteMany({ where: { accountId } });
  await adminClient.orderLineItem.deleteMany({ where: { accountId } });
  await adminClient.order.deleteMany({ where: { accountId } });
}

/**
 * Seeds packages/recon/src/fixtures.ts's deterministic order set into one
 * throwaway account/store. Field-for-field mapping from ReconOrder onto the
 * real canonical schema (packages/model/prisma/schema.prisma) — money
 * fields are already integer minor units in the fixture, so this is a
 * rename, not a conversion.
 */
export async function seedReconFixture(adminClient: PrismaClient, orders: ReconOrder[]): Promise<SeededRecon> {
  const account = await adminClient.account.create({ data: { name: RECON_FIXTURE_ACCOUNT_NAME } });
  const store = await adminClient.store.create({
    data: {
      accountId: account.id,
      shopDomain: RECON_FIXTURE_SHOP_DOMAIN,
      // UTC on purpose: fixtures.ts's periods are UTC-boundary Date objects
      // and reference.ts compares raw ISO timestamps with no timezone
      // conversion. Using a non-UTC store timezone here would silently
      // introduce a day-boundary mismatch between the SQL path (which would
      // need store-timezone-aware bucketing to be correct) and the
      // reference reducer (which has none) — that's a real gap, not
      // something to paper over. Store-timezone-aware aggregation is
      // deferred to Phase 6 per CLAUDE.md's per-layer timezone rule; this
      // recon suite proves the two code paths agree on UTC boundaries.
      shopCurrency: "USD",
      shopTimezone: "UTC",
      installedAt: new Date(),
    },
  });

  await insertOrdersForStore(adminClient, account.id, store.id, orders);

  return { accountId: account.id, storeId: store.id };
}

/**
 * Field-for-field mapping from ReconOrder onto the real canonical schema,
 * for an already-existing account/store. Split out from seedReconFixture so
 * apps/web's demo-data seed (scripts/seed-demo-data.ts) can reuse the same
 * mapping against the persistent seed store instead of duplicating it —
 * there is exactly one place that knows how a ReconOrder becomes real rows.
 */
export async function insertOrdersForStore(
  adminClient: PrismaClient,
  accountId: string,
  storeId: string,
  orders: ReconOrder[]
): Promise<void> {
  const account = { id: accountId };
  const store = { id: storeId };

  const orderRows = orders.map((o) => ({
    id: o.id,
    accountId: account.id,
    storeId: store.id,
    shopifyOrderId: o.id,
    createdAt: new Date(o.createdAt),
    processedAt: new Date(o.processedAt),
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    test: o.test,
    currencyCode: o.currencyCode,
    presentmentCurrencyCode: o.presentmentCurrencyCode,
    grossSalesMinor: o.grossSalesMinor,
    discountsMinor: o.discountsMinor,
    shippingMinor: o.shippingMinor,
    taxesMinor: o.taxesMinor,
    currentSubtotalMinor: o.currentSubtotalMinor,
    currentTotalMinor: o.currentTotalMinor,
    displayFinancialStatus: o.displayFinancialStatus,
    displayFulfillmentStatus: o.displayFulfillmentStatus,
    source: "backfill",
  }));

  const lineItemRows = orders.flatMap((o) =>
    o.lineItems.map((li) => ({
      id: li.id,
      accountId: account.id,
      orderId: o.id,
      shopifyLineItemId: li.id,
      quantity: li.quantity,
      priceMinor: li.priceMinor,
      discountMinor: 0,
      currencyCode: o.currencyCode,
    }))
  );

  const discountRows = orders.flatMap((o) =>
    o.discounts.map((d) => ({
      id: d.id,
      accountId: account.id,
      orderId: o.id,
      applicationType: d.applicationType,
      code: d.code,
      amountMinor: d.amountMinor,
      currencyCode: o.currencyCode,
    }))
  );

  const transactionRows = orders.flatMap((o) =>
    o.transactions.map((t) => ({
      id: t.id,
      accountId: account.id,
      storeId: store.id,
      orderId: o.id,
      shopifyTransactionId: t.id,
      kind: t.kind,
      status: "success",
      amountMinor: t.amountMinor,
      feeMinor: t.feeMinor,
      currencyCode: o.currencyCode,
      processedAt: new Date(t.processedAt),
    }))
  );

  const refundRows = orders.flatMap((o) =>
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
      currencyCode: o.currencyCode,
    }))
  );

  const refundLineItemRows = orders.flatMap((o) =>
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
  );

  // Dependency order: children after parents (FK constraints).
  await adminClient.order.createMany({ data: orderRows });
  await adminClient.orderLineItem.createMany({ data: lineItemRows });
  await adminClient.discount.createMany({ data: discountRows });
  await adminClient.transaction.createMany({ data: transactionRows });
  await adminClient.refund.createMany({ data: refundRows });
  await adminClient.refundLineItem.createMany({ data: refundLineItemRows });
}
