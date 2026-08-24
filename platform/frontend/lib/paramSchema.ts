/**
 * Curated, grouped schema for the ma_rr_v9 settings form. This is the subset a
 * trader actually tunes per coin (the engine fills the ~140 remaining inputs
 * from its own defaults). Field keys match the exact Pine input names, so a
 * saved config drops straight into a TradingView script and vice-versa.
 */
export type FieldType = "bool" | "int" | "float" | "select" | "timeframe";

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  help?: string;
  /** show only when this other bool key is true */
  showIf?: string;
}

export interface Group {
  title: string;
  fields: Field[];
}

const MA_TYPES = ["SMA", "EMA", "WMA", "RMA", "VWMA", "HMA"];
const TF_OPTS = ["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D"];

export const PARAM_GROUPS: Group[] = [
  {
    title: "General",
    fields: [
      { key: "long_en", label: "Enable longs", type: "bool", default: true },
      { key: "useChoppyFilter", label: "Pause after N consecutive losses", type: "bool", default: true },
      { key: "maxConsecLoss", label: "Max consecutive losses", type: "int", default: 2, min: 1, max: 10, showIf: "useChoppyFilter" },
      { key: "choppyPauseBars", label: "Pause duration (bars)", type: "int", default: 20, min: 1, max: 500, showIf: "useChoppyFilter" },
      { key: "cooldownBarsAfterExit", label: "Cooldown bars after exit", type: "int", default: 0, min: 0, max: 50 },
    ],
  },
  {
    title: "MA trend (MTF)",
    fields: [
      { key: "useMaTrend", label: "Require MA trend", type: "bool", default: true },
      { key: "maPrimary", label: "MA trend is PRIMARY (trigger)", type: "bool", default: true, showIf: "useMaTrend" },
      { key: "requireMaSlope", label: "Require MAs rising", type: "bool", default: false, showIf: "useMaTrend" },
      { key: "ma1_en", label: "TF1 enabled", type: "bool", default: true, showIf: "useMaTrend" },
      { key: "ma1_tf", label: "TF1 timeframe", type: "timeframe", default: "1", options: TF_OPTS, showIf: "useMaTrend" },
      { key: "ma1_len", label: "TF1 length", type: "int", default: 200, min: 1, max: 1000, showIf: "useMaTrend" },
      { key: "ma1_type", label: "TF1 type", type: "select", default: "SMA", options: MA_TYPES, showIf: "useMaTrend" },
      { key: "ma3_en", label: "TF3 enabled", type: "bool", default: true, showIf: "useMaTrend" },
      { key: "ma3_tf", label: "TF3 timeframe", type: "timeframe", default: "60", options: TF_OPTS, showIf: "useMaTrend" },
      { key: "ma3_len", label: "TF3 length", type: "int", default: 400, min: 1, max: 1000, showIf: "useMaTrend" },
      { key: "ma3_type", label: "TF3 type", type: "select", default: "SMA", options: MA_TYPES, showIf: "useMaTrend" },
    ],
  },
  {
    title: "R:R — swing-low stop + ratio TP",
    fields: [
      { key: "useRR", label: "Use R:R mode", type: "bool", default: true },
      { key: "rrSwingLb", label: "Swing-low lookback", type: "int", default: 10, min: 2, max: 200, showIf: "useRR" },
      { key: "rrBufAtr", label: "SL buffer (× ATR)", type: "float", default: 0.1, min: 0, step: 0.05, showIf: "useRR" },
      { key: "rrRatio", label: "Reward : Risk ratio", type: "float", default: 2.0, min: 0.25, step: 0.25, showIf: "useRR" },
      { key: "minSlDistAtr", label: "Min SL distance (× ATR)", type: "float", default: 0.25, min: 0.05, step: 0.05, showIf: "useRR" },
      { key: "rrUsePartialTp", label: "Partial TPs (TP1/TP2 + runner)", type: "bool", default: false, showIf: "useRR" },
      { key: "rrTp1Pct", label: "TP1 move %", type: "float", default: 2.0, min: 0.1, step: 0.1, showIf: "rrUsePartialTp" },
      { key: "rrTp1Size", label: "TP1 close % of pos", type: "float", default: 40, min: 1, max: 100, step: 5, showIf: "rrUsePartialTp" },
      { key: "rrTp2Pct", label: "TP2 move %", type: "float", default: 4.0, min: 0.1, step: 0.1, showIf: "rrUsePartialTp" },
      { key: "rrTp2Size", label: "TP2 close % of pos", type: "float", default: 30, min: 1, max: 100, step: 5, showIf: "rrUsePartialTp" },
      { key: "rrUseTrailSl", label: "Trailing stop (%)", type: "bool", default: false, showIf: "useRR" },
      { key: "rrTrailPct", label: "Trail distance %", type: "float", default: 3.0, min: 0.1, step: 0.1, showIf: "rrUseTrailSl" },
      { key: "rrTrailActPct", label: "Trail arm after +% profit", type: "float", default: 0.0, min: 0, step: 0.1, showIf: "rrUseTrailSl" },
    ],
  },
  {
    title: "Exits (signal-based)",
    fields: [
      { key: "atrLenExit", label: "ATR length (risk)", type: "int", default: 7, min: 1, max: 100 },
      { key: "useExitLongMa", label: "Exit: close crosses below MTF MA", type: "bool", default: true },
      { key: "exitMaTf", label: "Exit MA timeframe", type: "timeframe", default: "240", options: TF_OPTS, showIf: "useExitLongMa" },
      { key: "exitMaLen", label: "Exit MA length", type: "int", default: 100, min: 1, max: 1000, showIf: "useExitLongMa" },
      { key: "useExitBelowSt", label: "Exit: close below SuperTrend", type: "bool", default: true },
      { key: "useExitBelowMa1", label: "Exit: close below TF1 MA", type: "bool", default: true },
      { key: "useHlBreakExit", label: "Exit: break of last pivot low", type: "bool", default: true },
      { key: "hlBreakTf", label: "HL break timeframe", type: "timeframe", default: "15", options: TF_OPTS, showIf: "useHlBreakExit" },
      { key: "hlBreakPivLen", label: "HL break pivot length", type: "int", default: 9, min: 3, max: 30, showIf: "useHlBreakExit" },
    ],
  },
  {
    title: "SuperTrend / RSI filters",
    fields: [
      { key: "useSuperTrend", label: "Require SuperTrend bullish", type: "bool", default: false },
      { key: "stTf", label: "SuperTrend timeframe", type: "timeframe", default: "5", options: TF_OPTS, showIf: "useSuperTrend" },
      { key: "stAtrLen", label: "SuperTrend ATR period", type: "int", default: 15, min: 1, max: 100, showIf: "useSuperTrend" },
      { key: "stMult", label: "SuperTrend multiplier", type: "float", default: 2.5, min: 0.1, step: 0.1, showIf: "useSuperTrend" },
      { key: "useRsiFilter", label: "RSI band filter", type: "bool", default: false },
      { key: "rsiLongMin", label: "RSI min", type: "float", default: 45, min: 0, max: 100, step: 1, showIf: "useRsiFilter" },
      { key: "rsiLongMax", label: "RSI max", type: "float", default: 70, min: 0, max: 100, step: 1, showIf: "useRsiFilter" },
    ],
  },
  {
    title: "BTC market filter",
    fields: [
      { key: "btcEnable", label: "Require BTC uptrend", type: "bool", default: false },
      { key: "useBtcMa", label: "BTC: require MA uptrend", type: "bool", default: true, showIf: "btcEnable" },
      { key: "btcMa1_len", label: "BTC MA1 length", type: "int", default: 200, min: 1, max: 1000, showIf: "btcEnable" },
      { key: "btcMa1_tf", label: "BTC MA1 timeframe", type: "timeframe", default: "60", options: TF_OPTS, showIf: "btcEnable" },
    ],
  },
];

export const ALL_FIELDS: Field[] = PARAM_GROUPS.flatMap((g) => g.fields);

export function defaultParams(): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const f of ALL_FIELDS) out[f.key] = f.default;
  return out;
}

/**
 * Multi-strategy schema registry. Every strategy module ported into the
 * engine registers its grouped input schema here; the settings dialog, the
 * strategy tester and the alert dialog all resolve schemas by strategy key,
 * so adding strategy #2 is: port it in the backend + add one entry here.
 */
export const SCHEMAS: Record<string, Group[]> = {
  ma_rr_v9: PARAM_GROUPS,
  mtf_lean: [
    { title: "MTF gates", fields: [
      { key: "htfClosed", label: "Use confirmed HTF bars", type: "bool", default: true },
      { key: "useG1", label: "G1 SuperTrend", type: "bool", default: true },
      { key: "g1_tf", label: "G1 timeframe", type: "timeframe", default: "15", options: TF_OPTS },
      { key: "g1_mult", label: "G1 multiplier", type: "float", default: 3, min: 0.1, step: 0.1 },
      { key: "useG2", label: "G2 RSI", type: "bool", default: true },
      { key: "g2_tf", label: "G2 timeframe", type: "timeframe", default: "15", options: TF_OPTS },
      { key: "g2_len", label: "G2 RSI length", type: "int", default: 50, min: 1 },
      { key: "useG3", label: "G3 VFI", type: "bool", default: true },
      { key: "useG4", label: "G4 support", type: "bool", default: true },
      { key: "g4_tf", label: "G4 timeframe", type: "timeframe", default: "15", options: TF_OPTS },
    ]},
    { title: "Structure and trigger", fields: [
      { key: "useS1", label: "S1 liquidity sweep", type: "bool", default: true },
      { key: "s1_len", label: "S1 length", type: "int", default: 3, min: 1 },
      { key: "s1_maxAge", label: "S1 maximum age", type: "int", default: 20, min: 1 },
      { key: "useS4", label: "S4 SuperTrend", type: "bool", default: true },
      { key: "s4_mult", label: "S4 multiplier", type: "float", default: 3, min: 0.1, step: 0.1 },
      { key: "useS5", label: "S5 pivot SuperTrend", type: "bool", default: false },
      { key: "useS6", label: "S6 sell-side liquidity", type: "bool", default: true },
      { key: "s6_len", label: "S6 length", type: "int", default: 3, min: 1 },
      { key: "s6_prox", label: "S6 proximity × ATR", type: "float", default: 20, min: 0, step: 0.5 },
      { key: "useTrigger", label: "Require primary trigger", type: "bool", default: false },
    ]},
    { title: "Risk and partial exits", fields: [
      { key: "atrLenRisk", label: "Risk ATR length", type: "int", default: 7, min: 1 },
      { key: "rrSwingLb", label: "Swing-low lookback", type: "int", default: 10, min: 2 },
      { key: "rrBufAtr", label: "Stop buffer × ATR", type: "float", default: 0.1, min: 0, step: 0.05 },
      { key: "minSlDistAtr", label: "Minimum stop distance × ATR", type: "float", default: 0.25, min: 0.05, step: 0.05 },
      { key: "rrRatio", label: "Runner reward:risk", type: "float", default: 2, min: 0.25, step: 0.25 },
      { key: "rrUsePartialTp", label: "TP1 / TP2 partial exits", type: "bool", default: false },
      { key: "rrTp1Pct", label: "TP1 price move %", type: "float", default: 2, min: 0.1, step: 0.1, showIf: "rrUsePartialTp" },
      { key: "rrTp1Size", label: "TP1 % of original position", type: "float", default: 40, min: 1, max: 99, step: 1, showIf: "rrUsePartialTp" },
      { key: "rrTp2Pct", label: "TP2 price move %", type: "float", default: 4, min: 0.1, step: 0.1, showIf: "rrUsePartialTp" },
      { key: "rrTp2Size", label: "TP2 % of original position", type: "float", default: 30, min: 1, max: 99, step: 1, showIf: "rrUsePartialTp" },
      { key: "rrUseBE", label: "Break-even stop", type: "bool", default: true },
      { key: "rrBeAfterR", label: "Break-even after +R", type: "float", default: 0.75, min: 0, step: 0.25 },
      { key: "rrUseTrailSl", label: "Trailing stop", type: "bool", default: false },
      { key: "rrTrailPct", label: "Trail distance %", type: "float", default: 3, min: 0.1, step: 0.1, showIf: "rrUseTrailSl" },
    ]},
  ],
  srtrend_v10: [
    { title: "Support / Resistance", fields: [
      { key: "touchAtrMult", label: "Touch zone × ATR", type: "float", default: 0.85, min: 0.05, step: 0.05 },
      { key: "srStrengthMin", label: "Minimum pivot touches", type: "int", default: 1, min: 1, max: 10 },
      { key: "strengthTf", label: "Strength timeframe", type: "timeframe", default: "15", options: TF_OPTS },
      { key: "strengthPivotLen", label: "Strength pivot length", type: "int", default: 14, min: 3, max: 50 },
      { key: "tf5_en", label: "Use 5m S/R", type: "bool", default: true },
      { key: "pivLen5", label: "5m pivot length", type: "int", default: 13, min: 3, max: 50 },
      { key: "tf15_en", label: "Use 15m S/R", type: "bool", default: true },
      { key: "pivLen15", label: "15m pivot length", type: "int", default: 9, min: 3, max: 50 },
      { key: "tf60_en", label: "Use 1h S/R", type: "bool", default: true },
      { key: "pivLen60", label: "1h pivot length", type: "int", default: 9, min: 3, max: 50 },
      { key: "tf240_en", label: "Use 4h S/R", type: "bool", default: true },
      { key: "pivLen240", label: "4h pivot length", type: "int", default: 5, min: 3, max: 50 },
      { key: "retestConfirmBars", label: "Retest confirmation bars", type: "int", default: 8, min: 1, max: 30 },
      { key: "priorAboveLb", label: "Prior bars above support", type: "int", default: 4, min: 1, max: 20 },
      { key: "reclaimPierceAtr", label: "Reclaim pierce × ATR", type: "float", default: 0.05, min: 0, step: 0.05 },
      { key: "srStructBuffAtr", label: "Stop buffer below support × ATR", type: "float", default: 0.25, min: 0, step: 0.05 },
    ]},
    { title: "Trend filters", fields: [
      { key: "useMaTrend", label: "Require MA trend", type: "bool", default: true },
      { key: "requireMaSlope", label: "Require MA slope", type: "bool", default: true },
      { key: "maSlopeLb", label: "MA slope lookback", type: "int", default: 5, min: 1, max: 50 },
      { key: "ma1_len", label: "TF1 MA length", type: "int", default: 200, min: 1, max: 1000 },
      { key: "ma1_tf", label: "TF1 timeframe", type: "timeframe", default: "1", options: TF_OPTS },
      { key: "ma2_en", label: "Enable TF2 MA", type: "bool", default: false },
      { key: "ma2_len", label: "TF2 MA length", type: "int", default: 100, min: 1, max: 1000 },
      { key: "ma2_tf", label: "TF2 timeframe", type: "timeframe", default: "240", options: TF_OPTS },
      { key: "ma3_len", label: "TF3 MA length", type: "int", default: 400, min: 1, max: 1000 },
      { key: "ma3_tf", label: "TF3 timeframe", type: "timeframe", default: "60", options: TF_OPTS },
      { key: "useSuperTrend", label: "Require SuperTrend", type: "bool", default: true },
      { key: "stTf", label: "SuperTrend timeframe", type: "timeframe", default: "5", options: TF_OPTS },
      { key: "stAtrLen", label: "SuperTrend ATR", type: "int", default: 15, min: 1 },
      { key: "stMult", label: "SuperTrend multiplier", type: "float", default: 2.5, min: 0.1, step: 0.1 },
      { key: "useLinReg", label: "Use LinReg", type: "bool", default: true },
      { key: "lrTf", label: "LinReg timeframe", type: "timeframe", default: "5", options: TF_OPTS },
      { key: "lrLen", label: "LinReg length", type: "int", default: 12, min: 2 },
      { key: "useVwmaTrend", label: "Require HTF VWMA", type: "bool", default: true },
      { key: "vwmaTf", label: "VWMA timeframe", type: "timeframe", default: "240", options: TF_OPTS },
      { key: "vwmaLen", label: "VWMA length", type: "int", default: 200, min: 1 },
      { key: "useLocalTrend", label: "Require local EMA stack", type: "bool", default: true },
      { key: "localEmaFast", label: "Local fast EMA", type: "int", default: 21, min: 2 },
      { key: "localEmaSlow", label: "Local slow EMA", type: "int", default: 34, min: 2 },
      { key: "useVolumeFilter", label: "Require volume", type: "bool", default: true },
      { key: "volMaLen", label: "Volume SMA length", type: "int", default: 20, min: 5 },
      { key: "volMultMin", label: "Minimum volume × SMA", type: "float", default: 1.2, min: 0.1, step: 0.1 },
      { key: "at_en", label: "Use AlphaTrend confirmation", type: "bool", default: false },
      { key: "at_coeff", label: "AlphaTrend multiplier", type: "float", default: 1, step: 0.1 },
      { key: "at_ap", label: "AlphaTrend period", type: "int", default: 14, min: 1 },
      { key: "at_tf", label: "AlphaTrend timeframe", type: "timeframe", default: "", options: TF_OPTS },
      { key: "hac_en", label: "Use HACOLT confirmation", type: "bool", default: false },
      { key: "hac_length", label: "HACOLT TEMA period", type: "int", default: 55, min: 1 },
      { key: "hac_emaLen", label: "HACOLT EMA period", type: "int", default: 60, min: 1 },
    ]},
    { title: "Risk / exits", fields: [
      { key: "atrLenExit", label: "Risk ATR length", type: "int", default: 7, min: 1 },
      { key: "rrSwingLb", label: "Swing-low lookback", type: "int", default: 10, min: 2 },
      { key: "rrBufAtr", label: "Swing stop buffer × ATR", type: "float", default: 0.1, min: 0, step: 0.05 },
      { key: "rrRatio", label: "Reward : Risk ratio", type: "float", default: 2, min: 0.25, step: 0.25 },
      { key: "minSlDistAtr", label: "Minimum stop distance × ATR", type: "float", default: 0.25, min: 0.05, step: 0.05 },
      { key: "useBreakEven", label: "Break-even stop", type: "bool", default: true },
      { key: "breakEvenTriggerR", label: "Break-even trigger R", type: "float", default: 0.75, step: 0.25 },
      { key: "useTrail", label: "ATR trailing stop", type: "bool", default: true },
      { key: "trailTriggerR", label: "Trail trigger R", type: "float", default: 0.5, step: 0.25 },
      { key: "trailAtrMult", label: "Trail distance × ATR", type: "float", default: 1.8, step: 0.1 },
      { key: "useHtfBreakTrail", label: "HTF resistance-break runner", type: "bool", default: true },
      { key: "htfResTf", label: "HTF resistance timeframe", type: "timeframe", default: "60", options: TF_OPTS },
      { key: "htfResPivotLen", label: "HTF resistance pivot length", type: "int", default: 9, min: 3, max: 50 },
      { key: "htfBreakBufAtr", label: "Break buffer × ATR", type: "float", default: 0.25, min: 0, step: 0.05 },
      { key: "htfTrailAtrMult", label: "Runner trail distance × ATR", type: "float", default: 1, min: 0.1, step: 0.1 },
      { key: "useHlBreakExit", label: "HL-break exit", type: "bool", default: true },
      { key: "hlBreakTf", label: "HL-break timeframe", type: "timeframe", default: "15", options: TF_OPTS },
      { key: "hlBreakPivLen", label: "HL-break pivot length", type: "int", default: 9, min: 3, max: 30 },
    ]},
    { title: "Capital preservation", fields: [
      { key: "useChoppyFilter", label: "Pause after consecutive losses", type: "bool", default: true },
      { key: "maxConsecLoss", label: "Maximum consecutive losses", type: "int", default: 2, min: 1, max: 10 },
      { key: "choppyPauseBars", label: "Pause bars", type: "int", default: 20, min: 1, max: 500 },
      { key: "useAtrSpikeFilter", label: "ATR-spike filter", type: "bool", default: true },
      { key: "atrSpikeAvgLen", label: "ATR-spike average length", type: "int", default: 20, min: 2 },
      { key: "atrSpikeMaxMult", label: "Maximum ATR × average", type: "float", default: 1.8, min: 1, step: 0.1 },
    ]},
  ],
};

export function groupsFor(strategyKey: string): Group[] | null {
  return SCHEMAS[strategyKey] ?? null;
}

export function defaultParamsFor(strategyKey: string): Record<string, number | string | boolean> {
  const groups = groupsFor(strategyKey);
  if (!groups) return {};
  const out: Record<string, number | string | boolean> = {};
  for (const g of groups) for (const f of g.fields) out[f.key] = f.default;
  return out;
}
