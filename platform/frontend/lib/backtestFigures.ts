/**
 * How a quick-backtest result is READ — the rules the result pages share.
 *
 * ── Why this is one module ─────────────────────────────────────────────────
 *
 * The list, the headline tiles, the per-window table and the comparison each
 * decided for themselves which trade count to print, what a missing profit
 * factor means, and how to describe a failure — and they decided differently.
 * The headline printed 242 trades at a leg win rate above windows printing
 * 68 / 148 / 26 legs at ENTRY win rates; the window table had learned that a
 * window with no trades must not show ∞ while the tile and the list had not;
 * and the list printed the engine's raw failure string as page copy.
 *
 * Every surface now asks this file, so a rule is fixed once.
 */
import type { Backtest, BacktestMetrics, Strategy, StrategyParams, Trade } from "./types";
import { ENGINE_ORDER_SIZE, groupsFor } from "./paramSchema";

// ── One denominator per row ─────────────────────────────────────────────────

/** Which population a row of figures counts. */
export type TradeBasis = "entries" | "legs";

export interface TradeFigures {
  basis: TradeBasis;
  /** Entries (or legs, on a row that recorded nothing else). */
  count: number;
  wins: number;
  losses: number;
  winRatePct: number;
  /** Null when nothing lost — which includes when nothing traded. */
  profitFactor: number | null;
  /** Mean net return per entry (or leg), %. */
  avgPct: number;
  /** Exit legs, always — the number the trade list has rows for. */
  legs: number;
}

/**
 * The trade figures of one result, all over ONE population.
 *
 * Entries, wherever the run recorded them, because an entry is the decision a
 * reader is judging: a partial take-profit closes one entry as two or three
 * legs, and a leg win rate counts the banked TP1 of a trade that went on to
 * lose as a win.
 *
 *  - A run recorded since the engine began naming the entry figures carries
 *    `entryWinRatePct`, on the headline and on every window.
 *  - A WINDOW recorded before that carries `entries`, and its `winRatePct`,
 *    `profitFactor` and win/loss counts were already entry-based (the engine
 *    overwrote them); only its `totalTrades` was legs.
 *  - A HEADLINE recorded before that is legs throughout, and is shown as legs
 *    and labelled so — it cannot be converted after the fact.
 */
export function tradeFigures(m: BacktestMetrics): TradeFigures {
  if (m.entryWinRatePct !== undefined && m.entries !== undefined) {
    return {
      basis: "entries",
      count: m.entries,
      wins: m.winningEntries ?? 0,
      losses: m.losingEntries ?? 0,
      winRatePct: m.entryWinRatePct,
      profitFactor: m.entryProfitFactor ?? null,
      avgPct: m.avgEntryPct ?? m.avgTradePct,
      legs: m.totalTrades,
    };
  }
  if (m.entries !== undefined) {
    return {
      basis: "entries",
      count: m.entries,
      wins: m.winningTrades,
      losses: m.losingTrades,
      winRatePct: m.winRatePct,
      profitFactor: m.profitFactor,
      // Not recorded per entry on these rows; the leg mean is the nearest
      // honest figure and `avgIsLegMean` says so.
      avgPct: m.avgTradePct,
      legs: m.totalTrades,
    };
  }
  return {
    basis: "legs",
    count: m.totalTrades,
    wins: m.winningTrades,
    losses: m.losingTrades,
    winRatePct: m.winRatePct,
    profitFactor: m.profitFactor,
    avgPct: m.avgTradePct,
    legs: m.totalTrades,
  };
}

/** True when `avgPct` is a per-leg mean presented beside entry counts. */
export function avgIsLegMean(m: BacktestMetrics): boolean {
  return m.entries !== undefined && m.avgEntryPct === undefined;
}

/** "entries" / "legs" — the unit word a count is printed with. */
export function unitOf(basis: TradeBasis, n?: number): string {
  if (n === 1) return basis === "entries" ? "entry" : "leg";
  return basis;
}

/**
 * A profit factor as text.
 *
 * `profitFactor` is null both for "no losses" and for "no trades". A run that
 * took nothing showed the same green ∞ as a run that lost nothing — the
 * strongest possible claim about the weakest possible evidence. `RunWindows`
 * learned this first; it is the rule everywhere now.
 */
export function profitFactorText(f: TradeFigures): string {
  if (f.count === 0) return "—";
  if (f.profitFactor === null) return "∞";
  return f.profitFactor.toFixed(2);
}

/** The direction a profit factor reads in, or none when there is nothing to judge. */
export function profitFactorTone(f: TradeFigures): "up" | "down" | "none" {
  if (f.count === 0) return "none";
  if (f.profitFactor === null || f.profitFactor >= 1) return "up";
  return "down";
}

/** A win rate as text; a window that took nothing has no rate. */
export function winRateText(f: TradeFigures): string {
  return f.count === 0 ? "—" : `${f.winRatePct.toFixed(1)}%`;
}

/**
 * Below these, a figure is a handful of outcomes rather than a rate.
 *
 * A whole run is held to the bar the headline has always printed (`< 100 =
 * low sample`). A window is a fraction of a run, so its bar is lower, and the
 * validation window — a fifth by default — is where it bites: twenty entries
 * at a 60 % win rate is twelve wins, and one more loss moves it five points.
 */
export const LOW_SAMPLE_RUN = 100;
export const LOW_SAMPLE_WINDOW = 30;

// ── The validation window ───────────────────────────────────────────────────

/** The engine's default validation share, when a run did not state one. */
export const DEFAULT_VALIDATION_FRACTION = 0.2;
/** The choices the form offers; the API accepts 0.05–0.5. */
export const VALIDATION_FRACTIONS = [0.1, 0.2, 0.3, 0.4, 0.5] as const;

export function validationLabel(fraction: number): string {
  return `last ${Math.round(fraction * 100)}% of the window`;
}

/** Where the windows begin, as times the equity curve actually has a point at. */
export interface EquityWindowMarks {
  /** First point at or after the out-of-sample boundary, or null. */
  outOfSampleStart: number | null;
  /** First point at or after the validation boundary, or null. */
  validationStart: number | null;
}

/**
 * The split boundaries snapped to the curve's own points.
 *
 * The stored curve is downsampled to about two thousand points, so a boundary
 * rarely falls on one; a chart marker must sit on a point that exists or the
 * library refuses it. The first point at or after the boundary is the first
 * one that belongs to the later window.
 */
export function equityWindowMarks(
  points: readonly { t: number }[],
  split: { outOfSample: { startMs: number }; holdout: { startMs: number } } | null,
): EquityWindowMarks {
  if (!split) return { outOfSampleStart: null, validationStart: null };
  const first = (ms: number): number | null => points.find((p) => p.t >= ms)?.t ?? null;
  return { outOfSampleStart: first(split.outOfSample.startMs), validationStart: first(split.holdout.startMs) };
}

// ── Failures, in the reader's words ─────────────────────────────────────────

export interface RunFailureCopy {
  /** What happened, for the reader. Safe as the most prominent line. */
  headline: string;
  /** What to do about it. */
  action: string;
  /** The engine's message verbatim — for the tooltip and a support request, never the headline. */
  detail: string;
}

/**
 * Why a backtest did not finish, said for the person who ran it.
 *
 * The engine fails with its own vocabulary — `invalid SOLUSDT 1h backfill:
 * empty_series`, `internal candle gap in …`, `no tick size available for …` —
 * and the list printed that as the row's body while the detail page said
 * "Hover for the reason". Neither told the reader what to change. Each known
 * failure gets a sentence and a recovery; the raw text is kept verbatim as
 * `detail`.
 */
export function runFailure(raw: string | null | undefined): RunFailureCopy {
  const detail = String(raw ?? "");
  const pair = /\b([A-Z0-9]{2,}(?:USDT|USDC|BUSD|BTC|ETH|FDUSD|EUR|TRY)?)\s+(\d+[mhdwM])\b/.exec(detail);
  const what = pair ? `${pair[1]} ${pair[2]}` : "this instrument";

  if (/empty_series|returned no \S+ klines|no \S+ data for/i.test(detail)) {
    return {
      headline: `There were no candles for ${what} in the window you chose.`,
      action: "Choose dates inside the instrument's trading history — after it was listed, and not in the future — or a different timeframe.",
      detail,
    };
  }
  if (/internal candle gap/i.test(detail)) {
    return {
      headline: `The stored history for ${what} has a gap inside this window, and the engine will not simulate across missing bars.`,
      action: "Choose a window that avoids the gap, or re-run once the history has been backfilled.",
      detail,
    };
  }
  if (/backfill:/i.test(detail)) {
    return {
      headline: `The exchange's candles for ${what} in this window failed the integrity check.`,
      action: "Try a different window. If the same window keeps failing, the stored history needs repair.",
      detail,
    };
  }
  if (/no tick size/i.test(detail)) {
    return {
      headline: "The instrument's tick size is not known yet, so slippage could not be priced.",
      action: "Re-run in a moment; the exchange directory is synced on demand.",
      detail,
    };
  }
  if (/unknown symbol|disappeared while syncing/i.test(detail)) {
    return {
      headline: "The instrument is not in the catalogue any more.",
      action: "Choose another symbol, or add this one back before re-running.",
      detail,
    };
  }
  if (/rate limit|Binance \d{3}|fetch failed|ECONN|ETIMEDOUT|timeout|network/i.test(detail)) {
    return {
      headline: "The exchange did not answer while the history was being fetched.",
      action: "Re-run shortly; the settings are kept.",
      detail,
    };
  }
  if (/no engine module|strategy id .* not found/i.test(detail)) {
    return {
      headline: "This strategy has no engine to run it on this installation.",
      action: "Choose one of the strategies the form lists.",
      detail,
    };
  }
  return {
    headline: "The engine stopped before this backtest finished.",
    action: "Re-running with the same settings will reproduce it; the technical detail is below for a support request.",
    detail,
  };
}

// ── The settings a result was produced under ────────────────────────────────

export interface SettingRow {
  label: string;
  value: string;
  /** The technical form, for the tooltip, when the value is a summary of it. */
  title?: string;
}

const SEMANTICS: Record<NonNullable<Backtest["semanticsStatus"]>, string> = {
  reproducible: "Reproducible — engine, data source and cost model recorded",
  engine_only_legacy: "Engine recorded; data source and cost model were not",
  historical_unversioned: "Recorded before results carried an engine version",
};

const PROVIDERS: Record<string, string> = {
  "binance-spot": "Binance Spot",
};

// ── The engine a run was produced by ────────────────────────────────────────

/**
 * Each engine correction, in the reader's words.
 *
 * The keys are `backend/src/engine/corrections.ts`'s `CORRECTION_KEYS`; a key
 * this list does not know is shown as itself rather than dropped, so a newer
 * engine never reads as having fewer corrections than it has.
 */
export const CORRECTION_LABELS: Readonly<Record<string, string>> = {
  executableCloseFills: "Protective exits fill at the bar's close",
  netAvgTrade: "Average trade net of costs",
  exchangeFilters: "Exchange lot and notional filters",
  leanWarmupFloor: "Indicator warm-up floor",
  zeroPnlIsScratch: "Zero-P/L trades are scratches",
  assertSegmentValidity: "Window split validity check",
  entryBarBrackets: "Stop and target active on the entry bar",
  barMagnifier: "Bar magnifier",
  lotDustExit: "Sub-lot remainder closes the position",
  affordableEntries: "Entries the account cannot pay for are skipped",
  feeInclusiveAffordability: "Entry affordability includes commission",
};

export function correctionLabel(key: string): string {
  return CORRECTION_LABELS[key] ?? key;
}

/** The corrections a stored fingerprint names, or null when it is not one the engine writes. */
export function fingerprintCorrections(fingerprint: string | null | undefined): string[] | null {
  if (typeof fingerprint !== "string") return null;
  if (/^engine:legacy-baseline(:|$)/.test(fingerprint)) return [];
  const m = /^engine:v2-corrected:(.+)$/.exec(fingerprint);
  if (!m) return null;
  return m[1]!.split("+").map((s) => s.trim()).filter(Boolean);
}

const listOf = (keys: readonly string[]): string => keys.map(correctionLabel).join("; ");

/**
 * C-02: the sentence a finished run carries when the engine that produced it
 * is not the one the server runs now, or null.
 *
 * Its figures are reproducible only under an engine nobody runs any more — a
 * run from before `lotDustExit` counts sub-lot dust legs as wins — so the
 * page must not let "Reproducible" stand alone beside them.
 */
export function olderEngineNotice(bt: Pick<Backtest, "status" | "engineCurrency">): string | null {
  const c = bt.engineCurrency;
  if (!c || c.current || bt.status !== "done") return null;
  if (c.missing.length > 0) {
    return `This run used an older engine (missing: ${listOf(c.missing)}). `
      + "Re-run to get figures from the current engine.";
  }
  return `This run used engine corrections the server no longer applies (${listOf(c.extra)}). `
    + "Re-run to get figures from the current engine.";
}

/** The short form for a list row's badge tooltip. */
export function olderEngineTitle(bt: Pick<Backtest, "engineCurrency">): string | null {
  const c = bt.engineCurrency;
  if (!c || c.current) return null;
  return c.missing.length > 0
    ? `Produced by an older engine — missing: ${listOf(c.missing)}. Re-run for current figures.`
    : `Produced with corrections the server no longer applies: ${listOf(c.extra)}.`;
}

/**
 * C-07: the sentence a run carries when the server would refuse its settings
 * as a new request, or null. Re-run and Stress are refused with it.
 */
export function refusedSettingsNotice(bt: Pick<Backtest, "refusedSettings">): string | null {
  return bt.refusedSettings ? `Settings this engine now refuses: ${bt.refusedSettings}` : null;
}

// ── The list's filter and delete ────────────────────────────────────────────

/**
 * HVBO-4: does a run match the list's filter?
 *
 * The text matches the symbol, the timeframe, the strategy's name or key and
 * the status, case-insensitively; every word must match somewhere, so
 * "sol error" finds the failed SOLUSDT runs. `status` is one status, or "all".
 */
export function runMatches(
  r: Pick<Backtest, "symbol" | "timeframe" | "status">, strategy: Strategy | null, text: string, status: string,
): boolean {
  if (status !== "all" && r.status !== status) return false;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [r.symbol, r.timeframe, r.status, strategy?.name ?? "", strategy?.key ?? ""]
    .join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Why a run cannot be deleted, or null — the server's refusals, said before asking it. */
export function deleteBlocked(r: Pick<Backtest, "status" | "stressRunId">): string | null {
  if (r.status === "running") return "A running backtest cannot be deleted until it finishes.";
  if (r.stressRunId !== null) return "This run is one window of a stress analysis, which reads it.";
  return null;
}

/** A run that has not finished has no result for provenance to describe yet. */
function isPending(bt: Pick<Backtest, "status">): boolean {
  return bt.status === "queued" || bt.status === "running";
}

function utcDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

function utcStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function strategyFor(bt: Pick<Backtest, "strategyId">, strategies: readonly Strategy[]): Strategy | null {
  return strategies.find((s) => s.id === bt.strategyId) ?? null;
}

/** The fraction a run's validation window was cut at — stated, recorded, or the default. */
export function validationFractionOf(bt: Pick<Backtest, "holdoutFraction" | "segments">): {
  fraction: number; stated: boolean;
} {
  if (bt.holdoutFraction !== null && bt.holdoutFraction !== undefined) {
    return { fraction: bt.holdoutFraction, stated: true };
  }
  if (bt.segments?.available) return { fraction: bt.segments.holdoutFraction, stated: false };
  return { fraction: DEFAULT_VALIDATION_FRACTION, stated: false };
}

/**
 * Everything needed to reproduce a result, as rows.
 *
 * The detail page showed the symbol, the timeframe and the dates. The strategy,
 * the capital, the cost model, the sizing, the validation split and the engine
 * were all on the record and none was on the page, so a result could not be
 * reproduced — or even compared with another — from the page that reports it.
 */
export function runSettings(bt: Backtest, strategies: readonly Strategy[]): SettingRow[] {
  const strategy = strategyFor(bt, strategies);
  const prov = (bt.resultProvenance ?? {}) as {
    engineVersion?: unknown; providerId?: unknown; feedId?: unknown;
    costs?: { tickSize?: unknown };
  };
  const tick = typeof prov.costs?.tickSize === "number" ? prov.costs.tickSize : null;
  const { fraction, stated } = validationFractionOf(bt);
  /*
   * C-08: a queued or running run read "Not recorded on this run" and
   * "Recorded before results carried an engine version" — the words for an
   * OLD finished run — about a run that had simply not finished yet.
   */
  const noResult = bt.status === "error" ? "No result — the run did not finish"
    : isPending(bt) ? "Not finished yet" : null;
  const corrections = fingerprintCorrections(bt.engineFingerprint);
  const sizing = bt.executionTruth?.sizing;
  const qtyPct = Number(bt.params.qty_pct_equity ?? 0);
  const qtyCash = bt.params.qty_cash;
  const sizingText = sizing
    ? sizing.mode === "fixed_cash"
      ? `${sizing.value.toLocaleString()} cash per entry`
      : `${sizing.value}% of equity per entry (compounds)`
    : qtyPct > 0 ? `${qtyPct}% of equity per entry (compounds)`
      : qtyCash !== undefined ? `${Number(qtyCash).toLocaleString()} cash per entry`
        : "the strategy's default";
  const provider = typeof prov.providerId === "string" ? prov.providerId : null;
  const feed = typeof prov.feedId === "string" ? prov.feedId : null;
  const engineVersion = typeof prov.engineVersion === "string" ? prov.engineVersion : null;

  return [
    {
      label: "Strategy",
      value: strategy ? strategy.name : `Strategy #${bt.strategyId}`,
      title: strategy ? `key ${strategy.key}` : "This strategy is no longer registered",
    },
    { label: "Symbol", value: bt.symbol },
    { label: "Timeframe", value: bt.timeframe },
    { label: "Window requested (UTC)", value: `${utcDay(bt.startTime)} → ${utcDay(bt.endTime)}`, title: `${bt.startTime} → ${bt.endTime}` },
    {
      label: "Validation split",
      value: `${validationLabel(fraction)}${stated ? "" : " (engine default)"}`,
    },
    { label: "Initial capital", value: bt.initialCapital.toLocaleString() },
    { label: "Commission", value: `${bt.commissionPct}% per fill` },
    {
      label: "Slippage",
      value: `${bt.slippageTicks} tick${bt.slippageTicks === 1 ? "" : "s"} per fill`,
      ...(tick !== null ? { title: `tick size ${tick}` } : {}),
    },
    { label: "Position size", value: sizingText },
    {
      label: "Entry fills",
      value: bt.executionTruth
        ? bt.executionTruth.fillTiming === "next_bar_open" ? "at the next bar's open" : "at the signal bar's close"
        : bt.params.fill_bar_close ? "at the signal bar's close" : "at the next bar's open",
    },
    /*
     * C-09: a run that errored has no result for these to describe. It read
     * "Not recorded on this run" and "Recorded before results carried an
     * engine version" — the words for an OLD finished run — about a run from
     * this morning that failed in its backfill.
     */
    {
      label: "Data source",
      value: noResult ?? (provider ? (PROVIDERS[provider] ?? provider) : "Not recorded on this run"),
      ...(provider || feed ? { title: [provider, feed].filter(Boolean).join(" · ") } : {}),
    },
    {
      label: "Engine",
      value: noResult ?? engineVersion ?? (bt.engineFingerprint ? "Recorded" : "Not recorded on this run"),
      ...(bt.engineFingerprint ? { title: bt.engineFingerprint } : {}),
    },
    /*
     * C-01 (product-readiness): "v2-corrected" named the family and hid the
     * set — two runs a correction apart both read "v2-corrected". The set is
     * what decides the figures, so it is on the page in words.
     */
    ...(corrections !== null && noResult === null ? [{
      label: "Engine corrections",
      value: corrections.length === 0 ? "None — legacy baseline" : corrections.map(correctionLabel).join(", "),
      title: corrections.length === 0 ? bt.engineFingerprint ?? undefined : corrections.join(", "),
    }] : []),
    {
      label: "Result provenance",
      value: noResult
        ?? (bt.refusedSettings ? "Settings this engine now refuses — not reproducible as a new run"
          : bt.engineCurrency && !bt.engineCurrency.current
            ? "Older engine — a re-run today applies different corrections"
            : SEMANTICS[bt.semanticsStatus ?? "historical_unversioned"]),
      ...(bt.refusedSettings ? { title: bt.refusedSettings }
        : bt.engineCurrency && !bt.engineCurrency.current ? { title: olderEngineTitle(bt) ?? undefined } : {}),
    },
    { label: "Created", value: utcStamp(bt.createdAt) },
  ];
}

/** The parameters a run used, sorted, as printable pairs. */
export function paramRows(params: StrategyParams): [string, string][] {
  return Object.keys(params).sort((a, b) => a.localeCompare(b))
    .map((k) => [k, String(params[k])]);
}

// ── Re-running ──────────────────────────────────────────────────────────────

export interface RunRequest {
  strategyKey: string;
  symbol: string;
  timeframe: Backtest["timeframe"];
  startTime: string;
  endTime: string;
  params: StrategyParams;
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
  holdoutFraction?: number;
}

/**
 * The request that reproduces a run.
 *
 * The STORED parameters are sent — the run's own snapshot, already merged
 * over any config it was based on — and the config id is not, so a config
 * edited since cannot change what "the same settings" means. The dates are the
 * stored instants, not their calendar days, so a run the chart's tester ended
 * at `23:59:59Z` is re-run over the same bars.
 */
export function rerunRequest(bt: Backtest, strategyKey: string): RunRequest {
  return {
    strategyKey,
    symbol: bt.symbol,
    timeframe: bt.timeframe,
    startTime: bt.startTime,
    endTime: bt.endTime,
    params: { ...bt.params },
    initialCapital: bt.initialCapital,
    commissionPct: bt.commissionPct,
    slippageTicks: bt.slippageTicks,
    ...(bt.holdoutFraction !== null && bt.holdoutFraction !== undefined
      ? { holdoutFraction: bt.holdoutFraction } : {}),
  };
}

// ── The form's own checks ───────────────────────────────────────────────────

/** Mirrors `backend/src/api/backtestRequest.ts`; the server remains the authority. */
export const RUN_LIMITS = {
  maxInitialCapital: 1e12,
  maxCommissionPct: 5,
  maxSlippageTicks: 1000,
} as const;

export interface RunFormValues {
  capital: number;
  commissionPct: number;
  slippageTicks: number;
  /** YYYY-MM-DD, UTC. */
  start: string;
  end: string;
  params: StrategyParams;
  /** Which strategy the params belong to; its schema supplies the bounds. */
  strategyKey?: string;
}

/**
 * The first thing wrong with the form, in a sentence, or null.
 *
 * The same rules the server enforces, said before a request is sent, plus the
 * min/max the parameter schema already declares for the fields the form
 * renders — the number inputs carried those as attributes, and nothing read
 * them, so `rrRatio = -2` was submitted and came back as "0 trades".
 */
export function runFormProblem(v: RunFormValues, nowMs: number): string | null {
  if (!Number.isFinite(v.capital) || v.capital <= 0) return "Initial capital must be greater than 0.";
  if (v.capital > RUN_LIMITS.maxInitialCapital) return "Initial capital is larger than any account this engine models.";
  if (!Number.isFinite(v.commissionPct) || v.commissionPct < 0 || v.commissionPct > RUN_LIMITS.maxCommissionPct) {
    return `Commission must be between 0 and ${RUN_LIMITS.maxCommissionPct}% per fill.`;
  }
  if (!Number.isFinite(v.slippageTicks) || v.slippageTicks < 0 || v.slippageTicks > RUN_LIMITS.maxSlippageTicks) {
    return `Slippage must be between 0 and ${RUN_LIMITS.maxSlippageTicks} ticks.`;
  }
  const start = Date.parse(`${v.start}T00:00:00Z`);
  const end = Date.parse(`${v.end}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Choose a start and an end date.";
  if (start >= end) return "The start date must be before the end date.";
  const today = Math.floor(nowMs / 86_400_000) * 86_400_000;
  if (end > today) return "The end date is in the future. A backtest can only run over history that has already happened.";
  // The CHOSEN strategy's own fields and bounds: `mtf_lean` and `ma_rr_v9`
  // share key names with different meanings, and checking one against the
  // other's limits would refuse a valid run. No strategy given keeps the
  // historical ma_rr_v9 schema.
  const fields = (groupsFor(v.strategyKey ?? "ma_rr_v9") ?? []).flatMap((g) => g.fields);
  for (const f of fields) {
    const raw = v.params[f.key];
    if (typeof raw !== "number") continue;
    if (!Number.isFinite(raw)) return `${f.label} must be a number.`;
    if (f.min !== undefined && raw < f.min) return `${f.label} must be at least ${f.min}.`;
    if (f.max !== undefined && raw > f.max) return `${f.label} must be at most ${f.max}.`;
  }
  return orderSizeProblem(v.params, v.capital, ENGINE_ORDER_SIZE[v.strategyKey ?? "ma_rr_v9"] ?? null);
}

/**
 * C-01: an order size larger than the account — the server's sentence, said
 * before the request is sent. The run's own snapshot wins over the strategy's
 * engine default; percent-of-equity sizing is a share of the account by
 * construction and is not judged.
 */
function orderSizeProblem(
  params: StrategyParams,
  capital: number,
  defaults: { qty_cash: number; qty_pct_equity: number } | null,
): string | null {
  const pick = (key: "qty_cash" | "qty_pct_equity"): number =>
    Number(params[key] ?? defaults?.[key] ?? Number.NaN);
  const pct = pick("qty_pct_equity");
  if (Number.isFinite(pct) && pct > 0) return null;
  const cash = pick("qty_cash");
  if (!Number.isFinite(cash) || cash <= capital) return null;
  const n = (x: number): string => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `The order size (${n(cash)} per entry) is more than the initial capital (${n(capital)}). `
    + "A spot account cannot spend more than it holds — lower the order size or raise the initial capital.";
}

/** At or above this share of the capital per entry, the form warns before running. */
export const ORDER_SIZE_HINT_SHARE = 0.9;

/**
 * C-09: an order size the account can pay for once, but perhaps not twice.
 *
 * The defaults — 1,000 capital, 930 per entry — are affordable, and after the
 * first loss most entries are not: the engine skips them (`affordableEntries`)
 * and the run reads as a strategy that went quiet. Not an error, so not a
 * refusal: a hint, said before the run is queued. Null below the line, above
 * the capital (that is `runFormProblem`'s refusal), and for percent-of-equity
 * sizing, which is a share of whatever the account holds.
 */
export function orderSizeHint(params: StrategyParams, capital: number, strategyKey: string): string | null {
  const defaults = ENGINE_ORDER_SIZE[strategyKey] ?? null;
  const pick = (key: "qty_cash" | "qty_pct_equity"): number =>
    Number(params[key] ?? defaults?.[key] ?? Number.NaN);
  const pct = pick("qty_pct_equity");
  if (Number.isFinite(pct) && pct > 0) return null;
  const cash = pick("qty_cash");
  if (!Number.isFinite(cash) || !Number.isFinite(capital) || capital <= 0) return null;
  if (cash > capital || cash < capital * ORDER_SIZE_HINT_SHARE) return null;
  const n = (x: number): string => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `Each entry spends ${n(cash)} of the ${n(capital)} initial capital `
    + `(${Math.round((cash / capital) * 100)}%). After a loss the account may not afford the next entry; `
    + "skipped entries are counted on the result.";
}

// ── Comparing two runs ──────────────────────────────────────────────────────

export interface CompareRow {
  label: string;
  a: string;
  b: string;
  /** True when the two differ — the rows a reader needs to see first. */
  differs: boolean;
}

/**
 * A closed trade's P/L as a percentage of what it put in, NET of costs.
 *
 * C-08: the trade list's "P/L %" was the engine's `pnlPct` — the raw price
 * move, entry to exit — while "P/L" beside it is net of both commissions. So
 * a row read +0.16 % beside −0.33: a losing trade with a winning percentage.
 * This is the same division the engine's `netAvgTrade` correction makes for
 * the average: the leg's net P/L over its entry notional. The price move
 * stays available, as the cell's tooltip.
 */
export function tradeNetPct(t: Pick<Trade, "pnl" | "entryPrice" | "qty">): number | null {
  if (t.pnl === null) return null;
  const notional = t.entryPrice * Math.abs(t.qty);
  return notional > 0 ? (t.pnl / notional) * 100 : null;
}

/**
 * What a comparison cell says when one run has no value there.
 *
 * C-07: it was a bare "—", which beside a figure reads as zero, or as a
 * figure that failed to load. It is neither: the run predates the field, or
 * did not divide into windows, and says so.
 */
export const NOT_RECORDED = "not recorded for this run";

function figureRows(prefix: string, a: BacktestMetrics | null, b: BacktestMetrics | null): CompareRow[] {
  const fa = a ? tradeFigures(a) : null;
  const fb = b ? tradeFigures(b) : null;
  const row = (label: string, pa: string, pb: string): CompareRow => ({ label: `${prefix}${label}`, a: pa, b: pb, differs: pa !== pb });
  const pct = (n: number | undefined): string => n === undefined ? NOT_RECORDED : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  return [
    row("Net profit", pct(a?.netProfitPct), pct(b?.netProfitPct)),
    row("Max drawdown", a ? `-${a.maxDrawdownPct.toFixed(2)}%` : NOT_RECORDED, b ? `-${b.maxDrawdownPct.toFixed(2)}%` : NOT_RECORDED),
    row("Trades", fa ? `${fa.count} ${unitOf(fa.basis, fa.count)}` : NOT_RECORDED, fb ? `${fb.count} ${unitOf(fb.basis, fb.count)}` : NOT_RECORDED),
    // A run with no entries has no rate to state; it says so, as the result page does.
    row("Win rate", fa ? (fa.count === 0 ? "no trades" : winRateText(fa)) : NOT_RECORDED,
      fb ? (fb.count === 0 ? "no trades" : winRateText(fb)) : NOT_RECORDED),
    row("Profit factor", fa ? (fa.count === 0 ? "no trades" : profitFactorText(fa)) : NOT_RECORDED,
      fb ? (fb.count === 0 ? "no trades" : profitFactorText(fb)) : NOT_RECORDED),
  ];
}

/** Most parameter rows a comparison lists before it says how many more differ. */
const MAX_PARAM_ROWS = 12;

/**
 * C-07: the strategy parameters, compared key by key.
 *
 * The comparison said "Strategy parameters: differ / differ" — true, and
 * useless: the reader came to find WHICH input explains the difference and had
 * to open both runs to diff thirty values by eye. A summary row says how many
 * differ; one row per differing key follows, each run's value in its own
 * column. A key one run does not carry is "not set" there, which for these
 * snapshots means the strategy's default ran.
 */
function paramCompareRows(a: StrategyParams, b: StrategyParams): CompareRow[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => x.localeCompare(y));
  const shown = (p: StrategyParams, k: string): string => (k in p ? String(p[k]) : "not set");
  const differing = keys.filter((k) => shown(a, k) !== shown(b, k));
  if (differing.length === 0) {
    return [{ label: "Strategy parameters", a: "same", b: "same", differs: false }];
  }
  const count = `${differing.length} of ${keys.length} differ`;
  const rows: CompareRow[] = [{ label: "Strategy parameters", a: count, b: count, differs: true }];
  for (const k of differing.slice(0, MAX_PARAM_ROWS)) {
    rows.push({ label: `Parameter ${k}`, a: shown(a, k), b: shown(b, k), differs: true });
  }
  if (differing.length > MAX_PARAM_ROWS) {
    const more = `${differing.length - MAX_PARAM_ROWS} more — open each run`;
    rows.push({ label: "Other parameters", a: more, b: more, differs: true });
  }
  return rows;
}

/**
 * C-01 (product-readiness): the engine corrections, compared as sets.
 *
 * A run and its "Re-run with these settings" child compared as "same" on
 * every settings row — Engine `v2-corrected | v2-corrected`, parameters same —
 * while Net read −44.00 % against −7.26 %. The difference was the correction
 * set (`lotDustExit`, `affordableEntries` in the child only), carried in the
 * fingerprint and shown nowhere but a tooltip. Each side's extra corrections
 * get a row of their own, so the explanation is on the table.
 */
function engineCompareRows(a: Backtest, b: Backtest): CompareRow[] {
  const ca = fingerprintCorrections(a.engineFingerprint);
  const cb = fingerprintCorrections(b.engineFingerprint);
  if (ca === null || cb === null) {
    // One side recorded nothing comparable: say what each recorded, and flag
    // a difference only when the stored identities differ.
    const shown = (bt: Backtest, c: string[] | null): string =>
      isPending(bt) ? "Not finished yet"
        : c !== null ? (c.length === 0 ? "None — legacy baseline" : `${c.length} corrections`)
          : bt.engineFingerprint ? "not comparable — recorded in an older format" : NOT_RECORDED;
    const va = shown(a, ca);
    const vb = shown(b, cb);
    return [{ label: "Engine corrections", a: va, b: vb,
      differs: (a.engineFingerprint ?? null) !== (b.engineFingerprint ?? null) }];
  }
  const onlyA = ca.filter((k) => !cb.includes(k));
  const onlyB = cb.filter((k) => !ca.includes(k));
  if (onlyA.length === 0 && onlyB.length === 0) {
    return [{ label: "Engine corrections", a: "same", b: "same", differs: false }];
  }
  const count = `${onlyA.length + onlyB.length} differ`;
  const rows: CompareRow[] = [{ label: "Engine corrections", a: count, b: count, differs: true }];
  if (onlyA.length > 0) {
    rows.push({ label: "Engine corrections — only in A", a: listOf(onlyA), b: "not applied", differs: true });
  }
  if (onlyB.length > 0) {
    rows.push({ label: "Engine corrections — only in B", a: "not applied", b: listOf(onlyB), differs: true });
  }
  return rows;
}

/**
 * Two runs side by side: the settings that could explain a difference, the
 * headline, and each window.
 */
export function compareRuns(a: Backtest, b: Backtest, strategies: readonly Strategy[]): {
  settings: CompareRow[]; headline: CompareRow[]; windows: CompareRow[];
} {
  const sa = runSettings(a, strategies);
  const sb = runSettings(b, strategies);
  const wanted = ["Strategy", "Symbol", "Timeframe", "Window requested (UTC)", "Validation split",
    "Initial capital", "Commission", "Slippage", "Position size", "Entry fills", "Engine"];
  const settings = wanted.map((label) => {
    const va = sa.find((r) => r.label === label)?.value ?? NOT_RECORDED;
    const vb = sb.find((r) => r.label === label)?.value ?? NOT_RECORDED;
    return { label, a: va, b: vb, differs: va !== vb };
  });
  settings.push(...engineCompareRows(a, b));
  settings.push(...paramCompareRows(a.params ?? {}, b.params ?? {}));

  const seg = (bt: Backtest) => (bt.segments?.available ? bt.segments : null);
  const ga = seg(a);
  const gb = seg(b);
  const windows = [
    ...figureRows("Development · in sample — ", ga?.inSample ?? null, gb?.inSample ?? null),
    ...figureRows("Development · out of sample — ", ga?.outOfSample ?? null, gb?.outOfSample ?? null),
    ...figureRows("Validation — ", ga?.holdout ?? null, gb?.holdout ?? null),
  ];
  return { settings, headline: figureRows("", a.metrics, b.metrics), windows };
}
