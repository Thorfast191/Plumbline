import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local HTTP server that reproduces Shopify's cost-based leaky-bucket
 * GraphQL rate limit server-side, so the real CostAwareRateLimiter / ShopifyClient
 * pacing logic can be load-tested without hitting Shopify at all.
 */
export interface MockShopifyServerOptions {
  maximumAvailable: number;
  restoreRate: number; // points/second
  costPerRequest: number;
}

export interface MockShopifyServerHandle {
  url: string;
  close: () => Promise<void>;
  stats: { requestCount: number; throttledCount: number };
}

export function startMockShopifyServer(
  options: MockShopifyServerOptions
): Promise<MockShopifyServerHandle> {
  let currentlyAvailable = options.maximumAvailable;
  let lastRefillMs = Date.now();
  const stats = { requestCount: 0, throttledCount: 0 };

  function refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - lastRefillMs) / 1000;
    currentlyAvailable = Math.min(
      options.maximumAvailable,
      currentlyAvailable + elapsedSeconds * options.restoreRate
    );
    lastRefillMs = now;
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      stats.requestCount += 1;
      refill();

      const throttleStatus = {
        maximumAvailable: options.maximumAvailable,
        currentlyAvailable: Math.floor(currentlyAvailable),
        restoreRate: options.restoreRate,
      };

      if (currentlyAvailable < options.costPerRequest) {
        stats.throttledCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: null,
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: {
              cost: {
                requestedQueryCost: options.costPerRequest,
                actualQueryCost: 0,
                throttleStatus,
              },
            },
          })
        );
        return;
      }

      currentlyAvailable -= options.costPerRequest;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: { ok: true },
          extensions: {
            cost: {
              requestedQueryCost: options.costPerRequest,
              actualQueryCost: options.costPerRequest,
              throttleStatus: {
                ...throttleStatus,
                currentlyAvailable: Math.floor(currentlyAvailable),
              },
            },
          },
        })
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/graphql.json`,
        close: () => new Promise((r) => server.close(() => r())),
        stats,
      });
    });
  });
}
