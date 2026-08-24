/**
 * Multi-timeframe machinery — the local equivalent of Pine's
 * request.security(sym, tf, expr, barmerge.gaps_off, barmerge.lookahead_off).
 *
 * ── UNRESOLVED: which cutoff does TradingView actually use? (BE-08) ───────
 *
 * This header used to assert TWO DIFFERENT conventions, and the implementation
 * followed only one of them:
 *
 *   claimed for a higher TF : last HTF bar with closeTime <= chart bar's OPEN
 *                             (the classic one-bar delay — hour-10's value
 *                             first appears on the chart bar opening at 11:00)
 *   claimed for lower/equal : last bar with closeTime <= chart bar's CLOSE
 *   actually implemented    : closeTime <= chart bar's CLOSE, for ALL timeframes
 *
 * If the header was right and the code is wrong, every `ma_rr_v9` and
 * `srtrend_v10` result carries one bar of higher-timeframe LOOK-AHEAD, because
 * neither strategy applies a compensating shift. `mtf_lean` does — it gates on
 * `htfClosed` and then `shift(src, 1)` — which is why it is unaffected either
 * way, and why the two families cannot be compared until this is settled.
 *
 * The inline comment at `buildMergeIndex` cited a "DEXE parity run 2026-07-11"
 * as verification. Those artifacts lived in `platform/backend/parity/`, which is
 * gitignored and absent from every clone, so the claim cannot be checked from
 * source. `platform/README.md` separately records the parity run as "deferred".
 *
 * **Nothing here guesses.** The convention is an explicit parameter, the
 * default is exactly what the code did before, and both conventions are
 * implemented and tested. Resolving BE-08 is a one-line change to that default
 * with visible, tested consequences.
 *
 * ── The test that settles it ──────────────────────────────────────────────
 *
 * In TradingView, on a 15m chart:
 *
 *     plot(request.security(syminfo.tickerid, "60", close))
 *
 * Read the plotted value on the bar CLOSING at 10:00. Then compare against
 * `mergeValues(buildMergeIndex(chart15m, feed1h, convention), feed1h.close)[i]`
 * for the same bar under each convention. Whichever matches is the answer.
 *
 * Needs a TradingView account. See docs/RESEARCH-METHODOLOGY.md.
 *
 * Live/realtime TV behaves differently again (developing HTF values) — the
 * Stage 3 live runner implements that mode on top of the same feeds.
 */
import type { Candle, Interval } from "../types/market";

export interface Bars {
  symbol: string;
  interval: Interval;
  /** open time ms, ascending */
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  closeTime: number[];
  length: number;
}

export function toBars(candles: Candle[]): Bars {
  const n = candles.length;
  const b: Bars = {
    symbol: candles[0]?.symbol ?? "",
    interval: (candles[0]?.interval ?? "1m") as Interval,
    time: new Array(n),
    open: new Array(n),
    high: new Array(n),
    low: new Array(n),
    close: new Array(n),
    volume: new Array(n),
    closeTime: new Array(n),
    length: n,
  };
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    b.time[i] = c.openTime;
    b.open[i] = c.open;
    b.high[i] = c.high;
    b.low[i] = c.low;
    b.close[i] = c.close;
    b.volume[i] = c.volume;
    b.closeTime[i] = c.closeTime;
  }
  return b;
}

/**
 * Pine timeframe string → platform interval.
 * Pine: "" = chart TF, minutes as plain numbers ("1","5","60","240"), "D"/"1D" daily.
 */
export function pineTfToInterval(tf: string, chartTf: Interval): Interval {
  if (tf === "" || tf === undefined || tf === null) return chartTf;
  const t = String(tf).toUpperCase();
  if (t === "D" || t === "1D") return "1d";
  const map: Record<string, Interval> = {
    "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "120": "2h", "240": "4h", "360": "6h", "720": "12h",
  };
  const itv = map[t];
  if (!itv) throw new Error(`Unsupported Pine timeframe: "${tf}"`);
  return itv;
}

export function feedKey(symbol: string, interval: Interval): string {
  return `${symbol}|${interval}`;
}

/** Holds every (symbol, interval) bar series a strategy needs. */
export class FeedStore {
  private map = new Map<string, Bars>();

  set(bars: Bars): void {
    this.map.set(feedKey(bars.symbol, bars.interval), bars);
  }

  get(symbol: string, interval: Interval): Bars {
    const bars = this.map.get(feedKey(symbol, interval));
    if (!bars) throw new Error(`Missing feed: ${symbol} ${interval}`);
    return bars;
  }

  has(symbol: string, interval: Interval): boolean {
    return this.map.has(feedKey(symbol, interval));
  }
}

/**
 * For each chart bar i, the index j of the feed bar whose value the chart bar
 * sees under the TV-backtest convention, or -1 if none has closed yet.
 * O(n + m) two-pointer sweep.
 */
/**
 * The two candidate cutoffs. See the BE-08 note in this file's header.
 *
 *   `chartClose` — a chart bar sees the last feed bar that closed by the chart
 *                  bar's CLOSE. The final constituent bar of a higher-timeframe
 *                  period already sees that period's value, because the two
 *                  closes are simultaneous.
 *   `chartOpen`  — a chart bar sees the last feed bar that closed by the chart
 *                  bar's OPEN. A higher-timeframe value is delayed by one chart
 *                  bar, which is the convention the old header described.
 */
export const MERGE_CONVENTIONS = ["chartClose", "chartOpen"] as const;
export type MergeConvention = (typeof MERGE_CONVENTIONS)[number];

/**
 * The default is `chartClose` because that is what the code has always done,
 * and every stored result was produced under it. It is NOT asserted to be
 * correct — see BE-08.
 */
export const DEFAULT_MERGE_CONVENTION: MergeConvention =
  (process.env.MTF_MERGE_CONVENTION as MergeConvention | undefined) ?? "chartClose";

if (!(MERGE_CONVENTIONS as readonly string[]).includes(DEFAULT_MERGE_CONVENTION)) {
  throw new Error(
    `MTF_MERGE_CONVENTION must be one of ${MERGE_CONVENTIONS.join(", ")}, ` +
    `got ${JSON.stringify(process.env.MTF_MERGE_CONVENTION)}`
  );
}

export function buildMergeIndex(
  chart: Bars,
  feed: Bars,
  convention: MergeConvention = DEFAULT_MERGE_CONVENTION
): Int32Array {
  const n = chart.length;
  const idx = new Int32Array(n);
  let j = -1;
  for (let i = 0; i < n; i++) {
    // `chartOpen` compares against the bar's OPEN time, so a feed bar closing
    // exactly at that instant is not yet visible — hence `< cutoff` there, and
    // `<= cutoff` for `chartClose`, where a simultaneous close IS visible.
    if (convention === "chartClose") {
      const cutoff = chart.closeTime[i]!;
      while (j + 1 < feed.length && feed.closeTime[j + 1]! <= cutoff) j++;
    } else {
      const cutoff = chart.time[i]!;
      while (j + 1 < feed.length && feed.closeTime[j + 1]! < cutoff) j++;
    }
    idx[i] = j;
  }
  return idx;
}

/** Merge a numeric series computed on the feed TF onto chart bars (NaN before data). */
export function mergeValues(idx: Int32Array, src: number[]): number[] {
  const out = new Array<number>(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i]!;
    out[i] = j >= 0 ? src[j]! : NaN;
  }
  return out;
}

/** Merge a boolean series computed on the feed TF onto chart bars (false before data). */
export function mergeBools(idx: Int32Array, src: boolean[]): boolean[] {
  const out = new Array<boolean>(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i]!;
    out[i] = j >= 0 ? src[j]! : false;
  }
  return out;
}

/**
 * Slice a finer feed into the sub-bars covering one chart bar.
 *
 * The bar-magnifier source for `broker.ts`. Returns null when the finer feed
 * does not cover the bar at all, which the broker reads as "no finer path
 * available" and falls back to the whole-bar heuristic.
 *
 * A binary search over the finer feed's open times, so a 1-minute feed over a
 * year does not become a linear scan per chart bar.
 */
export function subBarsFor(
  chart: Bars,
  finer: Bars,
  i: number
): { open: number; high: number; low: number; close: number }[] | null {
  const start = chart.time[i];
  const end = chart.closeTime[i];
  if (start === undefined || end === undefined) return null;

  // First finer bar whose open time is at or after the chart bar's open.
  let lo = 0, hi = finer.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (finer.time[mid]! < start) lo = mid + 1;
    else hi = mid;
  }

  const out: { open: number; high: number; low: number; close: number }[] = [];
  for (let j = lo; j < finer.length && finer.time[j]! <= end; j += 1) {
    // A finer bar that runs past the chart bar's close does not belong to it.
    if (finer.closeTime[j]! > end) break;
    out.push({
      open: finer.open[j]!, high: finer.high[j]!,
      low: finer.low[j]!, close: finer.close[j]!,
    });
  }
  return out.length > 0 ? out : null;
}
