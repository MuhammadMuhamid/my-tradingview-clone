/**
 * regime_hold — the minimal test of the one component that survived out-of-sample.
 *
 * The MA+R:R walk-forward measured, on data the optimizer never saw:
 *     up-market blocks   : market +88.6%, strategy +5.6%   ->  6.4% upside capture
 *     down-market blocks : market -29.5%, strategy -3.3%   -> 11.1% downside capture
 *
 * So the trend filter genuinely avoids downtrends; the entry/stop/take-profit
 * machinery is what threw the upside away. This module keeps the filter and
 * deletes everything else: hold a full spot position while the regime is
 * bullish, sit flat while it is not. No entry trigger, no swing-low stop, no
 * take-profit, no partial exits.
 *
 * Deliberately tiny parameter count (4 searched, and `mode` only picks between
 * three 1-2 parameter definitions). 31 parameters against ~40 trades is what
 * broke the original system; this has to be resistant to the same failure or it
 * proves nothing.
 *
 * Long-only spot, same broker/cost model as every other tree here.
 * Nothing under src/engine/strategies is imported or modified.
 */
import * as ta from "../../../platform/backend/src/engine/ta";
import { Broker, BrokerOptions } from "../../../platform/backend/src/engine/broker";
import { FeedStore, Bars, pineTfToInterval } from "../../../platform/backend/src/engine/mtf";
import type { Interval } from "../../../platform/backend/src/types/market";
import type { EquityPoint } from "../../../platform/backend/src/types/backtest";

export const REGIME_DEFAULTS = {
  mode: "ema_slope",      // "ema_slope" | "supertrend" | "ma_align"
  regimeTf: "",           // "" = chart timeframe
  fastLen: 50,
  slowLen: 200,
  slopeLb: 10,
  stLen: 10,
  stMult: 3.0,
  exitConfirmBars: 1,     // consecutive bearish bars required before going flat
  qty_pct_equity: 100,
  qty_cash: 1000,
  fill_bar_close: true,
};

export type RegimeParams = { [K in keyof typeof REGIME_DEFAULTS]: (typeof REGIME_DEFAULTS)[K] };

const num = (v: unknown, d: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown, d: string): string => (v === undefined || v === null ? d : String(v));
const bool = (v: unknown, d: boolean): boolean =>
  typeof v === "boolean" ? v : typeof v === "string" ? v === "true" : d;

export function resolveParams(raw: Record<string, unknown>): RegimeParams {
  const out = { ...REGIME_DEFAULTS } as Record<string, number | string | boolean>;
  for (const k of Object.keys(REGIME_DEFAULTS)) {
    const def = (REGIME_DEFAULTS as Record<string, number | string | boolean>)[k]!;
    const got = raw[k];
    if (got === undefined) continue;
    out[k] = typeof def === "number" ? num(got, def)
      : typeof def === "boolean" ? bool(got, def)
      : str(got, def as string);
  }
  return out as unknown as RegimeParams;
}

export function requiredFeeds(p: RegimeParams, chartTf: Interval): { symbol: null; interval: Interval; warmupBars: number }[] {
  const need = new Map<Interval, number>();
  const add = (iv: Interval, w: number): void => { need.set(iv, Math.max(need.get(iv) ?? 0, w)); };
  add(chartTf, 300);
  const rIv = pineTfToInterval(String(p.regimeTf), chartTf);
  add(rIv, Math.max(p.slowLen * 4, p.fastLen * 4, p.stLen * 6, 300) + 60);
  return [...need.entries()].map(([interval, warmupBars]) => ({ symbol: null, interval, warmupBars }));
}

/** Wilder-style Supertrend direction: +1 bullish, -1 bearish. */
function supertrendDir(b: Bars, len: number, mult: number): number[] {
  const n = b.close.length;
  const atr = ta.atr(b.high, b.low, b.close, len);
  const src = ta.hl2(b.high, b.low);
  const dir = new Array<number>(n).fill(1);
  let upPrev = NaN, dnPrev = NaN, dPrev = 1;
  for (let i = 0; i < n; i++) {
    const a = atr[i]!;
    if (Number.isNaN(a)) { dir[i] = 1; continue; }
    let up = src[i]! - mult * a;
    let dn = src[i]! + mult * a;
    const cPrev = i > 0 ? b.close[i - 1]! : b.close[i]!;
    if (!Number.isNaN(upPrev)) up = cPrev > upPrev ? Math.max(up, upPrev) : up;
    if (!Number.isNaN(dnPrev)) dn = cPrev < dnPrev ? Math.min(dn, dnPrev) : dn;
    let d = dPrev;
    if (dPrev === -1 && b.close[i]! > dnPrev) d = 1;
    else if (dPrev === 1 && b.close[i]! < upPrev) d = -1;
    dir[i] = d;
    upPrev = up; dnPrev = dn; dPrev = d;
  }
  return dir;
}

/** Bullish-regime boolean on the regime feed, then merged onto chart bars. */
function regimeSeries(feeds: FeedStore, symbol: string, chartTf: Interval, p: RegimeParams): boolean[] {
  const chart = feeds.get(symbol, chartTf);
  const rIv = pineTfToInterval(String(p.regimeTf), chartTf);
  const rf = feeds.get(symbol, rIv);
  const n = rf.close.length;
  const bull = new Array<boolean>(n).fill(false);

  if (p.mode === "supertrend") {
    const d = supertrendDir(rf, p.stLen, p.stMult);
    for (let i = 0; i < n; i++) bull[i] = d[i] === 1;
  } else if (p.mode === "ma_align") {
    const f = ta.ema(rf.close, p.fastLen);
    const s = ta.ema(rf.close, p.slowLen);
    const sSlope = ta.change(ta.shift(s, 0));
    for (let i = 0; i < n; i++) {
      const rising = i >= p.slopeLb && !Number.isNaN(s[i]!) && !Number.isNaN(s[i - p.slopeLb]!)
        && s[i]! > s[i - p.slopeLb]!;
      bull[i] = !Number.isNaN(f[i]!) && !Number.isNaN(s[i]!)
        && f[i]! > s[i]! && rising && rf.close[i]! > s[i]! && ta.nz(sSlope[i]!) >= 0;
    }
  } else { // ema_slope — the default: price above a rising slow EMA, fast above slow
    const f = ta.ema(rf.close, p.fastLen);
    const s = ta.ema(rf.close, p.slowLen);
    for (let i = 0; i < n; i++) {
      const rising = i >= p.slopeLb && !Number.isNaN(s[i]!) && !Number.isNaN(s[i - p.slopeLb]!)
        && s[i]! > s[i - p.slopeLb]!;
      bull[i] = !Number.isNaN(f[i]!) && !Number.isNaN(s[i]!) && f[i]! > s[i]! && rising;
    }
  }

  // Merge regime-TF booleans onto chart bars with the [1] closed-bar shift, so a
  // chart bar only ever sees a regime bar that had already closed. Same
  // lookahead_off convention the other trees use.
  if (rIv === chartTf) return bull;
  const shifted = [false, ...bull.slice(0, -1)];
  const out = new Array<boolean>(chart.close.length).fill(false);
  let j = 0;
  for (let i = 0; i < chart.close.length; i++) {
    while (j + 1 < rf.time.length && rf.time[j + 1]! <= chart.time[i]!) j++;
    out[i] = rf.time[j]! <= chart.time[i]! ? shifted[j]! : false;
  }
  return out;
}

export interface RunResult {
  broker: Broker;
  equityCurve: EquityPoint[];
  barsProcessed: number;
  buyHoldPct: number;
  barsLong: number;
}

export function runBars(
  feeds: FeedStore,
  symbol: string,
  chartTf: Interval,
  p: RegimeParams,
  brokerOpts: BrokerOptions,
  range: { startMs: number; endMs: number }
): RunResult {
  const chart = feeds.get(symbol, chartTf);
  const bull = regimeSeries(feeds, symbol, chartTf, p);
  const broker = new Broker(brokerOpts);

  const equityCurve: EquityPoint[] = [];
  let equityPeak = brokerOpts.initialCapital;
  let bearRun = 0;
  let barsLong = 0;

  const startIdx = chart.time.findIndex((t) => t >= range.startMs);
  if (startIdx < 0) throw new Error("no chart bars in the requested range");
  let barsProcessed = 0;
  let firstClose = NaN, lastClose = NaN;

  for (let i = startIdx; i < chart.length; i++) {
    if (chart.time[i]! > range.endMs) break;
    barsProcessed++;
    const close = chart.close[i]!;
    if (Number.isNaN(firstClose)) firstClose = close;
    lastClose = close;

    broker.processOpen(chart, i);
    // No brackets: this strategy has no stop and no take-profit by design.

    const pos = broker.positionQty;
    if (pos > 0) barsLong++;

    bearRun = bull[i] ? 0 : bearRun + 1;

    if (pos === 0 && bull[i]!) broker.queueEntry("regime bull");
    else if (pos > 0 && bearRun >= Math.max(1, p.exitConfirmBars)) broker.queueClose("regime bear");

    broker.processClose(chart, i);

    const equity = broker.equityAt(close);
    const lowEquity = broker.equityAt(chart.low[i]!);
    if (equity > equityPeak) equityPeak = equity;
    equityCurve.push({
      t: chart.time[i]!,
      equity,
      drawdownPct: equityPeak > 0 ? ((equityPeak - Math.min(equity, lowEquity)) / equityPeak) * 100 : 0,
    });
  }

  let cum = 0;
  for (const t of broker.closed) { cum += t.pnl ?? 0; t.cumProfit = cum; }

  const buyHoldPct = Number.isNaN(firstClose) || firstClose <= 0
    ? 0 : ((lastClose / firstClose) - 1) * 100;

  return { broker, equityCurve, barsProcessed, buyHoldPct, barsLong };
}

export const regimeHoldModule = {
  key: "regime_hold",
  name: "Regime Hold",
  defaultParams: REGIME_DEFAULTS,
  resolveParams,
  requiredFeeds,
  runBars,
};
