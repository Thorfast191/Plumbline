import type { ThrottleStatus } from "./types.js";

/**
 * Cost-aware pacing for Shopify's GraphQL leaky-bucket rate limit
 * (docs/PLAN.md §2). Never sleeps a fixed duration — every wait is computed
 * from the bucket state Shopify's own response last reported, projected
 * forward by elapsed wall-clock time at the bucket's restore rate.
 */
export class CostAwareRateLimiter {
  private state: ThrottleStatus | null = null;
  private lastUpdatedMs = 0;
  private lastKnownCost = 1; // conservative default until the server tells us otherwise

  /** Call after every GraphQL response to record the server's reported budget. */
  update(status: ThrottleStatus, actualQueryCost?: number): void {
    this.state = status;
    this.lastUpdatedMs = Date.now();
    if (typeof actualQueryCost === "number" && actualQueryCost > 0) {
      this.lastKnownCost = actualQueryCost;
    }
  }

  /**
   * Adaptive cost estimate for the *next* call, based on the most recently
   * observed actualQueryCost. Real Shopify query cost depends on query shape,
   * so callers issuing a materially different query should pass an explicit
   * cost to `waitForBudget` instead of relying on this.
   */
  estimateNextCost(): number {
    return this.lastKnownCost;
  }

  /** Best estimate of currently-available budget, projecting refill since the last update. */
  estimateAvailable(nowMs = Date.now()): number {
    if (!this.state) return Number.POSITIVE_INFINITY; // no data yet — let the first request through
    const elapsedSeconds = Math.max(0, (nowMs - this.lastUpdatedMs) / 1000);
    const restored = elapsedSeconds * this.state.restoreRate;
    return Math.min(this.state.maximumAvailable, this.state.currentlyAvailable + restored);
  }

  /** Milliseconds to wait before `neededCost` points would be available. 0 if available now. */
  waitMsFor(neededCost: number, nowMs = Date.now()): number {
    const available = this.estimateAvailable(nowMs);
    if (available >= neededCost) return 0;
    if (!this.state) return 0; // no data to pace against yet
    const deficit = neededCost - available;
    return Math.ceil((deficit / this.state.restoreRate) * 1000);
  }

  /** Blocks (via injectable sleep, for tests) until `neededCost` points are available. */
  async waitForBudget(
    neededCost: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ): Promise<void> {
    const waitMs = this.waitMsFor(neededCost);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}
