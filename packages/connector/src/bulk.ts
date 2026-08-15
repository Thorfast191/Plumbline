import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { BulkOperationResult, ShopifyConnector } from "./types.js";

export interface RunBulkQueryOptions {
  pollIntervalMs?: number;
  timeoutMs?: number; // Shopify's own hard ceiling is 10 days (docs/PLAN.md §4); callers should pass something sane for their context.
}

/**
 * Submits a bulk query and polls `getBulkOperation` until it leaves the
 * RUNNING/CREATED states. Polling costs normal rate-limit points per call,
 * but the bulk extraction itself does not (docs/PLAN.md §4) — this is why
 * polling on a fixed interval (not tied to the leaky bucket) is fine here.
 */
export async function runBulkQueryToCompletion(
  connector: ShopifyConnector,
  query: string,
  options: RunBulkQueryOptions = {}
): Promise<BulkOperationResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  const submitted = await connector.bulkQuery(query);
  const deadline = Date.now() + timeoutMs;

  let current = submitted;
  while (current.status === "CREATED" || current.status === "RUNNING") {
    if (Date.now() > deadline) {
      throw new Error(`Bulk operation ${current.id} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    current = await connector.getBulkOperation(current.id);
  }

  if (current.status !== "COMPLETED") {
    throw new Error(
      `Bulk operation ${current.id} ended in status ${current.status} (errorCode: ${current.errorCode ?? "none"})`
    );
  }

  return current;
}

/**
 * Streams a completed bulk operation's JSONL result line-by-line without
 * buffering the whole file in memory — required for multi-year/10k+-order
 * backfills (docs/PLAN.md §4/§10).
 */
export async function* streamBulkResultLines(url: string): AsyncGenerator<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch bulk result at ${url}: ${res.status}`);
  }

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const rl = createInterface({ input: nodeStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    yield JSON.parse(line) as Record<string, unknown>;
  }
}
