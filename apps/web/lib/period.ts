// Timezone-correct calendar period math. See CLAUDE.md: "aggregate in the
// store's timezone, display in the viewer's timezone" and "Any function
// touching a date boundary states which timezone it operates in."
//
// No date library is added for this (date-fns/luxon/etc are not in the
// workspace) — Node ships full ICU, so `Intl.DateTimeFormat` alone is
// enough to convert a civil (wall-clock) date in an IANA timezone to the
// correct UTC instant, including across DST transitions. This file's only
// job is that conversion; packages/metrics' SQL already compares synced
// event timestamps (stored in UTC, per CLAUDE.md) against whatever UTC
// instants are passed in as period bounds — so computing those bounds
// correctly in the store's timezone here is what makes "aggregate in the
// store's timezone" true, without the SQL layer needing to know about
// timezones at all.

export interface Period {
  from: Date;
  to: Date; // exclusive
}

/**
 * The UTC instant corresponding to civil midnight (00:00:00.000) on
 * (year, month, day) in `timeZone`. Two-pass fixed-point technique: guess
 * the instant assuming the civil date is UTC, read back what that instant
 * renders as in the target zone to find the zone's offset, then correct.
 * A second offset read after correcting handles the rare case where the
 * initial guess and the corrected instant fall on opposite sides of a DST
 * transition. Not valid for the skipped hour during a spring-forward
 * transition (no such civil time exists) — midnight is never in that gap
 * for any IANA zone actually used by merchants, so this is not handled.
 */
export function civilMidnightToUtc(year: number, month1to12: number, day: number, timeZone: string): Date {
  const guessMs = Date.UTC(year, month1to12 - 1, day, 0, 0, 0);
  const offset1 = offsetMsAt(guessMs, timeZone);
  const corrected = guessMs - offset1;
  const offset2 = offsetMsAt(corrected, timeZone);
  return new Date(offset2 === offset1 ? corrected : guessMs - offset2);
}

/** How far `timeZone`'s local wall-clock is ahead of UTC at `instantMs`, in ms. */
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
  // Intl renders midnight as hour "24" in some environments; normalize.
  const hour = get("hour") % 24;
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asIfUtc - instantMs;
}

export function dayPeriod(year: number, month1to12: number, day: number, timeZone: string): Period {
  const from = civilMidnightToUtc(year, month1to12, day, timeZone);
  const nextDay = new Date(Date.UTC(year, month1to12 - 1, day + 1));
  const to = civilMidnightToUtc(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), timeZone);
  return { from, to };
}

/**
 * Calendar-month period, correct across month lengths: bounds are always
 * "first of this month" to "first of next month" in `timeZone`, never a
 * fixed day-count offset, so February vs. March needs no special-casing.
 */
export function monthPeriod(year: number, month1to12: number, timeZone: string): Period {
  const from = civilMidnightToUtc(year, month1to12, 1, timeZone);
  const nextMonthYear = month1to12 === 12 ? year + 1 : year;
  const nextMonth = month1to12 === 12 ? 1 : month1to12 + 1;
  const to = civilMidnightToUtc(nextMonthYear, nextMonth, 1, timeZone);
  return { from, to };
}

export function yearPeriod(year: number, timeZone: string): Period {
  const from = civilMidnightToUtc(year, 1, 1, timeZone);
  const to = civilMidnightToUtc(year + 1, 1, 1, timeZone);
  return { from, to };
}

/** The calendar month immediately before (year, month) — handles January -> previous December. */
export function previousMonth(year: number, month1to12: number): { year: number; month1to12: number } {
  return month1to12 === 1 ? { year: year - 1, month1to12: 12 } : { year, month1to12: month1to12 - 1 };
}

/** Same calendar month, one year earlier — for "vs. same month last year" comparisons. */
export function sameMonthPreviousYear(year: number, month1to12: number): { year: number; month1to12: number } {
  return { year: year - 1, month1to12 };
}
