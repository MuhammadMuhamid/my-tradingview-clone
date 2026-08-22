import type { Interval } from "../../../types/market";
import { FeedStore, buildMergeIndex, mergeValues, mergeBools, pineTfToInterval } from "../../mtf";
import * as ta from "../../ta";
import { computeSignals as computeMaSignals } from "../ma_rr_v9/signals";
import type { SrTrendParams } from "./params";
import { toMaParams } from "./params";

export interface SrSignals {
  longSetup: boolean[]; supportLevel: number[]; atr: number[]; swingLow: number[];
  freshPrimaryBuy: boolean[];
  exitMa: boolean[]; belowSt: boolean[]; belowMa1: boolean[]; belowLinReg: boolean[];
  hlBreak: boolean[]; volExhaust: boolean[]; htfBreak: boolean[]; sessionEnded: boolean[];
  strongTrend: boolean[];
}
const nan = (n: number) => new Array<number>(n).fill(NaN);
const falses = (n: number) => new Array<boolean>(n).fill(false);

export function computeSignals(feeds: FeedStore, symbol: string, chartTf: Interval, p: SrTrendParams): SrSignals {
  const chart = feeds.get(symbol, chartTf), n = chart.length;
  const base = computeMaSignals(feeds, symbol, chartTf, toMaParams(p));
  const atr = base.atrRisk;
  const pivot = (tf: string, len: number, high: boolean): number[] => {
    const b = feeds.get(symbol, pineTfToInterval(tf, chartTf));
    const x = high ? ta.pivothigh(b.high, len, len) : ta.pivotlow(b.low, len, len);
    const last = ta.valuewhen(x.map((v) => !Number.isNaN(v)), x, 0);
    return mergeValues(buildMergeIndex(chart, b), last);
  };
  const sup5 = p.tf5_en ? pivot("5", p.pivLen5, false) : nan(n);
  const sup15 = p.tf15_en ? pivot("15", p.pivLen15, false) : nan(n);
  const sup60 = p.tf60_en ? pivot("60", p.pivLen60, false) : nan(n);
  const sup240 = p.tf240_en ? pivot("240", p.pivLen240, false) : nan(n);
  const res5 = p.tf5_en ? pivot("5", p.pivLen5, true) : nan(n);
  const res15 = p.tf15_en ? pivot("15", p.pivLen15, true) : nan(n);
  const res60 = p.tf60_en ? pivot("60", p.pivLen60, true) : nan(n);
  const res240 = p.tf240_en ? pivot("240", p.pivLen240, true) : nan(n);

  const strengthBars = feeds.get(symbol, pineTfToInterval(p.strengthTf, chartTf));
  const strengthPlRaw = ta.pivotlow(strengthBars.low, p.strengthPivotLen, p.strengthPivotLen);
  const strengthPl = mergeValues(buildMergeIndex(chart, strengthBars), ta.valuewhen(strengthPlRaw.map(v => !Number.isNaN(v)), strengthPlRaw, 0));
  const longSetup = falses(n), supportLevel = nan(n), htfBreak = falses(n), sessionEnded = falses(n);
  let lastRetest = -1, lastLvl = NaN;
  const flipped = [false, false, false, false];
  const prevRes = [NaN, NaN, NaN, NaN];
  const sups = [sup5, sup15, sup60, sup240], ress = [res5, res15, res60, res240];
  const enabled = [p.tf5_en, p.tf15_en, p.tf60_en, p.tf240_en];
  const priorHigh = ta.highest(chart.high.map((v, i) => i > 0 ? chart.high[i - 1]! : NaN), p.contBreakLb);
  let vwma2 = nan(n), regime = nan(n);
  if (p.useVwma2Trend) {
    const b = feeds.get(symbol, pineTfToInterval(p.vwma2Tf, chartTf)); const idx = buildMergeIndex(chart, b);
    const cv = ta.sma(b.close.map((c, i) => c * b.volume[i]!), p.vwma2Len), vv = ta.sma(b.volume, p.vwma2Len);
    vwma2 = mergeValues(idx, cv.map((x, i) => x / vv[i]!));
  }
  if (p.useRegimeFilter) {
    const b = feeds.get(symbol, pineTfToInterval(p.regimeTf, chartTf));
    regime = mergeValues(buildMergeIndex(chart, b), ta.ema(b.close, p.regimeEmaLen));
  }
  let htfLvl = nan(n), htfEvent = falses(n);
  if (p.useHtfBreakTrail) {
    const b = feeds.get(symbol, pineTfToInterval(p.htfResTf, chartTf)); const idx = buildMergeIndex(chart, b);
    const ph = ta.pivothigh(b.high, p.htfResPivotLen, p.htfResPivotLen);
    const lv = ta.valuewhen(ph.map(v => !Number.isNaN(v)), ph, 0); htfLvl = mergeValues(idx, lv);
    const a = ta.atr(b.high, b.low, b.close, p.atrLenExit);
    htfEvent = mergeBools(idx, b.close.map((c, i) => !Number.isNaN(lv[i]!) && c > lv[i]! + p.htfBreakBufAtr * a[i]!));
  }
  for (let i = 0; i < n; i++) {
    const band = p.touchBandMode === "ATR" ? atr[i]! * p.touchAtrMult : 0;
    const touched = (v: number) => !Number.isNaN(v) && chart.low[i]! <= v + band;
    const reclaim = (v: number) => !Number.isNaN(v) && chart.low[i]! < v - p.reclaimPierceAtr * atr[i]! && chart.close[i]! > v;
    const fromAbove = (v: number) => {
      if (i < p.priorAboveLb) return false;
      for (let k = 1; k <= p.priorAboveLb; k++) if (!(chart.close[i-k]! > v)) return false;
      return true;
    };
    let retestNow = false, retestLvl = NaN;
    for (let k = 0; k < 4; k++) {
      if (!enabled[k]) continue;
      const r = ress[k]![i]!;
      if (!Number.isNaN(prevRes[k]!) && r !== prevRes[k]) flipped[k] = false;
      prevRes[k] = r;
      if (p.useResFlipSup && !Number.isNaN(r)) {
        if (chart.close[i]! > r + p.flipBreakBufAtr * atr[i]!) flipped[k] = true;
        if (flipped[k] && chart.close[i]! < r - p.flipInvalidBufAtr * atr[i]!) flipped[k] = false;
      }
      const candidates = [sups[k]![i]!, flipped[k] ? r : NaN];
      for (const v of candidates) if (!Number.isNaN(v) && touched(v) && fromAbove(v) && (!p.blockBreakReclaim || !reclaim(v))) {
        retestNow = true; retestLvl = v;
      }
    }
    if (retestNow) { lastRetest = i; lastLvl = retestLvl; }
    const recent = lastRetest >= 0 && i - lastRetest <= p.retestConfirmBars;
    const bounce = !p.requireBounce || Number.isNaN(lastLvl) || chart.close[i]! > lastLvl;
    let strength = 0;
    for (let k = 0; k < 4; k++) if (enabled[k] && !Number.isNaN(sups[k]![i]!) && !Number.isNaN(strengthPl[i]!) && Math.abs(strengthPl[i]! - sups[k]![i]!) <= band * 3) strength++;
    const strengthOk = p.srStrengthMin <= 1 || strength >= p.srStrengthMin;
    const deepTouch = touched(sup15[i]!) || touched(sup60[i]!) || touched(sup240[i]!);
    const continuation = p.useContLong && !deepTouch && chart.close[i]! > priorHigh[i]! && (!p.contRequireGreen || chart.close[i]! > chart.open[i]!);
    const vw2ok = !p.useVwma2Trend || (!Number.isNaN(vwma2[i]!) && chart.close[i]! > vwma2[i]!);
    const regPrev = i >= p.regimeSlopeLb ? regime[i-p.regimeSlopeLb]! : NaN;
    const regok = !p.useRegimeFilter || (!Number.isNaN(regime[i]!) && chart.close[i]! > regime[i]! && (!p.requireRegimeSlope || Number.isNaN(regPrev) || regime[i]! > regPrev));
    const hour = new Date(chart.time[i]!).getUTCHours();
    const inSession = !p.useSessionFilter || (hour >= p.sessionStartHour && hour < p.sessionEndHour);
    const touchPath = recent && bounce && (!p.blockBreakReclaim || Number.isNaN(lastLvl) || !reclaim(lastLvl)) && strengthOk;
    longSetup[i] = p.long_en && (touchPath || (continuation && (p.contRelaxStrength || strengthOk))) && base.filterLong[i]! && base.confirmationLong[i]! && vw2ok && regok && inSession;
    supportLevel[i] = continuation && !touchPath ? NaN : lastLvl;
    const prevHour = i > 0 ? new Date(chart.time[i-1]!).getUTCHours() : hour;
    sessionEnded[i] = p.useSessionFilter && p.useSessionClose && !(hour >= p.sessionStartHour && hour < p.sessionEndHour) && (prevHour >= p.sessionStartHour && prevHour < p.sessionEndHour);
    htfBreak[i] = p.useHtfBreakTrail && (p.htfBreakConfirmMode === "HTF candle close" ? htfEvent[i]! : !Number.isNaN(htfLvl[i]!) && chart.close[i]! > htfLvl[i]! + p.htfBreakBufAtr * atr[i]!);
  }
  const volSma = ta.sma(chart.volume, p.volMaLen);
  const priorHi = ta.highest(chart.high.map((v,i) => i ? chart.high[i-1]! : NaN), p.volExhaustLb);
  const volExhaust = chart.high.map((h,i) => p.useVolExhaustExit && !Number.isNaN(volSma[i]!) && chart.volume[i]! < p.volExhaustMult * volSma[i]! && h >= priorHi[i]!);
  const freshPrimaryBuy = longSetup.map((v, i) => v && (i === 0 || !longSetup[i - 1]!));
  return { longSetup, freshPrimaryBuy, supportLevel, atr, swingLow: ta.lowest(chart.low, p.rrSwingLb),
    exitMa: base.exitMaTrig, belowSt: base.belowSt, belowMa1: base.belowMa1,
    belowLinReg: base.belowLinReg, hlBreak: base.hlBreak, volExhaust, htfBreak,
    sessionEnded, strongTrend: base.hhTrendStrong };
}
