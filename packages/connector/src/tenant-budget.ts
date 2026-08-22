// Phase 8 — docs/BUILD-SPEC.md: "Backfill for a very large store does not
// starve other tenants' syncs" / "Per-tenant rate limits and cost caps on
// our side." Deliberately separate from CostAwareRateLimiter
// (rate-limiter.ts), which paces against SHOPIFY'S reported budget for one
// connection — that protects us from Shopify, not one tenant from another.
// This protects tenants from each other: each store gets its own
// independent budget, so one large backfill exhausting its own cap cannot
// touch — let alone reduce — any other tenant's.

export interface TenantBudgetConfig {
  /** Cost units (or milliseconds, or any consumption unit the caller defines) allowed per tenant per window. */
  maxPerWindow: number;
  windowMs: number;
}

interface TenantWindowState {
  consumed: number;
  windowStartMs: number;
}

export class TenantBudgetLimiter {
  private readonly windows = new Map<string, TenantWindowState>();

  constructor(private readonly config: TenantBudgetConfig) {}

  private currentWindow(tenantId: string, nowMs: number): TenantWindowState {
    const existing = this.windows.get(tenantId);
    if (existing && nowMs - existing.windowStartMs < this.config.windowMs) {
      return existing;
    }
    const fresh: TenantWindowState = { consumed: 0, windowStartMs: nowMs };
    this.windows.set(tenantId, fresh);
    return fresh;
  }

  /** Remaining budget for this tenant in the current window — independent of every other tenant's consumption. */
  remaining(tenantId: string, nowMs = Date.now()): number {
    const window = this.currentWindow(tenantId, nowMs);
    return Math.max(0, this.config.maxPerWindow - window.consumed);
  }

  /**
   * Attempts to consume `amount` from tenantId's own budget. Returns false
   * (and consumes nothing) if the tenant's own window is exhausted — the
   * caller should skip/defer that tenant's work this cycle rather than
   * block, so other tenants keep getting scheduled (docs/BUILD-SPEC.md
   * Phase 8: no starvation).
   */
  tryConsume(tenantId: string, amount: number, nowMs = Date.now()): boolean {
    const window = this.currentWindow(tenantId, nowMs);
    if (window.consumed + amount > this.config.maxPerWindow) {
      return false;
    }
    window.consumed += amount;
    return true;
  }

  isExhausted(tenantId: string, nowMs = Date.now()): boolean {
    return this.remaining(tenantId, nowMs) <= 0;
  }

  /**
   * Records actual consumption after the fact (e.g. "this tenant's sync
   * took N ms, whatever N turns out to be"), as opposed to tryConsume's
   * pre-authorize-a-known-amount semantics. Saturates at maxPerWindow
   * instead of refusing, so a single over-cap usage still correctly marks
   * the tenant exhausted rather than silently going unrecorded.
   */
  recordUsage(tenantId: string, amount: number, nowMs = Date.now()): void {
    const window = this.currentWindow(tenantId, nowMs);
    window.consumed = Math.min(this.config.maxPerWindow, window.consumed + Math.max(0, amount));
  }
}
