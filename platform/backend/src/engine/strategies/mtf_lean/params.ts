/**
 * mtf_lean parameters — every logic-relevant input.* of MTF_Confluence_Lean.pine,
 * keyed by the exact Pine variable names so optimizer presets copy over unchanged.
 *
 * Deliberately excluded:
 *   - plot / show / cap inputs (visual only)
 *   - signal-delivery inputs (ALERT_SECRET, alert_*) — live delivery is not backtested
 *   - the debug table / funnel toggles
 *
 * Engine extras: qty_cash mirrors `default_qty_value = 1000` (strategy.cash).
 */
import type { StrategyParams } from "../../../types/strategy";
import type { Interval } from "../../../types/market";
import { INTERVAL_MS } from "../../../types/market";
import { pineTfToInterval } from "../../mtf";

export const MTF_LEAN_DEFAULTS = {
  // ── 1 General ──
  useBarConfirm: true,
  ordersOnConfirmedBar: true,
  cooldownBarsAfterExit: 0,
  htfClosed: true,
  useHeikin: false,
  useChoppyFilter: false,
  maxConsecLoss: 1,
  choppyPauseBars: 20,

  // ── 2 Risk & position sizing ──
  atrLenRisk: 6,

  // ── 3 G1 — Supertrend regime ──
  useG1: true,
  g1_tf: "15",
  g1_atrLen: 10,
  g1_mult: 3.0,
  g1_chgAtr: true,

  // ── 4 G2 — RSI regime ──
  useG2: true,
  g2_tf: "15",
  g2_len: 50,
  g2_thr: 50.0,
  g2_max: 100.0,

  // ── 5 G3 — VFI regime ──
  useG3: true,
  g3_tf: "15",
  g3_len: 130,
  g3_coef: 0.2,
  g3_vcoef: 2.5,
  g3_sig: 5,
  g3_smooth: true,
  g3_level: 0.0,

  // ── 6 G4 — Price at/above SR support ──
  useG4: true,
  g4_tf: "15",
  g4_lb: 20,
  g4_volLen: 2,
  g4_boxW: 1.0,
  g4_atrMult: 1.0,

  // ── 6e Volume filter ──
  useVolumeFilter: true,
  volTf: "5",
  volMaLen: 100,
  volMultMin: 1.4,

  // ── 6f Higher-high structure ──
  useHhStructure: false,
  hhTf: "1",
  hhPivotLen: 5,

  // ── 7 S1 — Liquidity sweep ──
  useS1: true,
  s1_tf: "15",
  s1_len: 2,
  s1_maxAge: 30,

  // ── 10 S4 — Supertrend structure ──
  useS4: true,
  s4_tf: "5",
  s4_atrLen: 10,
  s4_mult: 3.0,
  s4_chgAtr: true,

  // ── 11 S5 — Pivot Point Supertrend ──
  useS5: true,
  s5_tf: "15",
  s5_prd: 2,
  s5_factor: 3.0,
  s5_pd: 10,

  // ── 12 S6 — Sellside liquidity ──
  useS6: true,
  s6_tf: "15",
  s6_len: 3,
  s6_margin: 7.0,
  s6_vis: 5,
  s6_prox: 4.0,

  // ── 13 S7 — Pivot low ──
  useS7: false,
  s7_tf: "15",
  s7_len: 10,

  // ── 14 Entry trigger ──
  useTrigger: false,
  trig_tf: "",
  trigMode: "Bollinger Reclaim",
  bbReclaimLb: 3,
  bb_len: 20,
  bb_maTyp: "SMA",
  bb_mult: 2.0,
  trig_stLen: 10,
  trig_stMult: 3.0,
  reqST5: false,

  // ── 7b Entries — Long ──
  long_en: true,
  useBodyFilter: true,
  entryBodyAtrMult: 0.3,
  useOneTradePerSignal: false,

  // ── 9b R:R — swing-low stop + ratio TP ──
  rrSwingLb: 10,
  rrBufAtr: 1.0,
  rrRatio: 3.75,
  minSlDistAtr: 3.0,
  rrUsePartialTp: false,
  rrTp1Pct: 6.0,
  rrTp1Size: 40.0,
  rrTp2Pct: 8.0,
  rrTp2Size: 30.0,
  rrUseTrailSl: false,
  rrTrailPct: 2.0,
  rrTrailActPct: 4.0,
  rrUseBE: false,
  rrBeAfterR: 1.0,
  rrBeOffR: 0.1,

  // ── 21 Exits ──
  exitOnG1Flip: false,
  exitOnS4Flip: false,
  maxBarsTrade: 0,
  useHlBreakExit: false,
  hlBreakTf: "15",
  hlBreakPivLen: 10,

  // ── engine extras ──
  qty_cash: 1000,
  qty_pct_equity: 0,
  fill_bar_close: true,
};

export type MtfLeanParams = {
  [K in keyof typeof MTF_LEAN_DEFAULTS]: (typeof MTF_LEAN_DEFAULTS)[K];
};

const num = (v: unknown, d: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown, d: boolean): boolean =>
  typeof v === "boolean" ? v : typeof v === "string" ? v === "true" : d;
const str = (v: unknown, d: string): string => (v === undefined || v === null ? d : String(v));

/** Coerce a loose params object onto the typed shape, filling defaults. */
export function resolveParams(raw: StrategyParams): MtfLeanParams {
  const out = { ...MTF_LEAN_DEFAULTS } as Record<string, number | string | boolean>;
  for (const key of Object.keys(MTF_LEAN_DEFAULTS)) {
    const def = (MTF_LEAN_DEFAULTS as Record<string, number | string | boolean>)[key]!;
    const got = (raw as Record<string, unknown>)[key];
    if (got === undefined) continue;
    out[key] = typeof def === "number" ? num(got, def)
      : typeof def === "boolean" ? bool(got, def)
      : str(got, def as string);
  }
  return out as unknown as MtfLeanParams;
}

export interface FeedNeed { symbol: string | null; interval: Interval; warmupBars: number }

/**
 * Every (symbol, interval) feed the strategy reads, with a warmup bar count.
 * A feed is requested whenever the component that reads it is enabled OR its
 * value feeds an enabled exit, mirroring the Pine (which always evaluates the
 * request.security call, but whose result only matters when the gate is on).
 * We request unconditionally for the always-evaluated ones to keep the feed set
 * stable across a GA generation — cheaper than re-fetching per genome.
 */
export function requiredFeeds(p: MtfLeanParams, chartTf: Interval): FeedNeed[] {
  const needs = new Map<string, FeedNeed>();
  const add = (symbol: string | null, pineTf: string, warmupBars: number): void => {
    const interval = pineTfToInterval(String(pineTf), chartTf);
    const key = `${symbol ?? ""}|${interval}`;
    const prev = needs.get(key);
    if (!prev || prev.warmupBars < warmupBars) needs.set(key, { symbol, interval, warmupBars });
  };

  // Chart feed: risk ATR, swing low, body filter, Bollinger (chart-TF trigger).
  add(null, "", Math.max(p.atrLenRisk * 4, p.rrSwingLb, p.bb_len * 3, 200));

  add(null, p.g1_tf, p.g1_atrLen * 4 + 60);
  add(null, p.g2_tf, p.g2_len * 4 + 60);
  // VFI needs `length` bars for the rolling sum plus its own 130-bar warmup gate.
  add(null, p.g3_tf, p.g3_len * 3 + 120);
  // ChartPrime SR uses ta.atr(200) and pivots of g4_lb on each side.
  add(null, p.g4_tf, Math.max(200 * 3, p.g4_lb * 4) + 60);
  add(null, p.volTf, p.volMaLen * 3 + 60);
  add(null, p.s1_tf, p.s1_len * 8 + 2100);         // sweep store prunes at 2000 bars
  add(null, p.s4_tf, p.s4_atrLen * 4 + 60);
  add(null, p.s5_tf, Math.max(p.s5_pd * 4, p.s5_prd * 8) + 60);
  add(null, p.s6_tf, Math.max(p.s6_len * 8, 60) + 200);

  // Optional components: only pull their feed when enabled. hhTf in particular
  // defaults to "1" — loading a year of 1m bars for every coin would dominate
  // both RAM and runtime for a filter that is switched off.
  if (p.useHhStructure) add(null, p.hhTf, p.hhPivotLen * 8 + 60);
  if (p.useS7) add(null, p.s7_tf, p.s7_len * 8 + 60);
  if (p.useTrigger) add(null, p.trig_tf, Math.max(p.bb_len * 3, p.trig_stLen * 4, p.bbReclaimLb) + 60);
  if (p.useHlBreakExit) add(null, p.hlBreakTf, p.hlBreakPivLen * 8 + 60);

  return [...needs.values()];
}

export function warmupMs(p: MtfLeanParams, chartTf: Interval): number {
  let ms = 0;
  for (const need of requiredFeeds(p, chartTf)) {
    ms = Math.max(ms, need.warmupBars * INTERVAL_MS[need.interval]);
  }
  return ms;
}
