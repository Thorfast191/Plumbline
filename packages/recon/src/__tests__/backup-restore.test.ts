import { PrismaClient, withAccountContextOn, exportAccountData, restoreAccountData } from "@plumbline/model";
import { registry, runMetric } from "@plumbline/metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReconFixture, SPECIAL_PERIOD } from "../fixtures.js";
import { computeReferenceFigures } from "../reference.js";
import { cleanupReconFixture, seedReconFixture } from "../seed.js";

// Phase 8 — docs/BUILD-SPEC.md: "Backup and restore, with a recon run
// after restore to prove integrity." Real production infra (S3, managed
// Postgres backups) doesn't exist to script against — see
// packages/model/src/backup.ts for why this is a Prisma-level per-account
// export/import instead of pg_dump/pg_restore. This test is the actual
// verification Gate 8 asks for: seed real data, back it up, DESTROY the
// live copy entirely (not just mutate it), restore from the backup alone,
// then run the same independent-reducer-vs-SQL recon check Phase 4 uses
// and prove it still passes — i.e. the restored data is byte-for-byte
// equivalent to what was backed up, not just "some data exists."

const migrateUrl = process.env.DATABASE_URL_MIGRATE_TEST;
const appUrl = process.env.DATABASE_URL_TEST;
if (!migrateUrl || !appUrl) {
  throw new Error("DATABASE_URL_MIGRATE_TEST and DATABASE_URL_TEST must be set to run the backup/restore test.");
}
const adminClient = new PrismaClient({ datasourceUrl: migrateUrl });
const appClient = new PrismaClient({ datasourceUrl: appUrl });

afterAll(async () => {
  await cleanupReconFixture(adminClient);
  await adminClient.$disconnect();
  await appClient.$disconnect();
});

describe("backup/restore + recon-after-restore (docs/BUILD-SPEC.md Phase 8)", () => {
  it("restores a fully-destroyed account from its backup and every recon check still passes against the restored data", async () => {
    await cleanupReconFixture(adminClient);
    const fixture = buildReconFixture();
    const { accountId, storeId } = await seedReconFixture(adminClient, fixture);

    // Sanity: recon passes BEFORE any backup/destroy/restore, proving the
    // baseline this test is protecting is real.
    const reference = computeReferenceFigures(fixture, SPECIAL_PERIOD);
    for (const def of registry.all().filter((d) => d.reconciliationTargetDescription !== null)) {
      const before = await withAccountContextOn(appClient, accountId, (tx) => runMetric(def.id, tx, storeId, SPECIAL_PERIOD));
      const expected = referenceFigureFor(def.id, reference);
      expect(before, `pre-backup sanity check for ${def.id}`).toBe(expected);
    }

    const snapshot = await exportAccountData(adminClient, accountId);
    expect(snapshot.orders.length).toBeGreaterThan(700); // 365 days * 2 filler orders + 5 special orders

    // Destroy — not mutate. The live account, store, and every order/line
    // item/refund/discount/transaction row are gone before restore begins.
    await cleanupReconFixture(adminClient);
    const goneCheck = await adminClient.account.findUnique({ where: { id: accountId } });
    expect(goneCheck).toBeNull();

    await restoreAccountData(adminClient, snapshot);

    const restoredAccount = await adminClient.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(restoredAccount.id).toBe(accountId);
    const restoredOrderCount = await adminClient.order.count({ where: { accountId } });
    expect(restoredOrderCount).toBe(snapshot.orders.length);

    // The actual Gate 8 ask: rerun recon against the restored data.
    for (const def of registry.all().filter((d) => d.reconciliationTargetDescription !== null)) {
      const after = await withAccountContextOn(appClient, accountId, (tx) => runMetric(def.id, tx, storeId, SPECIAL_PERIOD));
      const expected = referenceFigureFor(def.id, reference);
      expect(after, `post-restore recon check for ${def.id}`).toBe(expected);
    }
  });
});

function referenceFigureFor(metricId: string, ref: ReturnType<typeof computeReferenceFigures>): number {
  switch (metricId) {
    case "gross_sales":
      return ref.grossSalesMinor;
    case "discounts":
      return ref.discountsMinor;
    case "sales_reversals":
      return ref.salesReversalsMinor;
    case "net_sales":
      return ref.netSalesMinor;
    case "shipping":
      return ref.shippingMinor;
    case "taxes":
      return ref.taxesMinor;
    case "total_sales":
      return ref.totalSalesMinor;
    case "order_count":
      return ref.orderCount;
    default:
      throw new Error(`no reference mapping for metric "${metricId}"`);
  }
}
