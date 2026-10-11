/**
 * The stress page's sentences and settings, kept apart from the page so each
 * can be tested as what it says rather than as markup.
 *
 * Every function here describes a stress run to a reader. None of them is
 * involved in CHOOSING the windows — that happens on the server, from the
 * benchmark's candles alone, before the strategy is named.
 */
import type { Backtest, ExecutionTruth, Interval, StressDiscovery, StressWindow } from "./types";
import { displayTicker, displayVenue } from "./instrument";
import { fmtNum, fmtPct } from "./format";

/** The first eight characters of a run's id — enough to tell two runs apart on screen. */
export function shortRunId(id: string): string {
  return id.slice(0, 8);
}

/**
 * One row of "Start from a run": which run, over what window, and how it did.
 *
 * The row used to end on the day the run was CREATED, so five runs of the
 * same strategy on the same symbol made that afternoon read as five identical
 * lines — and the two things that tell them apart, the dates they covered and
 * their result, were not on the row. Dates are UTC days, like every other
 * window on this page.
 */
export function startableRunLabel(b: Backtest, strategyName: string | null): string {
  const utcDay = (iso: string): string => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "—";
  };
  const window = `${utcDay(b.startTime)} → ${utcDay(b.endTime)}`;
  const net = b.metrics ? ` · ${fmtPct(b.metrics.netProfitPct)}` : "";
  return `${shortRunId(b.id)} · ${strategyName ?? "strategy"} · ${displayTicker(b.symbol)} · `
    + `${b.timeframe} · ${window}${net}`;
}

/** A finished backtest's configuration, as a stress run will re-send it. */
export interface StressSource {
  backtestId: string;
  strategyKey: string;
  strategyName: string;
  symbol: string;
  timeframe: Interval;
  params: Backtest["params"];
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
}

/**
 * Read the settings out of a backtest so its stress run runs THAT
 * configuration.
 *
 * Without this the page ran every strategy at its defaults, whatever run the
 * reader had just been looking at, and said so only in a footnote under the
 * results. The params sent are the run's own merged snapshot, not its saved
 * config's id: the config may have been edited or deleted since, and the
 * point is to reproduce the run, not whatever the config says today.
 *
 * Returns a reason instead when the run's strategy is not one this install
 * can run — a stress run of a strategy the worker cannot load would queue
 * windows that can only fail.
 */
export function stressSourceFromBacktest(
  backtest: Backtest,
  strategies: readonly { id: number; key: string; name: string }[],
): StressSource | { reason: string } {
  const strategy = strategies.find((s) => s.id === backtest.strategyId);
  if (!strategy) {
    return { reason: "The strategy that run used is not available here, so its settings cannot be stressed." };
  }
  // C-07: a run queued before the request rules existed carries settings the
  // server refuses; every window it queued would be refused the same way.
  if (backtest.refusedSettings) {
    return { reason: `That run's settings cannot be stressed — this engine now refuses them: ${backtest.refusedSettings}` };
  }
  return {
    backtestId: backtest.id,
    strategyKey: strategy.key,
    strategyName: strategy.name,
    symbol: backtest.symbol,
    timeframe: backtest.timeframe,
    params: { ...backtest.params },
    initialCapital: backtest.initialCapital,
    commissionPct: backtest.commissionPct,
    slippageTicks: backtest.slippageTicks,
  };
}

/** "Stressing the settings of run 1a2b3c4d (MA RR v9 · SOLUSDT · 1h)". */
export function stressSourceHeadline(source: StressSource): string {
  return `Stressing the settings of run ${shortRunId(source.backtestId)} `
    + `(${source.strategyName} · ${displayTicker(source.symbol)} · ${source.timeframe})`;
}

/** The rest of what is being re-sent, so nothing about the configuration is implied. */
export function stressSourceDetail(source: StressSource): string {
  const n = Object.keys(source.params).length;
  return `${n} parameter${n === 1 ? "" : "s"} · ${fmtNum(source.initialCapital, 0)} initial capital · `
    + `${fmtNum(source.commissionPct, 3)} % commission per fill · `
    + `${source.slippageTicks} tick${source.slippageTicks === 1 ? "" : "s"} slippage`;
}

const METRIC_LABEL: Record<StressWindow["selectedBy"]["metric"], string> = {
  worst_return: "return",
  deepest_drawdown: "drawdown",
  highest_volatility: "volatility",
  manual: "named window",
};

/**
 * Why a window is in the table: the statistic it was ranked on, and its value.
 *
 * The three statistics are all shown in their own columns; this is the one
 * that put the window there, which a reader otherwise has to infer from the
 * method name in a footnote.
 */
export function qualifiedBy(window: StressWindow): string {
  const { metric, value } = window.selectedBy;
  if (metric === "manual") return METRIC_LABEL.manual;
  if (metric === "worst_return") return `${METRIC_LABEL.worst_return} ${fmtPct(value)}`;
  if (metric === "deepest_drawdown") return `${METRIC_LABEL.deepest_drawdown} -${fmtNum(value)}%`;
  return `${METRIC_LABEL.highest_volatility} ${fmtNum(value)}`;
}

/**
 * Where the benchmark's candles came from, as a reader would say it.
 *
 * The provenance stores `binance-spot` / `binance-public-klines`, which are
 * identifiers for a support ticket, not words. The venue is read from the
 * canonical instrument; the raw ids go in the tooltip.
 */
export function benchmarkSource(benchmark: StressDiscovery["benchmark"]): {
  label: string; detail: string;
} {
  const venue = benchmark.canonicalInstrument ? displayVenue(benchmark.canonicalInstrument) : null;
  return {
    label: venue ? `${venue} market data` : "this install's stored market data",
    detail: `provider ${benchmark.providerId} · feed ${benchmark.feedId}`,
  };
}

/**
 * What one window's Strategy % is a percentage OF — said where the number is.
 *
 * The engine sizes every entry from the strategy's own `qty_cash` (or a
 * percentage of equity), NOT from the initial capital, while Strategy % is
 * net profit divided by that capital. With the page's old default of 10,000
 * capital and a 1,000 cash size, a strategy fully exposed through a −30 %
 * window showed −3 %, beside a benchmark column showing −30 %, under a line
 * calling the two "directly comparable". They are not, and the ratio that
 * makes them comparable is this run's to state.
 *
 * `example` is a target return to make the arithmetic concrete with; the
 * worst window's, normally.
 */
export function exposureNote(
  sizing: ExecutionTruth["sizing"] | null,
  initialCapital: number,
  example: { returnPct: number; symbol: string } | null,
): string {
  if (!sizing) {
    return "How much of the capital each entry commits is reported once a window has run.";
  }
  if (sizing.mode === "percent_of_equity") {
    return `Each entry commits ${fmtNum(sizing.value, 0)} % of current equity, so a window `
      + "compounds; Strategy % is net profit over the initial capital.";
  }
  const share = initialCapital > 0 ? (sizing.value / initialCapital) * 100 : null;
  const head = `Each entry commits a fixed ${fmtNum(sizing.value, 0)} of quote currency`
    + (share === null ? "" : ` — ${fmtNum(share, 0)} % of the ${fmtNum(initialCapital, 0)} initial capital`)
    + ", and Strategy % is net profit over that capital, not over the cash at risk.";
  if (share === null || !example) return head;
  return `${head} Held through the whole of a window in which ${displayTicker(example.symbol)} `
    + `moved ${fmtPct(example.returnPct)}, a position of that size would show about `
    + `${fmtPct((example.returnPct * share) / 100)} here before costs.`;
}
