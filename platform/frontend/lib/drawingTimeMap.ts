/**
 * A drawing anchor's TIME, to the chart's logical position, and back (B-21).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * Anchors are stored as bar timestamps — the right thing — but the drawing
 * layer turned a timestamp into a position by its index in `candles` and
 * handed that index to the chart as a LOGICAL index. Those are the same
 * number only while the main series is the only thing on the time scale. The
 * chart's time scale is the union of every series' times: a study or a
 * strategy overlay whose points are not the candles' — still on the previous
 * interval's grid for a moment after a switch, or simply longer — shifts every
 * logical index the candles have, and every drawing slid with it. A Text
 * placed on 15m was drawn at the far-left edge after switching to 1d.
 *
 * So the candle's logical position is asked of the chart itself
 * (`timeToCoordinate` → `coordinateToLogical`), and only the arithmetic
 * BETWEEN two candles, or past either end, is ours. With nothing else on the
 * time scale this is exactly the old mapping.
 */

/** The bar's logical position on the chart's own time scale, or null when the chart does not know it. */
export type ChartLogicalOf = (barTime: number) => number | null;

export interface TimeMap {
  timeToLogical(t: number): number;
  logicalToTime(l: number): number;
  /** Index into `times` of the bar at or before `t`, or -1 before the first. */
  barIndexAt(t: number): number;
}

/**
 * @param times   the candles' open times, seconds, ascending
 * @param stepSec one bar of the interval, seconds — for positions past the data
 * @param chartLogicalOf the chart's own logical index for a bar time; when it
 *   is omitted or answers null, the bar's index in `times` stands in for it
 */
export function timeMap(times: readonly number[], stepSec: number, chartLogicalOf?: ChartLogicalOf): TimeMap {
  const n = times.length;
  const logicalAt = (i: number): number => {
    const answer = chartLogicalOf?.(times[i]!);
    return answer === null || answer === undefined || !Number.isFinite(answer) ? i : answer;
  };
  const barIndexAt = (t: number): number => {
    if (n === 0 || t < times[0]!) return -1;
    let lo = 0, hi = n - 1;
    if (t >= times[hi]!) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid; else hi = mid;
    }
    return lo;
  };
  const timeToLogical = (t: number): number => {
    if (n === 0) return 0;
    if (t <= times[0]!) return logicalAt(0) + (t - times[0]!) / stepSec;
    if (t >= times[n - 1]!) return logicalAt(n - 1) + (t - times[n - 1]!) / stepSec;
    const lo = barIndexAt(t);
    const hi = lo + 1;
    const span = times[hi]! - times[lo]!;
    const from = logicalAt(lo);
    return span > 0 ? from + (logicalAt(hi) - from) * ((t - times[lo]!) / span) : from;
  };
  const logicalToTime = (l: number): number => {
    if (n === 0) return 0;
    const first = logicalAt(0);
    const last = logicalAt(n - 1);
    if (l <= first) return times[0]! + (l - first) * stepSec;
    if (l >= last) return times[n - 1]! + (l - last) * stepSec;
    // The candles' logical positions ascend with their times, so this is a
    // binary search over the chart's answer rather than over the index.
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (logicalAt(mid) <= l) lo = mid; else hi = mid;
    }
    const from = logicalAt(lo);
    const span = logicalAt(hi) - from;
    const frac = span > 0 ? (l - from) / span : 0;
    return times[lo]! + (times[hi]! - times[lo]!) * frac;
  };
  return { timeToLogical, logicalToTime, barIndexAt };
}
