/**
 * The completed period a pivot alert derives its levels from.
 *
 * ── Why weekly and monthly are not intervals ───────────────────────────────
 *
 * Every other anchor is a `Interval` — the runner fetches candles at that
 * interval and takes the second-newest as the completed period. Weekly and
 * monthly deliberately are NOT added to `INTERVALS`, for two reasons:
 *
 *  1. **A month has no fixed length.** `INTERVAL_MS` is a constant per
 *     interval, relied on in sixty places for bar arithmetic, fetch windows,
 *     gap detection and feed-health checks. Any constant for `1M` is wrong for
 *     most months, and the failure would be silent: false gaps reported, real
 *     gaps missed, backfill windows off by days.
 *  2. **A week does not start at the epoch.** Bucketing by
 *     `floor(t / WEEK) * WEEK` puts boundaries on Thursdays, because 1970-01-01
 *     was a Thursday. Binance's own weekly bar opens Monday 00:00 UTC, and a
 *     pivot level computed from a Thursday-to-Thursday window is a level no
 *     chart ever drew.
 *
 * So both are aggregated here from DAILY candles, by calendar. Monday-start
 * ISO weeks and real calendar months, in UTC — the same boundaries the chart
 * uses. Nothing else in the platform has to learn about them.
 *
 * Pure, so the boundary arithmetic can be tested without a database.
 */
import type { Candle } from "../types/market";
import type { Period } from "../ta/core";

/** Anchors that are aggregated from daily candles rather than fetched. */
export const DERIVED_ANCHORS = ["1w", "1M"] as const;
export type DerivedAnchor = (typeof DERIVED_ANCHORS)[number];
export const isDerivedAnchor = (v: string): v is DerivedAnchor =>
  (DERIVED_ANCHORS as readonly string[]).includes(v);

/**
 * The key identifying which calendar week or month a timestamp falls in.
 *
 * Weeks are ISO: Monday starts the week. `getUTCDay()` returns 0 for Sunday,
 * so Sunday is pulled back six days rather than starting a new week — the
 * off-by-one that a naive `day - 1` would introduce every seventh day.
 */
export function periodKey(openTimeMs: number, anchor: DerivedAnchor): string {
  const d = new Date(openTimeMs);
  if (anchor === "1M") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const day = d.getUTCDay();
  const backToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(openTimeMs - backToMonday * 86_400_000);
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}` +
         `-${String(monday.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The last COMPLETED calendar week or month, from daily candles.
 *
 * "Completed" is the whole point, and it is why the newest group is discarded
 * rather than returned: a pivot level derived from the week still in progress
 * would move under the alert every day, and would be a level the chart never
 * drew. The same reasoning the interval-based path applies by dropping its
 * newest bar.
 *
 * Returns undefined when fewer than two calendar groups are present, because
 * then there is no group known to be finished.
 */
export function completedPeriodFromDaily(
  daily: readonly Candle[], anchor: DerivedAnchor
): Period | undefined {
  if (daily.length === 0) return undefined;

  const groups: { key: string; bars: Candle[] }[] = [];
  for (const bar of daily) {
    const key = periodKey(bar.openTime, anchor);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.bars.push(bar);
    else groups.push({ key, bars: [bar] });
  }
  // The newest group is the period currently forming.
  if (groups.length < 2) return undefined;
  const bars = groups[groups.length - 2]!.bars;

  return {
    open: bars[0]!.open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars[bars.length - 1]!.close,
  };
}

/**
 * How many daily bars to fetch to be sure of seeing two complete groups.
 *
 * Generous on purpose: the cost of over-fetching is a slightly larger query,
 * and the cost of under-fetching is an alert that silently never resolves its
 * anchor and therefore never fires.
 */
export const DAILY_BARS_FOR = (anchor: DerivedAnchor): number =>
  anchor === "1M" ? 130 : 40;
