import type {
  Alert, Backtest, BacktestStatus, Candle, Deployment, DeliveryMode,
  Interval, Strategy, StrategyConfig, StrategyParams, SymbolInfo, Trade,
} from "./types";

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
  baseAsset: string;
  quoteAsset: string;
  /** already in the local symbols table (has candles / can be charted at once) */
  tracked: boolean;
}

export interface SymbolSearchResponse {
  total: number;
  quotes: string[];
  results: SymbolSearchResult[];
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
  inputs: PineInputDef[];
}

export interface PineCompileError { line: number; col: number; message: string }

export interface PinePlotSeries {
  id: string;
  title: string;
  color: string;
  width: number;
  style: string;
  data: (number | null)[];
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
  hlines?: { price: number; color: string; title: string }[];
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
  timeframe: Interval;
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

export interface CompactCandles {
  format: "compact-v1";
  symbol: string;
  interval: Interval;
  stepMs: number;
  count: number;
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
export type FeedState = "live" | "lagging" | "stale" | "gapped" | "unknown";
export type DeliveryState = "failing" | "stalled" | "degraded" | "idle" | "healthy";

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
      realisedPnlInWindow: number;
    };
    summary: string;
  };
  deployments: { total: number; active: number; long: number; paused: number };
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
      symbol: string; interval: string; state: string;
      lastBarTime: string | null; lastCheckedAt: string;
      barsBehind: number | null; gapCount?: number | null; detail?: string | null;
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

/** Alert modes the MA watcher understands; mirrors backend types/maAlerts.ts. */
export type MaAlertMode = "touch" | "cross_up" | "cross_down" | "near_above" | "near_below";
export type MaType = "sma" | "ema";

/** What an alert watches. `ma` is the original family. */
export type ConditionKind = "price" | "ma" | "ma_vs_ma" | "sr_zone" | "pivot_level";

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
  srSide: SrSide | null;
  srPivotLength: number | null;
  srInvalidation: string | null;
  pivotType: PivotType | null;
  pivotLevelName: string | null;
  pivotAnchor: string | null;
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
  frequencies: AlertFrequencyOption[];
}

export interface ServerWatchlist {
  id: string;
  name: string;
  symbols: string[];
  position: number;
  updatedAt: string;
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
  /**
   * Candles in the COMPACT wire format.
   *
   * Measured on the chart's default 10,000-bar 15m request
   * (`platform/backend/scripts/bench_candles.ts`): 2,487,844 -> 674,250 bytes
   * (249 -> 67 per bar) and 11.1 -> 4.2 ms to `JSON.parse`. That parse is on
   * the main thread before anything can be drawn, and it happens again on every
   * symbol and timeframe switch.
   */
  candles: (symbol: string, interval: Interval, limit = 1000, signal?: AbortSignal) =>
    req<CompactCandles>(
      `/api/symbols/${symbol}/candles?interval=${interval}&limit=${limit}&format=compact`,
      signal ? { signal } : undefined
    ).then(expandCompact),

  /** The verbose shape, for consumers that need quoteVolume or tradeCount. */
  candlesVerbose: (symbol: string, interval: Interval, limit = 1000, signal?: AbortSignal) =>
    req<Candle[]>(
      `/api/symbols/${symbol}/candles?interval=${interval}&limit=${limit}`,
      signal ? { signal } : undefined
    ),
  /** Candles covering an explicit window — used to frame a backtest's own range. */
  candlesRange: (
    symbol: string, interval: Interval, fromMs: number, toMs: number,
    limit = 200000, signal?: AbortSignal
  ) =>
    req<CompactCandles>(
      `/api/symbols/${symbol}/candles?interval=${interval}&from=${fromMs}&to=${toMs}&limit=${limit}&format=compact`,
      signal ? { signal } : undefined
    ).then(expandCompact),
  backfill: (symbol: string, interval: Interval, start: string, end: string) =>
    req<{ fetched: number }>("/api/data/backfill", { method: "POST", body: JSON.stringify({ symbol, interval, start, end }) }),

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
    name: string; symbol: string; timeframe: Interval; bars: number;
    strategyKey: string; params: StrategyParams; properties: unknown;
    movingAverages?: { type: MaType; length: number; visible: boolean }[];
  }) => req<ServerLayout>("/api/layouts", { method: "POST", body: JSON.stringify(body) }),
  updateLayout: (id: string, body: Partial<{
    name: string; symbol: string; timeframe: Interval; bars: number;
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
    source: string; symbol: string; timeframe: Interval;
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
    maType?: MaType; maLength?: number; mode?: MaAlertMode;
    ma2Type?: MaType; ma2Length?: number;
    targetPrice?: number; priceDirection?: PriceDirection;
    frequency?: AlertFrequency;
    nearMinPct?: number; nearMaxPct?: number;
    cooldownMin?: number; note?: string | null;
  }) => req<MaAlert>("/api/ma-alerts", { method: "POST", body: JSON.stringify(body) }),
  updateMaAlert: (id: string, body: Partial<{
    enabled: boolean; cooldownMin: number; nearMinPct: number;
    nearMaxPct: number; mode: MaAlertMode; timeframe: Interval; note: string | null;
    frequency: AlertFrequency; targetPrice: number; priceDirection: PriceDirection;
  }>) => req<MaAlert>(`/api/ma-alerts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMaAlert: (id: string) => req<void>(`/api/ma-alerts/${id}`, { method: "DELETE" }),
  maAlertEvents: (limit = 100) => req<MaAlertEvent[]>(`/api/ma-alerts/events?limit=${limit}`),

  // watchlists (server-side, so the same lists appear on the phone)
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
