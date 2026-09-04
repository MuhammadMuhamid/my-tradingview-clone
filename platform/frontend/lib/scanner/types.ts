export type IndicatorKey =
  | "ema" | "rsi" | "macd" | "vfi" | "adx" | "candles" | "supertrend" | "sr";

export const INDICATOR_KEYS: IndicatorKey[] = [
  "ema", "rsi", "macd", "vfi", "adx", "candles", "supertrend", "sr",
];

export const TIMEFRAMES = [
  "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "3d", "1w",
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface MarketIdentity {
  exchange: string;
  market_type: "spot";
  contract_type: null;
  linear: boolean;
  spot: true;
  config_symbol?: string;
  native_symbol?: string | null;
}

export interface SeriesInfo {
  timeframe: string;
  last_bar_ts: number | null;
  last_close_ts: number | null;
  stale: boolean;
  bars: number;
}

export interface CandlePattern {
  name: string;
  direction: "bull" | "bear" | "none";
  strength: number;
  basis: string;
  bars_ago: number;
}

export interface SrLevel {
  price: number;
  strength: number;
  side: "support" | "resistance";
  formed_at: number;
  dist_pct: number | null;
  dist_atr: number | null;
}

/** Indicator payloads are flat records of primitives, plus two list-valued extras. */
export type IndicatorResult = Record<string, unknown> & {
  patterns?: CandlePattern[];
  levels?: SrLevel[];
};

export interface ScoreBucket {
  sub_score: number | null;
  weight: number;
  effective_weight: number;
  contribution: number | null;
  available: boolean;
  components: Record<string, number>;
}

export interface ScoreGate {
  regime: string | null;
  di_direction: string | null;
  di_conflicts_with_trend: boolean;
  multiplier: number;
  applies_to: string[];
}

export interface RowScore {
  label: string;
  disclaimer: string;
  /** 0-100 long bias. 50 is neutral. NOT a probability. */
  score: number | null;
  signed: number | null;
  coverage: number;
  gate: ScoreGate;
  buckets: Record<string, ScoreBucket>;
  note: string | null;
}

export interface CalibrationDecile {
  index: number;
  score_lo: number;
  score_hi: number;
  n: number;
  hits: number;
  unresolved: number;
  ambiguous: number;
  sufficient: boolean;
  hit_rate: number | null;
  display: string;
}

export interface Calibration {
  symbol: string;
  timeframe: string;
  available: boolean;
  reason?: string | null;
  in_sample?: boolean;
  settings?: Record<string, unknown>;
  window?: { start_ts: number | null; end_ts: number; days: number; bars: number };
  samples?: number;
  resolved?: number;
  unresolved?: number;
  ambiguous?: number;
  base_rate?: number;
  deciles: CalibrationDecile[];
  warnings: string[];
  generated_at?: number;
  current?: boolean;
  stale?: boolean;
  stale_reason?: string | null;
  fingerprint?: string;
  provenance?: Record<string, unknown>;
}

/** Live lookup of the decile the current score falls into. */
export interface EmpiricalLookup {
  available: boolean;
  decile?: number;
  hit_rate: number | null;
  n: number;
  display: string;
  current?: boolean;
  stale?: boolean;
  stale_reason?: string | null;
}

export interface RuleResult {
  id: string;
  label: string;
  passed: boolean | null;   // null = could not be evaluated; never counted as a pass
  required: boolean;
  detail: string | null;
  note: string | null;
}

export interface TimeframeResult {
  rules: RuleResult[];
  passed: number;
  total: number;
  pct: number | null;
  all: boolean;
  unknown: number;
}

export interface SideResult {
  side: "bull" | "bear";
  timeframes: Record<string, TimeframeResult>;
  passed: number;
  total: number;
  pct: number | null;
  aligned: boolean;
}

export interface StrategyResult {
  bull: SideResult;
  bear: SideResult;
  /** Share of the checklist passing. A count of conditions, NOT a probability. */
  bullish_pct: number | null;
  bearish_pct: number | null;
  bias: "bull" | "bear" | "none";
  setup: "bull" | "bear" | null;
  note: string;
  timeframes_used: Record<string, string>;
  series: Record<string, SeriesInfo>;
}

export interface ScreenerRow {
  symbol: string;
  market?: MarketIdentity;
  state: "ok" | "partial" | "unresolved" | "no_data";
  price: number | null;
  change_24h_pct: number | null;
  indicators: Partial<Record<IndicatorKey, IndicatorResult>>;
  series: Record<string, SeriesInfo>;
  errors: Record<string, string>;
  score: RowScore | null;
  empirical: EmpiricalLookup | null;
  strategy: StrategyResult | null;
  /** Every indicator at each strategy timeframe: mtf[slot][indicator][field]. */
  mtf: Record<string, Record<string, IndicatorResult | null>>;
  note: string | null;
  /**
   * Effective Shariah status of the row's base asset, joined in by the page
   * from the Shariah registry — the scanner service knows nothing about it.
   * Absent (undefined) means "not joined yet"; "UNKNOWN" means the base asset
   * is not in the Binance Spot USDT registry at all, which is not the same
   * thing as permitted.
   */
  shariah?: "ELIGIBLE" | "EXCLUDED" | "REVIEW" | "UNKNOWN";
}

export interface IndicatorSpec {
  enabled: boolean;
  timeframe: string;
  params: Record<string, unknown>;
}

export interface Snapshot {
  exchange: string;
  market: MarketIdentity;
  generated_at: number;
  last_refresh_at: number | null;
  last_refresh_error: string | null;
  timeframes: string[];
  indicators: Record<IndicatorKey, IndicatorSpec>;
  strategy: {
    enabled: boolean;
    name: string | null;
    timeframes: Record<string, string>;
    rules: Record<string, { id: string; label: string; required: boolean; note: string | null }[]>;
    note: string;
  };
  scoring: {
    label: string;
    mode: string;
    disclaimer: string;
    weights: Record<string, number>;
    ranging_multiplier: number | null;
  };
  unverified_symbols: { raw: string; note: string }[];
  rows: ScreenerRow[];
  compute_ms: number;
}
