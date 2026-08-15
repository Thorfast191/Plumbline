import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { ordersToJsonl, type SyntheticOrder } from "./fixtures.js";

/**
 * A local HTTP server reproducing the documented mechanics of Shopify's
 * Bulk Operations API and plain paginated GraphQL orders query (docs/PLAN.md
 * §2/§4): cost-based leaky bucket on every graphql.json call, async bulk
 * operations that go CREATED -> RUNNING -> COMPLETED and stream JSONL from a
 * separate (unmetered) URL, and an `orders(query: "updated_at:>=...")` path
 * for incremental/repair. The in-memory dataset is mutable so tests can
 * simulate drift (docs/BUILD-SPEC.md Phase 3's repair-loop requirement).
 */
export interface MockShopifyServerHandle {
  url: string; // graphql.json endpoint
  close: () => Promise<void>;
  stats: { requestCount: number; throttledCount: number; bulkOperationsCompleted: number };
  /** Mutates an order in the in-memory "Shopify" dataset, bumping updatedAt — simulates a change Plumbline hasn't seen yet. */
  mutateOrder: (id: string, patch: Partial<SyntheticOrder>) => void;
  getOrder: (id: string) => SyntheticOrder | undefined;
}

interface BulkOpRecord {
  id: string;
  submittedAtMs: number;
  jsonl: string;
  objectCount: number;
}

const RESTORE_RATE = 100; // points/sec, matches Standard plan (docs/PLAN.md §2)
const MAX_AVAILABLE = 2000;
const BULK_SUBMIT_COST = 10;
const PLAIN_QUERY_COST = 5;
const BULK_COMPLETION_DELAY_MS = 300;

export function startMockShopifyServer(initialOrders: SyntheticOrder[]): Promise<MockShopifyServerHandle> {
  const dataset = new Map(initialOrders.map((o) => [o.id, o]));
  const bulkOps = new Map<string, BulkOpRecord>();
  const stats = { requestCount: 0, throttledCount: 0, bulkOperationsCompleted: 0 };

  let currentlyAvailable = MAX_AVAILABLE;
  let lastRefillMs = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - lastRefillMs) / 1000;
    currentlyAvailable = Math.min(MAX_AVAILABLE, currentlyAvailable + elapsedSeconds * RESTORE_RATE);
    lastRefillMs = now;
  }

  function throttleStatus() {
    return {
      maximumAvailable: MAX_AVAILABLE,
      currentlyAvailable: Math.floor(currentlyAvailable),
      restoreRate: RESTORE_RATE,
    };
  }

  function respondJson(res: import("node:http").ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function chargeCost(cost: number): { throttled: boolean; cost: ReturnType<typeof throttleStatus> } {
    refill();
    if (currentlyAvailable < cost) {
      stats.throttledCount += 1;
      return { throttled: true, cost: throttleStatus() };
    }
    currentlyAvailable -= cost;
    return { throttled: false, cost: throttleStatus() };
  }

  function extractBetween(text: string, pattern: RegExp): string | null {
    const m = text.match(pattern);
    return m?.[1] ?? null;
  }

  function ordersInRange(fromISO: string | null, toISO: string | null, field: "createdAt" | "updatedAt"): SyntheticOrder[] {
    const from = fromISO ? new Date(fromISO).getTime() : -Infinity;
    const to = toISO ? new Date(toISO).getTime() : Infinity;
    return [...dataset.values()].filter((o) => {
      const t = new Date(o[field]).getTime();
      return t >= from && t < to;
    });
  }

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/bulk-results/")) {
      const id = decodeURIComponent(req.url.slice("/bulk-results/".length).replace(/\.jsonl$/, ""));
      const op = bulkOps.get(id);
      if (!op) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Bulk result extraction is NOT metered against the leaky bucket (docs/PLAN.md §4).
      res.writeHead(200, { "Content-Type": "application/jsonl" });
      res.end(op.jsonl);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      stats.requestCount += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query: string };
      const q = body.query;

      // --- bulkOperationRunQuery submission ---
      if (q.includes("bulkOperationRunQuery")) {
        const { throttled, cost } = chargeCost(BULK_SUBMIT_COST);
        if (throttled) {
          respondJson(res, {
            data: null,
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: { cost: { requestedQueryCost: BULK_SUBMIT_COST, actualQueryCost: 0, throttleStatus: cost } },
          });
          return;
        }

        const fromISO = extractBetween(q, /created_at:>=([0-9T:\-.Z]+)/);
        const toISO = extractBetween(q, /created_at:<([0-9T:\-.Z]+)/);
        const matched = ordersInRange(fromISO, toISO, "createdAt");
        const jsonl = ordersToJsonl(matched);
        const objectCount = jsonl.split("\n").filter((l) => l.length > 0).length;

        const id = `gid://shopify/BulkOperation/${randomUUID()}`;
        bulkOps.set(id, { id, submittedAtMs: Date.now(), jsonl, objectCount });

        respondJson(res, {
          data: {
            bulkOperationRunQuery: {
              bulkOperation: { id, status: "CREATED" },
              userErrors: [],
            },
          },
          extensions: {
            cost: { requestedQueryCost: BULK_SUBMIT_COST, actualQueryCost: BULK_SUBMIT_COST, throttleStatus: cost },
          },
        });
        return;
      }

      // --- bulk operation polling: node(id: "...") { ... on BulkOperation } ---
      if (q.includes("BulkOperation")) {
        const { throttled, cost } = chargeCost(1); // polling is cheap
        if (throttled) {
          respondJson(res, {
            data: null,
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 0, throttleStatus: cost } },
          });
          return;
        }
        const id = extractBetween(q, /node\(id:\s*"([^"]+)"\)/);
        const op = id ? bulkOps.get(id) : undefined;
        if (!op) {
          respondJson(res, {
            data: { node: null },
            extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: cost } },
          });
          return;
        }
        const done = Date.now() - op.submittedAtMs >= BULK_COMPLETION_DELAY_MS;
        if (done) stats.bulkOperationsCompleted += 1;
        respondJson(res, {
          data: {
            node: {
              id: op.id,
              status: done ? "COMPLETED" : "RUNNING",
              objectCount: String(op.objectCount),
              url: done ? `http://127.0.0.1:${(server.address() as AddressInfo).port}/bulk-results/${encodeURIComponent(op.id)}.jsonl` : null,
              errorCode: null,
            },
          },
          extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: cost } },
        });
        return;
      }

      // --- plain incremental/repair query: orders(query: "updated_at:>=...") ---
      if (q.includes("orders(")) {
        const { throttled, cost } = chargeCost(PLAIN_QUERY_COST);
        if (throttled) {
          respondJson(res, {
            data: null,
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: { cost: { requestedQueryCost: PLAIN_QUERY_COST, actualQueryCost: 0, throttleStatus: cost } },
          });
          return;
        }
        const sinceISO = extractBetween(q, /updated_at:>=?([0-9T:\-.Z]+)/);
        const matched = ordersInRange(sinceISO, null, "updatedAt");
        respondJson(res, {
          data: {
            orders: {
              edges: matched.map((o) => ({ node: o })),
              pageInfo: { hasNextPage: false },
            },
          },
          extensions: {
            cost: { requestedQueryCost: PLAIN_QUERY_COST, actualQueryCost: PLAIN_QUERY_COST, throttleStatus: cost },
          },
        });
        return;
      }

      respondJson(res, { data: null, errors: [{ message: `Mock server: unrecognized query shape` }] }, 400);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/graphql.json`,
        close: () => new Promise((r) => server.close(() => r())),
        stats,
        mutateOrder: (id, patch) => {
          const existing = dataset.get(id);
          if (!existing) throw new Error(`mutateOrder: no such order ${id}`);
          dataset.set(id, { ...existing, ...patch, updatedAt: new Date().toISOString() });
        },
        getOrder: (id) => dataset.get(id),
      });
    });
  });
}
