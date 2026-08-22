/**
 * Multi-timeframe machinery — the local equivalent of Pine's
 * request.security(sym, tf, expr, barmerge.gaps_off, barmerge.lookahead_off).
 *
 * TV-backtest merge convention (what the TradingView Strategy Tester shows on
 * historical bars): a chart bar sees the value of the most recent OTHER-TF bar
 * that had CLOSED by the relevant moment:
 *   - higher TF:  last HTF bar with closeTime <= chart bar's OPEN time
 *                 (the classic one-HTF-bar delay; hour-10's value first appears
 *                 on the chart bar opening at 11:00)
 *   - lower/equal TF: last bar with closeTime <= chart bar's CLOSE time
 *                 (same-TF passthrough falls out of this rule naturally)
 *
 * Live/realtime TV behaves differently (developing HTF values) — the Stage 3
 * live runner implements that mode on top of the same feeds.
 */
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";

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
export function buildMergeIndex(chart: Bars, feed: Bars): Int32Array {
  const n = chart.length;
  const idx = new Int32Array(n);
  // Verified against TV (DEXE parity run 2026-07-11): for higher AND lower
  // TFs, a chart bar sees the last feed bar that has CLOSED by the chart
  // bar's close. In particular the final constituent bar of an HTF period
  // (15m bar closing 09:00 on a 1h feed) already sees that HTF bar's value —
  // the HTF close and chart close are simultaneous, and Pine evaluates at
  // the chart bar's close.
  let j = -1;
  for (let i = 0; i < n; i++) {
    const cutoff = chart.closeTime[i]!;
    while (j + 1 < feed.length && feed.closeTime[j + 1]! <= cutoff) j++;
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
