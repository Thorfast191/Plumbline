import { withAccountContext, type TenantClient } from "@plumbline/model";

export interface SyncStateStatus {
  resource: string;
  kind: string;
  cursor: string | null;
  watermarkAt: Date | null;
  status: string;
  updatedAt: Date;
}

export interface StoreSyncStatus {
  storeId: string;
  states: SyncStateStatus[];
  correctionsLast24h: number;
}

/** Per-store sync status: last successful sync, cursor/watermark, and recent repair-loop activity (docs/BUILD-SPEC.md Phase 3). */
export async function getSyncStatus(accountId: string, storeId: string): Promise<StoreSyncStatus> {
  return withAccountContext(accountId, async (tx: TenantClient) => {
    const [states, correctionsLast24h] = await Promise.all([
      tx.syncState.findMany({ where: { storeId }, orderBy: { resource: "asc" } }),
      tx.syncCorrection.count({
        where: { storeId, detectedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);

    return {
      storeId,
      states: states.map((s) => ({
        resource: s.resource,
        kind: s.kind,
        cursor: s.cursor,
        watermarkAt: s.watermarkAt,
        status: s.status,
        updatedAt: s.updatedAt,
      })),
      correctionsLast24h,
    };
  });
}
