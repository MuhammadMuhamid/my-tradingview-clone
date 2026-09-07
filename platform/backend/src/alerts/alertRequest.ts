/**
 * Turning an alert request body into a condition, and a condition back into the
 * columns that store it.
 *
 * Separated from the route so the accept/reject matrix — which is where every
 * 400 an alert client can see is decided — is testable as pure functions,
 * without a Fastify instance or a database connection.
 */
import { isInterval, type Interval } from "../types/market";
import {
  MA_ALERT_MODES, PRICE_DIRECTIONS,
  isMaAlertMode, isMaType, isPriceDirection,
  type ConditionKind, type MaAlertMode, type MaType, type PriceDirection,
  SR_SIDES, PIVOT_LEVEL_ANY, isSrSide, type SrSide,
  RSI_TARGETS, MACD_TARGETS, RSI_DEFAULTS, MACD_DEFAULTS,
  ST_ATR_METHODS, SUPERTREND_DEFAULTS, isStAtrMethod, type StAtrMethod,
  isRsiTarget, isMacdTarget,
  BOLLINGER_BANDS, BOLLINGER_DEFAULTS, isBollingerBand,
  STOCHASTIC_TARGETS, STOCHASTIC_DEFAULTS, isStochasticTarget,
  ADX_DEFAULTS,
  FILTER_DEFAULTS, isFilterSide,
  ALERT_HISTORY_BARS, warmupBars,
} from "../types/maAlerts";
import {
  FILTER_KINDS, isFilterKind,
  type AlertCondition, type AlertFilter, type AlertFilters,
} from "./alertConditions";
import { PIVOT_TYPES, isPivotType } from "../engine/pivotLevels";
import { DEFAULT_SR_OPTIONS } from "../engine/srZones";

/**
 * An indicator length that can actually be computed.
 *
 * The upper bound is not arbitrary politeness: a length is an allocation and a
 * warm-up requirement, and one larger than the history the runner keeps would
 * leave the series permanently NaN — an alert that is armed, looks healthy in
 * the list, and can never fire.
 */
const isLength = (v: number): boolean => Number.isInteger(v) && v >= 1 && v <= 1000;

/**
 * The bound `isLength` cannot express.
 *
 * `isLength` checks each length on its own, which is enough where a family's
 * warm-up IS one length. Where lengths stack — MACD's signal EMA on top of its
 * slow EMA, %D's smoothing on top of %K's, ADX's DX smoothing on top of DI —
 * two individually legal values can together need more bars than the runner
 * ever loads, and the result is a stored alert that reads as armed and can
 * never produce a first value.
 */
const tooLong = (need: number): Rejection =>
  bad(`these lengths need ${need} bars of history and the alert runner evaluates ` +
      `${ALERT_HISTORY_BARS}; the alert could never warm up`);

/**
 * Read the gates a request carries.
 *
 * Two shapes are accepted, and the newer one wins when both are present:
 *
 *  1. `filters: [{ kind, timeframe?, … }, …]` — the list form. It is the only
 *     shape that can express two gates of the same kind, which is the whole
 *     reason it exists: "15m RSI above 50 AND 1h RSI above 50".
 *  2. `filterRsi` / `filterMa` / `filterSt` with their flat fields — the
 *     single-gate-per-kind shape every client written before this sent. Still
 *     accepted so an older client is not broken by an upgrade, and still
 *     meaning "on the alert's own timeframe".
 *
 * Absent keys mean "no gate", which is what an unrelated request must keep
 * meaning: a gate is only ever built when asked for explicitly.
 */
function readFilters(b: Record<string, unknown>): { filters?: AlertFilters } | Rejection {
  if (b.filters !== undefined) {
    if (!Array.isArray(b.filters)) return bad("filters must be an array");
    const out: AlertFilters = [];
    for (const [index, raw] of b.filters.entries()) {
      const one = readOneFilter(raw, index);
      if ("error" in one) return one;
      out.push(one.filter);
    }
    return out.length > 0 ? { filters: out } : {};
  }
  return readLegacyFilters(b);
}

/** The timeframe a gate names, or null for the alert's own. */
function readFilterTimeframe(v: unknown, index: number): Interval | null | Rejection {
  if (v === undefined || v === null || v === "") return null;
  const tf = String(v);
  if (!isInterval(tf)) {
    return bad(`filters[${index}].timeframe is not a supported interval`);
  }
  return tf;
}

/** One element of the list form. */
function readOneFilter(
  raw: unknown, index: number
): { filter: AlertFilter } | Rejection {
  if (typeof raw !== "object" || raw === null) {
    return bad(`filters[${index}] must be an object`);
  }
  const f = raw as Record<string, unknown>;
  const kind = String(f.kind ?? "");
  if (!isFilterKind(kind)) {
    return bad(`filters[${index}].kind must be one of ${FILTER_KINDS.join(", ")}`);
  }
  const tf = readFilterTimeframe(f.timeframe, index);
  if (tf !== null && typeof tf === "object") return tf;
  const timeframe = tf as Interval | null;

  const side = String(f.side ?? "above");
  if (!isFilterSide(side)) return bad(`filters[${index}].side must be above or below`);

  if (kind === "rsi") {
    const length = Number(f.length ?? FILTER_DEFAULTS.rsi.length);
    const level = Number(f.level ?? FILTER_DEFAULTS.rsi.level);
    if (!isLength(length)) return bad(`filters[${index}].length must be an integer 1..1000`);
    if (!(Number.isFinite(level) && level > 0 && level < 100)) {
      return bad(`filters[${index}].level must be a number between 0 and 100 (exclusive)`);
    }
    return { filter: { kind: "rsi", timeframe, length, level, side } };
  }

  if (kind === "ma") {
    const type = String(f.type ?? FILTER_DEFAULTS.ma.type);
    const length = Number(f.length ?? FILTER_DEFAULTS.ma.length);
    if (!isMaType(type)) return bad(`filters[${index}].type must be sma or ema`);
    if (!isLength(length)) return bad(`filters[${index}].length must be an integer 1..1000`);
    return { filter: { kind: "ma", timeframe, type, length, side } };
  }

  const period = Number(f.period ?? FILTER_DEFAULTS.supertrend.period);
  const multiplier = Number(f.multiplier ?? FILTER_DEFAULTS.supertrend.multiplier);
  const atrMethod = String(f.atrMethod ?? FILTER_DEFAULTS.supertrend.atrMethod);
  if (!isLength(period)) return bad(`filters[${index}].period must be an integer 1..1000`);
  if (!isMultiplier(multiplier)) return bad(multiplierMessage(`filters[${index}].multiplier`));
  if (!isStAtrMethod(atrMethod)) {
    return bad(`filters[${index}].atrMethod must be one of ${ST_ATR_METHODS.join(", ")}`);
  }
  return { filter: { kind: "supertrend", timeframe, period, multiplier, atrMethod, side } };
}

/** The pre-list shape: at most one gate per kind, always the alert's own timeframe. */
function readLegacyFilters(
  b: Record<string, unknown>
): { filters?: AlertFilters } | Rejection {
  const filters: AlertFilters = [];

  if (b.filterRsi === true || b.filterRsiLength !== undefined) {
    const length = Number(b.filterRsiLength ?? FILTER_DEFAULTS.rsi.length);
    const level = Number(b.filterRsiLevel ?? FILTER_DEFAULTS.rsi.level);
    const side = String(b.filterRsiSide ?? FILTER_DEFAULTS.rsi.side);
    if (!isLength(length)) return bad("filterRsiLength must be an integer 1..1000");
    if (!(Number.isFinite(level) && level > 0 && level < 100)) {
      return bad("filterRsiLevel must be a number between 0 and 100 (exclusive)");
    }
    if (!isFilterSide(side)) return bad("filterRsiSide must be above or below");
    filters.push({ kind: "rsi", timeframe: null, length, level, side });
  }

  if (b.filterMa === true || b.filterMaLength !== undefined) {
    const type = String(b.filterMaType ?? FILTER_DEFAULTS.ma.type);
    const length = Number(b.filterMaLength ?? FILTER_DEFAULTS.ma.length);
    const side = String(b.filterMaSide ?? FILTER_DEFAULTS.ma.side);
    if (!isMaType(type)) return bad("filterMaType must be sma or ema");
    if (!isLength(length)) return bad("filterMaLength must be an integer 1..1000");
    if (!isFilterSide(side)) return bad("filterMaSide must be above or below");
    filters.push({ kind: "ma", timeframe: null, type, length, side });
  }

  if (b.filterSt === true || b.filterStPeriod !== undefined) {
    const period = Number(b.filterStPeriod ?? FILTER_DEFAULTS.supertrend.period);
    const multiplier = Number(b.filterStMultiplier ?? FILTER_DEFAULTS.supertrend.multiplier);
    const atrMethod = String(b.filterStAtrMethod ?? FILTER_DEFAULTS.supertrend.atrMethod);
    const side = String(b.filterStSide ?? FILTER_DEFAULTS.supertrend.side);
    if (!isLength(period)) return bad("filterStPeriod must be an integer 1..1000");
    if (!isMultiplier(multiplier)) return bad(multiplierMessage("filterStMultiplier"));
    if (!isStAtrMethod(atrMethod)) {
      return bad(`filterStAtrMethod must be one of ${ST_ATR_METHODS.join(", ")}`);
    }
    if (!isFilterSide(side)) return bad("filterStSide must be above or below");
    filters.push({ kind: "supertrend", timeframe: null, period, multiplier, atrMethod, side });
  }

  return filters.length > 0 ? { filters } : {};
}

/**
 * A Supertrend ATR multiplier that produces a usable band.
 *
 * Zero or negative collapses the two bands onto hl2 or swaps them, so the
 * trend would flip on nearly every bar. The upper bound is the other failure:
 * a band 100 ATRs wide never flips at all, which is an alert that looks armed
 * and is silently dead.
 */
const isMultiplier = (v: number): boolean => Number.isFinite(v) && v > 0 && v <= 100;

/**
 * Named for the field that was actually wrong.
 *
 * The gate and the alert share the rule but not the field name, and a rejection
 * that says `stMultiplier` when the client sent `filterStMultiplier` sends
 * someone looking at the wrong input. Found by driving these over HTTP.
 */
const multiplierMessage = (field: string): string =>
  `${field} must be a number greater than 0 and at most 100`;

/** Shared 400 shape, so every rejection reads the same way in the UI. */
export type Rejection = { error: string };
export const bad = (error: string): Rejection => ({ error });

/**
 * Build the condition a request describes, or the reason it cannot be built.
 *
 * The per-kind field checks and `validateCondition` are deliberately both here:
 * this one turns "you sent the wrong type" into a message, and that one owns the
 * rules a condition must satisfy to be evaluable at all. Keeping the second in
 * the domain module is what stops the API and the database from drifting into
 * two different ideas of a valid alert.
 */
export function readCondition(
  kind: ConditionKind, b: Record<string, unknown>
): { condition: AlertCondition } | Rejection {
  const nearMinPct = b.nearMinPct === undefined ? 0.2 : Number(b.nearMinPct);
  const nearMaxPct = b.nearMaxPct === undefined ? 0.5 : Number(b.nearMaxPct);
  /*
   * The band is bounded for EVERY mode, not only the two that read it.
   *
   * `near_max_pct > near_min_pct` is an unconditional CHECK on the table, but
   * `nearBandError` only bounds the `near_*` modes, so a `touch` alert carrying
   * a reversed band passed both validators and failed at the insert — a 500 on
   * a request that is merely malformed. Bounding it here costs a family
   * nothing: a mode that ignores the band cannot send a reversed one either.
   */
  if (!Number.isFinite(nearMinPct) || !Number.isFinite(nearMaxPct)) {
    return bad("nearMinPct and nearMaxPct must be numbers");
  }
  if (nearMinPct < 0 || !(nearMaxPct > nearMinPct)) {
    return bad("nearMaxPct must be greater than nearMinPct, and neither may be negative");
  }

  // Gates are offered on every family, so they are read once here rather than
  // per-kind — a family added below cannot forget to accept them.
  const gates = readFilters(b);
  if ("error" in gates) return gates;

  if (kind === "price") {
    const targetPrice = Number(b.targetPrice);
    const direction = String(b.priceDirection ?? "either");
    if (!Number.isFinite(targetPrice)) return bad("targetPrice must be a number");
    if (!isPriceDirection(direction)) {
      return bad(`priceDirection must be one of ${PRICE_DIRECTIONS.join(", ")}`);
    }
    return { condition: { kind: "price", targetPrice, direction, ...gates } };
  }

  if (kind === "supertrend") {
    const period = Number(b.stPeriod ?? SUPERTREND_DEFAULTS.period);
    const multiplier = Number(b.stMultiplier ?? SUPERTREND_DEFAULTS.multiplier);
    const atrMethod = String(b.stAtrMethod ?? SUPERTREND_DEFAULTS.atrMethod);
    const stMode = String(b.mode ?? "cross_up");
    if (!isLength(period)) return bad("stPeriod must be an integer 1..1000");
    if (!isMultiplier(multiplier)) return bad(multiplierMessage("stMultiplier"));
    if (!isStAtrMethod(atrMethod)) {
      return bad(`stAtrMethod must be one of ${ST_ATR_METHODS.join(", ")}`);
    }
    // The event is a direction change, which has exactly two directions. A
    // touch or a near-band mode would describe something this family does not
    // watch.
    if (stMode !== "cross_up" && stMode !== "cross_down") {
      return bad("mode must be cross_up or cross_down for a Supertrend alert");
    }
    return {
      condition: {
        kind: "supertrend", period, multiplier, atrMethod, mode: stMode, ...gates,
      },
    };
  }

  if (kind === "bollinger") {
    const length = Number(b.bbLength ?? BOLLINGER_DEFAULTS.length);
    const mult = Number(b.bbMult ?? BOLLINGER_DEFAULTS.mult);
    const band = String(b.bbBand ?? BOLLINGER_DEFAULTS.band);
    const bbMaType = String(b.bbMaType ?? BOLLINGER_DEFAULTS.maType);
    const bbMode = String(b.mode ?? "touch");
    if (!isLength(length) || length < 2) return bad("bbLength must be an integer 2..1000");
    if (!isMultiplier(mult)) return bad(multiplierMessage("bbMult"));
    if (!isBollingerBand(band)) {
      return bad(`bbBand must be one of ${BOLLINGER_BANDS.join(", ")}`);
    }
    if (!isMaType(bbMaType)) return bad("bbMaType must be sma or ema");
    if (!isMaAlertMode(bbMode)) return bad(`mode must be one of ${MA_ALERT_MODES.join(", ")}`);
    return {
      condition: {
        kind: "bollinger", length, mult, band, maType: bbMaType, mode: bbMode,
        nearMinPct, nearMaxPct, ...gates,
      },
    };
  }

  if (kind === "stochastic") {
    const kLength = Number(b.stochKLength ?? STOCHASTIC_DEFAULTS.kLength);
    const kSmooth = Number(b.stochKSmooth ?? STOCHASTIC_DEFAULTS.kSmooth);
    const dSmooth = Number(b.stochDSmooth ?? STOCHASTIC_DEFAULTS.dSmooth);
    const target = String(b.target ?? "signal");
    const level = Number(b.stochLevel ?? STOCHASTIC_DEFAULTS.level);
    const sMode = String(b.mode ?? "cross_up");
    for (const [name, v] of [
      ["stochKLength", kLength], ["stochKSmooth", kSmooth], ["stochDSmooth", dSmooth],
    ] as const) {
      if (!isLength(v)) return bad(`${name} must be an integer 1..1000`);
    }
    if (!isStochasticTarget(target)) {
      return bad(`target must be one of ${STOCHASTIC_TARGETS.join(", ")}`);
    }
    if (!Number.isFinite(level)) return bad("stochLevel must be a number");
    // The oscillator crosses; there is no band to be near and no wick to touch.
    if (sMode !== "cross_up" && sMode !== "cross_down") {
      return bad("mode must be cross_up or cross_down for a Stochastic alert");
    }
    const stochNeed = warmupBars({ kind: "stochastic", kLength, kSmooth, dSmooth });
    if (stochNeed > ALERT_HISTORY_BARS) return tooLong(stochNeed);
    return {
      condition: {
        kind: "stochastic", kLength, kSmooth, dSmooth, target, level, mode: sMode, ...gates,
      },
    };
  }

  if (kind === "adx") {
    const diLength = Number(b.adxDiLength ?? ADX_DEFAULTS.diLength);
    const smoothing = Number(b.adxSmoothing ?? ADX_DEFAULTS.smoothing);
    const level = Number(b.adxLevel ?? ADX_DEFAULTS.level);
    const aMode = String(b.mode ?? "cross_up");
    if (!isLength(diLength)) return bad("adxDiLength must be an integer 1..1000");
    if (!isLength(smoothing)) return bad("adxSmoothing must be an integer 1..1000");
    if (!Number.isFinite(level)) return bad("adxLevel must be a number");
    if (aMode !== "cross_up" && aMode !== "cross_down") {
      return bad("mode must be cross_up or cross_down for an ADX alert");
    }
    const adxNeed = warmupBars({ kind: "adx", diLength, smoothing });
    if (adxNeed > ALERT_HISTORY_BARS) return tooLong(adxNeed);
    return { condition: { kind: "adx", diLength, smoothing, level, mode: aMode, ...gates } };
  }

  if (kind === "sr_zone") {
    const srSide = String(b.srSide ?? "either");
    const srMode = String(b.mode ?? "near_above");
    if (!isSrSide(srSide)) return bad(`srSide must be one of ${SR_SIDES.join(", ")}`);
    if (!isMaAlertMode(srMode)) return bad(`mode must be one of ${MA_ALERT_MODES.join(", ")}`);
    const pivotLength = b.pivotLength === undefined
      ? DEFAULT_SR_OPTIONS.pivotLength : Number(b.pivotLength);
    const invalidation = String(b.invalidation ?? "close") === "wick" ? "wick" : "close";
    return {
      condition: {
        kind: "sr_zone", srSide, mode: srMode, nearMinPct, nearMaxPct,
        pivotLength, invalidation, ...gates,
      },
    };
  }

  if (kind === "pivot_level") {
    const pivotType = String(b.pivotType ?? "Fibonacci");
    const levelName = String(b.levelName ?? PIVOT_LEVEL_ANY);
    const anchor = String(b.anchor ?? "1d");
    const pMode = String(b.mode ?? "near_above");
    if (!isPivotType(pivotType)) return bad(`pivotType must be one of ${PIVOT_TYPES.join(", ")}`);
    if (!isMaAlertMode(pMode)) return bad(`mode must be one of ${MA_ALERT_MODES.join(", ")}`);
    return {
      condition: {
        kind: "pivot_level", pivotType, levelName, anchor,
        mode: pMode, nearMinPct, nearMaxPct, ...gates,
      },
    };
  }

  if (kind === "rsi") {
    const rsiLength = Number(b.rsiLength ?? RSI_DEFAULTS.length);
    const target = String(b.target ?? "level");
    // `rsiLevel`, matching the column, the row field and what the client
    // sends. Reading a differently-named key here made the level silently
    // default: a request for 70 was stored, and armed, as 50.
    const level = Number(b.rsiLevel ?? RSI_DEFAULTS.level);
    const rsiMaLength = Number(b.rsiMaLength ?? RSI_DEFAULTS.maLength);
    const rMode = String(b.mode ?? "cross_up");
    if (!isRsiTarget(target)) return bad(`target must be one of ${RSI_TARGETS.join(", ")}`);
    if (!isLength(rsiLength)) return bad("rsiLength must be an integer 1..1000");
    if (target === "sma" && !isLength(rsiMaLength)) {
      return bad("rsiMaLength must be an integer 1..1000");
    }
    // RSI is bounded 0..100 by construction, so a level outside it can never be
    // crossed — accepting one would arm an alert that is silently dead.
    if (target === "level" && !(Number.isFinite(level) && level > 0 && level < 100)) {
      return bad("level must be a number between 0 and 100 (exclusive)");
    }
    if (rMode !== "cross_up" && rMode !== "cross_down") {
      return bad("mode must be cross_up or cross_down for an RSI alert");
    }
    return {
      condition: {
        kind: "rsi", rsiLength, target, level, maLength: rsiMaLength, mode: rMode,
        ...gates,
      },
    };
  }

  if (kind === "macd") {
    const fastLength = Number(b.macdFast ?? MACD_DEFAULTS.fast);
    const slowLength = Number(b.macdSlow ?? MACD_DEFAULTS.slow);
    const signalLength = Number(b.macdSignal ?? MACD_DEFAULTS.signal);
    const target = String(b.target ?? "signal");
    const mMode = String(b.mode ?? "cross_up");
    if (!isMacdTarget(target)) return bad(`target must be one of ${MACD_TARGETS.join(", ")}`);
    for (const [name, v] of [
      ["macdFast", fastLength], ["macdSlow", slowLength], ["macdSignal", signalLength],
    ] as const) {
      if (!isLength(v)) return bad(`${name} must be an integer 1..1000`);
    }
    // A fast length at or above the slow one inverts the oscillator's meaning:
    // every "crosses above" would report what the user reads as a downturn.
    const macdNeed = warmupBars({
      kind: "macd", slowLength, signalLength,
    });
    if (macdNeed > ALERT_HISTORY_BARS) return tooLong(macdNeed);
    if (fastLength >= slowLength) {
      return bad("macdFast must be less than macdSlow");
    }
    if (mMode !== "cross_up" && mMode !== "cross_down") {
      return bad("mode must be cross_up or cross_down for a MACD alert");
    }
    return {
      condition: {
        kind: "macd", fastLength, slowLength, signalLength, target, mode: mMode,
        ...gates,
      },
    };
  }

  const maType = String(b.maType ?? "");
  const maLength = Number(b.maLength);
  const mode = String(b.mode ?? "");
  if (!isMaType(maType)) return bad("maType must be sma or ema");
  if (!Number.isInteger(maLength)) return bad("maLength must be an integer 1..1000");

  if (kind === "ma") {
    if (!isMaAlertMode(mode)) return bad(`mode must be one of ${MA_ALERT_MODES.join(", ")}`);
    return {
      condition: { kind: "ma", maType, maLength, mode, nearMinPct, nearMaxPct, ...gates },
    };
  }

  const ma2Type = String(b.ma2Type ?? "");
  const ma2Length = Number(b.ma2Length);
  if (!isMaType(ma2Type)) return bad("ma2Type must be sma or ema");
  if (!Number.isInteger(ma2Length)) return bad("ma2Length must be an integer 1..1000");
  if (mode !== "cross_up" && mode !== "cross_down") {
    return bad("mode must be cross_up or cross_down for an MA-versus-MA alert");
  }
  return {
    condition: { kind: "ma_vs_ma", maType, maLength, ma2Type, ma2Length, mode, ...gates },
  };
}

/**
 * The flat column shape a condition is stored as.
 *
 * Named so the edit path can talk about "the columns this alert would have"
 * without restating the list, and so a family added here cannot be forgotten
 * by `alerts/alertEdit.ts`.
 */
export type AlertColumns = {
  conditionKind: ConditionKind;
  maType: MaType | null; maLength: number | null; mode: MaAlertMode | null;
  ma2Type: MaType | null; ma2Length: number | null;
  targetPrice: number | null; priceDirection: PriceDirection | null;
  nearMinPct: number; nearMaxPct: number;
  srSide: SrSide | null; srPivotLength: number | null; srInvalidation: string | null;
  pivotType: string | null; pivotLevelName: string | null; pivotAnchor: string | null;
  rsiLength: number | null; rsiLevel: number | null; rsiMaLength: number | null;
  macdFast: number | null; macdSlow: number | null; macdSignal: number | null;
  stPeriod: number | null; stMultiplier: number | null;
  stAtrMethod: StAtrMethod | null;
  bbLength: number | null; bbMult: number | null;
  bbBand: string | null; bbMaType: MaType | null;
  stochKLength: number | null; stochKSmooth: number | null;
  stochDSmooth: number | null; stochLevel: number | null;
  adxDiLength: number | null; adxSmoothing: number | null; adxLevel: number | null;
  indicatorTarget: string | null;
  filterRsiLength: number | null; filterRsiLevel: number | null;
  filterRsiSide: string | null;
  filterMaType: MaType | null; filterMaLength: number | null;
  filterMaSide: string | null;
  filterStPeriod: number | null; filterStMultiplier: number | null;
  filterStAtrMethod: StAtrMethod | null; filterStSide: string | null;
  /** The gates, in order. The authoritative storage since migration 032. */
  filters: AlertFilters;
};

/** Flatten a condition back into the column shape the repository writes. */
export function toColumns(condition: AlertCondition): AlertColumns {
  // Columns that belong to no kind are null, so a row never carries another
  // kind's settings for an operator to misread.
  const empty = {
    srSide: null, srPivotLength: null, srInvalidation: null,
    pivotType: null, pivotLevelName: null, pivotAnchor: null,
    rsiLength: null, rsiLevel: null, rsiMaLength: null,
    macdFast: null, macdSlow: null, macdSignal: null,
    stPeriod: null, stMultiplier: null, stAtrMethod: null,
    bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
    stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
    adxDiLength: null, adxSmoothing: null, adxLevel: null,
    indicatorTarget: null,
  };

  /**
   * Flatten the optional gates; absent halves stay null.
   *
   * Spread into EVERY family below, not just the level ones. A family that
   * omitted this would accept a gate at the API and silently drop it on the
   * way to the database, which presents to the user as a filter that does
   * nothing — the hardest kind of alert bug to notice.
   */
  const gates = (f: AlertFilters | undefined) => {
    /*
     * `filters` is the storage. The legacy columns are still written for the
     * first gate of each kind that names no timeframe, so a row stays readable
     * by code that predates the list — the rollback path, and any query
     * someone has already written against those columns.
     *
     * A gate on another timeframe, or a second gate of the same kind, has no
     * legacy column that could express it, so it lives only in `filters`.
     * Writing a partial truth into the old columns instead would be worse than
     * leaving them null: it would read as a complete gate that is not the one
     * being enforced.
     */
    const list = f ?? [];
    const firstOwn = (kind: AlertFilter["kind"]) =>
      list.find((x) => x.kind === kind && x.timeframe === null);
    const rsi = firstOwn("rsi") as Extract<AlertFilter, { kind: "rsi" }> | undefined;
    const ma = firstOwn("ma") as Extract<AlertFilter, { kind: "ma" }> | undefined;
    const st = firstOwn("supertrend") as Extract<AlertFilter, { kind: "supertrend" }> | undefined;
    return {
      filters: list,
      filterRsiLength: rsi?.length ?? null,
      filterRsiLevel: rsi?.level ?? null,
      filterRsiSide: rsi?.side ?? null,
      filterMaType: ma?.type ?? null,
      filterMaLength: ma?.length ?? null,
      filterMaSide: ma?.side ?? null,
      filterStPeriod: st?.period ?? null,
      filterStMultiplier: st?.multiplier ?? null,
      filterStAtrMethod: st?.atrMethod ?? null,
      filterStSide: st?.side ?? null,
    };
  };
  switch (condition.kind) {
    case "price":
      return {
        conditionKind: "price",
        maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
        targetPrice: condition.targetPrice, priceDirection: condition.direction,
        nearMinPct: 0.2, nearMaxPct: 0.5, ...empty, ...gates(condition.filters),
      };
    case "ma":
      return {
        conditionKind: "ma",
        maType: condition.maType, maLength: condition.maLength, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: condition.nearMinPct, nearMaxPct: condition.nearMaxPct, ...empty,
        ...gates(condition.filters),
      };
    case "ma_vs_ma":
      return {
        conditionKind: "ma_vs_ma",
        maType: condition.maType, maLength: condition.maLength, mode: condition.mode,
        ma2Type: condition.ma2Type, ma2Length: condition.ma2Length,
        targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5, ...empty, ...gates(condition.filters),
      };
    case "sr_zone":
      return {
        conditionKind: "sr_zone",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: condition.nearMinPct, nearMaxPct: condition.nearMaxPct,
        ...empty,
        srSide: condition.srSide,
        srPivotLength: condition.pivotLength,
        srInvalidation: condition.invalidation,
        ...gates(condition.filters),
      };
    case "pivot_level":
      return {
        conditionKind: "pivot_level",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: condition.nearMinPct, nearMaxPct: condition.nearMaxPct,
        ...empty,
        pivotType: condition.pivotType,
        pivotLevelName: condition.levelName,
        pivotAnchor: condition.anchor,
        ...gates(condition.filters),
      };
    case "rsi":
      return {
        conditionKind: "rsi",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5,
        ...empty,
        rsiLength: condition.rsiLength,
        rsiLevel: condition.level,
        rsiMaLength: condition.maLength,
        indicatorTarget: condition.target,
        ...gates(condition.filters),
      };
    case "macd":
      return {
        conditionKind: "macd",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5,
        ...empty,
        macdFast: condition.fastLength,
        macdSlow: condition.slowLength,
        macdSignal: condition.signalLength,
        indicatorTarget: condition.target,
        ...gates(condition.filters),
      };
    case "supertrend":
      return {
        conditionKind: "supertrend",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5,
        ...empty,
        stPeriod: condition.period,
        stMultiplier: condition.multiplier,
        stAtrMethod: condition.atrMethod,
        ...gates(condition.filters),
      };
    case "bollinger":
      return {
        conditionKind: "bollinger",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: condition.nearMinPct, nearMaxPct: condition.nearMaxPct,
        ...empty,
        bbLength: condition.length,
        bbMult: condition.mult,
        bbBand: condition.band,
        bbMaType: condition.maType,
        ...gates(condition.filters),
      };
    case "stochastic":
      return {
        conditionKind: "stochastic",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5,
        ...empty,
        stochKLength: condition.kLength,
        stochKSmooth: condition.kSmooth,
        stochDSmooth: condition.dSmooth,
        /*
         * A level belongs to the level target only.
         *
         * It used to be stored either way, on the reasoning that switching a
         * stored alert to a level should not take a default the operator never
         * chose. But `ma_alerts_stochastic_uniq` keys on this column, so a
         * leftover level made two identical "%K crosses above %D" alerts
         * distinct rows that both evaluated and both notified. The index
         * declares NULLS NOT DISTINCT (migration 028), so a null here is what
         * collapses them; the editor re-offers the default when the target is
         * switched back.
         */
        stochLevel: condition.target === "level" ? condition.level : null,
        indicatorTarget: condition.target,
        ...gates(condition.filters),
      };
    case "adx":
      return {
        conditionKind: "adx",
        maType: null, maLength: null, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5,
        ...empty,
        adxDiLength: condition.diLength,
        adxSmoothing: condition.smoothing,
        adxLevel: condition.level,
        ...gates(condition.filters),
      };
  }
}

