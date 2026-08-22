import { describe, expect, it } from "vitest";
import { TenantBudgetLimiter } from "../tenant-budget.js";

describe("TenantBudgetLimiter (docs/BUILD-SPEC.md Phase 8: one tenant's backfill must not starve another tenant's sync)", () => {
  it("a huge-backfill tenant exhausting its own budget does not reduce a second tenant's independent budget", () => {
    const limiter = new TenantBudgetLimiter({ maxPerWindow: 1000, windowMs: 60_000 });
    const now = 1_000_000;

    // Tenant A: a very large backfill hammering its budget.
    let consumedByA = 0;
    for (let i = 0; i < 50; i++) {
      if (limiter.tryConsume("tenant-a", 100, now)) consumedByA += 100;
    }
    expect(consumedByA).toBe(1000); // capped at its own maxPerWindow
    expect(limiter.isExhausted("tenant-a", now)).toBe(true);

    // Tenant B, sharing the same limiter instance, never touched tenant A's budget.
    expect(limiter.remaining("tenant-b", now)).toBe(1000);
    expect(limiter.tryConsume("tenant-b", 500, now)).toBe(true);
    expect(limiter.remaining("tenant-b", now)).toBe(500);
  });

  it("further consumption for the exhausted tenant is refused (not silently allowed), while the other tenant is unaffected", () => {
    const limiter = new TenantBudgetLimiter({ maxPerWindow: 100, windowMs: 60_000 });
    const now = 1_000_000;

    expect(limiter.tryConsume("tenant-a", 100, now)).toBe(true);
    expect(limiter.tryConsume("tenant-a", 1, now)).toBe(false); // over budget, refused

    expect(limiter.tryConsume("tenant-b", 100, now)).toBe(true); // completely independent
  });

  it("recordUsage saturates at maxPerWindow instead of refusing a single over-cap usage, and never touches another tenant's budget", () => {
    const limiter = new TenantBudgetLimiter({ maxPerWindow: 100, windowMs: 60_000 });
    const now = 1_000_000;

    // One over-long sync (e.g. a huge store's incremental sync ran 250ms
    // against a 100ms-per-window tenant cap) — must still register as
    // fully exhausted, not silently unrecorded.
    limiter.recordUsage("tenant-a", 250, now);
    expect(limiter.remaining("tenant-a", now)).toBe(0);
    expect(limiter.isExhausted("tenant-a", now)).toBe(true);

    expect(limiter.remaining("tenant-b", now)).toBe(100); // completely unaffected
  });

  it("a tenant's budget resets once its window elapses, independent of other tenants' window timing", () => {
    const limiter = new TenantBudgetLimiter({ maxPerWindow: 100, windowMs: 60_000 });
    const t0 = 1_000_000;

    expect(limiter.tryConsume("tenant-a", 100, t0)).toBe(true);
    expect(limiter.isExhausted("tenant-a", t0)).toBe(true);
    expect(limiter.isExhausted("tenant-a", t0 + 30_000)).toBe(true); // still within window

    const afterWindow = t0 + 60_001;
    expect(limiter.isExhausted("tenant-a", afterWindow)).toBe(false);
    expect(limiter.remaining("tenant-a", afterWindow)).toBe(100);
  });
});
