import type { ShopifyConnector } from "@plumbline/connector";
import { runBulkQueryToCompletion, streamBulkResultLines } from "@plumbline/connector";
import { withAccountContext, type TenantClient } from "@plumbline/model";
import { assembleOrderBundles } from "./jsonl.js";
import { upsertOrderBundle } from "./upsert.js";
import type { OrderBundle } from "./types.js";

export interface BackfillWindowSpec {
  from: Date;
  to: Date;
}

/** Splits [from, to) into contiguous windows of at most `chunkDays`, so each is independently resumable (docs/PLAN.md §10). */
export function chunkDateRange(from: Date, to: Date, chunkDays: number): BackfillWindowSpec[] {
  const windows: BackfillWindowSpec[] = [];
  let cursor = new Date(from);
  const chunkMs = chunkDays * 24 * 60 * 60 * 1000;
  while (cursor < to) {
    const windowEnd = new Date(Math.min(cursor.getTime() + chunkMs, to.getTime()));
    windows.push({ from: new Date(cursor), to: windowEnd });
    cursor = windowEnd;
  }
  return windows;
}

function buildBulkOrdersQuery(window: BackfillWindowSpec): string {
  const fromISO = window.from.toISOString();
  const toISO = window.to.toISOString();
  // Field selection is illustrative for a real Shopify query; the mock server
  // (docs/PLAN.md-faithful mechanics, not a schema mock — see
  // __tests__/mock-shopify-server.ts) only reads the created_at filter out of
  // this string and returns its own flat records for the matched window.
  return `{ orders(query: "created_at:>=${fromISO} AND created_at:<${toISO}") { edges { node { id createdAt updatedAt currentTotalPriceSet { shopMoney { amount currencyCode } } lineItems { edges { node { id } } } refunds { id } } } } }`;
}

async function processBundlesWithConcurrency(
  bundles: AsyncGenerator<OrderBundle>,
  limit: number,
  worker: (bundle: OrderBundle) => Promise<void>
): Promise<number> {
  let count = 0;
  const inFlight = new Set<Promise<void>>();

  for await (const bundle of bundles) {
    count += 1;
    const p = worker(bundle).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= limit) {
      await Promise.race(inFlight);
    }
  }
  await Promise.all(inFlight);
  return count;
}

export interface RunBackfillParams {
  connector: ShopifyConnector;
  accountId: string;
  storeId: string;
  resource: "orders";
  from: Date;
  to: Date;
  chunkDays?: number;
  concurrency?: number;
  pollIntervalMs?: number;
  /** Test-only crash simulation: called after each window's watermark is persisted; throwing here simulates a crash mid-backfill. */
  afterWindow?: (windowIndex: number, window: BackfillWindowSpec) => void | Promise<void>;
}

export interface BackfillRunResult {
  windowsTotal: number;
  windowsProcessed: number;
  windowsSkippedAlreadyDone: number;
  ordersUpserted: number;
  ordersSkippedByLastWriteWins: number;
  durationMs: number;
}

async function readWatermark(accountId: string, storeId: string, resource: string): Promise<Date | null> {
  return withAccountContext(accountId, async (tx: TenantClient) => {
    const row = await tx.syncState.findUnique({
      where: { storeId_resource_kind: { storeId, resource, kind: "backfill" } },
    });
    return row?.watermarkAt ?? null;
  });
}

async function writeWatermark(
  accountId: string,
  storeId: string,
  resource: string,
  watermarkAt: Date,
  status: string
): Promise<void> {
  await withAccountContext(accountId, async (tx: TenantClient) => {
    await tx.syncState.upsert({
      where: { storeId_resource_kind: { storeId, resource, kind: "backfill" } },
      create: { accountId, storeId, resource, kind: "backfill", watermarkAt, status },
      update: { watermarkAt, status },
    });
  });
}

/**
 * Runs (or resumes) a bulk backfill over [from, to), chunked into windows.
 * On crash, the next call resumes from the last window whose watermark was
 * persisted rather than restarting — verified by backfill.test.ts's
 * interrupt-and-resume case.
 */
export async function runBackfill(params: RunBackfillParams): Promise<BackfillRunResult> {
  const start = Date.now();
  const chunkDays = params.chunkDays ?? 90;
  const concurrency = params.concurrency ?? 8;

  const allWindows = chunkDateRange(params.from, params.to, chunkDays);
  const watermark = await readWatermark(params.accountId, params.storeId, params.resource);

  const remainingWindows = watermark
    ? allWindows.filter((w) => w.to > watermark)
    : allWindows;
  const skipped = allWindows.length - remainingWindows.length;

  let ordersUpserted = 0;
  let ordersSkipped = 0;

  for (let i = 0; i < remainingWindows.length; i++) {
    const window = remainingWindows[i]!;
    await writeWatermark(params.accountId, params.storeId, params.resource, watermark ?? params.from, "in_progress");

    const query = buildBulkOrdersQuery(window);
    const op = await runBulkQueryToCompletion(params.connector, query, {
      pollIntervalMs: params.pollIntervalMs ?? 100,
    });

    if (op.objectCount > 0 && op.url) {
      const lines = streamBulkResultLines(op.url);
      const bundles = assembleOrderBundles(lines);

      await processBundlesWithConcurrency(bundles, concurrency, async (bundle) => {
        await withAccountContext(params.accountId, async (tx: TenantClient) => {
          const result = await upsertOrderBundle(tx, {
            accountId: params.accountId,
            storeId: params.storeId,
            source: "backfill",
            bundle,
          });
          if (result.applied) ordersUpserted += 1;
          else ordersSkipped += 1;
        });
      });
    }

    await writeWatermark(params.accountId, params.storeId, params.resource, window.to, "completed");

    if (params.afterWindow) {
      await params.afterWindow(i, window);
    }
  }

  return {
    windowsTotal: allWindows.length,
    windowsProcessed: remainingWindows.length,
    windowsSkippedAlreadyDone: skipped,
    ordersUpserted,
    ordersSkippedByLastWriteWins: ordersSkipped,
    durationMs: Date.now() - start,
  };
}
