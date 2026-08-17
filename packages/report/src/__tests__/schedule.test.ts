import { describe, expect, it } from "vitest";
import { isDue, lastCompletedPeriod, formatPeriodLabel, weekPeriod } from "../period.js";

describe("lastCompletedPeriod — monthly, DST-crossing (docs/BUILD-SPEC.md Phase 7 cadence)", () => {
  it("evaluated on 2025-04-10 in America/New_York, the last completed month is March (which itself crosses the spring-forward boundary)", () => {
    const now = new Date("2025-04-10T15:00:00.000Z");
    const period = lastCompletedPeriod("monthly", now, "America/New_York");
    expect(period.from.toISOString()).toBe("2025-03-01T05:00:00.000Z"); // EST
    expect(period.to.toISOString()).toBe("2025-04-01T04:00:00.000Z"); // EDT — offset shifted mid-period
  });

  it("evaluated on 2025-01-05, the last completed month is the previous December (year rollback)", () => {
    const now = new Date("2025-01-05T12:00:00.000Z");
    const period = lastCompletedPeriod("monthly", now, "America/New_York");
    expect(period.from.toISOString()).toBe("2024-12-01T05:00:00.000Z");
    expect(period.to.toISOString()).toBe("2025-01-01T05:00:00.000Z");
  });
});

describe("weekPeriod / lastCompletedPeriod — weekly", () => {
  it("weekPeriod always starts on a Monday and spans exactly 7 civil days", () => {
    const wed = new Date("2025-06-11T18:00:00.000Z"); // a Wednesday
    const week = weekPeriod(wed, "America/New_York");
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
    expect(fmt.format(week.from)).toBe("Mon");
    expect((week.to.getTime() - week.from.getTime()) / (24 * 60 * 60 * 1000)).toBe(7);
  });

  it("evaluated mid-week, the last completed week is the one immediately before the current week", () => {
    const now = new Date("2025-06-11T18:00:00.000Z"); // Wednesday
    const thisWeek = weekPeriod(now, "America/New_York");
    const lastWeek = lastCompletedPeriod("weekly", now, "America/New_York");
    expect(lastWeek.to.toISOString()).toBe(thisWeek.from.toISOString());
  });
});

describe("isDue — cadence-length-agnostic, boundary-correct", () => {
  it("a schedule that has never sent is always due", () => {
    expect(isDue("monthly", null, new Date("2025-06-15T00:00:00.000Z"), "UTC")).toBe(true);
  });

  it("a monthly schedule last sent inside the previously-completed period is NOT due again for the same period", () => {
    const now = new Date("2025-04-10T00:00:00.000Z");
    const period = lastCompletedPeriod("monthly", now, "UTC"); // March 2025
    const lastSentAt = new Date(period.from.getTime() + 1000); // sent 1s after March started
    expect(isDue("monthly", lastSentAt, now, "UTC")).toBe(false);
  });

  it("a monthly schedule last sent before the previously-completed period IS due (a full period has elapsed since)", () => {
    const now = new Date("2025-04-10T00:00:00.000Z");
    const lastSentAt = new Date("2025-02-15T00:00:00.000Z"); // sent during February, before March completed
    expect(isDue("monthly", lastSentAt, now, "UTC")).toBe(true);
  });

  it("exactly at the boundary — sent at the instant the due period started counts as already covering it", () => {
    const now = new Date("2025-04-10T00:00:00.000Z");
    const period = lastCompletedPeriod("monthly", now, "UTC");
    expect(isDue("monthly", period.from, now, "UTC")).toBe(false);
  });
});

describe("formatPeriodLabel", () => {
  it("monthly labels as 'Month YYYY' in the given timezone", () => {
    const period = lastCompletedPeriod("monthly", new Date("2025-04-10T00:00:00.000Z"), "America/New_York");
    expect(formatPeriodLabel("monthly", period, "America/New_York")).toBe("March 2025");
  });

  it("weekly labels as a date range", () => {
    const period = weekPeriod(new Date("2025-06-11T18:00:00.000Z"), "America/New_York");
    const label = formatPeriodLabel("weekly", period, "America/New_York");
    expect(label).toMatch(/^Jun \d+, 2025 – Jun \d+, 2025$/);
  });
});
