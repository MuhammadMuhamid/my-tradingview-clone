/**
 * Multi-timeframe machinery — the local equivalent of Pine's
 * request.security(sym, tf, expr, barmerge.gaps_off, barmerge.lookahead_off).
 *
 * ── BE-08 RESOLVED: historical lookahead_off uses the chart close ────────
 *
 * TradingView's Pine v6 documentation states that a `lookahead_off` series has
 * a new historical value at the END of each HTF period. On a 15m chart
 * requesting 60m data, the 60m value is therefore first visible on the 15m bar
 * that closes with it (for example, the 00:45 bar closing at 01:00 UTC).
 *
 * That is the `chartClose` convention implemented here: the latest feed bar
 * with `closeTime <= chart.closeTime`. It does not leak future data because a
 * selected feed bar has closed no later than the chart bar itself.
 *
 * The alternate `chartOpen` convention is retained as an explicit diagnostic
 * option. It delays the new value until the next chart bar and does not match
 * TradingView's documented historical `lookahead_off` boundary.
 *
 * See `docs/BE-08-VALIDATION.md` and `tests/securityHtf.test.ts`. Realtime
 * developing HTF values are separate semantics and are not synthesized by the
 * historical merge or Pine interpreter.
 */
import type { Interval } from "../types/market";
import type { FoldableBar, Resolution } from "../data/resolution";

export interface Bars {
  symbol: string;
  /**
   * The resolution these bars ARE.
   *
   * A `Resolution` rather than an `Interval` because a chart may be on `45m`,
   * and a script asking `timeframe.period` on that chart must be told `45m`.
   * Reporting the `15m` source the bars were folded from would be a quiet lie
   * about the series the script is running over.
   */
  interval: Resolution;
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

export function toBars(candles: readonly FoldableBar[]): Bars {
  const n = candles.length;
  const b: Bars = {
    symbol: candles[0]?.symbol ?? "",
    interval: candles[0]?.interval ?? "1m",
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
/*
 * Two overloads rather than one widened signature.
 *
 * The empty string means "the chart's own timeframe", so this function returns
 * whatever it was given for that case — and a caller that handed it a native
 * `Interval` (every strategy does; the engine has no derived feeds) must get an
 * `Interval` back, not a `string` it then has to re-narrow. A caller that handed
 * it a chart `Resolution` gets a `Resolution`.
 */
export function pineTfToInterval(tf: string, chartTf: Interval): Interval;
export function pineTfToInterval(tf: string, chartTf: Resolution): Resolution;
export function pineTfToInterval(tf: string, chartTf: Resolution): Resolution {
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

export function feedKey(symbol: string, interval: Resolution): string {
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
 * The supported cutoff and the retained diagnostic alternative. See the BE-08
 * note in this file's header.
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
 * The default is `chartClose`: the documented TradingView historical
 * `lookahead_off` boundary and the convention used by existing stored results.
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
