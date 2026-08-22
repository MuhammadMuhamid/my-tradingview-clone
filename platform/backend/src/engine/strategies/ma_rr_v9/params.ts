/**
 * ma_rr_v9 parameters — every logic-relevant input.* of
 * ma_riskreward_strategy.pine, with the EXACT defaults from the source, keyed
 * by the exact Pine variable names so optimizer presets copy over unchanged.
 *
 * Deliberately excluded:
 *   - plot* / show* inputs (visual only)
 *   - signal-delivery inputs (live delivery lives in the deployments table)
 *   - input.source() pickers (stSrc, rsiSourceInput, rf_src, qt_src, at_src):
 *     the engine uses their Pine defaults (hl2 for SuperTrend, close for the
 *     rest). These are never varied in the user's optimizer configs.
 *   - shorts: the Pine computes short conditions but contains no
 *     strategy.entry for shorts — the strategy is long-only in practice.
 *
 * Engine extras: qty_cash mirrors `default_qty_value = 930` (strategy.cash).
 */
import type { StrategyParams } from "../../../types/strategy";
import type { Interval } from "../../../types/market";
import { INTERVAL_MS } from "../../../types/market";
import { pineTfToInterval } from "../../mtf";

export const MA_RR_V9_DEFAULTS = {
  // ── 1 General ──
  useBarConfirm: true,
  ordersOnConfirmedBar: true,
  cooldownBarsAfterExit: 0,
  useChoppyFilter: true,
  maxConsecLoss: 2,
  choppyPauseBars: 20,
  // ── 1b Profit-run limit ──
  useRunLimit: false,
  runLimTrades: 3,
  runLimProfitPct: 5.0,
  runLimPauseBars: 50,
  // ── 3 Trend — Moving averages (MTF) ──
  useMaTrend: false,
  maPrimary: false,
  maBlockWhenNa: true,
  requireMaSlope: false,
  ma1_en: true,  ma1_tf: "1",   ma1_len: 200, ma1_type: "SMA", ma1_src: "Close", ma1_slopeLb: 5,
  ma2_en: false, ma2_tf: "240", ma2_len: 100, ma2_type: "SMA", ma2_src: "Close", ma2_slopeLb: 5,
  ma3_en: true,  ma3_tf: "60",  ma3_len: 400, ma3_type: "SMA", ma3_src: "Close", ma3_slopeLb: 5,
  ma4_en: false, ma4_tf: "15",  ma4_len: 50,  ma4_type: "SMA", ma4_src: "Close", ma4_slopeLb: 5,
  // ── 4 Trend — SuperTrend ──
  useSuperTrend: false,
  stTf: "5",
  stAtrLen: 15,
  stMult: 2.5,
  // ── 5 Trend — Linear regression ──
  useLinReg: false,
  lrTf: "5",
  lrLen: 12,
  sigLen: 11,
  sigUseSma: false,
  // ── 6a Trend — VWMA ──
  useVwmaTrend: false,
  vwmaTf: "240",
  vwmaLen: 200,
  // ── 6d Trend — Local EMA stack ──
  useLocalTrend: false,
  localTrendTf: "5",
  localEmaFast: 21,
  localEmaSlow: 34,
  requireAboveFast: true,
  // ── 6e Volume filter ──
  useVolumeFilter: false,
  volTf: "",
  volMaLen: 20,
  volMultMin: 1.2,
  // ── 6f Higher-high structure ──
  useHhStructure: false,
  hhTf: "15",
  hhPivotLen: 9,
  // ── 7 Entries — Long ──
  long_en: true,
  lrLongRule: "Green candle",
  useBodyFilter: false,
  entryBodyAtrMult: 0.3,
  useOneTradePerSignal: false,
  // ── 9 Exits — signal-based ──
  atrLenExit: 7,
  minRForSoftExit: 0.0,
  useExitLongMa: true,
  exitMaTf: "240",
  exitMaLen: 100,
  exitMaType: "SMA",
  exitMaSrc: "Close",
  useExitBelowSt: true,
  useExitBelowMa1: true,
  useExitBelowLinReg: true,
  useHlBreakExit: true,
  hlBreakTf: "15",
  hlBreakPivLen: 9,
  hlBreakMinR: 0.0,
  // ── 9b R:R ──
  useRR: false,
  rrSwingLb: 10,
  rrBufAtr: 0.1,
  rrRatio: 2.0,
  minSlDistAtr: 0.25,
  rrUsePartialTp: false,
  rrTp1Pct: 2.0,
  rrTp1Size: 40.0,
  rrTp2Pct: 4.0,
  rrTp2Size: 30.0,
  rrUseTrailSl: false,
  rrTrailPct: 3.0,
  rrTrailActPct: 0.0,
  // ── 11 Peak / spike filters ──
  useExtFilter: false,
  extRefLen: 50,
  extMode: "ATR",
  extMaxAtr: 2.5,
  extMaxPct: 3.0,
  usePeakRun: false,
  runLb: 20,
  runMode: "Percent",
  runMaxPct: 12.0,
  runMaxAtr: 6.0,
  useAtrSpike: false,
  atrSpikeAvgLen: 20,
  atrSpikeMaxMult: 1.8,
  useWickFilter: false,
  wickMaxAtr: 0.6,
  // ── 12 BTC market filter ──
  btcEnable: false,
  btcSym: "BTCUSDT",
  useBtcMa: true,
  requireBtcMaSlope: true,
  btcMa1_en: true,  btcMa1_tf: "60",  btcMa1_len: 200, btcMa1_type: "SMA", btcMa1_src: "Close", btcMa1_slopeLb: 5,
  btcMa2_en: false, btcMa2_tf: "240", btcMa2_len: 100, btcMa2_type: "SMA", btcMa2_src: "Close", btcMa2_slopeLb: 5,
  btcMa3_en: false, btcMa3_tf: "15",  btcMa3_len: 50,  btcMa3_type: "SMA", btcMa3_src: "Close", btcMa3_slopeLb: 5,
  useBtcSt: false,
  btcStTf: "60",
  btcStAtrLen: 15,
  btcStMult: 2.5,
  useBtcHh: false,
  btcHhTf: "60",
  btcHhPivLen: 9,
  useBtcAt: false,
  btcAtTf: "60",
  btcAtCoeff: 1.0,
  btcAtAp: 14,
  btcAtNovol: false,
  // ── 14 RSI ──
  useRsiFilter: false,
  rsiLengthInput: 14,
  rsiTf: "",
  rsiLongMin: 45.0,
  rsiLongMax: 70.0,
  useRsiExit: false,
  rsiExitLevel: 50.0,
  // ── 18 Range Filter ──
  rf_en: false,
  rf_primary: false,
  rf_per: 100,
  rf_mult: 3.0,
  rf_tf: "",
  rf_useExit: false,
  rf_exitTf: "",
  // ── 19 Q-Trend (chart TF) ──
  qt_en: false,
  qt_primary: false,
  qt_p: 200,
  qt_atrP: 14,
  qt_mult: 1.0,
  // ── 20 AlphaTrend ──
  at_en: false,
  at_primary: false,
  at_coeff: 1.0,
  at_ap: 14,
  at_novol: false,
  at_tf: "",
  at_useExit: false,
  at_exitTf: "",
  // ── 21 HACOLT ──
  hac_en: false,
  hac_primary: false,
  hac_length: 55,
  hac_emaLen: 60,
  hac_csf: 1.1,
  hac_tf: "",
  hac_useExit: false,
  hac_exitTf: "",
  // ── 22 UT Bot ──
  ut_en: false,
  ut_primary: false,
  ut_key: 1.0,
  ut_atrP: 10,
  ut_heikin: false,
  ut_tf: "",
  ut_useExit: false,
  ut_exitTf: "",
  // ── Engine (Pine strategy() header / TV Properties tab) ──
  qty_cash: 930,
  /** >0 = TV "% of equity" order size (compounding); 0 = fixed qty_cash. */
  qty_pct_equity: 0,
  /** TV property "Process orders on bar Close" — fills at signal-bar close. */
  fill_bar_close: false,
} as const;

export type MaRrParams = { -readonly [K in keyof typeof MA_RR_V9_DEFAULTS]: (typeof MA_RR_V9_DEFAULTS)[K] extends number ? number : (typeof MA_RR_V9_DEFAULTS)[K] extends boolean ? boolean : string };

export function resolveParams(overrides: StrategyParams): MaRrParams {
  const p = { ...MA_RR_V9_DEFAULTS } as MaRrParams;
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in p)) continue; // unknown keys (e.g. plot toggles) are ignored
    (p as Record<string, unknown>)[k] = v;
  }
  // Pine's "BINANCE:BTCUSDT" symbol form → plain Binance symbol.
  p.btcSym = String(p.btcSym).replace(/^BINANCE:/i, "").toUpperCase();
  return p;
}

interface FeedNeed {
  symbol: string | null; // null = the chart symbol
  interval: Interval;
  /** minimum warmup bars on that interval for indicators to settle */
  warmupBars: number;
}

/**
 * Every (symbol, interval) feed the strategy needs for the given params —
 * the local equivalent of the script's request.security call graph — with a
 * conservative warmup estimate (recursive MAs get 3× their length).
 */
export function requiredFeeds(p: MaRrParams, chartTf: Interval): FeedNeed[] {
  const needs = new Map<string, FeedNeed>();
  const add = (symbol: string | null, pineTf: string, warmupBars: number): void => {
    const interval = pineTfToInterval(String(pineTf), chartTf);
    const key = `${symbol ?? ""}|${interval}`;
    const prev = needs.get(key);
    if (!prev || prev.warmupBars < warmupBars) {
      needs.set(key, { symbol, interval, warmupBars });
    }
  };

  // Chart feed always needed. Chart-TF indicators: risk ATR, swing low, spike
  // filters, Q-Trend, entry candle logic, signal line for LinReg.
  const chartWarmup = Math.max(
    p.atrLenExit * 3,
    p.rrSwingLb,
    p.extRefLen * 3,
    p.runLb,
    p.atrSpikeAvgLen + p.atrLenExit * 3,
    p.qt_en || p.qt_primary ? Math.max(p.qt_p, p.qt_atrP * 3) : 0,
    p.sigLen * 3,
    60
  );
  add(null, "", chartWarmup + 60);

  // MTF MAs: ma1 also feeds the "close below TF1 MA" exit.
  if (p.useMaTrend || p.useExitBelowMa1) {
    if (p.ma1_en) add(null, p.ma1_tf, p.ma1_len * 3 + p.ma1_slopeLb + 10);
  }
  if (p.useMaTrend) {
    if (p.ma2_en) add(null, p.ma2_tf, p.ma2_len * 3 + p.ma2_slopeLb + 10);
    if (p.ma3_en) add(null, p.ma3_tf, p.ma3_len * 3 + p.ma3_slopeLb + 10);
    if (p.ma4_en) add(null, p.ma4_tf, p.ma4_len * 3 + p.ma4_slopeLb + 10);
  }
  // SuperTrend feeds both the entry filter and the "close below ST" exit.
  // NOTE: ST/AT/UT/HACOLT have ratcheting recursions — their state depends on
  // the series start point far beyond the indicator length, so give them a
  // deep warmup to converge to TV (which computes over all loaded bars).
  if (p.useSuperTrend || p.useExitBelowSt) add(null, p.stTf, Math.max(p.stAtrLen * 8 + 30, 1500));
  if (p.useLinReg) add(null, p.lrTf, p.lrLen + 20);
  if (p.useVwmaTrend) add(null, p.vwmaTf, p.vwmaLen + 10);
  if (p.useLocalTrend) add(null, p.localTrendTf, p.localEmaSlow * 3 + 10);
  if (p.useVolumeFilter) add(null, p.volTf, p.volMaLen + 10);
  if (p.useHhStructure) add(null, p.hhTf, p.hhPivotLen * 12 + 30);
  if (p.useExitLongMa) add(null, p.exitMaTf, p.exitMaLen * 3 + 10);
  if (p.useHlBreakExit) add(null, p.hlBreakTf, p.hlBreakPivLen * 12 + 30);
  if (p.useRsiFilter || p.useRsiExit) add(null, p.rsiTf, p.rsiLengthInput * 8 + 20);
  if (p.rf_en) add(null, p.rf_tf, p.rf_per * 4 + 30);
  if (p.rf_useExit) add(null, p.rf_exitTf === "" ? p.rf_tf : p.rf_exitTf, p.rf_per * 4 + 30);
  if (p.at_en) add(null, p.at_tf, Math.max(p.at_ap * 6 + 30, 1500));
  if (p.at_useExit) add(null, p.at_exitTf === "" ? p.at_tf : p.at_exitTf, Math.max(p.at_ap * 6 + 30, 1500));
  if (p.hac_en) add(null, p.hac_tf, Math.max((p.hac_length * 9 + p.hac_emaLen * 3) + 30, 1500));
  if (p.hac_useExit) add(null, p.hac_exitTf === "" ? p.hac_tf : p.hac_exitTf, Math.max((p.hac_length * 9 + p.hac_emaLen * 3) + 30, 1500));
  if (p.ut_en) add(null, p.ut_tf, Math.max(p.ut_atrP * 8 + 30, 1500));
  if (p.ut_useExit) add(null, p.ut_exitTf === "" ? p.ut_tf : p.ut_exitTf, Math.max(p.ut_atrP * 8 + 30, 1500));

  if (p.btcEnable) {
    if (p.useBtcMa) {
      if (p.btcMa1_en) add(p.btcSym, p.btcMa1_tf, p.btcMa1_len * 3 + p.btcMa1_slopeLb + 10);
      if (p.btcMa2_en) add(p.btcSym, p.btcMa2_tf, p.btcMa2_len * 3 + p.btcMa2_slopeLb + 10);
      if (p.btcMa3_en) add(p.btcSym, p.btcMa3_tf, p.btcMa3_len * 3 + p.btcMa3_slopeLb + 10);
    }
    if (p.useBtcSt) add(p.btcSym, p.btcStTf, p.btcStAtrLen * 8 + 30);
    if (p.useBtcHh) add(p.btcSym, p.btcHhTf, p.btcHhPivLen * 12 + 30);
    if (p.useBtcAt) add(p.btcSym, p.btcAtTf, p.btcAtAp * 6 + 30);
  }

  return [...needs.values()].map((n) => ({
    ...n,
    warmupBars: Math.min(Math.max(n.warmupBars, 60), 5000),
  }));
}

export function warmupMs(need: FeedNeed): number {
  return need.warmupBars * INTERVAL_MS[need.interval];
}
