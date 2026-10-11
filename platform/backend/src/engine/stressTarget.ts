/**
 * What the TRADED instrument itself did across a stress window.
 *
 * A stress table that shows the benchmark falling 30 % and the strategy
 * losing 0.4 % invites the reading "the strategy weathered the crash". It may
 * equally be that the traded instrument barely moved, or that the strategy
 * held a tenth of its capital for a day of it. The first of those is a fact
 * about the market and is answered here: buy-and-hold of the traded symbol
 * over the same window, from the first bar's OPEN to the last bar's close —
 * the same anchoring `engine/stress.ts` uses for the benchmark, and the span
 * in which the window's backtest could hold a position.
 *
 * This lives apart from `engine/stress.ts` deliberately. That module's
 * invariant is that discovery reads the benchmark and nothing else; this
 * reads the traded symbol, runs only AFTER the windows are fixed, and takes
 * no strategy output either — just two candles.
 */
import type { Candle } from "../types/market";

export interface TargetReturn {
  /** Buy-and-hold of the traded symbol, percent: first bar's open to last bar's close. */
  returnPct: number;
  /** The span the two candles actually cover, which may be narrower than the window. */
  startMs: number;
  endMs: number;
  /**
   * Whether that span is the window, to within one traded bar at each end.
   * False when the traded symbol's stored history starts late or stops early
   * — a figure over part of a window is not the figure for the window.
   */
  complete: boolean;
}

/**
 * Buy-and-hold across a window, from its first and last traded bars.
 *
 * `first` is the earliest traded bar opening at or after the window's start;
 * `last` the latest one CLOSING at or before its end, so no part of the
 * figure comes from after the window. Null when either is missing, when they
 * are out of order, or when the opening price is not positive — "no figure"
 * is a different answer from "0 %".
 */
export function targetReturn(
  first: Candle | undefined,
  last: Candle | undefined,
  window: { startMs: number; endMs: number },
  barMs: number,
): TargetReturn | null {
  if (!first || !last) return null;
  if (last.openTime < first.openTime || !(first.open > 0)) return null;
  if (first.openTime < window.startMs || last.closeTime > window.endMs) return null;
  return {
    returnPct: ((last.close - first.open) / first.open) * 100,
    startMs: first.openTime,
    endMs: last.closeTime,
    complete: first.openTime - window.startMs < barMs && window.endMs - last.closeTime < barMs,
  };
}
