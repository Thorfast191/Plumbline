// Timezone-correct calendar period + cadence math for scheduled reports and
// alert evaluation. This is a deliberate, minimal duplication of
// apps/web/lib/period.ts's civil-date-to-UTC conversion technique, not an
// import of it: packages/report is a workspace package and must not depend
// on apps/web (wrong dependency direction — packages don't depend on apps),
// and building a third shared package for ~30 lines of Intl-based date math
// would be scaffolding CLAUDE.md's minimalism rule explicitly warns against.
// If a third consumer needs this, that's the point to extract a shared
// package — not before.

export interface Period {
  from: Date;
  to: Date; // exclusive
}

/** See apps/web/lib/period.ts for the full explanation of this technique. */
export function civilMidnightToUtc(year: number, month1to12: number, day: number, timeZone: string): Date {
  const guessMs = Date.UTC(year, month1to12 - 1, day, 0, 0, 0);
  const offset1 = offsetMsAt(guessMs, timeZone);
  const corrected = guessMs - offset1;
  const offset2 = offsetMsAt(corrected, timeZone);
  return new Date(offset2 === offset1 ? corrected : guessMs - offset2);
}

function offsetMsAt(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") % 24;
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asIfUtc - instantMs;
}

export function monthPeriod(year: number, month1to12: number, timeZone: string): Period {
  const from = civilMidnightToUtc(year, month1to12, 1, timeZone);
  const nextMonthYear = month1to12 === 12 ? year + 1 : year;
  const nextMonth = month1to12 === 12 ? 1 : month1to12 + 1;
  const to = civilMidnightToUtc(nextMonthYear, nextMonth, 1, timeZone);
  return { from, to };
}

/** The calendar month immediately before (year, month) — handles January -> previous December. */
export function previousMonth(year: number, month1to12: number): { year: number; month1to12: number } {
  return month1to12 === 1 ? { year: year - 1, month1to12: 12 } : { year, month1to12: month1to12 - 1 };
}

/**
 * Civil-week period (Monday 00:00 through the following Monday 00:00) in
 * `timeZone`, for the week containing `reference`. `reference` is read in
 * `timeZone`'s civil calendar to find that week's Monday, so a UTC instant
 * near a day boundary still lands in the correct local week.
 */
export function weekPeriod(reference: Date, timeZone: string): Period {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(reference);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const weekdayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  const daysSinceMonday = weekdayIndex; // Mon=0 ... Sun=6

  const mondayUtcNoon = Date.UTC(year, month - 1, day - daysSinceMonday, 12); // noon avoids DST-edge date-arithmetic surprises
  const monday = new Date(mondayUtcNoon);
  const from = civilMidnightToUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), timeZone);

  const nextMondayUtcNoon = Date.UTC(year, month - 1, day - daysSinceMonday + 7, 12);
  const nextMonday = new Date(nextMondayUtcNoon);
  const to = civilMidnightToUtc(nextMonday.getUTCFullYear(), nextMonday.getUTCMonth() + 1, nextMonday.getUTCDate(), timeZone);

  return { from, to };
}

export type Cadence = "weekly" | "monthly";

/**
 * The most recently completed period for `cadence`, as of `now`, in
 * `timeZone` — "last week" or "last (calendar) month", never the
 * still-in-progress current one, since a scheduled report or alert
 * evaluated mid-month should report on complete data, not a partial period
 * that will look artificially low.
 */
export function lastCompletedPeriod(cadence: Cadence, now: Date, timeZone: string): Period {
  if (cadence === "weekly") {
    const thisWeek = weekPeriod(now, timeZone);
    const lastWeekReference = new Date(thisWeek.from.getTime() - 24 * 60 * 60 * 1000);
    return weekPeriod(lastWeekReference, timeZone);
  }
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const prev = previousMonth(year, month);
  return monthPeriod(prev.year, prev.month1to12, timeZone);
}

/**
 * Whether a schedule/rule with the given cadence and `lastSentAt` is due to
 * fire at `now`. A schedule that has never sent is due immediately (see
 * ScheduledReport model comment in schema.prisma) — otherwise it's due once
 * the most recently completed period has changed since the last send,
 * which is cadence-length-agnostic (correct whether a month is 28 or 31
 * days, or a week crosses a DST transition) because it compares period
 * boundaries, not elapsed milliseconds.
 */
export function isDue(cadence: Cadence, lastSentAt: Date | null, now: Date, timeZone: string): boolean {
  if (lastSentAt === null) return true;
  const currentDuePeriod = lastCompletedPeriod(cadence, now, timeZone);
  return lastSentAt.getTime() < currentDuePeriod.from.getTime();
}

/** Human-readable label for a period, read back in `timeZone` so it matches the civil dates the period was built from. */
export function formatPeriodLabel(cadence: Cadence, period: Period, timeZone: string): string {
  if (cadence === "monthly") {
    return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "long" }).format(period.from);
  }
  const lastDayInstant = new Date(period.to.getTime() - 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
  return `${fmt.format(period.from)} – ${fmt.format(lastDayInstant)}`;
}
