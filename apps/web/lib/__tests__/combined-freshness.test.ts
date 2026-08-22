import { describe, expect, it } from "vitest";
import { combinedFreshness } from "../freshness.js";

describe("combinedFreshness (docs/BUILD-SPEC.md Phase 8: one erroring resource must not hide behind another's healthy watermark)", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("is 'unknown' with no sync states at all", () => {
    expect(combinedFreshness([], now).level).toBe("unknown");
  });

  it("uses the most recent watermark across multiple healthy resources", () => {
    const info = combinedFreshness(
      [
        { watermarkAt: new Date(now.getTime() - 60 * 60 * 1000), status: "idle" },
        { watermarkAt: new Date(now.getTime() - 5 * 60 * 1000), status: "idle" },
      ],
      now
    );
    expect(info.level).toBe("fresh");
    expect(info.watermarkAt?.getTime()).toBe(now.getTime() - 5 * 60 * 1000);
  });

  it("downgrades to 'stale' if ANY resource is in error, even with a recent watermark on another resource", () => {
    const info = combinedFreshness(
      [
        { watermarkAt: new Date(now.getTime() - 2 * 60 * 1000), status: "idle" },
        { watermarkAt: new Date(now.getTime() - 90 * 60 * 1000), status: "error" },
      ],
      now
    );
    expect(info.level).toBe("stale");
    expect(info.message).toMatch(/currently failing/i);
  });
});
