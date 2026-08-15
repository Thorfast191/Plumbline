import type { ShopifyConnector } from "@plumbline/connector";
import { withAccountContext, type TenantClient } from "@plumbline/model";
import { upsertOrderBundle } from "./upsert.js";
import type { OrderBundle, SyncSource } from "./types.js";

interface OrdersQueryResponse {
  orders: { edges: Array<{ node: OrderBundle }>; pageInfo: { hasNextPage: boolean } };
}

function buildIncrementalQuery(sinceISO: string): string {
  return `{ orders(first: 250, query: "updated_at:>=${sinceISO}") { edges { node { id updatedAt } } pageInfo { hasNextPage } } }`;
}

/**
 * Shared by incremental sync and the repair loop — both are "fetch what
 * changed since X, upsert through the same convergence point as backfill"
 * (docs/PLAN.md §10). Self-paced via the connector's CostAwareRateLimiter
 * (already proven in Phase 2), never a fixed sleep.
 */
export async function fetchChangedOrders(
  connector: ShopifyConnector,
  sinceISO: string
): Promise<OrderBundle[]> {
  const result = await connector.graphql<OrdersQueryResponse>(buildIncrementalQuery(sinceISO));
  return result.data.orders.edges.map((e) => e.node);
}

export interface RunIncrementalSyncParams {
  connector: ShopifyConnector;
  accountId: string;
  storeId: string;
  resource: "orders";
}

export interface IncrementalSyncResult {
  ordersFetched: number;
  ordersUpserted: number;
  ordersSkippedByLastWriteWins: number;
}

export async function runIncrementalSync(params: RunIncrementalSyncParams): Promise<IncrementalSyncResult> {
  const watermark = await withAccountContext(params.accountId, async (tx: TenantClient) => {
    const row = await tx.syncState.findUnique({
      where: { storeId_resource_kind: { storeId: params.storeId, resource: params.resource, kind: "incremental" } },
    });
    return row?.watermarkAt ?? new Date(0);
  });

  const orders = await fetchChangedOrders(params.connector, watermark.toISOString());

  let upserted = 0;
  let skipped = 0;
  for (const bundle of orders) {
    await withAccountContext(params.accountId, async (tx: TenantClient) => {
      const result = await upsertOrderBundle(tx, {
        accountId: params.accountId,
        storeId: params.storeId,
        source: "incremental" as SyncSource,
        bundle,
      });
      if (result.applied) upserted += 1;
      else skipped += 1;
    });
  }

  const newWatermark = new Date();
  await withAccountContext(params.accountId, async (tx: TenantClient) => {
    await tx.syncState.upsert({
      where: {
        storeId_resource_kind: { storeId: params.storeId, resource: params.resource, kind: "incremental" },
      },
      create: {
        accountId: params.accountId,
        storeId: params.storeId,
        resource: params.resource,
        kind: "incremental",
        watermarkAt: newWatermark,
        status: "completed",
      },
      update: { watermarkAt: newWatermark, status: "completed" },
    });
  });

  return { ordersFetched: orders.length, ordersUpserted: upserted, ordersSkippedByLastWriteWins: skipped };
}
