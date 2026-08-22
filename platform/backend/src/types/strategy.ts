import type { Candle, Interval } from "./market";

/** A flat Pine-inputs object: every input.* of the strategy, keyed by its Pine name. */
export type StrategyParams = Record<string, number | string | boolean>;

export interface StrategyRow {
  id: number;
  key: string;
  name: string;
  description: string | null;
  pineSource: string | null;
}

export interface StrategyConfigRow {
  id: string;
  strategyId: number;
  name: string;
  symbol: string | null;
  timeframe: Interval;
  params: StrategyParams;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Multi-timeframe candle feeds keyed by interval, each oldest → newest. */
export type CandleFeeds = Partial<Record<Interval, Candle[]>>;

/** A signal emitted on a confirmed bar close. */
export interface StrategySignal {
  action: "buy" | "sell";
  /** Which rule fired: 'entry','tp','tp1','tp2','sl','trail','break_even','ma_cross','hl_break',… */
  reason: string;
  price: number;
  /** Open time (ms) of the bar that produced the signal. */
  barTime: number;
}

/**
 * Contract every ported strategy module implements. Stage 2 provides the
 * ma_rr_v9 implementation; the backtester and the live runner both consume
 * modules only through this interface, so adding a strategy never touches
 * platform code.
 */
export interface StrategyModule {
  key: string;
  name: string;
  defaultParams: StrategyParams;
  /**
   * Intervals required beyond the chart timeframe — the local equivalent of
   * every request.security() timeframe the Pine version uses for the given
   * params (MTF MAs, exit MA, HL-break pivots, BTC filter, …).
   */
  requiredIntervals(params: StrategyParams, chartTf: Interval): Interval[];
  /** Extra symbols required (e.g. BTCUSDT when the BTC market filter is on). */
  requiredSymbols(params: StrategyParams): string[];
}
