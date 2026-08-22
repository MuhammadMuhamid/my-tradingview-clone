/**
 * ma_rr_v9 signal computation — a line-faithful port of the indicator and
 * condition logic of ma_riskreward_strategy.pine (lines 425–1012).
 *
 * Everything here is position-INDEPENDENT and therefore precomputable as
 * arrays over the chart bars. The stateful gates (choppy pause, run limit,
 * cooldown, one-trade latch, unrealized-R gates, R:R bracket engine) live in
 * the bar loop in index.ts, mirroring the Pine execution order.
 */
import type { Interval } from "../../../types/market";
import { INTERVAL_MS } from "../../../types/market";
import {
  Bars, FeedStore, buildMergeIndex, mergeValues, mergeBools, pineTfToInterval,
} from "../../mtf";
import * as ta from "../../ta";
import type { MaRrParams } from "./params";

export interface SignalArrays {
  n: number;
  /** long_en && frameworkLongOk && filtLong (Pine rawLongSetup minus position/state gates) */
  longSetup: boolean[];
  /** Position-independent confirmation filters, reusable by SR entry modules. */
  filterLong: boolean[];
  /** Enabled non-primary MA/AlphaTrend/HACOLT framework confirmations. */
  confirmationLong: boolean[];
  /** Raw higher-high state, before the useHhStructure gate. */
  hhTrendStrong: boolean[];
  /** arms the one-trade-per-signal latch */
  anyIndBuyTrig: boolean[];
  /** Fresh event from an enabled PRIMARY, with the complete entry setup valid. */
  freshPrimaryBuy: boolean[];
  // Soft-exit components (Pine exitWhy precedence is applied in the bar loop)
  exitMaTrig: boolean[];
  belowSt: boolean[];
  belowMa1: boolean[];
  belowLinReg: boolean[];
  rsiExit: boolean[];
  // HL structure break: close below last pivot low (R-gate applied in loop)
  hlBreak: boolean[];
  // Indicator SELL exits (ungated by R)
  rfSell: boolean[];
  atSell: boolean[];
  hacSell: boolean[];
  utSell: boolean[];
  // R:R primitives
  atrRisk: number[];
  rrSwingLow: number[];
}

const pickSrc = (bars: Bars, name: string): number[] =>
  name === "Open" ? bars.open : name === "High" ? bars.high : name === "Low" ? bars.low : bars.close;

// ── Recursive indicator ports (sequential, Pine-literal) ───────────────────────

/** SuperTrend exactly as f_super_trend_htf / the chart-TF block computes it. */
function superTrend(bars: Bars, atrLen: number, mult: number): { up: number[]; dn: number[]; trend: number[] } {
  const n = bars.length;
  const atrArr = ta.atr(bars.high, bars.low, bars.close, atrLen);
  const src = ta.hl2(bars.high, bars.low);
  const up = new Array<number>(n).fill(NaN);
  const dn = new Array<number>(n).fill(NaN);
  const trend = new Array<number>(n).fill(1);
  for (let i = 0; i < n; i++) {
    let u = src[i]! - mult * atrArr[i]!;
    let d = src[i]! + mult * atrArr[i]!;
    const u1 = i > 0 && !Number.isNaN(up[i - 1]!) ? up[i - 1]! : u;
    const d1 = i > 0 && !Number.isNaN(dn[i - 1]!) ? dn[i - 1]! : d;
    const pc = i > 0 ? bars.close[i - 1]! : NaN;
    if (pc > u1) u = Math.max(u, u1);
    if (pc < d1) d = Math.min(d, d1);
    let t = i > 0 ? trend[i - 1]! : 1;
    if (t === -1 && bars.close[i]! > d1) t = 1;
    else if (t === 1 && bars.close[i]! < u1) t = -1;
    up[i] = u;
    dn[i] = d;
    trend[i] = t;
  }
  return { up, dn, trend };
}

/** Range Filter (f_smoothrng + f_rngfilt + signal logic), NaN semantics intact. */
function rangeFilter(bars: Bars, per: number, mult: number): {
  evtLong: boolean[]; sellEvt: boolean[]; stateLong: boolean[]; stateShort: boolean[];
} {
  const n = bars.length;
  const x = bars.close;
  const absCh = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) absCh[i] = Math.abs(x[i]! - x[i - 1]!);
  const avrng = ta.ema(absCh, per);
  const smoothed = ta.ema(avrng, per * 2 - 1).map((v) => v * mult);
  const filt = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? filt[i - 1]! : NaN;
    const r = smoothed[i]!;
    if (Number.isNaN(prev)) filt[i] = x[i]!;
    else if (x[i]! > prev) filt[i] = x[i]! - r < prev ? prev : x[i]! - r;
    else filt[i] = x[i]! + r > prev ? prev : x[i]! + r;
  }
  const up = new Array<number>(n).fill(0);
  const dn = new Array<number>(n).fill(0);
  const ci = new Array<number>(n).fill(0);
  const evtLong = new Array<boolean>(n).fill(false);
  const sellEvt = new Array<boolean>(n).fill(false);
  const stateLong = new Array<boolean>(n).fill(false);
  const stateShort = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const pf = i > 0 ? filt[i - 1]! : NaN;
    const f = filt[i]!;
    const pu = i > 0 ? up[i - 1]! : 0;
    const pd = i > 0 ? dn[i - 1]! : 0;
    up[i] = f > pf ? pu + 1 : f < pf ? 0 : pu;
    dn[i] = f < pf ? pd + 1 : f > pf ? 0 : pd;
    const px = i > 0 ? x[i - 1]! : NaN;
    const lraw = x[i]! > f && up[i]! > 0 && (x[i]! > px || x[i]! < px);
    const sraw = x[i]! < f && dn[i]! > 0 && (x[i]! < px || x[i]! > px);
    const prevCi = i > 0 ? ci[i - 1]! : 0;
    ci[i] = lraw ? 1 : sraw ? -1 : prevCi;
    evtLong[i] = lraw && prevCi === -1;
    sellEvt[i] = sraw && prevCi === 1;
    stateLong[i] = up[i]! > 0;
    stateShort[i] = dn[i]! > 0;
  }
  return { evtLong, sellEvt, stateLong, stateShort };
}

/** Q-Trend (chart TF only — the Pine has no request.security around it). */
function qTrend(bars: Bars, p: number, atrP: number, mult: number): {
  evtLong: boolean[]; stateLong: boolean[]; evtShort: boolean[];
} {
  const n = bars.length;
  const src = bars.close;
  const h = ta.highest(src, p);
  const l = ta.lowest(src, p);
  const atrArr = ta.shift(ta.atr(bars.high, bars.low, bars.close, atrP), 1);
  const m = new Array<number>(n).fill(NaN);
  const ls = new Array<number>(n).fill(0); // 0 = na, 1 = "B", -1 = "S"
  const evtLong = new Array<boolean>(n).fill(false);
  const evtShort = new Array<boolean>(n).fill(false);
  const stateLong = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const eps = mult * atrArr[i]!;
    const base = (h[i]! + l[i]!) / 2;
    const prevM = i > 0 ? m[i - 1]! : NaN;
    // qtM := bar_index > qt_p ? nz(qtM[1], base) : base
    let cur = i > p ? (Number.isNaN(prevM) ? base : prevM) : base;
    // crossover/crossunder against (m + eps) use the previous bar's FINAL m/eps
    const prevEps = i > 0 ? mult * atrArr[i - 1]! : NaN;
    const prevSrc = i > 0 ? src[i - 1]! : NaN;
    const upXo = src[i]! > cur + eps && prevSrc <= prevM + prevEps;
    const dnXu = src[i]! < cur - eps && prevSrc >= prevM - prevEps;
    const changeUp = upXo || src[i]! > cur + eps;
    const changeDn = dnXu || src[i]! < cur - eps;
    // qtM := (up|dn) and qtM != qtM[1] ? qtM : up ? qtM+eps : dn ? qtM-eps : nz(qtM[1], qtM)
    if ((changeUp || changeDn) && cur !== prevM) {
      // keep cur
    } else if (changeUp) cur = cur + eps;
    else if (changeDn) cur = cur - eps;
    else cur = Number.isNaN(prevM) ? cur : prevM;
    m[i] = cur;
    const prevLs = i > 0 ? ls[i - 1]! : 0;
    ls[i] = changeUp ? 1 : changeDn ? -1 : prevLs;
    // Pine: evt requires qtLs[1] != "B" — a na previous latch compares as false.
    evtLong[i] = changeUp && prevLs !== 0 && prevLs !== 1;
    evtShort[i] = changeDn && prevLs !== 0 && prevLs !== -1;
    stateLong[i] = ls[i] === 1;
  }
  return { evtLong, stateLong, evtShort };
}

/** AlphaTrend (f_alphatrend). Returns events, states and the line itself. */
function alphaTrend(bars: Bars, coeff: number, ap: number, novol: boolean): {
  evtLong: boolean[]; sellEvt: boolean[]; stateLong: boolean[]; line: number[];
} {
  const n = bars.length;
  const trArr = ta.trueRange(bars.high, bars.low, bars.close);
  const aAtr = ta.sma(trArr, ap);
  const mom = novol ? ta.rsi(bars.close, ap) : ta.mfi(ta.hlc3(bars.high, bars.low, bars.close), bars.volume, ap);
  const at = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const up = bars.low[i]! - aAtr[i]! * coeff;
    const dn = bars.high[i]! + aAtr[i]! * coeff;
    const prev = i > 0 ? ta.nz(at[i - 1]!) : 0;
    at[i] = mom[i]! >= 50 ? (up < prev ? prev : up) : (dn > prev ? prev : dn);
  }
  const at2 = ta.shift(at, 2);
  const buyRaw = ta.crossover(at, at2);
  const sellRaw = ta.crossunder(at, at2);
  const k1 = ta.barssince(buyRaw);
  const k2 = ta.barssince(sellRaw);
  const buyRawPrev = [false, ...buyRaw.slice(0, -1)];
  const sellRawPrev = [false, ...sellRaw.slice(0, -1)];
  const o1 = ta.barssince(buyRawPrev);
  const o2 = ta.barssince(sellRawPrev);
  const evtLong = buyRaw.map((b, i) => b && o1[i]! > k2[i]!);   // NaN > x → false, as in Pine
  const sellEvt = sellRaw.map((s, i) => s && o2[i]! > k1[i]!);
  const stateLong = at.map((v, i) => v > at2[i]!);
  return { evtLong, sellEvt, stateLong, line: at };
}

/** HACOLT (f_hacolt) — Vervoort Heikin-Ashi oscillator, literal port. */
function hacolt(bars: Bars, len: number, emaLen: number, csf: number): {
  evtLong: boolean[]; sellEvt: boolean[]; stateLong: boolean[];
} {
  const n = bars.length;
  const o4 = ta.ohlc4(bars.open, bars.high, bars.low, bars.close);
  const haOpen = new Array<number>(n).fill(NaN);
  const haClose = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    haOpen[i] = i === 0 || Number.isNaN(haOpen[i - 1]!) ? o4[i]! : (haOpen[i - 1]! + o4[i]!) / 2;
    haClose[i] = (haOpen[i]! + Math.max(bars.high[i]!, haOpen[i]!) + Math.min(bars.low[i]!, haOpen[i]!) + o4[i]!) / 4;
  }
  const tema = (src: number[]): number[] => {
    const e1 = ta.ema(src, len);
    const e2 = ta.ema(e1, len);
    const e3 = ta.ema(e2, len);
    return e1.map((v, i) => 3 * (v - e2[i]!) + e3[i]!);
  };
  const thaClose = tema(haClose);
  const thl2 = tema(ta.hl2(bars.high, bars.low));
  const temaThaClose = tema(thaClose);
  const temaThl2 = tema(thl2);
  const closeSm = thaClose.map((v, i) => 2 * v - temaThaClose[i]!);
  const hl2Sm = thl2.map((v, i) => 2 * v - temaThl2[i]!);
  const ltEma = ta.ema(bars.close, emaLen);

  const keepn1Arr = new Array<boolean>(n).fill(false);
  const keepAll1Arr = new Array<boolean>(n).fill(false);
  const keepn2Arr = new Array<boolean>(n).fill(false);
  const keepAll2Arr = new Array<boolean>(n).fill(false);
  const utrArr = new Array<boolean>(n).fill(false);
  const dtrArr = new Array<boolean>(n).fill(false);
  const upwOffF = new Array<number>(n).fill(0);
  const neutralF = new Array<number>(n).fill(0);
  const hv = new Array<number>(n).fill(0);
  const evtLong = new Array<boolean>(n).fill(false);
  const sellEvt = new Array<boolean>(n).fill(false);
  const stateLong = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    const c = bars.close[i]!, o = bars.open[i]!, h = bars.high[i]!, l = bars.low[i]!;
    const pc = i > 0 ? bars.close[i - 1]! : NaN;
    const ph = i > 0 ? bars.high[i - 1]! : NaN;
    const pl = i > 0 ? bars.low[i - 1]! : NaN;
    const shortCandle = Math.abs(c - o) < (h - l) * csf;
    const haBull = haClose[i]! >= haOpen[i]!;
    const haBullPrev = i > 0 ? haClose[i - 1]! >= haOpen[i - 1]! : false;
    const keepn1 = (haBull && haBullPrev) || c >= haClose[i]! || h > ph || l > pl || hl2Sm[i]! >= closeSm[i]!;
    // Pine precedence: A or (B and C) or D
    const keepAll1 = keepn1 || (keepn1Arr[i - 1] === true && c >= o) || c >= pc;
    const keep13 = shortCandle && h >= pl;
    const utr = keepAll1 || (keepAll1Arr[i - 1] === true && keep13);
    const keepn2 = (haClose[i]! < haOpen[i]! && (i > 0 ? haClose[i - 1]! < haOpen[i - 1]! : false)) || hl2Sm[i]! < closeSm[i]!;
    const keep23 = shortCandle && l <= ph;
    const keepAll2 = keepn2 || (keepn2Arr[i - 1] === true && c < o) || c < pc;
    const dtr = keepAll2 || (keepAll2Arr[i - 1] === true && keep23);
    const upw = !dtr && (dtrArr[i - 1] === true) && utr;
    const dnw = !utr && (utrArr[i - 1] === true) && dtr;
    upwOffF[i] = upw !== dnw ? (upw ? 1 : 0) : i > 0 ? upwOffF[i - 1]! : 0;
    const buySig = upw || (!dnw && upwOffF[i]! > 0);
    const ltSell = c < ltEma[i]!;
    neutralF[i] = buySig ? 1 : ltSell ? 0 : i > 0 ? neutralF[i - 1]! : 0;
    hv[i] = buySig ? 1 : neutralF[i]! > 0 ? 0 : -1;
    const prevHv = i > 0 ? hv[i - 1]! : 0;
    evtLong[i] = hv[i] === 1 && prevHv !== 1;
    sellEvt[i] = hv[i] === -1 && prevHv !== -1;
    stateLong[i] = hv[i]! > 0;
    keepn1Arr[i] = keepn1;
    keepAll1Arr[i] = keepAll1;
    keepn2Arr[i] = keepn2;
    keepAll2Arr[i] = keepAll2;
    utrArr[i] = utr;
    dtrArr[i] = dtr;
  }
  return { evtLong, sellEvt, stateLong };
}

/** UT Bot Alerts (f_ut_bot). */
function utBot(bars: Bars, key: number, atrP: number, heikin: boolean): {
  evtLong: boolean[]; sellEvt: boolean[]; stateLong: boolean[];
} {
  const n = bars.length;
  const o4 = ta.ohlc4(bars.open, bars.high, bars.low, bars.close);
  const src = new Array<number>(n);
  if (heikin) {
    // haC = ohlc4 (the Pine's inline HA close is just ohlc4; haO is unused for src)
    for (let i = 0; i < n; i++) src[i] = o4[i]!;
  } else {
    for (let i = 0; i < n; i++) src[i] = bars.close[i]!;
  }
  const atrArr = ta.atr(bars.high, bars.low, bars.close, atrP);
  const stop = new Array<number>(n).fill(0);
  const evtLong = new Array<boolean>(n).fill(false);
  const sellEvt = new Array<boolean>(n).fill(false);
  const stateLong = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const nLoss = key * atrArr[i]!;
    const prevStop = i > 0 ? ta.nz(stop[i - 1]!, 0) : 0;
    const s = src[i]!;
    const ps = i > 0 ? src[i - 1]! : NaN;
    stop[i] =
      s > prevStop && ps > prevStop ? Math.max(prevStop, s - nLoss) :
      s < prevStop && ps < prevStop ? Math.min(prevStop, s + nLoss) :
      s > prevStop ? s - nLoss : s + nLoss;
    // em = ema(src, 1) = src.
    // buy  = src > stop AND crossover(em, stop):  em > stop && em[1] <= stop[1]
    // sell = src < stop AND crossover(stop, em): stop > em && stop[1] <= em[1]
    const prevStopRaw = i > 0 ? stop[i - 1]! : NaN;
    evtLong[i] = s > stop[i]! && ps <= prevStopRaw;
    sellEvt[i] = s < stop[i]! && prevStopRaw <= ps;
    stateLong[i] = s > stop[i]!;
  }
  return { evtLong, sellEvt, stateLong };
}

// ── Feed helpers ───────────────────────────────────────────────────────────────

interface Ctx {
  feeds: FeedStore;
  chart: Bars;
  symbol: string;
  chartTf: Interval;
  p: MaRrParams;
  mergeCache: Map<string, Int32Array>;
}

function feedOf(ctx: Ctx, symbol: string | null, pineTf: string): { bars: Bars; idx: Int32Array } {
  const itv = pineTfToInterval(String(pineTf), ctx.chartTf);
  const sym = symbol ?? ctx.symbol;
  const bars = ctx.feeds.get(sym, itv);
  const key = `${sym}|${itv}`;
  let idx = ctx.mergeCache.get(key);
  if (!idx) {
    idx = buildMergeIndex(ctx.chart, bars);
    ctx.mergeCache.set(key, idx);
  }
  return { bars, idx };
}

/** f_ma_mtf: MA of a source on a Pine TF, merged onto chart bars. */
function maMtf(ctx: Ctx, en: boolean, pineTf: string, len: number, type: string, src: string): number[] {
  if (!en || len <= 0) return new Array<number>(ctx.chart.length).fill(NaN);
  const { bars, idx } = feedOf(ctx, null, pineTf);
  const ma = ta.maByType(type as ta.MaType, pickSrc(bars, src), len, bars.volume);
  return mergeValues(idx, ma);
}

const TRUE_ARR = (n: number): boolean[] => new Array<boolean>(n).fill(true);
const FALSE_ARR = (n: number): boolean[] => new Array<boolean>(n).fill(false);
const NAN_ARR = (n: number): number[] => new Array<number>(n).fill(NaN);

// ── Main computation ───────────────────────────────────────────────────────────

/** Bar open-times (ms) to dump entry-gate values for — parity debugging. */
export const DEBUG_TIMES = new Set<number>();

export function computeSignals(
  feeds: FeedStore, symbol: string, chartTf: Interval, p: MaRrParams
): SignalArrays {
  const chart = feeds.get(symbol, chartTf);
  const n = chart.length;
  const ctx: Ctx = { feeds, chart, symbol, chartTf, p, mergeCache: new Map() };
  const close = chart.close;
  const open = chart.open;
  const high = chart.high;
  const low = chart.low;

  const atrRisk = ta.atr(high, low, close, p.atrLenExit);
  const rrSwingLow = ta.lowest(low, p.rrSwingLb);

  // ── MTF MAs (ma1 also feeds the "below TF1 MA" exit) ──
  const needMa1 = p.useMaTrend || p.useExitBelowMa1;
  const ma1 = needMa1 ? maMtf(ctx, p.ma1_en, p.ma1_tf, p.ma1_len, p.ma1_type, p.ma1_src) : NAN_ARR(n);
  const ma2 = p.useMaTrend ? maMtf(ctx, p.ma2_en, p.ma2_tf, p.ma2_len, p.ma2_type, p.ma2_src) : NAN_ARR(n);
  const ma3 = p.useMaTrend ? maMtf(ctx, p.ma3_en, p.ma3_tf, p.ma3_len, p.ma3_type, p.ma3_src) : NAN_ARR(n);
  const ma4 = p.useMaTrend ? maMtf(ctx, p.ma4_en, p.ma4_tf, p.ma4_len, p.ma4_type, p.ma4_src) : NAN_ARR(n);

  const maPassLong = (en: boolean, m: number[], i: number): boolean => {
    if (!en) return true;
    if (Number.isNaN(m[i]!)) return !p.maBlockWhenNa;
    return close[i]! > m[i]!;
  };
  const slopeOk = (en: boolean, m: number[], lb: number, i: number): boolean => {
    if (!p.requireMaSlope || !en) return true;
    if (Number.isNaN(m[i]!)) return true;
    const prev = i >= lb ? m[i - lb]! : NaN;
    if (Number.isNaN(prev)) return true;
    return m[i]! > prev;
  };

  // ── VWMA trend ──
  let vwTrend = NAN_ARR(n);
  if (p.useVwmaTrend && p.vwmaLen > 0) {
    const { bars, idx } = feedOf(ctx, null, p.vwmaTf);
    const cv = ta.sma(bars.close.map((c, i) => c * bars.volume[i]!), p.vwmaLen);
    const vm = ta.sma(bars.volume, p.vwmaLen);
    const res = cv.map((v, i) => (!Number.isNaN(vm[i]!) && vm[i]! > 0 ? v / vm[i]! : NaN));
    vwTrend = mergeValues(idx, res);
  }

  // ── Exit MA cross (computed on the HTF series, merged as a bool) ──
  let exitMaTrig = FALSE_ARR(n);
  if (p.useExitLongMa) {
    const { bars, idx } = feedOf(ctx, null, p.exitMaTf);
    const m = ta.maByType(p.exitMaType as ta.MaType, pickSrc(bars, p.exitMaSrc), p.exitMaLen, bars.volume);
    exitMaTrig = mergeBools(idx, ta.crossunder(bars.close, m));
  }

  // ── SuperTrend (chart TF or HTF, per stIsChartTf) ──
  let stBull = TRUE_ARR(n);
  let stLine = NAN_ARR(n);
  if (p.useSuperTrend || p.useExitBelowSt) {
    const stItv = pineTfToInterval(p.stTf, chartTf);
    if (INTERVAL_MS[stItv] === INTERVAL_MS[chartTf]) {
      const st = superTrend(chart, p.stAtrLen, p.stMult);
      stBull = st.trend.map((t) => t === 1);
      stLine = st.trend.map((t, i) => (t === 1 ? st.up[i]! : st.dn[i]!));
    } else {
      const { bars, idx } = feedOf(ctx, null, p.stTf);
      const st = superTrend(bars, p.stAtrLen, p.stMult);
      const trendM = mergeValues(idx, st.trend);
      const upM = mergeValues(idx, st.up);
      const dnM = mergeValues(idx, st.dn);
      stBull = trendM.map((t) => t === 1);
      stLine = trendM.map((t, i) => (t === 1 ? upM[i]! : dnM[i]!));
    }
  }

  // ── LinReg candles ──
  let bopen = open, bclose = close;
  if (p.useLinReg) {
    const { bars, idx } = feedOf(ctx, null, p.lrTf);
    bopen = mergeValues(idx, ta.linreg(bars.open, p.lrLen, 0));
    bclose = mergeValues(idx, ta.linreg(bars.close, p.lrLen, 0));
  }
  const sig = p.sigUseSma ? ta.sma(bclose, p.sigLen) : ta.ema(bclose, p.sigLen);
  const lrLongOkAt = (i: number): boolean => {
    if (!p.useLinReg) return true;
    const green = bopen[i]! < bclose[i]!;
    if (p.lrLongRule === "Green candle") return green;
    if (p.lrLongRule === "Close > signal") return bclose[i]! > sig[i]!;
    return green && bclose[i]! > sig[i]!;
  };

  // ── Local EMA stack ──
  let localFast = NAN_ARR(n), localSlow = NAN_ARR(n);
  if (p.useLocalTrend) {
    const { bars, idx } = feedOf(ctx, null, p.localTrendTf);
    localFast = mergeValues(idx, ta.ema(bars.close, p.localEmaFast));
    localSlow = mergeValues(idx, ta.ema(bars.close, p.localEmaSlow));
  }

  // ── Volume filter ──
  let volCur = NAN_ARR(n), volSma = NAN_ARR(n);
  if (p.useVolumeFilter) {
    const { bars, idx } = feedOf(ctx, null, p.volTf);
    volCur = mergeValues(idx, bars.volume);
    volSma = mergeValues(idx, ta.sma(bars.volume, p.volMaLen));
  }

  // ── Higher-high structure ──
  let hhLast = NAN_ARR(n), hhPrior = NAN_ARR(n);
  if (p.useHhStructure) {
    const { bars, idx } = feedOf(ctx, null, p.hhTf);
    const ph = ta.pivothigh(bars.high, p.hhPivotLen, p.hhPivotLen);
    const cond = ph.map((v) => !Number.isNaN(v));
    hhLast = mergeValues(idx, ta.valuewhen(cond, ph, 0));
    hhPrior = mergeValues(idx, ta.valuewhen(cond, ph, 1));
  }

  // ── RSI (band filter + rollover exit) ──
  let rsiVal = NAN_ARR(n);
  let rsiExitArr = FALSE_ARR(n);
  if (p.useRsiFilter || p.useRsiExit) {
    const { bars, idx } = feedOf(ctx, null, p.rsiTf);
    rsiVal = mergeValues(idx, ta.rsi(bars.close, p.rsiLengthInput));
    if (p.useRsiExit) {
      const level = new Array<number>(n).fill(p.rsiExitLevel);
      rsiExitArr = ta.crossunder(rsiVal, level);
    }
  }

  // ── HL structure break pivot low ──
  let hlPivLow = NAN_ARR(n);
  if (p.useHlBreakExit) {
    const { bars, idx } = feedOf(ctx, null, p.hlBreakTf);
    const pl = ta.pivotlow(bars.low, p.hlBreakPivLen, p.hlBreakPivLen);
    const cond = pl.map((v) => !Number.isNaN(v));
    hlPivLow = mergeValues(idx, ta.valuewhen(cond, pl, 0));
  }

  // ── Peak / spike filters ──
  const extRefEma = p.useExtFilter ? ta.ema(close, p.extRefLen) : NAN_ARR(n);
  const atrAvgSpk = p.useAtrSpike ? ta.sma(atrRisk, p.atrSpikeAvgLen) : NAN_ARR(n);

  // ── Range Filter (entry TF + exit TF) ──
  let rfEvtLong = FALSE_ARR(n), rfStateLong = TRUE_ARR(n), rfSellArr = FALSE_ARR(n);
  if (p.rf_en) {
    const { bars, idx } = feedOf(ctx, null, p.rf_tf);
    const rf = rangeFilter(bars, p.rf_per, p.rf_mult);
    rfEvtLong = mergeBools(idx, rf.evtLong);
    rfStateLong = mergeBools(idx, rf.stateLong);
  }
  if (p.rf_useExit) {
    const { bars, idx } = feedOf(ctx, null, p.rf_exitTf === "" ? p.rf_tf : p.rf_exitTf);
    rfSellArr = mergeBools(idx, rangeFilter(bars, p.rf_per, p.rf_mult).sellEvt);
  }

  // ── Q-Trend (chart TF) ──
  let qtEvtLong = FALSE_ARR(n), qtStateLong = TRUE_ARR(n);
  if (p.qt_en) {
    const qt = qTrend(chart, p.qt_p, p.qt_atrP, p.qt_mult);
    qtEvtLong = qt.evtLong;
    qtStateLong = qt.stateLong;
  }

  // ── AlphaTrend (entry + exit TF) ──
  let atEvtLong = FALSE_ARR(n), atStateLong = TRUE_ARR(n), atSellArr = FALSE_ARR(n);
  if (p.at_en) {
    const { bars, idx } = feedOf(ctx, null, p.at_tf);
    const at = alphaTrend(bars, p.at_coeff, p.at_ap, p.at_novol);
    atEvtLong = mergeBools(idx, at.evtLong);
    atStateLong = mergeBools(idx, at.stateLong);
  }
  if (p.at_useExit) {
    const { bars, idx } = feedOf(ctx, null, p.at_exitTf === "" ? p.at_tf : p.at_exitTf);
    atSellArr = mergeBools(idx, alphaTrend(bars, p.at_coeff, p.at_ap, p.at_novol).sellEvt);
  }

  // ── HACOLT (entry + exit TF) ──
  let hacEvtLong = FALSE_ARR(n), hacStateLong = TRUE_ARR(n), hacSellArr = FALSE_ARR(n);
  if (p.hac_en) {
    const { bars, idx } = feedOf(ctx, null, p.hac_tf);
    const hc = hacolt(bars, p.hac_length, p.hac_emaLen, p.hac_csf);
    hacEvtLong = mergeBools(idx, hc.evtLong);
    hacStateLong = mergeBools(idx, hc.stateLong);
  }
  if (p.hac_useExit) {
    const { bars, idx } = feedOf(ctx, null, p.hac_exitTf === "" ? p.hac_tf : p.hac_exitTf);
    hacSellArr = mergeBools(idx, hacolt(bars, p.hac_length, p.hac_emaLen, p.hac_csf).sellEvt);
  }

  // ── UT Bot (entry + exit TF) ──
  let utEvtLong = FALSE_ARR(n), utStateLong = TRUE_ARR(n), utSellArr = FALSE_ARR(n);
  if (p.ut_en) {
    const { bars, idx } = feedOf(ctx, null, p.ut_tf);
    const ut = utBot(bars, p.ut_key, p.ut_atrP, p.ut_heikin);
    utEvtLong = mergeBools(idx, ut.evtLong);
    utStateLong = mergeBools(idx, ut.stateLong);
  }
  if (p.ut_useExit) {
    const { bars, idx } = feedOf(ctx, null, p.ut_exitTf === "" ? p.ut_tf : p.ut_exitTf);
    utSellArr = mergeBools(idx, utBot(bars, p.ut_key, p.ut_atrP, p.ut_heikin).sellEvt);
  }

  // ── BTC market filter ──
  let btcOk = TRUE_ARR(n);
  if (p.btcEnable) {
    const btcMaOk = (en: boolean, tf: string, len: number, type: string, src: string, lb: number): boolean[] => {
      if (!en) return TRUE_ARR(n);
      const { bars, idx } = feedOf(ctx, p.btcSym, tf);
      const m = ta.maByType(type as ta.MaType, pickSrc(bars, src), len, bars.volume);
      const ok = m.map((v, j) => {
        if (Number.isNaN(v) || !(bars.close[j]! > v)) return false;
        if (!p.requireBtcMaSlope) return true;
        const prev = j >= lb ? m[j - lb]! : NaN;
        return Number.isNaN(prev) ? true : v > prev;
      });
      return mergeBools(idx, ok);
    };
    const m1 = p.useBtcMa ? btcMaOk(p.btcMa1_en, p.btcMa1_tf, p.btcMa1_len, p.btcMa1_type, p.btcMa1_src, p.btcMa1_slopeLb) : TRUE_ARR(n);
    const m2 = p.useBtcMa ? btcMaOk(p.btcMa2_en, p.btcMa2_tf, p.btcMa2_len, p.btcMa2_type, p.btcMa2_src, p.btcMa2_slopeLb) : TRUE_ARR(n);
    const m3 = p.useBtcMa ? btcMaOk(p.btcMa3_en, p.btcMa3_tf, p.btcMa3_len, p.btcMa3_type, p.btcMa3_src, p.btcMa3_slopeLb) : TRUE_ARR(n);
    let stOk = TRUE_ARR(n);
    if (p.useBtcSt) {
      const { bars, idx } = feedOf(ctx, p.btcSym, p.btcStTf);
      stOk = mergeBools(idx, superTrend(bars, p.btcStAtrLen, p.btcStMult).trend.map((t) => t === 1));
    }
    let hhOk = TRUE_ARR(n);
    if (p.useBtcHh) {
      const { bars, idx } = feedOf(ctx, p.btcSym, p.btcHhTf);
      const ph = ta.pivothigh(bars.high, p.btcHhPivLen, p.btcHhPivLen);
      const cond = ph.map((v) => !Number.isNaN(v));
      const lastV = ta.valuewhen(cond, ph, 0);
      const priorV = ta.valuewhen(cond, ph, 1);
      hhOk = mergeBools(idx, lastV.map((v, j) => !Number.isNaN(v) && !Number.isNaN(priorV[j]!) && v > priorV[j]!));
    }
    let atOk = TRUE_ARR(n);
    if (p.useBtcAt) {
      const { bars, idx } = feedOf(ctx, p.btcSym, p.btcAtTf);
      atOk = mergeBools(idx, alphaTrend(bars, p.btcAtCoeff, p.btcAtAp, p.btcAtNovol).stateLong);
    }
    btcOk = m1.map((v, i) => v && m2[i]! && m3[i]! && stOk[i]! && hhOk[i]! && atOk[i]!);
  }

  // ── Per-bar assembly (mirrors Pine lines 843–1006) ──
  const longSetup = new Array<boolean>(n).fill(false);
  const filterLong = new Array<boolean>(n).fill(false);
  const confirmationLong = new Array<boolean>(n).fill(false);
  const hhTrendStrong = new Array<boolean>(n).fill(false);
  const anyIndBuyTrig = new Array<boolean>(n).fill(false);
  const freshPrimaryBuy = new Array<boolean>(n).fill(false);
  const belowSt = new Array<boolean>(n).fill(false);
  const belowMa1 = new Array<boolean>(n).fill(false);
  const belowLinReg = new Array<boolean>(n).fill(false);
  const hlBreak = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    const c = close[i]!, o = open[i]!, h = high[i]!;
    const a = atrRisk[i]!;

    // MA section
    const maUp = maPassLong(p.ma1_en, ma1, i) && maPassLong(p.ma2_en, ma2, i) && maPassLong(p.ma3_en, ma3, i) && maPassLong(p.ma4_en, ma4, i);
    const maSlopeOkLong = slopeOk(p.ma1_en, ma1, p.ma1_slopeLb, i) && slopeOk(p.ma2_en, ma2, p.ma2_slopeLb, i) && slopeOk(p.ma3_en, ma3, p.ma3_slopeLb, i) && slopeOk(p.ma4_en, ma4, p.ma4_slopeLb, i);
    const maCondLong = maUp && maSlopeOkLong;

    // Always-on filters
    const vwOkLong = maPassLong(p.useVwmaTrend, vwTrend, i);
    const localOk = !p.useLocalTrend || (
      !Number.isNaN(localFast[i]!) && !Number.isNaN(localSlow[i]!) &&
      localFast[i]! > localSlow[i]! && (!p.requireAboveFast || c > localFast[i]!)
    );
    const volOk = !p.useVolumeFilter || (
      !Number.isNaN(volSma[i]!) && volSma[i]! > 0 && volCur[i]! >= p.volMultMin * volSma[i]!
    );
    const hhOkLong = !p.useHhStructure || (
      !Number.isNaN(hhLast[i]!) && !Number.isNaN(hhPrior[i]!) && hhLast[i]! > hhPrior[i]!
    );
    hhTrendStrong[i] = !Number.isNaN(hhLast[i]!) && !Number.isNaN(hhPrior[i]!) && hhLast[i]! > hhPrior[i]!;
    const bodyOk = !p.useBodyFilter || c >= o || (o - c) <= p.entryBodyAtrMult * a;
    const rsiOk = !p.useRsiFilter || (
      !Number.isNaN(rsiVal[i]!) && rsiVal[i]! >= p.rsiLongMin && rsiVal[i]! <= p.rsiLongMax
    );
    // Spike filters
    const extLimit = p.extMode === "ATR" ? p.extMaxAtr * a : extRefEma[i]! * p.extMaxPct / 100;
    const extOk = !p.useExtFilter || Number.isNaN(extRefEma[i]!) || c <= extRefEma[i]! + extLimit;
    const prevC = i >= p.runLb ? close[i - p.runLb]! : NaN;
    const runRise = c - prevC;
    const runOk = !p.usePeakRun || Number.isNaN(prevC) ||
      (p.runMode === "Percent" ? runRise <= prevC * p.runMaxPct / 100 : runRise <= p.runMaxAtr * a);
    const spkOk = !p.useAtrSpike || Number.isNaN(atrAvgSpk[i]!) || atrAvgSpk[i]! <= 0 || a <= p.atrSpikeMaxMult * atrAvgSpk[i]!;
    const upperWick = h - Math.max(o, c);
    const wickOk = !p.useWickFilter || upperWick <= p.wickMaxAtr * a;
    const spikeFiltLong = extOk && runOk && spkOk && wickOk;

    const filtLong =
      (!p.useSuperTrend || stBull[i]!) &&
      lrLongOkAt(i) &&
      vwOkLong &&
      localOk && volOk && hhOkLong &&
      bodyOk &&
      rsiOk &&
      spikeFiltLong &&
      btcOk[i]!;
    filterLong[i] = filtLong && (!p.useMaTrend || maCondLong);

    // Primary / filter framework
    let priActive = false, priFired = false, fltPass = true;
    const apply = (en: boolean, primary: boolean, evt: boolean, state: boolean): void => {
      if (!en) return;
      if (primary) { priActive = true; priFired = priFired || evt; }
      else fltPass = fltPass && state;
    };
    const maFreshLong = i > 0 && maCondLong && !(
      maPassLong(p.ma1_en, ma1, i - 1) && maPassLong(p.ma2_en, ma2, i - 1) &&
      maPassLong(p.ma3_en, ma3, i - 1) && maPassLong(p.ma4_en, ma4, i - 1) &&
      slopeOk(p.ma1_en, ma1, p.ma1_slopeLb, i - 1) && slopeOk(p.ma2_en, ma2, p.ma2_slopeLb, i - 1) &&
      slopeOk(p.ma3_en, ma3, p.ma3_slopeLb, i - 1) && slopeOk(p.ma4_en, ma4, p.ma4_slopeLb, i - 1)
    );
    apply(p.useMaTrend, p.maPrimary, maCondLong, maCondLong);
    apply(p.rf_en, p.rf_primary, rfEvtLong[i]!, rfStateLong[i]!);
    apply(p.qt_en, p.qt_primary, qtEvtLong[i]!, qtStateLong[i]!);
    apply(p.at_en, p.at_primary, atEvtLong[i]!, atStateLong[i]!);
    apply(p.hac_en, p.hac_primary, hacEvtLong[i]!, hacStateLong[i]!);
    apply(p.ut_en, p.ut_primary, utEvtLong[i]!, utStateLong[i]!);
    const frameworkLongOk = priActive && priFired && fltPass;
    confirmationLong[i] = fltPass && (!priActive || priFired);

    longSetup[i] = p.long_en && frameworkLongOk && filtLong;
    const freshPrimaryEvent =
      (p.useMaTrend && p.maPrimary && maFreshLong) ||
      (p.rf_en && p.rf_primary && rfEvtLong[i]!) ||
      (p.qt_en && p.qt_primary && qtEvtLong[i]!) ||
      (p.at_en && p.at_primary && atEvtLong[i]!) ||
      (p.hac_en && p.hac_primary && hacEvtLong[i]!) ||
      (p.ut_en && p.ut_primary && utEvtLong[i]!);
    freshPrimaryBuy[i] = freshPrimaryEvent && longSetup[i]!;
    if (DEBUG_TIMES.size > 0 && DEBUG_TIMES.has(chart.time[i]!)) {
      console.log("[gates]", new Date(chart.time[i]!).toISOString(), JSON.stringify({
        maUp, maSlopeOkLong, st: !p.useSuperTrend || stBull[i],
        localOk, volOk, hhOkLong, bodyOk, extOk, runOk, spkOk, wickOk,
        atEvt: atEvtLong[i], atState: atStateLong[i],
        hacEvt: hacEvtLong[i], hacState: hacStateLong[i],
        frameworkLongOk, filtLong, longSetup: longSetup[i],
      }));
    }
    anyIndBuyTrig[i] = (p.rf_en && rfEvtLong[i]!) || (p.qt_en && qtEvtLong[i]!) || (p.at_en && atEvtLong[i]!) || (p.ut_en && utEvtLong[i]!);

    // Exit components
    belowSt[i] = p.useExitBelowSt && !Number.isNaN(stLine[i]!) && c < stLine[i]!;
    belowMa1[i] = p.useExitBelowMa1 && p.ma1_en && !Number.isNaN(ma1[i]!) && c < ma1[i]!;
    belowLinReg[i] = p.useExitBelowLinReg && p.useLinReg && c < bclose[i]!;
    hlBreak[i] = p.useHlBreakExit && !Number.isNaN(hlPivLow[i]!) && c < hlPivLow[i]!;
  }

  return {
    n,
    longSetup,
    filterLong,
    confirmationLong,
    hhTrendStrong,
    anyIndBuyTrig,
    freshPrimaryBuy,
    exitMaTrig,
    belowSt,
    belowMa1,
    belowLinReg,
    rsiExit: p.useRsiExit ? rsiExitArr : FALSE_ARR(n),
    hlBreak,
    rfSell: p.rf_useExit ? rfSellArr : FALSE_ARR(n),
    atSell: p.at_useExit ? atSellArr : FALSE_ARR(n),
    hacSell: p.hac_useExit ? hacSellArr : FALSE_ARR(n),
    utSell: p.ut_useExit ? utSellArr : FALSE_ARR(n),
    atrRisk,
    rrSwingLow,
  };
}
