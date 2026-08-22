import { describe, expect, it } from "vitest";
import { describeFreshness, runDegradable } from "../freshness.js";

describe("describeFreshness (docs/BUILD-SPEC.md Phase 8: clear freshness warning, never a blank page or wrong number)", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("is 'unknown' when no sync has ever completed", () => {
    const info = describeFreshness(null, null, now);
    expect(info.level).toBe("unknown");
    expect(info.message).toMatch(/no sync has completed/i);
  });

  it("is 'fresh' when the watermark is recent and sync status is not 'error'", () => {
    const info = describeFreshness(new Date(now.getTime() - 10 * 60 * 1000), "idle", now);
    expect(info.level).toBe("fresh");
  });

  it("is 'stale' when the watermark is older than the 2-hour threshold", () => {
    const info = describeFreshness(new Date(now.getTime() - 3 * 60 * 60 * 1000), "idle", now);
    expect(info.level).toBe("stale");
    expect(info.message).toMatch(/3h ago/);
  });

  it("is exactly 'fresh' one second before the 2-hour threshold", () => {
    const info = describeFreshness(new Date(now.getTime() - (2 * 60 * 60 * 1000 - 1000)), "idle", now);
    expect(info.level).toBe("fresh");
  });

  it("is 'stale' when sync status is 'error', even if the watermark is recent (platform API down/degraded)", () => {
    const info = describeFreshness(new Date(now.getTime() - 5 * 60 * 1000), "error", now);
    expect(info.level).toBe("stale");
    expect(info.message).toMatch(/currently failing/i);
  });
});

describe("runDegradable (docs/BUILD-SPEC.md Phase 8: platform-down simulation against a mock)", () => {
  it("returns ok:true with the real data when the underlying call succeeds", async () => {
    const result = await runDegradable(async () => ({ grossSales: 12345 }));
    expect(result).toEqual({ ok: true, data: { grossSales: 12345 }, errorMessage: null });
  });

  it("returns ok:false with a clear error message instead of throwing, when the underlying call fails (simulated platform-down)", async () => {
    const result = await runDegradable(async () => {
      throw new Error("ECONNREFUSED: mock platform API is down");
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.errorMessage).toMatch(/mock platform API is down/);
  });
});
