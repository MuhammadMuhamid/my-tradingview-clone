/**
 * What a backtest request may ask for, checked before anything is queued.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `POST /api/backtests` checked the strategy, the symbol, the timeframe, the
 * date order and the holdout fraction, and nothing else. A request for an
 * initial capital of -5, a commission of -1 % and -50 ticks of slippage was
 * queued, simulated and stored as `done` — a confident result for a market in
 * which the trader is paid to trade. A negative `rrRatio` or `qty_cash` was
 * accepted the same way and came back as "0 trades", which reads as the
 * strategy declining rather than the request being impossible.
 *
 * A bad number is refused here, as a 400 on the request that made it, in a
 * sentence the form can show: the same reasoning the holdout check already
 * documented ("not an error on a queued row the user has to open a result page
 * to discover").
 *
 * Pure — no database, no clock of its own — so the rules are testable without
 * the shared test database, and the route stays the only caller.
 */
export const BACKTEST_LIMITS = {
  /** Above this the figure is a typo, not an account. */
  maxInitialCapital: 1e12,
  /**
   * Per fill. The trees run 0.1 %; 5 % per side is already far beyond any
   * venue this engine models, so anything above it is a unit mistake (a
   * percent typed as basis points, say) rather than a cost model.
   */
  maxCommissionPct: 5,
  /** Ticks, per fill. */
  maxSlippageTicks: 1000,
  /**
   * The validation window's share of the range.
   *
   * The splitter accepts anything strictly between 0 and 1, but below a
   * twentieth the window is too short to hold a trade on most timeframes, and
   * above a half the development window is smaller than the one it is meant
   * to be checked against.
   */
  minHoldoutFraction: 0.05,
  maxHoldoutFraction: 0.5,
} as const;

const DAY_MS = 86_400_000;

export interface RunSettingsInput {
  initialCapital?: unknown;
  commissionPct?: unknown;
  slippageTicks?: unknown;
  holdoutFraction?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The first problem with a request's run settings, as a sentence, or null.
 *
 * Only fields that are PRESENT are checked; an absent one takes the route's
 * default, which is valid by construction.
 */
export function runSettingsProblem(body: RunSettingsInput, nowMs: number): string | null {
  const L = BACKTEST_LIMITS;
  if (body.initialCapital !== undefined) {
    if (!finite(body.initialCapital) || body.initialCapital <= 0) {
      return "Initial capital must be a number greater than 0.";
    }
    if (body.initialCapital > L.maxInitialCapital) {
      return `Initial capital must be at most ${L.maxInitialCapital.toExponential(0)}.`;
    }
  }
  if (body.commissionPct !== undefined) {
    if (!finite(body.commissionPct) || body.commissionPct < 0 || body.commissionPct > L.maxCommissionPct) {
      return `Commission must be between 0 and ${L.maxCommissionPct} % per fill.`;
    }
  }
  if (body.slippageTicks !== undefined) {
    // Not required to be whole: Pine's input is, but the engine prices any
    // multiple of the tick, and the chart's Strategy Tester has always sent
    // whatever its field holds.
    if (!finite(body.slippageTicks) || body.slippageTicks < 0 || body.slippageTicks > L.maxSlippageTicks) {
      return `Slippage must be between 0 and ${L.maxSlippageTicks} ticks.`;
    }
  }
  if (body.holdoutFraction !== undefined) {
    if (!finite(body.holdoutFraction)
      || body.holdoutFraction < L.minHoldoutFraction || body.holdoutFraction > L.maxHoldoutFraction) {
      return `The validation window must be between ${L.minHoldoutFraction * 100} % and `
        + `${L.maxHoldoutFraction * 100} % of the range (holdoutFraction ${L.minHoldoutFraction}–${L.maxHoldoutFraction}).`;
    }
  }

  const startTime = new Date((body.startTime ?? NaN) as string | number).getTime();
  const endTime = new Date((body.endTime ?? NaN) as string | number).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    return "startTime and endTime must be valid dates with startTime < endTime";
  }
  /*
   * A window in the future used to be queued and then fail in the backfill as
   * `invalid SOLUSDT 1h backfill: empty_series` — there are no candles for a
   * day that has not happened. Refused here, it is a sentence on the form.
   *
   * The line is the end of TODAY (UTC), not this instant. The chart's
   * Strategy Tester sends an end date as `T23:59:59Z`, so a run "to today" is
   * hours in the future by the clock and is still a perfectly good request:
   * the engine simulates the bars that exist. What has no bars at all is a
   * window that begins after now, or ends on a day that has not started.
   */
  const startOfTomorrow = Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS;
  if (startTime > nowMs || endTime >= startOfTomorrow) {
    return "The end date is in the future. A backtest can only run over history that has already happened.";
  }
  return null;
}

/**
 * Numeric parameters every shipped strategy shares, with the range in which
 * the engine can do anything meaningful with them.
 *
 * The backend carries no per-strategy input schema — the grouped schema with
 * min/max lives in the frontend's `lib/paramSchema.ts` — so this is the
 * shared core rather than the whole tree: the position size and the reward
 * multiple, the two whose bad values were observed to produce a silent
 * zero-trade run.
 */
const PARAM_BOUNDS: Record<string, { min: number; max: number; exclusiveMin?: boolean; label: string }> = {
  qty_cash: { min: 0, max: 1e12, exclusiveMin: true, label: "Order size (qty_cash)" },
  qty_pct_equity: { min: 0, max: 100, label: "Order size as % of equity (qty_pct_equity)" },
  rrRatio: { min: 0, max: 1000, exclusiveMin: true, label: "Reward : risk ratio (rrRatio)" },
};

/** The first problem with a request's strategy parameters, or null. */
export function paramsProblem(params: unknown): string | null {
  if (params === undefined) return null;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return "params must be an object of strategy inputs.";
  }
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    const kind = typeof value;
    if (kind !== "number" && kind !== "string" && kind !== "boolean") {
      return `Strategy input ${key} must be a number, a string or a boolean.`;
    }
    if (kind === "number" && !Number.isFinite(value)) {
      return `Strategy input ${key} must be a finite number.`;
    }
    const bound = PARAM_BOUNDS[key];
    // A cash size is not read when the run sizes by equity, and the chart's
    // Strategy Tester always sends one; a legacy zero there means nothing.
    const sizedByEquity = Number((params as Record<string, unknown>).qty_pct_equity ?? 0) > 0;
    if (key === "qty_cash" && sizedByEquity) continue;
    if (bound && kind === "number") {
      const n = value as number;
      const low = bound.exclusiveMin ? n <= bound.min : n < bound.min;
      if (low || n > bound.max) {
        return `${bound.label} must be ${bound.exclusiveMin ? "greater than" : "at least"} ${bound.min}`
          + ` and at most ${bound.max}.`;
      }
    }
  }
  return null;
}

/**
 * A backtest id is a UUID. Anything else names no row — and handing it to
 * Postgres raised `invalid input syntax for type uuid`, which the route
 * reported as a 500: a server fault for what is a wrong address.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isBacktestId(id: string): boolean {
  return UUID.test(id);
}
