// Phase 8 — docs/BUILD-SPEC.md: "Behaviour when the platform API is down or
// degraded: reports serve stale data with a clear freshness warning, never
// a blank page or a wrong number." Pure logic here (no DB dependency, same
// reasoning as report-data.ts) so it can be unit-tested directly; the
// DB-touching half (reading SyncState) lives in report-query.ts.

export type FreshnessLevel = "fresh" | "stale" | "unknown";

export interface FreshnessInfo {
  level: FreshnessLevel;
  message: string;
  watermarkAt: Date | null;
}

const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — CLAUDE.md's own north-star metric is p95 sync freshness in minutes; a report crossing hours of staleness needs a visible warning, not silence.

export function describeFreshness(
  watermarkAt: Date | null,
  syncStatus: string | null,
  now: Date = new Date()
): FreshnessInfo {
  if (!watermarkAt) {
    return { level: "unknown", message: "No sync has completed for this store yet — figures may be incomplete.", watermarkAt: null };
  }

  const ageMs = now.getTime() - watermarkAt.getTime();
  const asOf = watermarkAt.toISOString();

  if (syncStatus === "error") {
    return {
      level: "stale",
      message: `Sync is currently failing. Data as of ${asOf} — figures below may not reflect recent activity.`,
      watermarkAt,
    };
  }

  if (ageMs > STALE_THRESHOLD_MS) {
    const hours = Math.floor(ageMs / (60 * 60 * 1000));
    return {
      level: "stale",
      message: `Data as of ${asOf} (${hours}h ago) — sync may be delayed. Figures below reflect the last successful sync, not live data.`,
      watermarkAt,
    };
  }

  return { level: "fresh", message: `Data as of ${asOf}.`, watermarkAt };
}

/**
 * Wraps report-figure generation so a failure (simulating the platform API
 * or DB being down/degraded, per BUILD-SPEC Phase 8) produces a clearly
 * degraded result instead of throwing all the way up into a blank page —
 * CLAUDE.md: "never a blank page or a wrong number."
 */
export interface DegradableResult<T> {
  ok: boolean;
  data: T | null;
  errorMessage: string | null;
}

export interface SyncStateLike {
  watermarkAt: Date | null;
  status: string;
}

/**
 * Reduces a store's per-resource SyncState rows (packages/sync's
 * getSyncStatus) to one freshness verdict for the report page: the most
 * recent watermark across resources, but downgraded to "error" status if
 * ANY resource is currently erroring — one silently-failing sync resource
 * should not be hidden behind another resource's healthy watermark.
 */
export function combinedFreshness(states: SyncStateLike[], now: Date = new Date()): FreshnessInfo {
  const withWatermark = states.filter((s): s is SyncStateLike & { watermarkAt: Date } => s.watermarkAt !== null);
  const latest =
    withWatermark.length > 0
      ? withWatermark.reduce((a, b) => (a.watermarkAt.getTime() >= b.watermarkAt.getTime() ? a : b))
      : null;
  const anyError = states.some((s) => s.status === "error");
  return describeFreshness(latest?.watermarkAt ?? null, anyError ? "error" : (latest?.status ?? null), now);
}

export async function runDegradable<T>(fn: () => Promise<T>): Promise<DegradableResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data, errorMessage: null };
  } catch (err) {
    return { ok: false, data: null, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
