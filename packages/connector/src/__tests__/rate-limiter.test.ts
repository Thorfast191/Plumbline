import { describe, it, expect } from "vitest";
import { ShopifyClient } from "../client.js";
import { startMockShopifyServer } from "./mock-shopify-server.js";

describe("CostAwareRateLimiter under load (via ShopifyClient against a mock leaky-bucket server)", () => {
  it("never gets throttled and is genuinely paced by the reported budget, not luck", async () => {
    const options = {
      maximumAvailable: 500,
      restoreRate: 200, // points/second
      costPerRequest: 50,
    };
    const mock = await startMockShopifyServer(options);

    const client = new ShopifyClient({
      shop: "test-shop.myshopify.com",
      apiVersion: "2026-01",
      apiKey: "test_key",
      apiSecret: "test_secret",
      accessToken: "test_token",
      graphqlEndpointOverride: mock.url,
    });

    const TOTAL_REQUESTS = 40;
    const start = Date.now();

    for (let i = 0; i < TOTAL_REQUESTS; i++) {
      await client.graphql("{ shop { name } }");
    }

    const elapsedMs = Date.now() - start;
    await mock.close();

    // (a) zero throttled responses were ever received — the client always paced correctly.
    expect(mock.stats.throttledCount).toBe(0);
    expect(mock.stats.requestCount).toBe(TOTAL_REQUESTS);

    // (b) wall-clock time is consistent with the bucket's restore rate: the first
    // maximumAvailable/costPerRequest requests are free (burst), every request after
    // that costs costPerRequest/restoreRate seconds of real waiting.
    const burstCapacity = Math.floor(options.maximumAvailable / options.costPerRequest);
    const pacedRequests = TOTAL_REQUESTS - burstCapacity;
    const expectedMinMs = pacedRequests * (options.costPerRequest / options.restoreRate) * 1000;

    console.log(
      `[rate-limiter load test] requests=${TOTAL_REQUESTS} throttled=${mock.stats.throttledCount} ` +
        `elapsedMs=${elapsedMs} expectedMinMs=${Math.floor(expectedMinMs)}`
    );

    // Allow 20% slack below the theoretical minimum for scheduling jitter.
    expect(elapsedMs).toBeGreaterThan(expectedMinMs * 0.8);
  }, 30_000);
});
