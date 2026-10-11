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
import type { Backtest, BacktestMetrics, Strategy, StrategyParams } from "./types";
import { ALL_FIELDS } from "./paramSchema";

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
    {
      label: "Data source",
      value: provider ? (PROVIDERS[provider] ?? provider) : "Not recorded on this run",
      ...(provider || feed ? { title: [provider, feed].filter(Boolean).join(" · ") } : {}),
    },
    {
      label: "Engine",
      value: engineVersion ?? (bt.engineFingerprint ? "Recorded" : "Not recorded on this run"),
      ...(bt.engineFingerprint ? { title: bt.engineFingerprint } : {}),
    },
    {
      label: "Result provenance",
      value: SEMANTICS[bt.semanticsStatus ?? "historical_unversioned"],
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
  for (const f of ALL_FIELDS) {
    const raw = v.params[f.key];
    if (typeof raw !== "number") continue;
    if (!Number.isFinite(raw)) return `${f.label} must be a number.`;
    if (f.min !== undefined && raw < f.min) return `${f.label} must be at least ${f.min}.`;
    if (f.max !== undefined && raw > f.max) return `${f.label} must be at most ${f.max}.`;
  }
  return null;
}

// ── Comparing two runs ──────────────────────────────────────────────────────

export interface CompareRow {
  label: string;
  a: string;
  b: string;
  /** True when the two differ — the rows a reader needs to see first. */
  differs: boolean;
}

function figureRows(prefix: string, a: BacktestMetrics | null, b: BacktestMetrics | null): CompareRow[] {
  const fa = a ? tradeFigures(a) : null;
  const fb = b ? tradeFigures(b) : null;
  const row = (label: string, pa: string, pb: string): CompareRow => ({ label: `${prefix}${label}`, a: pa, b: pb, differs: pa !== pb });
  const pct = (n: number | undefined): string => n === undefined ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  return [
    row("Net profit", pct(a?.netProfitPct), pct(b?.netProfitPct)),
    row("Max drawdown", a ? `-${a.maxDrawdownPct.toFixed(2)}%` : "—", b ? `-${b.maxDrawdownPct.toFixed(2)}%` : "—"),
    row("Trades", fa ? `${fa.count} ${unitOf(fa.basis, fa.count)}` : "—", fb ? `${fb.count} ${unitOf(fb.basis, fb.count)}` : "—"),
    row("Win rate", fa ? winRateText(fa) : "—", fb ? winRateText(fb) : "—"),
    row("Profit factor", fa ? profitFactorText(fa) : "—", fb ? profitFactorText(fb) : "—"),
  ];
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
    const va = sa.find((r) => r.label === label)?.value ?? "—";
    const vb = sb.find((r) => r.label === label)?.value ?? "—";
    return { label, a: va, b: vb, differs: va !== vb };
  });
  const paramsDiffer = JSON.stringify(paramRows(a.params)) !== JSON.stringify(paramRows(b.params));
  settings.push({
    label: "Strategy parameters",
    a: paramsDiffer ? "differ" : "same",
    b: paramsDiffer ? "differ" : "same",
    differs: paramsDiffer,
  });

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
