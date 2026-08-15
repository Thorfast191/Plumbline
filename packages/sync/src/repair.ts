import type { ShopifyConnector } from "@plumbline/connector";
import { withAccountContext, type TenantClient } from "@plumbline/model";
import { fetchChangedOrders } from "./incremental.js";
import { upsertOrderBundle } from "./upsert.js";

export interface RunRepairPassParams {
  connector: ShopifyConnector;
  accountId: string;
  storeId: string;
  trailingWindowHours: number;
}

export interface RepairPassResult {
  ordersChecked: number;
  correctionCount: number;
}

/**
 * Re-fetches a trailing window regardless of webhook activity and reconciles
 * against what's stored, logging every correction (docs/BUILD-SPEC.md Phase
 * 3). This is what catches webhooks Shopify silently never delivered — a
 * rising correction count over time means the webhook path is degrading,
 * not that this loop is broken.
 */
export async function runRepairPass(params: RunRepairPassParams): Promise<RepairPassResult> {
  const since = new Date(Date.now() - params.trailingWindowHours * 60 * 60 * 1000);
  const orders = await fetchChangedOrders(params.connector, since.toISOString());

  let correctionCount = 0;
  for (const bundle of orders) {
    await withAccountContext(params.accountId, async (tx: TenantClient) => {
      const result = await upsertOrderBundle(tx, {
        accountId: params.accountId,
        storeId: params.storeId,
        source: "repair",
        bundle,
      });

      for (const cf of result.correctedFields) {
        await tx.syncCorrection.create({
          data: {
            accountId: params.accountId,
            storeId: params.storeId,
            resource: "orders",
            resourceId: bundle.id,
            field: cf.field,
            oldValue: cf.oldValue,
            newValue: cf.newValue,
          },
        });
        correctionCount += 1;
      }
    });
  }

  return { ordersChecked: orders.length, correctionCount };
}
