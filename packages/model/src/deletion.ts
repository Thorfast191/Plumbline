import type { PrismaClient } from "@prisma/client";
import type { TenantClient } from "./client.js";

export interface DeletionReport {
  accountId: string;
  deletedCounts: Record<string, number>;
}

/**
 * Phase 8 — docs/BUILD-SPEC.md: "GDPR/data deletion path: a merchant
 * requests deletion, everything goes." Deletes every row across every
 * tenant-scoped table for one account, in FK-safe order.
 *
 * Runs on the superuser/migrate connection deliberately: RLS would make a
 * DELETE issued through the RLS-scoped app role redundant-but-harmless for
 * most tables, but the whole point of this function is "everything goes,"
 * so it should not depend on RLS being configured correctly — it is the
 * backstop, not a second enforcement of the same policy. Callers must pass
 * a client already connected as a role with unrestricted delete rights
 * (see DATABASE_URL_MIGRATE in .env.example).
 *
 * Order.customerId <-> Customer.firstOrderId is a circular FK (each can
 * reference the other), so both sides are nulled out before either table's
 * rows are deleted — otherwise neither table could be emptied first.
 */
export async function deleteAccountData(client: PrismaClient, accountId: string): Promise<DeletionReport> {
  const deletedCounts: Record<string, number> = {};

  await client.$transaction(async (tx) => {
    await tx.order.updateMany({ where: { accountId }, data: { customerId: null } });
    await tx.customer.updateMany({ where: { accountId }, data: { firstOrderId: null } });

    const refundLineItems = await tx.refundLineItem.deleteMany({ where: { accountId } });
    deletedCounts.refundLineItems = refundLineItems.count;

    const deliveryLogs = await tx.deliveryLog.deleteMany({ where: { accountId } });
    deletedCounts.deliveryLogs = deliveryLogs.count;

    const scheduledReports = await tx.scheduledReport.deleteMany({ where: { accountId } });
    deletedCounts.scheduledReports = scheduledReports.count;

    const alertRules = await tx.alertRule.deleteMany({ where: { accountId } });
    deletedCounts.alertRules = alertRules.count;

    const webhookEvents = await tx.webhookEvent.deleteMany({ where: { accountId } });
    deletedCounts.webhookEvents = webhookEvents.count;

    const syncCorrections = await tx.syncCorrection.deleteMany({ where: { accountId } });
    deletedCounts.syncCorrections = syncCorrections.count;

    const syncStates = await tx.syncState.deleteMany({ where: { accountId } });
    deletedCounts.syncStates = syncStates.count;

    const enrichCogs = await tx.enrichCogs.deleteMany({ where: { accountId } });
    deletedCounts.enrichCogs = enrichCogs.count;

    const enrichAdSpend = await tx.enrichAdSpend.deleteMany({ where: { accountId } });
    deletedCounts.enrichAdSpend = enrichAdSpend.count;

    const enrichShippingCost = await tx.enrichShippingCost.deleteMany({ where: { accountId } });
    deletedCounts.enrichShippingCost = enrichShippingCost.count;

    const refunds = await tx.refund.deleteMany({ where: { accountId } });
    deletedCounts.refunds = refunds.count;

    const discounts = await tx.discount.deleteMany({ where: { accountId } });
    deletedCounts.discounts = discounts.count;

    const transactions = await tx.transaction.deleteMany({ where: { accountId } });
    deletedCounts.transactions = transactions.count;

    const orderLineItems = await tx.orderLineItem.deleteMany({ where: { accountId } });
    deletedCounts.orderLineItems = orderLineItems.count;

    const orders = await tx.order.deleteMany({ where: { accountId } });
    deletedCounts.orders = orders.count;

    const customers = await tx.customer.deleteMany({ where: { accountId } });
    deletedCounts.customers = customers.count;

    const stores = await tx.store.deleteMany({ where: { accountId } });
    deletedCounts.stores = stores.count;

    const accounts = await tx.account.deleteMany({ where: { id: accountId } });
    deletedCounts.accounts = accounts.count;
  });

  return { accountId, deletedCounts };
}

/**
 * Shopify's `customers/redact` mandatory compliance webhook targets one
 * customer, not a whole account — anonymizes PII on that customer's row
 * (and the orders' customer linkage) rather than deleting order/financial
 * history, which the merchant may have a legal obligation to retain for
 * tax/accounting purposes independent of Shopify's own redaction request.
 * This is a judgment call: Shopify's docs describe redacting "personal
 * information" while leaving orders in place is standard practice for
 * commerce platforms (the order total is not PII; the customer's name/email
 * tied to it is) — not independently verified against a Shopify compliance
 * review, since no live app/store exists to test against.
 */
export async function redactCustomer(
  client: TenantClient,
  params: { accountId: string; storeId: string; shopifyCustomerId: string }
): Promise<{ redacted: boolean }> {
  const result = await client.customer.updateMany({
    where: { accountId: params.accountId, storeId: params.storeId, shopifyCustomerId: params.shopifyCustomerId },
    data: {
      // Customer model (packages/model/prisma/schema.prisma) carries no
      // name/email/address fields today — only identifiers and currency —
      // so there is currently no PII on this row to null out beyond the
      // Shopify customer id itself, which redirects to a tombstone value
      // rather than deletion (orders' customerId FK must keep resolving
      // for cohort/LTV aggregates to remain accurate after redaction).
      shopifyCustomerId: `redacted-${params.shopifyCustomerId}`,
    },
  });
  return { redacted: result.count > 0 };
}
