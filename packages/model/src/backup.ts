import type { PrismaClient } from "@prisma/client";

// Phase 8 — docs/BUILD-SPEC.md: "Backup and restore, with a recon run
// after restore to prove integrity." No production infra (S3, a managed
// Postgres backup product) exists to script against, and `pg_dump`/
// `pg_restore` are not guaranteed to be on PATH in every deploy target —
// this is a Prisma-level, portable export/import of every tenant-scoped
// row for one account, serializable to plain JSON. Real production
// backup/restore would layer actual Postgres-native backups (WAL archiving,
// `pg_dump`) underneath this for whole-database disaster recovery — this
// covers the per-account unit CLAUDE.md's GDPR/tenant-scoped rules already
// treat as the meaningful boundary (see deleteAccountData), and is
// end-to-end provable without any infra beyond the DB itself.

export interface AccountBackupSnapshot {
  account: Record<string, unknown>;
  stores: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  orderLineItems: Record<string, unknown>[];
  refunds: Record<string, unknown>[];
  refundLineItems: Record<string, unknown>[];
  discounts: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  webhookEvents: Record<string, unknown>[];
  syncStates: Record<string, unknown>[];
  syncCorrections: Record<string, unknown>[];
  enrichCogs: Record<string, unknown>[];
  enrichAdSpend: Record<string, unknown>[];
  enrichShippingCost: Record<string, unknown>[];
  scheduledReports: Record<string, unknown>[];
  alertRules: Record<string, unknown>[];
  deliveryLogs: Record<string, unknown>[];
  capturedAt: string;
}

/**
 * Reads every tenant-scoped row for one account. Callers must pass a
 * client with unrestricted read access (see packages/model/src/client.ts's
 * migratePrisma) — a real backup must not depend on RLS being configured
 * correctly, same reasoning as deleteAccountData.
 */
export async function exportAccountData(client: PrismaClient, accountId: string): Promise<AccountBackupSnapshot> {
  const [
    account, stores, orders, orderLineItems, refunds, refundLineItems, discounts, transactions,
    customers, webhookEvents, syncStates, syncCorrections, enrichCogs, enrichAdSpend, enrichShippingCost,
    scheduledReports, alertRules, deliveryLogs,
  ] = await Promise.all([
    client.account.findUniqueOrThrow({ where: { id: accountId } }),
    client.store.findMany({ where: { accountId } }),
    client.order.findMany({ where: { accountId } }),
    client.orderLineItem.findMany({ where: { accountId } }),
    client.refund.findMany({ where: { accountId } }),
    client.refundLineItem.findMany({ where: { accountId } }),
    client.discount.findMany({ where: { accountId } }),
    client.transaction.findMany({ where: { accountId } }),
    client.customer.findMany({ where: { accountId } }),
    client.webhookEvent.findMany({ where: { accountId } }),
    client.syncState.findMany({ where: { accountId } }),
    client.syncCorrection.findMany({ where: { accountId } }),
    client.enrichCogs.findMany({ where: { accountId } }),
    client.enrichAdSpend.findMany({ where: { accountId } }),
    client.enrichShippingCost.findMany({ where: { accountId } }),
    client.scheduledReport.findMany({ where: { accountId } }),
    client.alertRule.findMany({ where: { accountId } }),
    client.deliveryLog.findMany({ where: { accountId } }),
  ]);

  return {
    account, stores, orders, orderLineItems, refunds, refundLineItems, discounts, transactions,
    customers, webhookEvents, syncStates, syncCorrections, enrichCogs, enrichAdSpend, enrichShippingCost,
    scheduledReports, alertRules, deliveryLogs,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Recreates every row from a snapshot, preserving original ids (so foreign
 * keys captured in the snapshot still resolve) — this is a restore-into-an-
 * empty-space operation, not a merge; the account must not already exist.
 * Order.customerId is nulled on insert and reattached in a second pass,
 * mirroring deleteAccountData's handling of the same circular FK.
 */
export async function restoreAccountData(client: PrismaClient, snapshot: AccountBackupSnapshot): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.account.create({ data: snapshot.account as never });
    if (snapshot.stores.length > 0) await tx.store.createMany({ data: snapshot.stores as never[] });

    const ordersWithoutCustomer = snapshot.orders.map((o) => ({ ...o, customerId: null }));
    if (ordersWithoutCustomer.length > 0) await tx.order.createMany({ data: ordersWithoutCustomer as never[] });
    if (snapshot.customers.length > 0) await tx.customer.createMany({ data: snapshot.customers as never[] });

    // Reattach Order.customerId now that both sides exist.
    for (const order of snapshot.orders) {
      if (order.customerId) {
        await tx.order.update({ where: { id: order.id as string }, data: { customerId: order.customerId as string } });
      }
    }

    if (snapshot.orderLineItems.length > 0) await tx.orderLineItem.createMany({ data: snapshot.orderLineItems as never[] });
    if (snapshot.discounts.length > 0) await tx.discount.createMany({ data: snapshot.discounts as never[] });
    if (snapshot.transactions.length > 0) await tx.transaction.createMany({ data: snapshot.transactions as never[] });
    if (snapshot.refunds.length > 0) await tx.refund.createMany({ data: snapshot.refunds as never[] });
    if (snapshot.refundLineItems.length > 0) await tx.refundLineItem.createMany({ data: snapshot.refundLineItems as never[] });
    if (snapshot.webhookEvents.length > 0) await tx.webhookEvent.createMany({ data: snapshot.webhookEvents as never[] });
    if (snapshot.syncStates.length > 0) await tx.syncState.createMany({ data: snapshot.syncStates as never[] });
    if (snapshot.syncCorrections.length > 0) await tx.syncCorrection.createMany({ data: snapshot.syncCorrections as never[] });
    if (snapshot.enrichCogs.length > 0) await tx.enrichCogs.createMany({ data: snapshot.enrichCogs as never[] });
    if (snapshot.enrichAdSpend.length > 0) await tx.enrichAdSpend.createMany({ data: snapshot.enrichAdSpend as never[] });
    if (snapshot.enrichShippingCost.length > 0) await tx.enrichShippingCost.createMany({ data: snapshot.enrichShippingCost as never[] });
    if (snapshot.scheduledReports.length > 0) await tx.scheduledReport.createMany({ data: snapshot.scheduledReports as never[] });
    if (snapshot.alertRules.length > 0) await tx.alertRule.createMany({ data: snapshot.alertRules as never[] });
    if (snapshot.deliveryLogs.length > 0) await tx.deliveryLog.createMany({ data: snapshot.deliveryLogs as never[] });
  });
}
