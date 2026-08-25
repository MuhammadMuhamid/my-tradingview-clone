/**
 * Pure candle-series invariants.
 *
 * The engine, the chart and the alert runners all assume a candle array is
 * ascending by `openTime`, has one bar per interval slot with no repeats, and
 * carries `closeTime = openTime + INTERVAL_MS - 1`. Nothing enforced that:
 * `ensureCandles` accepts up to 1.5 % missing bars and `toBars` then packs
 * whatever rows exist into a contiguous array, so a gap silently compresses
 * the timeline every rolling indicator is computed over (finding BE-14).
 *
 * These helpers are deliberately dependency-free so both the live path and the
 * research tooling can share one definition of "this series is usable".
 */
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";

export interface SeriesGap {
  /** Open time of the bar after which the gap starts. */
  afterOpenTime: number;
  /** Open time of the next bar present. */
  beforeOpenTime: number;
  /** How many interval slots are absent between them. */
  missingBars: number;
}

export interface SeriesCheck {
  ok: boolean;
  bars: number;
  /** Bars whose openTime is not strictly greater than their predecessor's. */
  outOfOrder: number[];
  /** openTimes appearing more than once. */
  duplicates: number[];
  /** openTimes not aligned to the interval grid. */
  misaligned: number[];
  /** Bars whose closeTime is not openTime + INTERVAL_MS - 1. */
  badCloseTime: number[];
  gaps: SeriesGap[];
}

/** Bar open times are exact multiples of the interval, as Binance emits them. */
export function isAlignedOpenTime(openTime: number, interval: Interval): boolean {
  return Number.isInteger(openTime) && openTime % INTERVAL_MS[interval] === 0;
}

/** The open time of the bar containing `ms`. */
export function barOpenTime(ms: number, interval: Interval): number {
  const step = INTERVAL_MS[interval];
  return Math.floor(ms / step) * step;
}

/** A bar is closed once wall-clock has passed its final millisecond. */
export function isBarClosed(candle: Pick<Candle, "closeTime">, now: number): boolean {
  return now > candle.closeTime;
}

/**
 * Full structural check. Returns every defect rather than throwing on the first
 * so an operator surface can show what is actually wrong with a feed.
 */
export function checkSeries(candles: Candle[], interval: Interval): SeriesCheck {
  const step = INTERVAL_MS[interval];
  const out: SeriesCheck = {
    ok: true, bars: candles.length,
    outOfOrder: [], duplicates: [], misaligned: [], badCloseTime: [], gaps: [],
  };
  const seen = new Set<number>();
  let prev: Candle | undefined;

  for (const c of candles) {
    if (!isAlignedOpenTime(c.openTime, interval)) out.misaligned.push(c.openTime);
    if (c.closeTime !== c.openTime + step - 1) out.badCloseTime.push(c.openTime);
    if (seen.has(c.openTime)) out.duplicates.push(c.openTime);
    seen.add(c.openTime);

    if (prev) {
      if (c.openTime <= prev.openTime) {
        out.outOfOrder.push(c.openTime);
      } else if (c.openTime !== prev.openTime + step) {
        out.gaps.push({
          afterOpenTime: prev.openTime,
          beforeOpenTime: c.openTime,
          missingBars: Math.round((c.openTime - prev.openTime) / step) - 1,
        });
      }
    }
    prev = c;
  }

  out.ok =
    out.outOfOrder.length === 0 && out.duplicates.length === 0 &&
    out.misaligned.length === 0 && out.badCloseTime.length === 0 && out.gaps.length === 0;
  return out;
}

/** True when every consecutive pair is exactly one interval apart. */
export function isContiguous(candles: Candle[], interval: Interval): boolean {
  return checkSeries(candles, interval).gaps.length === 0;
}

/** Total bars absent from the interval grid spanned by the series. */
export function missingBarCount(candles: Candle[], interval: Interval): number {
  return checkSeries(candles, interval).gaps.reduce((n, g) => n + g.missingBars, 0);
}

/**
 * Keep the last-seen row for each open time and return them ascending. Mirrors
 * the database's `ON CONFLICT (symbol, interval, open_time) DO UPDATE`, which
 * is what makes re-fetching a range idempotent.
 */
export function dedupeByOpenTime(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.openTime, c);
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}
