import type { StrategyParams } from "../../../types/strategy";
import type { Interval } from "../../../types/market";
import { INTERVAL_MS } from "../../../types/market";
import { pineTfToInterval } from "../../mtf";
import { MA_RR_V9_DEFAULTS, requiredFeeds as maFeeds, resolveParams as resolveMa } from "../ma_rr_v9/params";

export const SRTREND_V10_DEFAULTS = {
  useBarConfirm: true, ordersOnConfirmedBar: true, cooldownBarsAfterExit: 0,
  useChoppyFilter: true, maxConsecLoss: 2, choppyPauseBars: 20,
  touchBandMode: "ATR", touchAtrMult: 0.85, touchTicks: 5,
  srStrengthMin: 1, strengthTf: "15", strengthPivotLen: 14,
  tf5_en: true, pivLen5: 13, tf15_en: true, pivLen15: 9,
  tf60_en: true, pivLen60: 9, tf240_en: true, pivLen240: 5,
  retestConfirmBars: 8, priorAboveLb: 4, blockBreakReclaim: true, reclaimPierceAtr: 0.05,
  srStructBuffAtr: 0.25,
  useResFlipSup: false, flipConfirmOnClose: false, flipBreakBufAtr: 0.05, flipInvalidBufAtr: 0.2,
  useMaTrend: true, maType: "SMA", maBlockWhenNa: true, requireMaSlope: true, maSlopeLb: 5,
  ma1_en: true, ma1_tf: "1", ma1_len: 200,
  ma2_en: false, ma2_tf: "240", ma2_len: 100,
  ma3_en: true, ma3_tf: "60", ma3_len: 400,
  useSuperTrend: true, stTf: "5", stAtrLen: 15, stMult: 2.5,
  useLinReg: true, lrTf: "5", lrLen: 12, sigLen: 11, sigUseSma: false,
  useVwmaTrend: true, vwmaTf: "240", vwmaLen: 200,
  useVwma2Trend: false, vwma2Tf: "60", vwma2Len: 100,
  useLocalTrend: true, localTrendTf: "5", localEmaFast: 21, localEmaSlow: 34, requireAboveFast: true,
  useRegimeFilter: false, regimeTf: "240", regimeEmaLen: 200, requireRegimeSlope: true, regimeSlopeLb: 10,
  useVolumeFilter: true, volMaLen: 20, volMultMin: 1.2,
  useHhStructure: false, hhTf: "15", hhPivotLen: 9,
  at_en: false, at_primary: false, at_coeff: 1, at_ap: 14, at_novol: false, at_tf: "", at_useExit: false, at_exitTf: "",
  hac_en: false, hac_primary: false, hac_length: 55, hac_emaLen: 60, hac_csf: 1.1, hac_tf: "", hac_useExit: false, hac_exitTf: "",
  long_en: true, requireBounce: false, lrLongRule: "Green candle",
  useContLong: false, contBreakLb: 10, contRequireGreen: false, contRelaxStrength: false, contExtraTpR: 1,
  useBodyFilter: true, entryBodyAtrMult: 0.3, short_en: false,
  atrLenExit: 7, rrSwingLb: 10, rrBufAtr: 0.1, rrRatio: 2,
  minSlDistAtr: 0.25, minRForSoftExit: 0,
  useBreakEven: true, breakEvenTriggerR: 0.75,
  tpMode: "Risk multiple (R)", tpR: 2, tpAtrMult: 12, tpPct: 1.5,
  useAdaptiveTp: false, adaptiveTpStrong: 2.5, adaptiveTpNeutral: 2,
  adaptiveTrailStrong: 1.75, adaptiveTrailNeutral: 1.25,
  useTrail: true, trailTriggerR: 0.5, trailAtrMult: 1.8, trailStyle: "ATR from close (ratchet)",
  useHtfBreakTrail: true, htfResTf: "60", htfResPivotLen: 9,
  htfBreakConfirmMode: "HTF candle close", htfBreakBufAtr: 0.25,
  htfTrailImmediate: true, htfTrailTriggerR: 0.25, htfTrailAtrMult: 1, htfResetTrailAnchorOnBreak: true,
  useExitLongMa: true, exitMaTf: "240", exitMaLen: 100, exitMaType: "SMA",
  useExitBelowSt: true, useExitBelowMa1: true, useExitBelowLinReg: true,
  useVolExhaustExit: false, volExhaustMult: 0.6, volExhaustLb: 12, volExhaustMinR: 0.5,
  useVeReentryBlock: false, veBlockBars: 24, veBlockZoneAtr: 1,
  useHlBreakExit: true, hlBreakTf: "15", hlBreakPivLen: 9, hlBreakMinR: 0,
  useAtrSpikeFilter: true, atrSpikeAvgLen: 20, atrSpikeMaxMult: 1.8,
  useSessionFilter: false, sessionStartHour: 0, sessionEndHour: 24,
  useSessionClose: false, sessionCloseProfitableOnly: false,
  qty_cash: 930, qty_pct_equity: 0, fill_bar_close: false,
} as const;

export type SrTrendParams = { -readonly [K in keyof typeof SRTREND_V10_DEFAULTS]:
  (typeof SRTREND_V10_DEFAULTS)[K] extends number ? number :
  (typeof SRTREND_V10_DEFAULTS)[K] extends boolean ? boolean : string };

export function resolveParams(overrides: StrategyParams): SrTrendParams {
  const p = { ...SRTREND_V10_DEFAULTS } as SrTrendParams;
  for (const [k, v] of Object.entries(overrides)) if (k in p) (p as Record<string, unknown>)[k] = v;
  return p;
}

export function toMaParams(p: SrTrendParams) {
  return resolveMa({
    useMaTrend: p.useMaTrend, maPrimary: false, maBlockWhenNa: p.maBlockWhenNa,
    requireMaSlope: p.requireMaSlope,
    ma1_en: p.ma1_en, ma1_tf: p.ma1_tf, ma1_len: p.ma1_len, ma1_type: p.maType, ma1_slopeLb: p.maSlopeLb,
    ma2_en: p.ma2_en, ma2_tf: p.ma2_tf, ma2_len: p.ma2_len, ma2_type: p.maType, ma2_slopeLb: p.maSlopeLb,
    ma3_en: p.ma3_en, ma3_tf: p.ma3_tf, ma3_len: p.ma3_len, ma3_type: p.maType, ma3_slopeLb: p.maSlopeLb,
    ma4_en: false,
    useSuperTrend: p.useSuperTrend, stTf: p.stTf, stAtrLen: p.stAtrLen, stMult: p.stMult,
    useLinReg: p.useLinReg, lrTf: p.lrTf, lrLen: p.lrLen, sigLen: p.sigLen, sigUseSma: p.sigUseSma, lrLongRule: p.lrLongRule,
    useVwmaTrend: p.useVwmaTrend, vwmaTf: p.vwmaTf, vwmaLen: p.vwmaLen,
    useLocalTrend: p.useLocalTrend, localTrendTf: p.localTrendTf, localEmaFast: p.localEmaFast,
    localEmaSlow: p.localEmaSlow, requireAboveFast: p.requireAboveFast,
    useVolumeFilter: p.useVolumeFilter, volTf: "", volMaLen: p.volMaLen, volMultMin: p.volMultMin,
    useHhStructure: p.useHhStructure, hhTf: p.hhTf, hhPivotLen: p.hhPivotLen,
    useBodyFilter: p.useBodyFilter, entryBodyAtrMult: p.entryBodyAtrMult,
    atrLenExit: p.atrLenExit, rrSwingLb: p.rrSwingLb,
    useExitLongMa: p.useExitLongMa, exitMaTf: p.exitMaTf, exitMaLen: p.exitMaLen, exitMaType: p.exitMaType,
    useExitBelowSt: p.useExitBelowSt, useExitBelowMa1: p.useExitBelowMa1, useExitBelowLinReg: p.useExitBelowLinReg,
    useHlBreakExit: p.useHlBreakExit, hlBreakTf: p.hlBreakTf, hlBreakPivLen: p.hlBreakPivLen, hlBreakMinR: p.hlBreakMinR,
    useAtrSpike: p.useAtrSpikeFilter, atrSpikeAvgLen: p.atrSpikeAvgLen, atrSpikeMaxMult: p.atrSpikeMaxMult,
    // Disable all MA+RR-only primary engines and filters.
    rf_en: false, qt_en: false, ut_en: false,
    at_en: p.at_en, at_primary: p.at_primary, at_coeff: p.at_coeff, at_ap: p.at_ap, at_novol: p.at_novol,
    at_tf: p.at_tf, at_useExit: p.at_useExit, at_exitTf: p.at_exitTf,
    hac_en: p.hac_en, hac_primary: p.hac_primary, hac_length: p.hac_length, hac_emaLen: p.hac_emaLen,
    hac_csf: p.hac_csf, hac_tf: p.hac_tf, hac_useExit: p.hac_useExit, hac_exitTf: p.hac_exitTf,
    useRsiFilter: false, useExtFilter: false, usePeakRun: false, useWickFilter: false,
  } as StrategyParams);
}

export interface FeedNeed { symbol: string | null; interval: Interval; warmupBars: number }
export function requiredFeeds(p: SrTrendParams, chartTf: Interval): FeedNeed[] {
  const base = maFeeds(toMaParams(p), chartTf);
  const map = new Map(base.map((x) => [`${x.symbol ?? ""}|${x.interval}`, x]));
  const add = (tf: string, bars: number) => {
    const interval = pineTfToInterval(tf, chartTf); const key = `|${interval}`;
    const old = map.get(key); if (!old || old.warmupBars < bars) map.set(key, { symbol: null, interval, warmupBars: bars });
  };
  if (p.tf5_en) add("5", p.pivLen5 * 12 + 40);
  if (p.tf15_en) add("15", p.pivLen15 * 12 + 40);
  if (p.tf60_en) add("60", p.pivLen60 * 12 + 40);
  if (p.tf240_en) add("240", p.pivLen240 * 12 + 40);
  add(p.strengthTf, p.strengthPivotLen * 12 + 40);
  if (p.useVwma2Trend) add(p.vwma2Tf, p.vwma2Len + 20);
  if (p.useRegimeFilter) add(p.regimeTf, p.regimeEmaLen * 3 + p.regimeSlopeLb + 20);
  if (p.useHtfBreakTrail) add(p.htfResTf, p.htfResPivotLen * 12 + 80);
  return [...map.values()];
}
export const warmupMs = (need: FeedNeed): number => need.warmupBars * INTERVAL_MS[need.interval];
