/**
 * mtf_lean signal computation — a line-faithful port of the indicator and
 * condition logic of MTF_Confluence_Lean.pine.
 *
 * Everything here is position-INDEPENDENT and precomputable as arrays over the
 * chart bars. The stateful gates (choppy pause, cooldown, one-trade latch,
 * break-even / trailing, R:R bracket engine) live in the bar loop in index.ts.
 *
 * HTF READ CONVENTION
 * -------------------
 * buildMergeIndex() already gives, for each chart bar, the last feed bar that
 * had CLOSED by the chart bar's close — the Pine `lookahead_off` value. The
 * Lean script additionally applies a `[1]` offset inside every request.security
 * when `htfClosed` is on, so here we shift the feed-TF series by one bar BEFORE
 * merging. `sec()` is the single place that decision is made.
 */
import type { Interval } from "../../../types/market";
import {
  Bars, FeedStore, buildMergeIndex, mergeValues, mergeBools, pineTfToInterval,
} from "../../mtf";
import * as ta from "../../ta";
import type { MtfLeanParams } from "./params";

export interface SignalArrays {
  n: number;
  /** All enabled filters agree AND the primary trigger fired (Pine rawLongSetup minus position/state gates). */
  longSetup: boolean[];
  /** Filters only, without the trigger — used by the funnel counters. */
  filtersOk: boolean[];
  /** Arms the one-trade-per-signal latch. */
  anyIndBuyTrig: boolean[];
  /** A genuinely new primary setup, used to unlock re-entry after manual close. */
  freshPrimaryBuy: boolean[];
  /** Exit components (position gating applied in the bar loop). */
  g1Bear: boolean[];
  s4Bear: boolean[];
  hlBreak: boolean[];
  /** R:R primitives. */
  atrRisk: number[];
  rrSwingLow: number[];
}

interface Ctx {
  feeds: FeedStore;
  chart: Bars;
  symbol: string;
  chartTf: Interval;
  p: MtfLeanParams;
  mergeCache: Map<string, Int32Array>;
}

const NAN_ARR = (n: number): number[] => new Array<number>(n).fill(NaN);
const FALSE_ARR = (n: number): boolean[] => new Array<boolean>(n).fill(false);

function feedOf(ctx: Ctx, pineTf: string): { bars: Bars; idx: Int32Array } {
  const itv = pineTfToInterval(String(pineTf), ctx.chartTf);
  const bars = ctx.feeds.get(ctx.symbol, itv);
  const key = `${ctx.symbol}|${itv}`;
  let idx = ctx.mergeCache.get(key);
  if (!idx) {
    idx = buildMergeIndex(ctx.chart, bars);
    ctx.mergeCache.set(key, idx);
  }
  return { bars, idx };
}

/** Merge a feed-TF numeric series onto chart bars, applying the `[1]` offset when htfClosed. */
function sec(ctx: Ctx, idx: Int32Array, src: number[]): number[] {
  return mergeValues(idx, ctx.p.htfClosed ? ta.shift(src, 1) : src);
}
/** Boolean variant of sec(). */
function secB(ctx: Ctx, idx: Int32Array, src: boolean[]): boolean[] {
  if (!ctx.p.htfClosed) return mergeBools(idx, src);
  const shifted = new Array<boolean>(src.length).fill(false);
  for (let i = 1; i < src.length; i++) shifted[i] = src[i - 1]!;
  return mergeBools(idx, shifted);
}

// ── Recursive indicator ports (sequential, Pine-literal) ───────────────────────

/** f_supertrend. changeATR ? ta.atr(len) : ta.sma(ta.tr, len). */
function superTrend(bars: Bars, atrLen: number, mult: number, changeATR: boolean):
    { up: number[]; dn: number[]; trend: number[]; line: number[] } {
  const n = bars.length;
  const atrStd = ta.atr(bars.high, bars.low, bars.close, atrLen);
  const atrClassic = ta.sma(ta.trueRange(bars.high, bars.low, bars.close), atrLen);
  const a = changeATR ? atrStd : atrClassic;
  const src = ta.hl2(bars.high, bars.low);
  const up = NAN_ARR(n);
  const dn = NAN_ARR(n);
  const trend = new Array<number>(n).fill(1);
  const line = NAN_ARR(n);
  for (let i = 0; i < n; i++) {
    let u = src[i]! - mult * a[i]!;
    let d = src[i]! + mult * a[i]!;
    const u1 = i > 0 && !Number.isNaN(up[i - 1]!) ? up[i - 1]! : u;
    const d1 = i > 0 && !Number.isNaN(dn[i - 1]!) ? dn[i - 1]! : d;
    const pc = i > 0 ? bars.close[i - 1]! : NaN;
    if (pc > u1) u = Math.max(u, u1);
    if (pc < d1) d = Math.min(d, d1);
    let t = i > 0 ? trend[i - 1]! : 1;
    if (t === -1 && bars.close[i]! > d1) t = 1;
    else if (t === 1 && bars.close[i]! < u1) t = -1;
    up[i] = u; dn[i] = d; trend[i] = t;
    line[i] = t === 1 ? u : d;
  }
  return { up, dn, trend, line };
}

/** f_pivotSupertrend — (c) LonesomeTheBlue. */
function pivotSuperTrend(bars: Bars, prd: number, factor: number, pd: number):
    { trend: number[]; tsl: number[] } {
  const n = bars.length;
  const ph = ta.pivothigh(bars.high, prd, prd);
  const pl = ta.pivotlow(bars.low, prd, prd);
  const a = ta.atr(bars.high, bars.low, bars.close, pd);
  const trend = new Array<number>(n).fill(0);
  const tsl = NAN_ARR(n);
  let center = NaN;
  let tUpPrev = NaN;
  let tDnPrev = NaN;
  let trendPrev = 1;
  for (let i = 0; i < n; i++) {
    const lastpp = !Number.isNaN(ph[i]!) ? ph[i]! : !Number.isNaN(pl[i]!) ? pl[i]! : NaN;
    if (!Number.isNaN(lastpp)) center = Number.isNaN(center) ? lastpp : (center * 2 + lastpp) / 3;
    const up = center - factor * a[i]!;
    const dn = center + factor * a[i]!;
    const pc = i > 0 ? bars.close[i - 1]! : NaN;
    // Pine: `close[1] > TUp[1] ? max(Up, TUp[1]) : Up` — NaN comparisons are false.
    const tUp = pc > tUpPrev ? Math.max(up, tUpPrev) : up;
    const tDn = pc < tDnPrev ? Math.min(dn, tDnPrev) : dn;
    let t: number;
    if (bars.close[i]! > tDnPrev) t = 1;
    else if (bars.close[i]! < tUpPrev) t = -1;
    else t = Number.isNaN(trendPrev) ? 1 : trendPrev;
    trend[i] = t;
    tsl[i] = t === 1 ? tUp : tDn;
    tUpPrev = tUp; tDnPrev = tDn; trendPrev = t;
  }
  return { trend, tsl };
}

/** f_vfi — Volume Flow Indicator (c) LazyBear. */
function vfi(bars: Bars, length: number, coef: number, vcoef: number, sigLen: number, smooth: boolean):
    { val: number[]; ready: boolean[] } {
  const n = bars.length;
  const typ = ta.hlc3(bars.high, bars.low, bars.close);
  const inter = NAN_ARR(n);
  for (let i = 1; i < n; i++) inter[i] = Math.log(typ[i]!) - Math.log(typ[i - 1]!);
  const vinter = ta.stdev(inter, 30);
  const vaveRaw = ta.sma(bars.volume, length);
  const vave = ta.shift(vaveRaw, 1);          // Pine: ta.sma(volume, length)[1]
  const vcp = NAN_ARR(n);
  for (let i = 0; i < n; i++) {
    const cutoff = coef * vinter[i]! * bars.close[i]!;
    const vmax = vave[i]! * vcoef;
    const vc = bars.volume[i]! < vmax ? bars.volume[i]! : vmax;
    const mf = i > 0 ? typ[i]! - typ[i - 1]! : NaN;
    vcp[i] = Number.isNaN(mf) || Number.isNaN(cutoff) ? NaN
      : mf > cutoff ? vc : mf < -cutoff ? -vc : 0;
  }
  const sum = ta.rollSum(vcp, length);
  const raw = sum.map((s, i) => {
    const v = vave[i]!;
    if (Number.isNaN(s) || Number.isNaN(v)) return NaN;
    return v === 0 ? 0 : s / v;
  });
  const sm = ta.sma(raw, 3);
  const val = smooth ? sm : raw;
  const ready = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) ready[i] = i > length + 40;
  return { val, ready };
}

/**
 * f_srBoxes — "Support and Resistance (High Volume Boxes)" (c) ChartPrime.
 * Returns the support box edges and whether the support is still standing.
 */
function srBoxes(bars: Bars, lookback: number, volLen: number, boxWidth: number):
    { supTop: number[]; supBot: number[]; supOk: boolean[] } {
  const n = bars.length;
  const dvol = NAN_ARR(n);
  let isBuy = true;
  for (let i = 0; i < n; i++) {
    if (bars.close[i]! > bars.open[i]!) isBuy = true;
    else if (bars.close[i]! < bars.open[i]!) isBuy = false;
    dvol[i] = isBuy ? bars.volume[i]! : -bars.volume[i]!;
  }
  const scaled = dvol.map((v) => v / 2.5);
  const volHi = ta.highest(scaled, volLen);
  const volLo = ta.lowest(scaled, volLen);
  const ph = ta.pivothigh(bars.close, lookback, lookback);
  const pl = ta.pivotlow(bars.close, lookback, lookback);
  const atr200 = ta.atr(bars.high, bars.low, bars.close, 200);

  const supTop = NAN_ARR(n);
  const supBot = NAN_ARR(n);
  const supOk = new Array<boolean>(n).fill(false);

  let sTop = NaN, sBot = NaN, rBot = NaN, rTop = NaN, ok = false;
  let pTop = NaN, pBot = NaN;                 // previous-bar levels, for the crossovers
  for (let i = 0; i < n; i++) {
    const wid = atr200[i]! * boxWidth;
    if (!Number.isNaN(pl[i]!) && dvol[i]! > volHi[i]!) {
      sTop = pl[i]!; sBot = pl[i]! - wid; ok = true;
    }
    if (!Number.isNaN(ph[i]!) && dvol[i]! < volLo[i]!) {
      rBot = ph[i]!; rTop = ph[i]! + wid;
    }
    // ta.crossover(low, supTop) / ta.crossunder(high, supBot) against last bar's levels
    const lo = bars.low[i]!, hi = bars.high[i]!;
    const loPrev = i > 0 ? bars.low[i - 1]! : NaN;
    const hiPrev = i > 0 ? bars.high[i - 1]! : NaN;
    const holdSup = loPrev <= pTop && lo > sTop;
    const brkSup = hiPrev >= pBot && hi < sBot;
    if (brkSup) ok = false;
    if (holdSup) ok = true;
    supTop[i] = sTop; supBot[i] = sBot; supOk[i] = ok;
    pTop = sTop; pBot = sBot;
    void rBot; void rTop;
  }
  return { supTop, supBot, supOk };
}

/**
 * f_liquiditySweeps — "Liquidity Sweeps" (c) LuxAlgo, 'Only Wicks' mode.
 * A stored pivot low is MITIGATED once price closes below it; a bullish SWEEP is
 * registered when price pierces it with a wick but closes back above.
 */
function liquiditySweeps(bars: Bars, len: number): { bullAge: number[]; bullLow: number[] } {
  const n = bars.length;
  const pl = ta.pivotlow(bars.low, len, len);
  const bullAge = new Array<number>(n).fill(100000);
  const bullLow = NAN_ARR(n);

  const prc: number[] = [];
  const bix: number[] = [];
  const wic: boolean[] = [];
  let lastLow = NaN;
  let lastBar = -1;

  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(pl[i]!)) {
      prc.unshift(pl[i]!); bix.unshift(i - len); wic.unshift(false);
    }
    const c = bars.close[i]!, lo = bars.low[i]!;
    for (let k = prc.length - 1; k >= 0; k--) {
      const p = prc[k]!;
      let mit = false;
      if (c < p) mit = true;
      else if (lo < p && c > p && !wic[k]!) {
        lastLow = lo; lastBar = i; wic[k] = true;
      }
      if (mit || i - bix[k]! > 2000) {
        prc.splice(k, 1); bix.splice(k, 1); wic.splice(k, 1);
      }
    }
    bullAge[i] = lastBar < 0 ? 100000 : i - lastBar;
    bullLow[i] = lastLow;
  }
  return { bullAge, bullLow };
}

/**
 * f_buysideSellside — "Buyside & Sellside Liquidity" (c) LuxAlgo.
 * Zigzag + "3 or more swing points clustered inside atr/margin" detection.
 * Returns the nearest UNBROKEN sellside level sitting below the close.
 */
function sellsideLiquidity(bars: Bars, liqLen: number, marginIn: number, visLiq: number): number[] {
  const n = bars.length;
  const liqMar = 10 / marginIn;
  const a10 = ta.atr(bars.high, bars.low, bars.close, 10);
  const ph = ta.pivothigh(bars.high, liqLen, 1);
  const pl = ta.pivotlow(bars.low, liqLen, 1);

  const MAX = 50;
  const zd = new Array<number>(MAX).fill(0);
  const zx = new Array<number>(MAX).fill(0);
  const zy = new Array<number>(MAX).fill(NaN);
  // sellside store
  const sPrc: number[] = [], sTop: number[] = [], sBot: number[] = [], sBar: number[] = [];
  const sBrk: boolean[] = [];
  const out = NAN_ARR(n);

  for (let i = 0; i < n; i++) {
    const x2 = i - 1;
    const m = a10[i]! / liqMar;

    if (!Number.isNaN(ph[i]!)) {
      const d1 = zd[0]!, y1 = zy[0]!;
      const y2 = i > 0 ? bars.high[i - 1]! : NaN;
      if (d1 < 1) { zd.unshift(1); zx.unshift(x2); zy.unshift(y2); zd.pop(); zx.pop(); zy.pop(); }
      else if (d1 === 1 && ph[i]! > y1) { zx[0] = x2; zy[0] = y2; }
      // buyside clustering is computed by the Pine but only the sellside level is
      // consumed by S6, so it is intentionally not tracked here.
    }

    if (!Number.isNaN(pl[i]!)) {
      const d2 = zd[0]!, w1 = zy[0]!;
      const w2 = i > 0 ? bars.low[i - 1]! : NaN;
      if (d2 > -1) { zd.unshift(-1); zx.unshift(x2); zy.unshift(w2); zd.pop(); zx.pop(); zy.pop(); }
      else if (d2 === -1 && pl[i]! < w1) { zx[0] = x2; zy[0] = w2; }

      let cnt = 0, stP = 0, stB = 0, minP = 0, maxP = 10e6;
      for (let k = 0; k < MAX; k++) {
        if (zd[k] !== -1) continue;
        const y = zy[k]!;
        if (y < pl[i]! - m) break;
        if (y > pl[i]! - m && y < pl[i]! + m) {
          cnt += 1; stB = zx[k]!; stP = y;
          if (y > minP) minP = y;
          if (y < maxP) maxP = y;
        }
      }
      if (cnt > 2) {
        const mid = (minP + maxP) / 2;
        const tp = mid + m, bt = mid - m;
        if (sPrc.length > 0 && sBar[0] === stB) {
          sPrc[0] = stP; sTop[0] = tp; sBot[0] = bt;
        } else {
          sPrc.unshift(stP); sTop.unshift(tp); sBot.unshift(bt); sBar.unshift(stB); sBrk.unshift(false);
          if (sPrc.length > visLiq) { sPrc.pop(); sTop.pop(); sBot.pop(); sBar.pop(); sBrk.pop(); }
        }
      }
    }

    for (let k = 0; k < sPrc.length; k++) {
      if (!sBrk[k] && bars.low[i]! < sBot[k]!) sBrk[k] = true;
    }
    let near = NaN;
    for (let k = 0; k < sPrc.length; k++) {
      if (!sBrk[k] && sPrc[k]! < bars.close[i]!) {
        if (Number.isNaN(near) || sPrc[k]! > near) near = sPrc[k]!;
      }
    }
    out[i] = near;
  }
  return out;
}

/** f_packTrigger — Bollinger / Supertrend entry trigger on its own timeframe. */
function triggerOn(bars: Bars, p: MtfLeanParams): boolean[] {
  const n = bars.length;
  const src = p.useHeikin ? ta.ohlc4(bars.open, bars.high, bars.low, bars.close) : bars.close;
  const basis = ta.maByType(p.bb_maTyp as ta.MaType, src, p.bb_len, bars.volume);
  const dev = ta.stdev(src, p.bb_len).map((d) => p.bb_mult * d);
  const lower = basis.map((b, i) => b - dev[i]!);
  const st = superTrend(bars, p.trig_stLen, p.trig_stMult, true);
  const out = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    let below = false;
    for (let k = 1; k <= p.bbReclaimLb; k++) {
      const j = i - k;
      if (j >= 0 && src[j]! < lower[j]!) below = true;
    }
    const xUpLower = i > 0 && src[i - 1]! <= lower[i - 1]! && src[i]! > lower[i]!;
    const reclaim = xUpLower || (src[i]! > lower[i]! && below && i > 0 && src[i - 1]! <= lower[i - 1]!);
    const basisX = i > 0 && src[i - 1]! <= basis[i - 1]! && src[i]! > basis[i]!;
    const stFlip = st.trend[i] === 1 && i > 0 && st.trend[i - 1] === -1;
    const bothT = reclaim && st.trend[i] === 1;
    const raw =
      p.trigMode === "Bollinger Reclaim" ? reclaim :
      p.trigMode === "Bollinger Basis Cross" ? basisX :
      p.trigMode === "Supertrend Flip" ? stFlip :
      p.trigMode === "BB + Supertrend (both)" ? bothT : false;
    out[i] = raw && (!p.reqST5 || st.trend[i] === 1);
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function computeSignals(
  feeds: FeedStore, symbol: string, chartTf: Interval, p: MtfLeanParams
): SignalArrays {
  const chart = feeds.get(symbol, chartTf);
  const n = chart.length;
  const ctx: Ctx = { feeds, chart, symbol, chartTf, p, mergeCache: new Map() };

  // ── G1 Supertrend ──
  const f1 = feedOf(ctx, p.g1_tf);
  const st1 = superTrend(f1.bars, p.g1_atrLen, p.g1_mult, p.g1_chgAtr);
  const g1Trend = sec(ctx, f1.idx, st1.trend);

  // ── G2 RSI ──
  const f2 = feedOf(ctx, p.g2_tf);
  const g2Rsi = sec(ctx, f2.idx, ta.rsi(f2.bars.close, p.g2_len));

  // ── G3 VFI ──
  const f3 = feedOf(ctx, p.g3_tf);
  const v3 = vfi(f3.bars, p.g3_len, p.g3_coef, p.g3_vcoef, p.g3_sig, p.g3_smooth);
  const g3Vfi = sec(ctx, f3.idx, v3.val);
  const g3Ready = secB(ctx, f3.idx, v3.ready);

  // ── G4 SR support ──
  const f4 = feedOf(ctx, p.g4_tf);
  const sr4 = srBoxes(f4.bars, p.g4_lb, p.g4_volLen, p.g4_boxW);
  const g4SupBot = sec(ctx, f4.idx, sr4.supBot);
  const g4SupOk = secB(ctx, f4.idx, sr4.supOk);
  const g4Atr = sec(ctx, f4.idx, ta.atr(f4.bars.high, f4.bars.low, f4.bars.close, p.atrLenRisk));

  // ── S1 liquidity sweep ──
  const fs1 = feedOf(ctx, p.s1_tf);
  const sw = liquiditySweeps(fs1.bars, p.s1_len);
  const s1Age = sec(ctx, fs1.idx, sw.bullAge);
  const s1Low = sec(ctx, fs1.idx, sw.bullLow);

  // ── S4 Supertrend ──
  const fs4 = feedOf(ctx, p.s4_tf);
  const st4 = superTrend(fs4.bars, p.s4_atrLen, p.s4_mult, p.s4_chgAtr);
  const s4Trend = sec(ctx, fs4.idx, st4.trend);

  // ── S5 Pivot Point Supertrend ──
  const fs5 = feedOf(ctx, p.s5_tf);
  const pst = pivotSuperTrend(fs5.bars, p.s5_prd, p.s5_factor, p.s5_pd);
  const s5Trend = sec(ctx, fs5.idx, pst.trend);

  // ── S6 sellside liquidity ──
  const fs6 = feedOf(ctx, p.s6_tf);
  const s6Lvl = sec(ctx, fs6.idx, sellsideLiquidity(fs6.bars, p.s6_len, p.s6_margin, p.s6_vis));
  const s6Atr = sec(ctx, fs6.idx, ta.atr(fs6.bars.high, fs6.bars.low, fs6.bars.close, p.atrLenRisk));

  // ── Volume filter ──
  const fv = feedOf(ctx, p.volTf);
  const volCur = sec(ctx, fv.idx, fv.bars.volume);
  const volSma = sec(ctx, fv.idx, ta.sma(fv.bars.volume, p.volMaLen));

  // ── Optional components — computed only when enabled, matching requiredFeeds() ──
  let s7PivLow = NAN_ARR(n);
  if (p.useS7) {
    const fs7 = feedOf(ctx, p.s7_tf);
    const pl7 = ta.pivotlow(fs7.bars.low, p.s7_len, p.s7_len);
    s7PivLow = sec(ctx, fs7.idx, ta.valuewhen(pl7.map((v) => !Number.isNaN(v)), pl7, 0));
  }

  let hhLast = NAN_ARR(n);
  let hhPrior = NAN_ARR(n);
  if (p.useHhStructure) {
    const fh = feedOf(ctx, p.hhTf);
    const phh = ta.pivothigh(fh.bars.high, p.hhPivotLen, p.hhPivotLen);
    const phhCond = phh.map((v) => !Number.isNaN(v));
    hhLast = sec(ctx, fh.idx, ta.valuewhen(phhCond, phh, 0));
    hhPrior = sec(ctx, fh.idx, ta.valuewhen(phhCond, phh, 1));
  }

  let trigFired = FALSE_ARR(n);
  if (p.useTrigger) {
    const ftr = feedOf(ctx, p.trig_tf);
    trigFired = secB(ctx, ftr.idx, triggerOn(ftr.bars, p));
  }

  let hlPivLow = NAN_ARR(n);
  if (p.useHlBreakExit) {
    const fhl = feedOf(ctx, p.hlBreakTf);
    const plHl = ta.pivotlow(fhl.bars.low, p.hlBreakPivLen, p.hlBreakPivLen);
    hlPivLow = sec(ctx, fhl.idx, ta.valuewhen(plHl.map((v) => !Number.isNaN(v)), plHl, 0));
  }

  // ── Chart-TF primitives ──
  const atrRisk = ta.atr(chart.high, chart.low, chart.close, p.atrLenRisk);
  const rrSwingLow = ta.lowest(chart.low, p.rrSwingLb);

  // ── Filter evaluation (pure AND of ENABLED filters) ──
  const longSetup = FALSE_ARR(n);
  const filtersOk = FALSE_ARR(n);
  const anyIndBuyTrig = FALSE_ARR(n);
  const freshPrimaryBuy = FALSE_ARR(n);
  const g1Bear = FALSE_ARR(n);
  const s4Bear = FALSE_ARR(n);
  const hlBreak = FALSE_ARR(n);

  for (let i = 0; i < n; i++) {
    const c = chart.close[i]!;
    const g1Bull = g1Trend[i] === 1;
    const s4Bull = s4Trend[i] === 1;

    const g1ok = g1Bull;
    const g2ok = g2Rsi[i]! > p.g2_thr && g2Rsi[i]! <= p.g2_max;
    const g3ok = g3Ready[i]! && g3Vfi[i]! > p.g3_level;
    const g4ok = !Number.isNaN(g4SupBot[i]!) && g4SupOk[i]! &&
      c >= g4SupBot[i]! - p.g4_atrMult * ta.nz(g4Atr[i]!);

    const s1ok = !Number.isNaN(s1Low[i]!) && s1Age[i]! <= p.s1_maxAge;
    const s4ok = s4Bull;
    const s5ok = s5Trend[i] === 1;
    const s6ok = !Number.isNaN(s6Lvl[i]!) && c > s6Lvl[i]! &&
      c - s6Lvl[i]! <= p.s6_prox * ta.nz(s6Atr[i]!);
    const s7ok = !Number.isNaN(s7PivLow[i]!) && c > s7PivLow[i]!;

    const volOk = !p.useVolumeFilter ||
      (!Number.isNaN(volSma[i]!) && volSma[i]! > 0 && volCur[i]! >= p.volMultMin * volSma[i]!);
    const hhOk = !p.useHhStructure ||
      (!Number.isNaN(hhLast[i]!) && !Number.isNaN(hhPrior[i]!) && hhLast[i]! > hhPrior[i]!);
    const bodyOk = !p.useBodyFilter || c >= chart.open[i]! ||
      chart.open[i]! - c <= p.entryBodyAtrMult * atrRisk[i]!;

    const gatesOk = (!p.useG1 || g1ok) && (!p.useG2 || g2ok) && (!p.useG3 || g3ok) && (!p.useG4 || g4ok);
    const structOk = (!p.useS1 || s1ok) && (!p.useS4 || s4ok) && (!p.useS5 || s5ok) &&
      (!p.useS6 || s6ok) && (!p.useS7 || s7ok);
    const fOk = gatesOk && structOk && volOk && hhOk && bodyOk;

    const primaryFired = p.useTrigger ? trigFired[i]! : true;

    filtersOk[i] = fOk;
    longSetup[i] = p.long_en && fOk && primaryFired;
    anyIndBuyTrig[i] = p.useTrigger && trigFired[i]!;
    freshPrimaryBuy[i] = longSetup[i]! && (i === 0 || !longSetup[i - 1]!);
    g1Bear[i] = !g1Bull;
    s4Bear[i] = !s4Bull;
    hlBreak[i] = !Number.isNaN(hlPivLow[i]!) && c < hlPivLow[i]!;
  }

  return { n, longSetup, filtersOk, anyIndBuyTrig, freshPrimaryBuy, g1Bear, s4Bear, hlBreak, atrRisk, rrSwingLow };
}
