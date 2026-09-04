import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";
import { checkSeries, isBarClosed } from "./candleSeries";
import { MAX_BARS_BEHIND_LIVE, newestClosedBarOpenTime } from "./feedHealth";

export const CANDLE_INTEGRITY_STATES = ["healthy", "degraded", "invalid"] as const;
export type CandleIntegrityState = (typeof CANDLE_INTEGRITY_STATES)[number];

export const CANDLE_INTEGRITY_ISSUES = [
  "empty_series",
  "duplicate_timestamp",
  "out_of_order_timestamp",
  "missing_completed_interval",
  "malformed_ohlc",
  "non_finite_value",
  "non_positive_price",
  "stale_latest_completed_bar",
  "backfill_live_discontinuity",
  "identity_mismatch",
  "misaligned_timestamp",
  "invalid_close_time",
] as const;
export type CandleIntegrityIssueCode = (typeof CANDLE_INTEGRITY_ISSUES)[number];

export interface CandleIntegrityIssue {
  code: CandleIntegrityIssueCode;
  count: number;
  /** Bounded examples; count remains the complete count. */
  timestamps: number[];
}

export interface CandleIntegrityReport {
  state: CandleIntegrityState;
  market: "spot";
  symbol: string;
  interval: Interval;
  checkedAt: number;
  latestCompletedBarOpenTime: number | null;
  latestCompletedBarAgeMs: number | null;
  issues: CandleIntegrityIssue[];
}

export interface InspectCandleIntegrityOptions {
  symbol: string;
  interval: Interval;
  now: number;
  /** Historical/backfill ranges are not expected to end at `now`. */
  checkFreshness?: boolean;
}

const INVALID_CODES = new Set<CandleIntegrityIssueCode>([
  "empty_series",
  "malformed_ohlc",
  "non_finite_value",
  "non_positive_price",
  "identity_mismatch",
  "misaligned_timestamp",
  "invalid_close_time",
]);
const MAX_TIMESTAMPS_PER_ISSUE = 20;

function addIssue(
  issues: Map<CandleIntegrityIssueCode, CandleIntegrityIssue>,
  code: CandleIntegrityIssueCode,
  timestamps: number[],
  count = timestamps.length
): void {
  if (count <= 0) return;
  const current = issues.get(code);
  if (current) {
    current.count += count;
    current.timestamps.push(...timestamps.slice(0, MAX_TIMESTAMPS_PER_ISSUE - current.timestamps.length));
    return;
  }
  issues.set(code, { code, count, timestamps: timestamps.slice(0, MAX_TIMESTAMPS_PER_ISSUE) });
}

function finish(
  opts: InspectCandleIntegrityOptions,
  issues: Map<CandleIntegrityIssueCode, CandleIntegrityIssue>,
  latestCompletedBarOpenTime: number | null
): CandleIntegrityReport {
  const list = [...issues.values()];
  const state: CandleIntegrityState = list.some((issue) => INVALID_CODES.has(issue.code))
    ? "invalid"
    : list.length > 0
      ? "degraded"
      : "healthy";
  const age = latestCompletedBarOpenTime === null
    ? null
    : Math.max(0, opts.now - (latestCompletedBarOpenTime + INTERVAL_MS[opts.interval]));
  return {
    state,
    market: "spot",
    symbol: opts.symbol,
    interval: opts.interval,
    checkedAt: opts.now,
    latestCompletedBarOpenTime,
    latestCompletedBarAgeMs: age,
    issues: list,
  };
}

/**
 * Inspect only the supplied bounded series. It reports defects; it never
 * changes, sorts, deduplicates, fills or interpolates candles.
 */
export function inspectCandleIntegrity(
  candles: Candle[],
  opts: InspectCandleIntegrityOptions
): CandleIntegrityReport {
  const issues = new Map<CandleIntegrityIssueCode, CandleIntegrityIssue>();
  const step = INTERVAL_MS[opts.interval];
  if (candles.length === 0) addIssue(issues, "empty_series", [], 1);

  const structural = checkSeries(candles, opts.interval);
  addIssue(issues, "duplicate_timestamp", structural.duplicates);
  addIssue(issues, "out_of_order_timestamp", structural.outOfOrder);
  addIssue(issues, "misaligned_timestamp", structural.misaligned);
  addIssue(issues, "invalid_close_time", structural.badCloseTime);

  for (const candle of candles) {
    if (candle.symbol !== opts.symbol || candle.interval !== opts.interval) {
      addIssue(issues, "identity_mismatch", [candle.openTime]);
    }
    const numeric = [
      candle.openTime, candle.closeTime, candle.open, candle.high, candle.low,
      candle.close, candle.volume, candle.quoteVolume, candle.tradeCount,
    ].filter((value): value is number => value !== undefined);
    if (numeric.some((value) => !Number.isFinite(value))) {
      addIssue(issues, "non_finite_value", [candle.openTime]);
    }
    if ([candle.open, candle.high, candle.low, candle.close].some((value) => value <= 0)) {
      addIssue(issues, "non_positive_price", [candle.openTime]);
    }
    if (
      candle.low > candle.high || candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close)
    ) {
      addIssue(issues, "malformed_ohlc", [candle.openTime]);
    }
  }

  // Only completed bars participate in historical gap and freshness checks.
  // A forming bar and the next slot that has not closed are not missing facts.
  const completed = candles.filter((candle) => isBarClosed(candle, opts.now));
  const newestClosed = newestClosedBarOpenTime(opts.interval, opts.now);
  const observedOpenTimes = [...new Set(candles
    .map((candle) => candle.openTime)
    .filter((openTime) => Number.isInteger(openTime) && openTime % step === 0))]
    .sort((a, b) => a - b);
  let previousOpenTime: number | undefined;
  for (const openTime of observedOpenTimes) {
    if (previousOpenTime !== undefined && openTime > previousOpenTime + step) {
      const firstMissing = previousOpenTime + step;
      const lastMissing = Math.min(openTime - step, newestClosed);
      if (lastMissing >= firstMissing) {
        const missingBars = Math.floor((lastMissing - firstMissing) / step) + 1;
        addIssue(
          issues, "missing_completed_interval",
          [previousOpenTime, openTime], missingBars
        );
      }
    }
    previousOpenTime = openTime;
  }
  const latestCompleted = completed.reduce<number | null>(
    (latest, candle) => latest === null || candle.openTime > latest ? candle.openTime : latest,
    null
  );

  if (opts.checkFreshness !== false && latestCompleted !== null) {
    const expectedLatest = newestClosed;
    const barsBehind = Math.max(0, Math.round((expectedLatest - latestCompleted) / step));
    // Preserve the established feed semantic: one interval of close/write
    // latency is acceptable; two completed intervals behind is stale.
    if (barsBehind > MAX_BARS_BEHIND_LIVE) {
      addIssue(issues, "stale_latest_completed_bar", [latestCompleted], barsBehind);
    }
  }

  return finish(opts, issues, latestCompleted);
}

/** Validate one completed live candle against the newest stored/observed open. */
export function inspectBackfillLiveBoundary(
  previousOpenTime: number | null,
  candle: Candle,
  opts: InspectCandleIntegrityOptions
): CandleIntegrityReport {
  const base = inspectCandleIntegrity([candle], { ...opts, checkFreshness: false });
  const issues = new Map(base.issues.map((issue) => [issue.code, { ...issue, timestamps: [...issue.timestamps] }]));
  if (!isBarClosed(candle, opts.now) || previousOpenTime === null) {
    return finish(opts, issues, base.latestCompletedBarOpenTime);
  }

  const step = INTERVAL_MS[opts.interval];
  const delta = candle.openTime - previousOpenTime;
  if (delta === 0) {
    addIssue(issues, "duplicate_timestamp", [candle.openTime]);
  } else if (delta < 0) {
    addIssue(issues, "out_of_order_timestamp", [candle.openTime]);
  } else if (delta > step) {
    const missing = Math.max(0, Math.round(delta / step) - 1);
    addIssue(issues, "missing_completed_interval", [previousOpenTime, candle.openTime], missing);
    addIssue(issues, "backfill_live_discontinuity", [previousOpenTime, candle.openTime], 1);
  }
  return finish(opts, issues, base.latestCompletedBarOpenTime);
}

export function issueCounts(report: CandleIntegrityReport): Record<string, number> {
  return Object.fromEntries(report.issues.map((issue) => [issue.code, issue.count]));
}
