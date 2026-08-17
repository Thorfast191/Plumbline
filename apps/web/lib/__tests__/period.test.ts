import { describe, expect, it } from "vitest";
import { civilMidnightToUtc, monthPeriod, previousMonth, sameMonthPreviousYear, yearPeriod } from "../period.js";

describe("civilMidnightToUtc — America/New_York (observes DST)", () => {
  it("is 5 hours ahead of UTC in standard time (EST, e.g. January)", () => {
    expect(civilMidnightToUtc(2025, 1, 15, "America/New_York").toISOString()).toBe("2025-01-15T05:00:00.000Z");
  });

  it("is 4 hours ahead of UTC in daylight time (EDT, e.g. July)", () => {
    expect(civilMidnightToUtc(2025, 7, 15, "America/New_York").toISOString()).toBe("2025-07-15T04:00:00.000Z");
  });

  it("is exact at UTC for the UTC zone itself", () => {
    expect(civilMidnightToUtc(2025, 6, 1, "UTC").toISOString()).toBe("2025-06-01T00:00:00.000Z");
  });
});

describe("monthPeriod — DST-crossing comparison periods (docs/BUILD-SPEC.md Phase 6: 'correctly across month lengths and DST')", () => {
  it("March 2025 in America/New_York starts in EST (UTC-5) and ends in EDT (UTC-4) — the DST transition (2025-03-09) falls inside the month", () => {
    const march = monthPeriod(2025, 3, "America/New_York");
    expect(march.from.toISOString()).toBe("2025-03-01T05:00:00.000Z"); // EST: UTC-5
    expect(march.to.toISOString()).toBe("2025-04-01T04:00:00.000Z"); // EDT: UTC-4 — offset shifted mid-period
  });

  it("the elapsed duration of DST-crossing March 2025 is 1 hour shorter than a naive 31*24h assumption would give", () => {
    const march = monthPeriod(2025, 3, "America/New_York");
    const naiveMs = 31 * 24 * 60 * 60 * 1000;
    const actualMs = march.to.getTime() - march.from.getTime();
    expect(naiveMs - actualMs).toBe(60 * 60 * 1000); // spring-forward loses exactly 1 hour
  });

  it("February (28 days) vs. March (31 days) 2025 need no special-casing — both computed the same way", () => {
    const feb = monthPeriod(2025, 2, "America/New_York");
    const mar = monthPeriod(2025, 3, "America/New_York");
    expect(feb.to.toISOString()).toBe(mar.from.toISOString()); // Feb's end is exactly March's start
    expect((feb.to.getTime() - feb.from.getTime()) / (24 * 60 * 60 * 1000)).toBe(28);
    expect((mar.to.getTime() - mar.from.getTime()) / (24 * 60 * 60 * 1000)).toBe(31 - 1 / 24); // minus the DST hour
  });

  it("previousMonth() rolls January back to December of the prior year", () => {
    expect(previousMonth(2025, 1)).toEqual({ year: 2024, month1to12: 12 });
    expect(previousMonth(2025, 6)).toEqual({ year: 2025, month1to12: 5 });
  });

  it("sameMonthPreviousYear() keeps the month and decrements the year", () => {
    expect(sameMonthPreviousYear(2025, 3)).toEqual({ year: 2024, month1to12: 3 });
  });

  it("a 'this month vs. previous month' comparison correctly spans the DST boundary when previous month is used", () => {
    const april = monthPeriod(2025, 4, "America/New_York");
    const prev = previousMonth(2025, 4);
    const march = monthPeriod(prev.year, prev.month1to12, "America/New_York");
    expect(march.to.toISOString()).toBe(april.from.toISOString());
  });
});

describe("yearPeriod", () => {
  it("spans exactly Jan 1 civil midnight to next Jan 1 civil midnight in the store's timezone", () => {
    const year = yearPeriod(2025, "America/New_York");
    expect(year.from.toISOString()).toBe("2025-01-01T05:00:00.000Z");
    expect(year.to.toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });
});
