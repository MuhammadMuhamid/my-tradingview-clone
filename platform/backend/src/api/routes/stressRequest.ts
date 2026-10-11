/**
 * What a stress-run request may carry, checked before anything is queued.
 *
 * Kept apart from `stress.ts` so it reads no repository: every rule here is a
 * property of the request alone, and is tested as one.
 *
 * ── Why the run's settings are validated here at all ──────────────────────
 *
 * `/stress?from=<backtestId>` re-sends a finished run's parameters, capital
 * and cost model so the stress windows run the configuration the reader was
 * looking at rather than the strategy's defaults. Those values arrive from a
 * browser, and a stress run turns one request into up to ten queued
 * backtests. A capital of zero, a negative commission or a parameter that is
 * an object would each be accepted, queued ten times, and surface as ten
 * worker errors on a result page — or worse, as ten plausible numbers
 * computed under a cost model nobody meant. A 400 on the request that carried
 * it is the honest place for the refusal.
 */
import type { StrategyParams } from "../../types/strategy";

/** A database uuid. Anything else cannot name a row, so it is a 404, not a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Bounds that no real configuration approaches and every typo exceeds. */
const MAX_PARAM_KEYS = 200;
const MAX_PARAM_STRING = 500;
const MAX_INITIAL_CAPITAL = 1e12;
/** Per side, in percent. 10 % a fill is already absurd; 100 % is a typo. */
const MAX_COMMISSION_PCT = 10;
const MAX_SLIPPAGE_TICKS = 10_000;

export interface StressRunSettings {
  strategyKey: string;
  configId?: string;
  symbol?: string;
  timeframe?: string;
  params: StrategyParams;
  initialCapital?: number;
  commissionPct?: number;
  slippageTicks?: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: number; error: string };

const refuse = (error: string, code = 400): { ok: false; code: number; error: string } =>
  ({ ok: false, code, error });

/**
 * The strategy half of `POST /api/stress/runs`.
 *
 * Absent cost fields stay absent, so the route's own `DEFAULT_*` constants
 * apply — this function states no default of its own (`tests/costModel.test.ts`
 * forbids a second copy of those numbers).
 */
export function parseStressRunSettings(body: Record<string, unknown>): Parsed<StressRunSettings> {
  const { strategyKey, configId, symbol, timeframe, params } = body;
  if (typeof strategyKey !== "string" || strategyKey.length === 0) {
    return refuse("strategyKey is required");
  }
  if (configId !== undefined && configId !== null && !isUuid(configId)) {
    return refuse("config not found", 404);
  }
  if (symbol !== undefined && typeof symbol !== "string") return refuse("symbol must be a string");
  if (timeframe !== undefined && typeof timeframe !== "string") {
    return refuse("timeframe must be a string");
  }

  if (params !== undefined
    && (params === null || typeof params !== "object" || Array.isArray(params))) {
    return refuse("params must be an object of named values");
  }
  const entries = Object.entries((params ?? {}) as Record<string, unknown>);
  if (entries.length > MAX_PARAM_KEYS) {
    return refuse(`params may name at most ${MAX_PARAM_KEYS} values, got ${entries.length}`);
  }
  for (const [key, value] of entries) {
    const fine = typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && value.length <= MAX_PARAM_STRING);
    if (!fine) {
      return refuse(`params.${key} must be a finite number, a boolean or a short string`);
    }
  }

  const number = (name: string, value: unknown, ok: (n: number) => boolean, rule: string) => {
    if (value === undefined) return { ok: true as const, value: undefined };
    if (typeof value !== "number" || !Number.isFinite(value) || !ok(value)) {
      return { ok: false as const, error: `${name} must be ${rule}` };
    }
    return { ok: true as const, value };
  };
  const capital = number("initialCapital", body.initialCapital,
    (n) => n > 0 && n <= MAX_INITIAL_CAPITAL, "a positive amount");
  if (!capital.ok) return refuse(capital.error);
  const commission = number("commissionPct", body.commissionPct,
    (n) => n >= 0 && n <= MAX_COMMISSION_PCT, `a percentage per fill from 0 to ${MAX_COMMISSION_PCT}`);
  if (!commission.ok) return refuse(commission.error);
  const slippage = number("slippageTicks", body.slippageTicks,
    (n) => Number.isInteger(n) && n >= 0 && n <= MAX_SLIPPAGE_TICKS,
    `a whole number of ticks from 0 to ${MAX_SLIPPAGE_TICKS}`);
  if (!slippage.ok) return refuse(slippage.error);

  return {
    ok: true,
    value: {
      strategyKey,
      ...(typeof configId === "string" ? { configId } : {}),
      ...(symbol === undefined ? {} : { symbol: symbol.toUpperCase() }),
      ...(timeframe === undefined ? {} : { timeframe }),
      params: Object.fromEntries(entries) as StrategyParams,
      ...(capital.value === undefined ? {} : { initialCapital: capital.value }),
      ...(commission.value === undefined ? {} : { commissionPct: commission.value }),
      ...(slippage.value === undefined ? {} : { slippageTicks: slippage.value }),
    },
  };
}
