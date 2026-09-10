import type {
  Alert, Backtest, BacktestStatus, Candle, Deployment, DeliveryMode,
  Interval, Strategy, StrategyConfig, StrategyParams, SymbolInfo, Trade,
} from "./types";
import type { Resolution } from "./resolution";
import type { TradingOverlayResponse } from "./tradingOverlays";

export interface OptimizerBest {
  symbol: string;
  rank: number;
  score: number | null;
  foundAt: string | null;
  metrics: {
    net_pct?: number | null;
    dd_pct?: number | null;
    win_rate?: number | null;
    trades?: number | null;
    profit_factor?: number | null;
  };
  params: StrategyParams;
  tunedParams: StrategyParams;
  properties: {
    // Null where the tree's own config.json does not state the figure. There is
    // no invented default: a fabricated order size silently mis-sizes every
    // reproduction of the leaderboard number (`OPT-11`).
    initialCapital: number | null;
    commissionPct: number | null;
    slippageTicks: number | null;
    qtyCash: number | null;
    qtyType: "percent_of_equity" | "cash";
    qtyValue: number | null;
    rangeStart: string | null;
    rangeEnd: string | null;
  };
  timeframe: Interval;
  strategyKey: string;
  tree?: OptimizerTree;
  /** The ranked scan hit its byte budget, so the rank is best-within-scanned. */
  rankTruncated?: boolean;
}

export interface SymbolSearchResult {
  symbol: string;
  canonicalId?: string;
  providerId?: string;
  providerSymbol?: string;
  venueId?: string;
  baseAsset: string;
  quoteAsset: string;
  /** already in the local symbols table (has candles / can be charted at once) */
  tracked: boolean;
}

export interface SymbolSearchResponse {
  total: number;
  quotes: string[];
  results: SymbolSearchResult[];
  venues?: { id: string; label: string }[];
  errors?: { providerId: string; error: string }[];
}

// ── Pine editor ──
export interface PineScript {
  id: string;
  name: string;
  source: string;
  kind: "indicator" | "strategy";
  createdAt: string;
  updatedAt: string;
}

export interface PineInputDef {
  key: string;
  title: string;
  type: "int" | "float" | "bool" | "string" | "source" | "color" | "timeframe";
  defval: number | string | boolean;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: (string | number)[];
  group?: string;
  tooltip?: string;
}

export interface PineMeta {
  kind: "indicator" | "strategy";
  title: string;
  shortTitle: string;
  overlay: boolean;
  format: string;
  precision: number | null;
  inputs: PineInputDef[];
  warnings: { line: number; message: string }[];
}

export interface PineCompileError { line: number; col: number; message: string }

export interface PinePlotSeries {
  id: string;
  title: string;
  color: string;
  width: number;
  style: string;
  offset: number;
  forceOverlay: boolean;
  renderable: boolean;
  colors: (string | null)[];
  data: (number | null)[];
}

export interface PineFillSeries {
  id: string;
  title: string;
  firstId: string;
  secondId: string;
  forceOverlay: boolean;
  renderable: boolean;
  fillgaps: boolean;
  colors: (string | null)[];
}

export interface PineBackgroundSeries {
  id: string;
  title: string;
  offset: number;
  forceOverlay: boolean;
  colors: (string | null)[];
}

export interface PineBarColorSeries {
  id: string;
  title: string;
  offset: number;
  colors: (string | null)[];
}

export interface PineOhlcSeries {
  id: string;
  title: string;
  style: "candles" | "bars";
  color: string;
  forceOverlay: boolean;
  renderable: boolean;
  data: ({ open: number; high: number; low: number; close: number } | null)[];
  colors: (string | null)[];
  wickColors: (string | null)[];
  borderColors: (string | null)[];
}

export interface PineShapeMark {
  time: number;
  position: "above" | "below";
  color: string;
  text: string;
  shape: string;
}

/** Drawing objects a script left on the chart at the end of a run. */
export interface PineDrawings {
  lines: { x1: number; y1: number; x2: number; y2: number;
    color: string; width: number; style: string; extend: string }[];
  boxes: { left: number; top: number; right: number; bottom: number;
    borderColor: string; borderWidth: number; borderStyle: string;
    bgColor: string; text: string; textColor: string }[];
  labels: { x: number; y: number; text: string;
    color: string; textColor: string; style: string; size: string }[];
  tables: { position: string;
    cells: { col: number; row: number; text: string; textColor: string; bgColor: string }[] }[];
}

export interface PineRunResult {
  ok: boolean;
  errors: PineCompileError[];
  meta: PineMeta;
  times?: number[];
  plots?: PinePlotSeries[];
  fills?: PineFillSeries[];
  backgrounds?: PineBackgroundSeries[];
  barColors?: PineBarColorSeries[];
  ohlcPlots?: PineOhlcSeries[];
  hlines?: { id: string; price: number; color: string; title: string;
    width: number; style: "solid" | "dashed" | "dotted"; renderable: boolean }[];
  shapes?: PineShapeMark[];
  drawings?: PineDrawings;
  trades?: Trade[];
  metrics?: Backtest["metrics"];
  equityCurve?: { t: number; equity: number; drawdownPct: number }[];
}

export type OptimizerSystem = "current" | "one-year" | "three-year";

/** One optimizer tree, as the backend registry (`<tree>/tree.json`) reports it. */
export interface OptimizerTree {
  id: string;
  label: string;
  strategy: string;
  timeframe: Interval;
  system: string;
  kind: "search" | "walk-forward" | "holdout" | "replay";
  status: "current" | "historical" | "not-comparable";
  note?: string;
  cost: {
    initialCapital: number | null;
    commissionPct: number | null;
    slippageTicks: number | null;
    range: { start?: string; end?: string; split?: string } | null;
    hasSplit: boolean;
  };
}

export interface OptimizerLeaderboard {
  tree: OptimizerTree;
  system: string;
  timeframe: Interval;
  range: { start?: string; end?: string; split?: string } | null;
  /** `snapshot` was exported elsewhere and may be old; `tree` is read live. */
  source: "snapshot" | "tree";
  totalBacktests: number;
  /** `pending` means the background line count has not finished — not zero. */
  testsState?: "ready" | "pending" | "unavailable";
  /** False when the tree exists but has produced no results yet (`X-04`). */
  resultsAvailable?: boolean;
  generatedAt?: string | null;
  ageMinutes?: number | null;
  stale?: boolean;
  /** The objective's `min_trades` floor, from the tree's own params.json. */
  minTrades?: number | null;
  leaderboard: Array<{
    symbol: string;
    score: number | null;
    tests: number;
    /** OPT-09: this winner sits on the objective's min_trades floor. */
    atTradeFloor?: boolean;
    metrics: {
      net_pct?: number | null;
      dd_pct?: number | null;
      win_rate?: number | null;
      trades?: number | null;
      profit_factor?: number | null;
      /** Out-of-sample: the window the optimiser never saw. Present on the
       *  MTF Lean trees; absent on older trees that predate the IS/OOS split. */
      oos_net_pct?: number | null;
      oos_dd_pct?: number | null;
      oos_win_rate?: number | null;
      oos_trades?: number | null;
      oos_profit_factor?: number | null;
      /** Share of entries STOPPED OUT AT A LOSS. Not "the stop filled": a
       *  trailing or break-even stop books a profitable exit as SL, which for a
       *  trailing config reads ~100% and says nothing. */
      sl_loss_rate?: number | null;
      oos_sl_loss_rate?: number | null;
    };
  }>;
}

export interface ServerLayout {
  id: string;
  name: string;
  symbol: string;
  /** The chart's resolution — a saved layout restores exactly what was saved. */
  timeframe: Resolution;
  bars: number;
  strategyKey: string;
  params: StrategyParams;
  properties: {
    initialCapital: number;
    qtyCash: number;
    qtyType?: "cash" | "percent_of_equity";
    qtyValue?: number;
    commissionPct: number;
    slippageTicks: number;
  };
  /** MA lines the layout draws; see lib/movingAverages.ts. */
  movingAverages: { type: MaType; length: number; visible: boolean }[];
  createdAt: string;
  updatedAt: string;
}

/**
 * FE-07: every call accepts an `AbortSignal`.
 *
 * Without one, switching symbol while a 2.5 MB candle request is in flight
 * leaves that request running — still holding a connection, still parsed in
 * full by the browser — and its response can land after the newer one and
 * overwrite it. `lib/requestGuard.ts` carries the pieces that use this.
 */
// ── Compact candle wire format ──────────────────────────────────────────────

/** `[openTime, open, high, low, close, volume]`. Mirrors
 *  `platform/backend/src/data/candleWire.ts`. */
export type CompactBar = [number, number, number, number, number, number];

export interface Ticker24h {
  symbol: string;
  last: number;
  /** The price 24h ago — the same reference `@miniTicker` reports as `o`. */
  open: number;
  /** Exchange-side event time, ms. */
  at: number;
}

export interface MarketTickerResponse {
  providers: Array<{ providerId: string; observations: Array<{
    canonicalInstrumentId: string; providerSymbol: string; observedAt: number;
    values: { last?: number; bid?: number; ask?: number; mid?: number };
    freshness: { state: "fresh" | "stale"; ageMs: number };
  }> }>;
  errors: { providerId: string; error: string }[];
  missing: string[];
}

export interface MarketStreamConfig {
  contractVersion: "market.v1";
  canonicalId: string;
  providerId: string;
  providerSymbol: string;
  interval: string;
  request: { origins: string[]; path: string; subscribeMessage: string | null; requiresBootstrapToken: false };
}

export interface CompactCandles {
  format: "compact-v1";
  symbol: string;
  interval: Resolution;
  stepMs: number;
  count: number;
  completeness?: { complete: boolean; missingBars: number; truncated: boolean; limitation?: string };
  bars: CompactBar[];
}

/**
 * Expand the compact response into the `Candle` shape the chart uses.
 *
 * `closeTime` is derived rather than transmitted — it is
 * `openTime + stepMs - 1` by definition, and sending it per bar was a
 * meaningful share of the payload.
 */
export function expandCompact(payload: CompactCandles): Candle[] {
  const { symbol, interval, stepMs } = payload;
  return payload.bars.map(([openTime, open, high, low, close, volume]) => ({
    symbol,
    interval,
    openTime,
    open,
    high,
    low,
    close,
    volume,
    closeTime: openTime + stepMs - 1,
  }));
}

// ── Operator console ────────────────────────────────────────────────────────

/**
 * `mode` has four states and none of them is a guess. A process that does not
 * hold the emitter lease cannot report on emission, and `DISABLED` means the
 * live runner is off by configuration rather than by an operator's decision.
 */
export type OpsMode = "LIVE" | "STANDBY" | "HALTED" | "DISABLED";
export type FeedState = "live" | "delayed" | "reconnecting" | "gap" | "error" | "unknown";
export type DeliveryState = "failing" | "stalled" | "degraded" | "idle" | "healthy";

export interface BotOperationalStatus {
  service: { reachable: true; name: string; version: string | null };
  execution: {
    mode: "DRY_RUN" | "HALTED" | "LIVE";
    dryRun: boolean;
    halted: boolean;
    haltedBy: string | null;
    haltedReason: string | null;
  };
  exchange: {
    mode: "TESTNET" | "MAINNET" | "MIXED";
    processDefault: "TESTNET" | "MAINNET";
    configuredAccounts: { total: number; testnet: number; mainnet: number };
  };
  realisedPnl: {
    currency: "USDT"; today: number; dayStart: string; timezone: "UTC";
    rollingWindowHours: number; rolling: number;
  };
  openTrades: { count: number; exposureQuote: number; currency: "USDT" };
  dailyLossProtection: {
    authority: "BOT"; limitQuote: number | null; windowHours: number;
    realisedPnlInWindow: number; enabled: boolean;
  };
  time: string;
}

export type BotStatusConnection =
  | { state: "CONNECTED"; configuredEndpoints: number; status: BotOperationalStatus }
  | { state: "NOT_CONFIGURED"; configuredEndpoints: 0; reason: "no_custom_bot_deployment" }
  | {
      state: "UNAVAILABLE"; configuredEndpoints: number;
      reason: "authentication_rejected" | "request_failed" | "invalid_response";
    };

export interface OpsStatus {
  mode: OpsMode;
  emitter: {
    thisProcess: string;
    liveRunnerEnabled: boolean;
    holdsLease: boolean;
    lease: {
      holder: string; hostname: string | null; pid: number | null;
      acquiredAt: string; expiresAt: string; isThisProcess: boolean;
    } | null;
  };
  risk: {
    tradingHalted: boolean;
    haltedReason: string | null;
    haltedBy: string | null;
    haltedAt: string | null;
    maxTotalExposureQuote: number | null;
    maxConcurrentPositions: number | null;
    maxDailyLossQuote: number | null;
    dailyLossWindowHours: number;
    snapshot: {
      currentExposureQuote: number;
      openPositions: number;
      realisedPnlInWindow: null;
    };
    summary: string;
    dailyLossControl: {
      state: "DISABLED_UNFED";
      authority: "BOT";
      note: string;
    };
  };
  bot: BotStatusConnection;
  database:
    | {
        ready: true;
        checks: { database: "ok"; schema: "current" };
        schema: { expected: number; applied: number; missing: string[] };
        time: string;
      }
    | {
        ready: false;
        checks: { database: "unavailable" | "ok"; schema: "unknown" | "unavailable" | "behind" };
        schema?: { expected: number; applied: number; missing: string[] };
        time: string;
      };
  alertRunner: {
    state: "healthy" | "degraded" | "unknown" | "disabled" | "not_configured";
    active: number;
    recent: number;
    stale: number;
    withoutEvidence: number;
    lastEvaluatedAt: string | null;
    reason: string;
  };
  deployments: {
    total: number; active: number; long: number; paused: number;
    paper: number; automated: number; signalOnly: number;
  };
  delivery: {
    state: DeliveryState;
    summary: string;
    windowHours: number;
    counts: Record<"pending" | "sent" | "failed" | "skipped" | "blocked", number>;
    total: number;
    lastSentAt: string | null;
    lastFailureAt: string | null;
    stuckPending: number;
    retried: number;
  };
  exchange: { testnetConfigured: boolean; note: string };
  feeds: {
    worst: FeedState;
    rows: Array<{
      symbol: string; interval: string; state: FeedState;
      lastBarTime: string | null; lastCheckedAt: string;
      barsBehind?: number | null; missingBars: number; detail?: string | null;
      integrity: {
        state: "healthy" | "degraded" | "invalid" | null;
        market: "spot";
        symbol: string;
        interval: string;
        latestCompletedBarTime: string | null;
        latestCompletedBarAgeMs: number | null;
        lastCheckedAt: string;
        issueCodes: string[];
        issueCounts: Record<string, number>;
      };
    }>;
  };
  time: string;
}

export interface UnresolvedIntents {
  count: number;
  intents: Array<{
    id: number; deploymentId: string; state: string; action: string;
    barTime: string; createdAt: string; resolvedAt: string | null;
    dedupeKey?: string | null;
  }>;
}

/** A paper deployment's simulated fills and their running result. */
export interface PaperResult {
  deploymentId: string;
  symbol: string;
  timeframe: Interval;
  buyQuoteQty: number | null;
  commissionPctPerSide: number;
  caveat: string;
  summary: {
    fills: number; buys: number; sells: number;
    realisedPnl: number; commissionPaid: number;
    wins: number; losses: number; winRatePct: number | null;
    openPosition: { qty: number; costBasis: number; entryPrice: number | null };
    unrealisedPnl: number | null;
  };
  fills: Array<{
    id: number; action: "buy" | "sell"; barTime: string; filledAt: string;
    price: number; qty: number; quote: number; commission: number;
    realisedPnl: number | null; positionQty: number; reason: string | null;
  }>;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(path, {
    ...init,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* keep status text */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * A write whose 409 is an ANSWER rather than a failure.
 *
 * `req` throws on any non-2xx, which is right for every other endpoint. Chart
 * state is different: a stale write is refused with the state that is actually
 * stored, and that body is exactly what the caller needs. Routing it through
 * `req` would turn "here is what is true" into `Error: 409 Conflict` and force
 * a second round trip to learn something the server already said.
 *
 * ── Why `conflicted` is carried out of here ────────────────────────────────
 *
 * Because the caller cannot work it out. It used to infer the refusal from
 * arithmetic — "my write landed if the version came back as the one I sent
 * plus one" — and that is true except in the case it was most needed: a FIRST
 * write, `baseVersion: 0`, refused because the row already existed at version
 * 1. Zero plus one is one, so a refusal looked exactly like a success, and the
 * study or drawing the user had just added was reported saved and was not on
 * the server at all. Two panes reach that state on any pane whose two halves
 * are first written a moment apart. The status code is the only thing that
 * actually knows, so the status code is what travels.
 */
async function reqAcceptingConflict<T>(
  path: string, body: unknown
): Promise<T & { conflicted: boolean }> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (res.ok || res.status === 409) {
    const payload = (await res.json()) as T;
    return { ...payload, conflicted: res.status === 409 };
  }
  let msg = `${res.status} ${res.statusText}`;
  try {
    const parsed = (await res.json()) as { error?: string };
    if (parsed.error) msg = parsed.error;
  } catch { /* keep status text */ }
  throw new Error(msg);
}

/** One instrument's drawings, or one pane's studies, as the server holds them. */
export interface StoredDrawingState {
  venue: string;
  symbol: string;
  drawings: unknown[];
  /** 0 means nothing is stored; every write carries the version it read. */
  version: number;
  updatedAt: string;
}

export interface StoredPaneState {
  scope: string;
  pine: unknown[];
  native: unknown[];
  version: number;
  updatedAt: string;
  /**
   * Whether each half has ever been written.
   *
   * The two halves share one `version`, so "the row exists" stopped meaning
   * "my half was written" the moment they were written separately. These say
   * what the version cannot.
   */
  pineWritten: boolean;
  nativeWritten: boolean;
}

/** Alert modes the MA watcher understands; mirrors backend types/maAlerts.ts. */
export type MaAlertMode = "touch" | "cross_up" | "cross_down" | "near_above" | "near_below";
export type MaType = "sma" | "ema";

/** What an alert watches. `ma` is the original family. */
export type ConditionKind =
  | "price" | "ma" | "ma_vs_ma" | "sr_zone" | "pivot_level" | "rsi" | "macd"
  | "supertrend" | "bollinger" | "stochastic" | "adx";

/** What an RSI alert crosses: a fixed level, or its own moving average. */
export type RsiTarget = "level" | "sma";
/** What a MACD alert crosses: its signal line, or zero. */
export type MacdTarget = "signal" | "zero";

/** Which side of a gate's reference the market must be on. */
export type FilterSide = "above" | "below";

/** Which average of true range a Supertrend uses. `rma` is Wilder's. */
export type StAtrMethod = "rma" | "sma";

/** Mirrors the backend's `FILTER_DEFAULTS`. */
export const FILTER_DEFAULTS = {
  rsi: { length: 50, level: 50, side: "above" as FilterSide },
  ma: { type: "ema" as MaType, length: 200, side: "above" as FilterSide },
  supertrend: {
    period: 10, multiplier: 3, atrMethod: "rma" as StAtrMethod, side: "above" as FilterSide,
  },
} as const;

/** Mirrors the backend's `RSI_DEFAULTS` / `MACD_DEFAULTS` / `SUPERTREND_DEFAULTS`. */
export const RSI_DEFAULTS = { length: 50, level: 50, maLength: 14 } as const;
export const MACD_DEFAULTS = { fast: 12, slow: 26, signal: 9 } as const;
export const SUPERTREND_DEFAULTS = {
  period: 10, multiplier: 3, atrMethod: "rma" as StAtrMethod,
} as const;

/** Which Bollinger band an alert watches. Mirrors `BOLLINGER_BANDS`. */
export type BollingerBand = "upper" | "basis" | "lower";
/** What a Stochastic alert compares %K against. Mirrors `STOCHASTIC_TARGETS`. */
export type StochasticTarget = "signal" | "level";

/**
 * The three families' own study defaults, so an armed alert watches the line
 * the chart is already drawing. Mirrors `BOLLINGER_DEFAULTS`,
 * `STOCHASTIC_DEFAULTS` and `ADX_DEFAULTS`.
 */
export const BOLLINGER_DEFAULTS = {
  length: 20, mult: 2, band: "upper" as BollingerBand, maType: "sma" as MaType,
} as const;
export const STOCHASTIC_DEFAULTS = {
  kLength: 14, kSmooth: 1, dSmooth: 3, level: 20,
} as const;
export const ADX_DEFAULTS = { diLength: 14, smoothing: 14, level: 25 } as const;

/**
 * Bars of history the alert runner evaluates against.
 *
 * Mirrors `ALERT_HISTORY_BARS` in `backend/src/types/maAlerts.ts`, checked by
 * `tests/alertEditing.test.ts`. It is the ceiling a family's warm-up must fit
 * under: lengths that stack past it produce an alert that reads as armed and
 * can never fire, and the server refuses them. This copy exists so the dialog
 * says so beside the field rather than after a round trip.
 */
export const ALERT_HISTORY_BARS = 1200;

/**
 * Mirrors `NOTE_MAX_LENGTH` on the server and `ma_alerts_note_len_ck` in the
 * schema. Served by `/api/ma-alerts/options` too; this copy is what the dialogs
 * count against before that arrives.
 */
export const NOTE_MAX_LENGTH = 280;

/** Which side of the market a support/resistance alert watches. */
export type SrSide = "support" | "resistance" | "either";

/** Pivot families the engine computes. Fibonacci is the default. */
export type PivotType = "Traditional" | "Fibonacci" | "Woodie" | "Classic" | "Camarilla";
export type PriceDirection = "cross_up" | "cross_down" | "either";

/**
 * How often a true condition may notify.
 *
 * `once_per_bar` and `once_per_minute` evaluate the candle currently forming,
 * which is a different promise to the user and must always be shown with the
 * warning the server serves from `/api/ma-alerts/options`.
 */
export type AlertFrequency =
  | "once_only"
  | "once_per_bar"
  | "once_per_bar_close"
  | "once_per_minute";

export const DEFAULT_ALERT_FREQUENCY: AlertFrequency = "once_per_bar_close";

export const INTRABAR_FREQUENCIES: AlertFrequency[] = ["once_per_bar", "once_per_minute"];

export const isIntrabarFrequency = (f: AlertFrequency): boolean =>
  INTRABAR_FREQUENCIES.includes(f);

export interface MaAlert {
  id: string;
  symbol: string;
  timeframe: Interval;
  conditionKind: ConditionKind;
  patternId?: string | null;
  srSide: SrSide | null;
  srPivotLength: number | null;
  srInvalidation: string | null;
  pivotType: PivotType | null;
  pivotLevelName: string | null;
  pivotAnchor: string | null;
  /** Populated for `rsi`. */
  rsiLength: number | null;
  rsiLevel: number | null;
  rsiMaLength: number | null;
  /** Populated for `macd`. */
  macdFast: number | null;
  macdSlow: number | null;
  macdSignal: number | null;
  /** Populated for `supertrend`. */
  stPeriod: number | null;
  stMultiplier: number | null;
  stAtrMethod: string | null;
  /** Populated for `bollinger`. */
  bbLength: number | null;
  bbMult: number | null;
  bbBand: string | null;
  bbMaType: MaType | null;
  /** Populated for `stochastic`. */
  stochKLength: number | null;
  stochKSmooth: number | null;
  stochDSmooth: number | null;
  stochLevel: number | null;
  /** Populated for `adx`. */
  adxDiLength: number | null;
  adxSmoothing: number | null;
  adxLevel: number | null;
  /**
   * `RsiTarget` for `rsi`, `MacdTarget` for `macd`, `StochasticTarget` for
   * `stochastic`. One field because all three answer the same question.
   */
  indicatorTarget: string | null;
  /** Optional trend gates, available on every family; null when unset. */
  filterRsiLength: number | null;
  filterRsiLevel: number | null;
  filterRsiSide: string | null;
  filterMaType: MaType | null;
  filterMaLength: number | null;
  filterMaSide: string | null;
  filterStPeriod: number | null;
  filterStMultiplier: number | null;
  filterStAtrMethod: string | null;
  filterStSide: string | null;
  /** Populated for `ma` and `ma_vs_ma`. */
  maType: MaType | null;
  maLength: number | null;
  mode: MaAlertMode | null;
  /** The slow line, for `ma_vs_ma`. */
  ma2Type: MaType | null;
  ma2Length: number | null;
  /** Populated for `price`. */
  targetPrice: number | null;
  priceDirection: PriceDirection | null;
  /** Band edges in percent; only meaningful for the near_* modes. */
  nearMinPct: number;
  nearMaxPct: number;
  enabled: boolean;
  frequency: AlertFrequency;
  cooldownMin: number;
  note: string | null;
  lastSide: "above" | "below" | null;
  lastFiredAt: string | null;
  lastFiredBarTime: string | null;
  lastBarTime: string | null;
  /** Set once a `once_only` alert has delivered and retired itself. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaAlertEvent {
  id: number;
  alertId: string;
  firedAt: string;
  barTime: string;
  price: number;
  /** The value compared against: the MA, the slow MA, or the price target. */
  maValue: number;
  distancePct: number;
  title: string;
  body: string;
  pushedTo: number;
  pushFailed: number;
  pushPruned: number;
  deliveryStatus: "delivered" | "partial_failure" | "failed" | "no_devices";
  /** Whether this fired on a candle that had not closed yet. */
  intrabar: boolean;
  frequency: AlertFrequency | null;
}

export interface AlertFrequencyOption {
  value: AlertFrequency;
  label: string;
  explanation: string;
  intrabar: boolean;
  /** The exact warning to display for an intrabar mode, or null. */
  warning: string | null;
}

export interface MaAlertOptions {
  maTypes: MaType[];
  maLengths: number[];
  modes: MaAlertMode[];
  conditionKinds: ConditionKind[];
  priceDirections: PriceDirection[];
  defaultFrequency: AlertFrequency;
  intrabarWarning: string;
  /** The server's own cap on a note, so the dialogs never invent their own. */
  noteMaxLength?: number;
  frequencies: AlertFrequencyOption[];
}

/**
 * What a single alert edit may change.
 *
 * Every key here is one the server also accepts at creation, read back through
 * the same validators — an edit cannot store a configuration the create route
 * would have refused. The alert's `conditionKind` is deliberately absent: a
 * family is fixed for the life of a row, because its id carries the event log
 * and the per-kind uniqueness rule.
 *
 * Nothing about firing state (`lastSide`, `lastFiredAt`, `completedAt`) appears
 * either. Those belong to the runner, and the server refuses them outright
 * rather than ignoring them.
 */
export interface MaAlertUpdate {
  // ── common to every family ──
  symbol?: string;
  timeframe?: Interval;
  frequency?: AlertFrequency;
  cooldownMin?: number;
  note?: string | null;
  enabled?: boolean;
  /** Echoed back on save so the server can confirm the family is unchanged. */
  conditionKind?: ConditionKind;
  // ── price ──
  targetPrice?: number;
  priceDirection?: PriceDirection;
  // ── ma / ma_vs_ma ──
  maType?: MaType;
  maLength?: number;
  ma2Type?: MaType;
  ma2Length?: number;
  mode?: MaAlertMode;
  nearMinPct?: number;
  nearMaxPct?: number;
  // ── sr_zone ──
  srSide?: SrSide;
  pivotLength?: number;
  invalidation?: "close" | "wick";
  // ── pivot_level ──
  pivotType?: PivotType;
  levelName?: string;
  anchor?: string;
  // ── rsi / macd ──
  rsiLength?: number;
  rsiLevel?: number;
  rsiMaLength?: number;
  macdFast?: number;
  macdSlow?: number;
  macdSignal?: number;
  /**
   * `RsiTarget` for an RSI alert, `MacdTarget` for a MACD one,
   * `StochasticTarget` for a Stochastic one. One field because all three
   * answer the same question, and the server stores them in one column.
   */
  target?: RsiTarget | MacdTarget | StochasticTarget;
  // ── supertrend ──
  stPeriod?: number;
  stMultiplier?: number;
  stAtrMethod?: StAtrMethod;
  // ── bollinger ──
  bbLength?: number;
  bbMult?: number;
  bbBand?: BollingerBand;
  bbMaType?: MaType;
  // ── stochastic ──
  stochKLength?: number;
  stochKSmooth?: number;
  stochDSmooth?: number;
  stochLevel?: number;
  // ── adx ──
  adxDiLength?: number;
  adxSmoothing?: number;
  adxLevel?: number;
  // ── optional trend gates, accepted on every family ──
  filterRsi?: boolean;
  filterRsiLength?: number;
  filterRsiLevel?: number;
  filterRsiSide?: FilterSide;
  filterMa?: boolean;
  filterMaType?: MaType;
  filterMaLength?: number;
  filterMaSide?: FilterSide;
  filterSt?: boolean;
  filterStPeriod?: number;
  filterStMultiplier?: number;
  filterStAtrMethod?: StAtrMethod;
  filterStSide?: FilterSide;
}

export type BulkAlertAction = "pause" | "resume" | "delete";
export interface BulkAlertResult {
  action: BulkAlertAction;
  requested: number;
  affected: number;
  missingIds: string[];
}

export interface ServerWatchlist {
  id: string;
  name: string;
  symbols: string[];
  position: number;
  updatedAt: string;
}

export interface ManualAccount {
  id: string; name: string; exchange: string; marketType: string;
  testnet: boolean; mode: "testnet" | "mainnet";
}
export interface ManualOrder {
  id: string; requestId: string; exchangeAccountId: string; linkedPositionId: string | null;
  symbol: string; side: "BUY" | "SELL"; orderType: "MARKET" | "LIMIT";
  quantityType: "quote" | "base"; requestedBaseQty: number | null;
  requestedQuoteQty: number | null; limitPrice: number | null;
  takeProfitPrice: number | null; stopLossPrice: number | null;
  protectionType: string | null; protectionState: string | null; status: string;
  exchangeOrderId: string | null; clientOrderId: string | null;
  filledBaseQty: number; filledQuoteQty: number;
  averageFillPrice: number | null; error: string | null; submittedAt: string | null;
  completedAt: string | null; createdAt: string; updatedAt: string;
}
export interface ManualPosition {
  id: string; exchangeAccountId: string; pair: string; status: string;
  entryPrice: number | null; currentPrice: number | null; quantity: number; quoteSpent: number;
  pnlUsdt: number; pnlPct: number; manualTpPrice: number | null; manualSlPrice: number | null;
  protectionType: string | null; protectionState: string | null;
  createdAt: string; closedAt: string | null; closedReason: string | null;
}
export interface ManualAssetBalance { asset: string; free: number; locked: number }
export interface ManualAccountStateView {
  symbol: string;
  base: ManualAssetBalance;
  quote: ManualAssetBalance;
  rules: { lotStep: number; minQty: number; priceTick: number; minNotional: number };
  simulated: boolean;
}
export interface ManualTradingState {
  enabled: boolean; mainnetEnabled: boolean; dryRun: boolean; mixed: boolean;
  accounts: ManualAccount[]; orders: ManualOrder[]; positions: ManualPosition[];
  protection: { type: "bot-managed"; exchangeResting: false; note: string };
}

export type TimelineEvidenceClass =
  | "AUTHORITATIVE_EVENT"
  | "AUTHORITATIVE_HISTORICAL_EVENT"
  | "CURRENT_AUTHORITATIVE_STATE"
  | "SAFE_DERIVATION";

export interface TimelineItem {
  key: string;
  timestamp: string;
  kind: string;
  state?: string;
  evidenceClass: TimelineEvidenceClass;
  title: string;
  description: string;
  source: "MANUAL" | "AUTOMATED" | "PAPER" | "UNKNOWN";
  evidenceSource: string;
  linkageEvidenceClass?: "AUTHORITATIVE_LINKAGE";
  identifiers: Partial<Record<
    "requestId" | "clientOrderId" | "exchangeOrderId" | "deploymentId"
    | "strategyId" | "signalId" | "alertId" | "intentId" | "strategyOrderIntentId"
    | "sourceKey" | "callerDedupeKey" | "botId" | "manualOrderId" | "manualCommandId"
    | "commandRequestId" | "targetManualOrderId" | "partialCloseId", string
  >>;
  quantity?: Partial<Record<
    "requestedBase" | "requestedQuote" | "filledBase" | "filledQuote" | "price" | "averagePrice"
    | "reportedQuantity" | "baseQuantity" | "quoteRevenue" | "realizedPnlQuote"
    | "cumulativeExecutedBaseQuantity" | "cumulativeExecutedQuoteQuantity", number
  >>;
}

export interface TradingTimeline {
  scope: {
    kind: "manual_order" | "deployment";
    id: string;
    source: "MANUAL" | "AUTOMATED" | "PAPER" | "UNKNOWN";
    symbol: string | null;
    side: string | null;
    executionMode: string;
    delivery?: string;
    strategyId?: string;
    configId?: string | null;
  };
  finalKnownState: string | null;
  items: TimelineItem[];
  gaps: string[];
  truncated: boolean;
}

export type JournalSource = "MANUAL" | "AUTOMATED" | "PAPER";
export interface JournalSummarySlice {
  knownRealizedPnl: number; knownRealizedRows: number; realizationRows: number;
  knownFees: number; feeKnownRows: number; wins: number; losses: number; scratches: number;
  incompleteRows: number; unknownEconomicRows: number; durationKnownRows: number;
  averageDurationMs: number | null;
}
export interface JournalRow {
  id: string; kind: "ACTIVITY" | "REALIZATION" | "CLOSED_TRADE";
  source: JournalSource; environment: "REAL" | "PAPER"; symbol: string;
  side: "BUY" | "SELL" | null; title: string; occurredAt: string;
  entryAt: string | null; realizationAt: string | null; durationMs: number | null;
  quantity: number | null; entryPrice: number | null; exitPrice: number | null;
  grossRealizedPnl: number | null; fees: number | null; realizedPnl: number | null;
  netRealizedPnl: number | null;
  economicsState: "KNOWN" | "UNKNOWN"; feeState: "KNOWN" | "UNKNOWN";
  evidenceState: "COMPLETE" | "INCOMPLETE"; evidenceDetail: string;
  strategy: { id: string; key: string | null; name: string | null } | null;
  deploymentId: string | null; config: { id: string; name: string | null } | null;
  reason: string | null; identifiers: Record<string, string | undefined>;
}
export interface JournalResponse {
  rows: JournalRow[];
  page: { number: number; limit: number; hasNext: boolean };
  range: { from: string; toExclusive: string; period: "day" | "week" | "month" };
  summary: JournalSummarySlice & {
    real: JournalSummarySlice; paper: JournalSummarySlice;
    bySource: Array<{ source: JournalSource; summary: JournalSummarySlice }>;
    bySymbol: Array<{ symbol: string; source: JournalSource; summary: JournalSummarySlice }>;
    byPeriod: Array<{ bucket: string; source: JournalSource; summary: JournalSummarySlice }>;
    evidenceRowsScanned: number; truncated: boolean;
  };
  limitations: string[];
}

export const api = {
  // symbols + market data
  listSymbols: (activeOnly = false) =>
    req<SymbolInfo[]>(`/api/symbols${activeOnly ? "?active=true" : ""}`),
  addSymbol: (symbol: string, baseAsset: string, quoteAsset: string) =>
    req<SymbolInfo>("/api/symbols", { method: "POST", body: JSON.stringify({ symbol, baseAsset, quoteAsset }) }),
  searchSymbols: (q: string, quote = "", limit = 50) =>
    req<SymbolSearchResponse>(
      `/api/symbols/search?q=${encodeURIComponent(q)}&quote=${encodeURIComponent(quote)}&limit=${limit}`
    ),
  searchMarket: (q: string, quote = "", venue = "", limit = 60) =>
    req<SymbolSearchResponse>(
      `/api/market/v1/search?q=${encodeURIComponent(q)}&quote=${encodeURIComponent(quote)}` +
      `&venue=${encodeURIComponent(venue)}&limit=${limit}`
    ),
  /**
   * Candles in the COMPACT wire format.
   *
   * Measured on the chart's default 10,000-bar 15m request
   * (`platform/backend/scripts/bench_candles.ts`): 2,487,844 -> 674,250 bytes
   * (249 -> 67 per bar) and 11.1 -> 4.2 ms to `JSON.parse`. That parse is on
   * the main thread before anything can be drawn, and it happens again on every
   * symbol and timeframe switch.
   */
  candles: (symbol: string, interval: Resolution, limit = 1000, signal?: AbortSignal) =>
    req<CompactCandles>(
      symbol.toLowerCase().startsWith("instrument:v1:")
        ? `/api/market/v1/candles/${encodeURIComponent(symbol)}?interval=${interval}&limit=${limit}&format=compact`
        : `/api/symbols/${symbol}/candles?interval=${interval}&limit=${limit}&format=compact`,
      signal ? { signal } : undefined
    ).then(expandCompact),

  /**
   * The same-origin watchlist seed: last price and the price 24h ago, from
   * Binance's public ticker through the backend's market-data host. Read once
   * per watchlist change so the rows are populated before — or without — the
   * browser's own market stream.
   */
  tickers: (symbols: readonly string[], signal?: AbortSignal) =>
    req<Ticker24h[]>(
      `/api/symbols/tickers?symbols=${encodeURIComponent(symbols.join(","))}`,
      signal ? { signal } : undefined
    ),
  marketTickers: (instruments: readonly string[], signal?: AbortSignal) =>
    req<MarketTickerResponse>(
      `/api/market/v1/tickers?instruments=${encodeURIComponent(instruments.join(","))}`,
      signal ? { signal } : undefined
    ),
  marketStream: (instrument: string, kind: "ticker" | "candle", interval = "1m", signal?: AbortSignal) =>
    req<MarketStreamConfig>(
      `/api/market/v1/stream/${encodeURIComponent(instrument)}?kind=${kind}&interval=${encodeURIComponent(interval)}`,
      signal ? { signal } : undefined
    ),
  /** The verbose shape, for consumers that need quoteVolume or tradeCount. */
  candlesVerbose: (symbol: string, interval: Resolution, limit = 1000, signal?: AbortSignal) =>
    req<Candle[]>(
      `/api/symbols/${symbol}/candles?interval=${interval}&limit=${limit}`,
      signal ? { signal } : undefined
    ),
  /** Candles covering an explicit window — used to frame a backtest's own range. */
  candlesRange: (
    symbol: string, interval: Resolution, fromMs: number, toMs: number,
    limit = 200000, signal?: AbortSignal
  ) =>
    req<CompactCandles>(
      symbol.toLowerCase().startsWith("instrument:v1:")
        ? `/api/market/v1/candles/${encodeURIComponent(symbol)}?interval=${interval}&from=${fromMs}&to=${toMs}&limit=${limit}&format=compact`
        : `/api/symbols/${symbol}/candles?interval=${interval}&from=${fromMs}&to=${toMs}&limit=${limit}&format=compact`,
      signal ? { signal } : undefined
    ).then(expandCompact),
  /**
   * Store what a resolution is folded FROM.
   *
   * A derived resolution has nothing of its own to fetch, so the server
   * backfills its source and names both in the reply. The caller passes the
   * resolution it is on; the translation belongs on the side that owns the
   * candle store.
   */
  backfill: (
    symbol: string, interval: Resolution, start: string, end: string,
    signal?: AbortSignal,
  ) => req<{ fetched: number; interval: Resolution; source: Interval }>(
    "/api/data/backfill",
    { method: "POST", body: JSON.stringify({ symbol, interval, start, end }), ...(signal ? { signal } : {}) },
  ),

  // strategies + configs
  listStrategies: () => req<Strategy[]>("/api/strategies"),
  listConfigs: (key: string) => req<StrategyConfig[]>(`/api/strategies/${key}/configs`),
  createConfig: (key: string, body: Partial<StrategyConfig>) =>
    req<StrategyConfig>(`/api/strategies/${key}/configs`, { method: "POST", body: JSON.stringify(body) }),
  updateConfig: (id: string, body: Partial<StrategyConfig>) =>
    req<StrategyConfig>(`/api/configs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteConfig: (id: string) => req<void>(`/api/configs/${id}`, { method: "DELETE" }),

  // local optimizer winners
  optimizerBest: (symbol: string, rank = 1, strategy = "ma_rr_v9", timeframe: Interval = "15m") =>
    req<OptimizerBest>(`/api/optimizer/best/${symbol.toUpperCase()}?rank=${rank}&strategy=${strategy}&timeframe=${timeframe}`),
  /** Simulated fills for a `paper` deployment. 409 when it is not one. */
  paperResult: (deploymentId: string) =>
    req<PaperResult>(`/api/deployments/${deploymentId}/paper`),

  // operator console
  opsStatus: () => req<OpsStatus>(`/api/ops/status`),
  opsUnresolvedIntents: () => req<UnresolvedIntents>(`/api/ops/unresolved-intents`),
  opsHalt: (reason: string) =>
    req<{ halted: true; reason: string }>(`/api/ops/halt`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "HALT_TRADING", reason }),
    }),
  opsResume: () =>
    req<{ halted: false; previousReason?: string | null; note?: string }>(`/api/ops/resume`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "RESUME_TRADING" }),
    }),
  opsSetRiskLimits: (patch: Record<string, number | null>) =>
    req<OpsStatus["risk"]>(`/api/ops/risk-limits`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  // Manual Binance Spot commands (platform session -> HMAC service channel -> bot).
  /**
   * Advisory account context for the ticket. Bound to one symbol and one
   * account, and read-only: the execution Bot re-derives everything at
   * submission, so this can inform a human but never widen what executes.
   */
  manualAccountState: (symbol: string, accountId: string) => req<ManualAccountStateView>(
    `/api/manual-trading/account-state?symbol=${encodeURIComponent(symbol)}`
    + `&accountId=${encodeURIComponent(accountId)}`),
  manualState: (symbol?: string) => req<ManualTradingState>(
    `/api/manual-trading/state${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`),
  submitManualOrder: (body: Record<string, unknown>) => req<ManualOrder>(
    "/api/manual-trading/orders", { method: "POST", body: JSON.stringify(body) }),
  cancelManualOrder: (id: string, body: Record<string, unknown>) => req<ManualOrder>(
    `/api/manual-trading/orders/${id}/cancel`, { method: "POST", body: JSON.stringify(body) }),
  updateManualProtection: (id: string, body: Record<string, unknown>) => req<ManualPosition>(
    `/api/manual-trading/positions/${id}/protection`, { method: "PATCH", body: JSON.stringify(body) }),
  manualOrderTimeline: (id: string) => req<TradingTimeline>(
    `/api/trading-timeline/manual-orders/${encodeURIComponent(id)}`),
  deploymentTimeline: (id: string, limit = 50) => req<TradingTimeline>(
    `/api/trading-timeline/deployments/${encodeURIComponent(id)}?limit=${limit}`),
  journal: (query: {
    from: string; to: string; source?: JournalSource | ""; symbol?: string;
    deploymentId?: string; strategyId?: string; period: "day" | "week" | "month";
    page: number; limit?: number;
  }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== "" && value !== undefined) params.set(key, String(value));
    }
    return req<JournalResponse>(`/api/journal?${params.toString()}`);
  },
  tradingOverlays: (query: {
    symbol: string; from: number; to: number; replayCutoff?: number;
    limit?: number; scope?: "all" | "historical" | "current";
  }, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return req<TradingOverlayResponse>(`/api/trading-overlays?${params.toString()}`, { signal });
  },

  /** Every tree the backend can actually reach, from its own registry. */
  optimizerTrees: () => req<{ root: string; trees: OptimizerTree[] }>(`/api/optimizer/trees`),
  optimizerLeaderboardByTree: (tree: string) =>
    req<OptimizerLeaderboard>(`/api/optimizer/leaderboard?tree=${encodeURIComponent(tree)}`),

  // backtests
  listBacktests: (symbol?: string) =>
    req<Backtest[]>(`/api/backtests${symbol ? `?symbol=${symbol}` : ""}`),
  getBacktest: (id: string) => req<Backtest>(`/api/backtests/${id}`),
  getBacktestTrades: (id: string) => req<Trade[]>(`/api/backtests/${id}/trades`),
  createBacktest: (body: {
    strategyKey: string; configId?: string; symbol: string; timeframe: Interval;
    startTime: string; endTime: string; params?: StrategyParams;
    initialCapital?: number; commissionPct?: number; slippageTicks?: number;
  }) => req<Backtest>("/api/backtests", { method: "POST", body: JSON.stringify(body) }),

  // chart layouts (server-persisted workspaces)
  listLayouts: () => req<ServerLayout[]>("/api/layouts"),
  getLayout: (id: string) => req<ServerLayout>(`/api/layouts/${id}`),
  upsertLayout: (body: {
    name: string; symbol: string; timeframe: Resolution; bars: number;
    strategyKey: string; params: StrategyParams; properties: unknown;
    movingAverages?: { type: MaType; length: number; visible: boolean }[];
  }) => req<ServerLayout>("/api/layouts", { method: "POST", body: JSON.stringify(body) }),
  updateLayout: (id: string, body: Partial<{
    name: string; symbol: string; timeframe: Resolution; bars: number;
    strategyKey: string; params: StrategyParams; properties: unknown;
    movingAverages: { type: MaType; length: number; visible: boolean }[];
  }>) => req<ServerLayout>(`/api/layouts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLayout: (id: string) => req<void>(`/api/layouts/${id}`, { method: "DELETE" }),
  syncDeploymentLayouts: () =>
    req<{ synced: string[]; count: number }>("/api/layouts/sync-deployments", { method: "POST" }),

  // pine editor
  listPineScripts: () => req<PineScript[]>("/api/pine"),
  getPineScript: (id: string) => req<PineScript>(`/api/pine/${id}`),
  savePineScript: (name: string, source: string) =>
    req<PineScript>("/api/pine", { method: "POST", body: JSON.stringify({ name, source }) }),
  updatePineScript: (id: string, body: { name?: string; source?: string }) =>
    req<PineScript>(`/api/pine/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deletePineScript: (id: string) => req<void>(`/api/pine/${id}`, { method: "DELETE" }),
  compilePine: (source: string) =>
    req<{ ok: boolean; meta: PineMeta; errors: PineCompileError[] }>(
      "/api/pine/compile", { method: "POST", body: JSON.stringify({ source }) }
    ),
  runPine: (body: {
    source: string; symbol: string; timeframe: Resolution;
    startTime?: string; endTime?: string;
    params?: Record<string, number | string | boolean>;
    initialCapital?: number; commissionPct?: number; slippageTicks?: number;
    qtyCash?: number; qtyPctEquity?: number;
  }) => req<PineRunResult>("/api/pine/run", { method: "POST", body: JSON.stringify(body) }),

  // deployments + alerts
  listDeployments: () => req<Deployment[]>("/api/deployments"),
  getDeployment: (id: string) => req<Deployment>(`/api/deployments/${id}`),
  createDeployment: (body: {
    strategyKey: string; configId?: string; symbol: string; timeframe: Interval;
    params?: StrategyParams; delivery: DeliveryMode; webhookUrl?: string;
    secret?: string; botUuid?: string; buyQuoteQty?: number;
  }) => req<Deployment>("/api/deployments", { method: "POST", body: JSON.stringify(body) }),
  updateDeployment: (id: string, body: Partial<{
    delivery: DeliveryMode; webhookUrl: string; secret: string;
    botUuid: string; buyQuoteQty: number;
  }>) => req<Deployment>(`/api/deployments/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  activateDeployment: (id: string) => req<Deployment>(`/api/deployments/${id}/activate`, { method: "POST" }),
  pauseDeployment: (id: string) => req<Deployment>(`/api/deployments/${id}/pause`, { method: "POST" }),
  deleteDeployment: (id: string) => req<void>(`/api/deployments/${id}`, { method: "DELETE" }),
  deploymentAlerts: (id: string, limit = 50) => req<Alert[]>(`/api/deployments/${id}/alerts?limit=${limit}`),
  listAlerts: (limit = 100) => req<Alert[]>(`/api/alerts?limit=${limit}`),

  // moving-average alerts (server-side watcher + Web Push to the phone)
  listMaAlerts: (opts: { symbol?: string; timeframe?: Interval } = {}) => {
    const q = new URLSearchParams();
    if (opts.symbol) q.set("symbol", opts.symbol);
    if (opts.timeframe) q.set("timeframe", opts.timeframe);
    const qs = q.toString();
    return req<MaAlert[]>(`/api/ma-alerts${qs ? `?${qs}` : ""}`);
  },
  maAlertOptions: () => req<MaAlertOptions>("/api/ma-alerts/options"),
  createMaAlert: (body: {
    symbol: string; timeframe: Interval;
    conditionKind?: ConditionKind;
    srSide?: SrSide;
    pivotType?: PivotType;
    levelName?: string;
    anchor?: string;
    rsiLength?: number; rsiLevel?: number; rsiMaLength?: number;
    macdFast?: number; macdSlow?: number; macdSignal?: number;
    stPeriod?: number; stMultiplier?: number; stAtrMethod?: StAtrMethod;
    /** `RsiTarget` or `MacdTarget`, depending on `conditionKind`. */
    target?: RsiTarget | MacdTarget;
    /**
     * Trend gates, accepted on every family. Send the `filter*` flag to enable
     * one with its defaults; omit them entirely to arm an ungated alert.
     */
    filterRsi?: boolean;
    filterRsiLength?: number; filterRsiLevel?: number; filterRsiSide?: FilterSide;
    filterMa?: boolean;
    filterMaType?: MaType; filterMaLength?: number; filterMaSide?: FilterSide;
    filterSt?: boolean;
    filterStPeriod?: number; filterStMultiplier?: number;
    filterStAtrMethod?: StAtrMethod; filterStSide?: FilterSide;
    maType?: MaType; maLength?: number; mode?: MaAlertMode;
    ma2Type?: MaType; ma2Length?: number;
    bbLength?: number; bbMult?: number; bbBand?: BollingerBand; bbMaType?: MaType;
    stochKLength?: number; stochKSmooth?: number; stochDSmooth?: number;
    stochLevel?: number;
    adxDiLength?: number; adxSmoothing?: number; adxLevel?: number;
    targetPrice?: number; priceDirection?: PriceDirection;
    frequency?: AlertFrequency;
    nearMinPct?: number; nearMaxPct?: number;
    cooldownMin?: number; note?: string | null;
  }) => req<MaAlert>("/api/ma-alerts", { method: "POST", body: JSON.stringify(body) }),
  createPatternAlert: (body: {
    symbol: string; timeframe: Interval; patternId: string;
  }) => req<Record<string, unknown>>("/api/ma-alerts", {
    method: "POST", body: JSON.stringify({
      ...body, conditionKind: "candlestick_pattern", frequency: "once_per_bar_close",
    }),
  }),
  updateMaAlert: (id: string, body: MaAlertUpdate) =>
    req<MaAlert>(`/api/ma-alerts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMaAlert: (id: string) => req<void>(`/api/ma-alerts/${id}`, { method: "DELETE" }),
  bulkMaAlerts: (action: BulkAlertAction, ids: string[]) =>
    req<BulkAlertResult>("/api/ma-alerts/bulk", {
      method: "POST", body: JSON.stringify({ action, ids }),
    }),
  /**
   * Delivered alert events, optionally scoped to one chart.
   *
   * Pass both `symbol` and `timeframe` or neither: a symbol alone would return
   * a 1h alert's events to a 1m chart. Scoping matters for the chart's marks —
   * unscoped, this is the newest N across every alert on the account, so busy
   * alerts elsewhere hide this chart's and the absence of a mark stops meaning
   * anything.
   */
  maAlertEvents: (limit = 100, scope?: { symbol: string; timeframe: string }) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (scope) {
      query.set("symbol", scope.symbol);
      query.set("timeframe", scope.timeframe);
    }
    return req<MaAlertEvent[]>(`/api/ma-alerts/events?${query.toString()}`);
  },

  // watchlists (server-side, so the same lists appear on the phone)
  // chart state (drawings and applied studies, so a second device sees them)
  getChartDrawings: (symbol: string) =>
    req<StoredDrawingState>(`/api/chart-state/drawings/${encodeURIComponent(symbol)}`),
  putChartDrawings: (symbol: string, drawings: unknown[], baseVersion: number) =>
    reqAcceptingConflict<StoredDrawingState>(
      `/api/chart-state/drawings/${encodeURIComponent(symbol)}`, { drawings, baseVersion }),
  getChartPaneStudies: (scope: string) =>
    req<StoredPaneState>(`/api/chart-state/panes/${encodeURIComponent(scope)}`),
  /**
   * Write one pane's studies. An OMITTED half is left as the server has it.
   *
   * The two halves are owned by two different hooks, and a writer that has
   * nothing to say about the other must not erase it — sending `pine: []` from
   * the native hook is precisely how a pane's Pine studies got deleted.
   */
  putChartPaneStudies: (
    scope: string,
    body: { pine?: unknown[]; native?: unknown[]; baseVersion: number }
  ) =>
    reqAcceptingConflict<StoredPaneState>(
      `/api/chart-state/panes/${encodeURIComponent(scope)}`, body),
  listChartPanes: () => req<StoredPaneState[]>("/api/chart-state/panes"),

  listWatchlists: () => req<ServerWatchlist[]>("/api/watchlists"),
  upsertWatchlist: (body: { name: string; symbols: string[]; position?: number }) =>
    req<ServerWatchlist>("/api/watchlists", { method: "POST", body: JSON.stringify(body) }),
  updateWatchlist: (id: string, body: Partial<{ name: string; symbols: string[]; position: number }>) =>
    req<ServerWatchlist>(`/api/watchlists/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteWatchlist: (id: string) => req<void>(`/api/watchlists/${id}`, { method: "DELETE" }),

  // Web Push registration
  vapidKey: () => req<{ publicKey: string; devices: number }>("/api/push/vapid"),
  subscribePush: (sub: PushSubscriptionJSON) =>
    req<{ id: string; devices: number }>("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) }),
  unsubscribePush: (endpoint: string) =>
    req<{ ok: boolean; devices: number }>("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),
  testPush: () =>
    req<{ sent: number; pruned: number; failed: number }>("/api/push/test", { method: "POST" }),
};

export type { BacktestStatus };
