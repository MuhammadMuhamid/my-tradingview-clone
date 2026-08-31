/**
 * Turning an alert request body into a condition, and a condition back into the
 * columns that store it.
 *
 * Separated from the route so the accept/reject matrix — which is where every
 * 400 an alert client can see is decided — is testable as pure functions,
 * without a Fastify instance or a database connection.
 */
import {
  MA_ALERT_MODES, PRICE_DIRECTIONS,
  isMaAlertMode, isMaType, isPriceDirection,
  type ConditionKind, type MaAlertMode, type MaType, type PriceDirection,
  SR_SIDES, PIVOT_LEVEL_ANY, isSrSide, type SrSide,
  RSI_TARGETS, MACD_TARGETS, RSI_DEFAULTS, MACD_DEFAULTS,
  isRsiTarget, isMacdTarget,
  FILTER_DEFAULTS, isFilterSide,
} from "../types/maAlerts";
import type { AlertCondition, AlertFilters } from "./alertConditions";
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
 * Read the optional gates a level alert may carry.
 *
 * Absent keys mean "no gate", which is the pre-existing behaviour every alert
 * created before this feature has. A gate is only built when the client asks
 * for it explicitly, so an unrelated request can never acquire one by default.
 */
function readFilters(b: Record<string, unknown>): { filters?: AlertFilters } | Rejection {
  const filters: AlertFilters = {};

  if (b.filterRsi === true || b.filterRsiLength !== undefined) {
    const length = Number(b.filterRsiLength ?? FILTER_DEFAULTS.rsi.length);
    const level = Number(b.filterRsiLevel ?? FILTER_DEFAULTS.rsi.level);
    const side = String(b.filterRsiSide ?? FILTER_DEFAULTS.rsi.side);
    if (!isLength(length)) return bad("filterRsiLength must be an integer 1..1000");
    if (!(Number.isFinite(level) && level > 0 && level < 100)) {
      return bad("filterRsiLevel must be a number between 0 and 100 (exclusive)");
    }
    if (!isFilterSide(side)) return bad("filterRsiSide must be above or below");
    filters.rsi = { length, level, side };
  }

  if (b.filterMa === true || b.filterMaLength !== undefined) {
    const type = String(b.filterMaType ?? FILTER_DEFAULTS.ma.type);
    const length = Number(b.filterMaLength ?? FILTER_DEFAULTS.ma.length);
    const side = String(b.filterMaSide ?? FILTER_DEFAULTS.ma.side);
    if (!isMaType(type)) return bad("filterMaType must be sma or ema");
    if (!isLength(length)) return bad("filterMaLength must be an integer 1..1000");
    if (!isFilterSide(side)) return bad("filterMaSide must be above or below");
    filters.ma = { type, length, side };
  }

  return Object.keys(filters).length > 0 ? { filters } : {};
}

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

  if (kind === "price") {
    const targetPrice = Number(b.targetPrice);
    const direction = String(b.priceDirection ?? "either");
    if (!Number.isFinite(targetPrice)) return bad("targetPrice must be a number");
    if (!isPriceDirection(direction)) {
      return bad(`priceDirection must be one of ${PRICE_DIRECTIONS.join(", ")}`);
    }
    return { condition: { kind: "price", targetPrice, direction } };
  }

  if (kind === "sr_zone") {
    const srSide = String(b.srSide ?? "either");
    const srMode = String(b.mode ?? "near_above");
    if (!isSrSide(srSide)) return bad(`srSide must be one of ${SR_SIDES.join(", ")}`);
    if (!isMaAlertMode(srMode)) return bad(`mode must be one of ${MA_ALERT_MODES.join(", ")}`);
    const pivotLength = b.pivotLength === undefined
      ? DEFAULT_SR_OPTIONS.pivotLength : Number(b.pivotLength);
    const invalidation = String(b.invalidation ?? "close") === "wick" ? "wick" : "close";
    const f = readFilters(b);
    if ("error" in f) return f;
    return {
      condition: {
        kind: "sr_zone", srSide, mode: srMode, nearMinPct, nearMaxPct,
        pivotLength, invalidation, ...f,
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
    const pf = readFilters(b);
    if ("error" in pf) return pf;
    return {
      condition: {
        kind: "pivot_level", pivotType, levelName, anchor,
        mode: pMode, nearMinPct, nearMaxPct, ...pf,
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
    if (fastLength >= slowLength) {
      return bad("macdFast must be less than macdSlow");
    }
    if (mMode !== "cross_up" && mMode !== "cross_down") {
      return bad("mode must be cross_up or cross_down for a MACD alert");
    }
    return {
      condition: { kind: "macd", fastLength, slowLength, signalLength, target, mode: mMode },
    };
  }

  const maType = String(b.maType ?? "");
  const maLength = Number(b.maLength);
  const mode = String(b.mode ?? "");
  if (!isMaType(maType)) return bad("maType must be sma or ema");
  if (!Number.isInteger(maLength)) return bad("maLength must be an integer 1..1000");

  if (kind === "ma") {
    if (!isMaAlertMode(mode)) return bad(`mode must be one of ${MA_ALERT_MODES.join(", ")}`);
    return { condition: { kind: "ma", maType, maLength, mode, nearMinPct, nearMaxPct } };
  }

  const ma2Type = String(b.ma2Type ?? "");
  const ma2Length = Number(b.ma2Length);
  if (!isMaType(ma2Type)) return bad("ma2Type must be sma or ema");
  if (!Number.isInteger(ma2Length)) return bad("ma2Length must be an integer 1..1000");
  if (mode !== "cross_up" && mode !== "cross_down") {
    return bad("mode must be cross_up or cross_down for an MA-versus-MA alert");
  }
  return { condition: { kind: "ma_vs_ma", maType, maLength, ma2Type, ma2Length, mode } };
}

/** Flatten a condition back into the column shape the repository writes. */
export function toColumns(condition: AlertCondition): {
  conditionKind: ConditionKind;
  maType: MaType | null; maLength: number | null; mode: MaAlertMode | null;
  ma2Type: MaType | null; ma2Length: number | null;
  targetPrice: number | null; priceDirection: PriceDirection | null;
  nearMinPct: number; nearMaxPct: number;
  srSide: SrSide | null; srPivotLength: number | null; srInvalidation: string | null;
  pivotType: string | null; pivotLevelName: string | null; pivotAnchor: string | null;
  rsiLength: number | null; rsiLevel: number | null; rsiMaLength: number | null;
  macdFast: number | null; macdSlow: number | null; macdSignal: number | null;
  indicatorTarget: string | null;
  filterRsiLength: number | null; filterRsiLevel: number | null;
  filterRsiSide: string | null;
  filterMaType: MaType | null; filterMaLength: number | null;
  filterMaSide: string | null;
} {
  // Columns that belong to no kind are null, so a row never carries another
  // kind's settings for an operator to misread.
  const empty = {
    srSide: null, srPivotLength: null, srInvalidation: null,
    pivotType: null, pivotLevelName: null, pivotAnchor: null,
    rsiLength: null, rsiLevel: null, rsiMaLength: null,
    macdFast: null, macdSlow: null, macdSignal: null,
    indicatorTarget: null,
    filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
    filterMaType: null, filterMaLength: null, filterMaSide: null,
  };

  /** Flatten the optional gates; absent halves stay null. */
  const gates = (f: AlertFilters | undefined) => ({
    filterRsiLength: f?.rsi?.length ?? null,
    filterRsiLevel: f?.rsi?.level ?? null,
    filterRsiSide: f?.rsi?.side ?? null,
    filterMaType: f?.ma?.type ?? null,
    filterMaLength: f?.ma?.length ?? null,
    filterMaSide: f?.ma?.side ?? null,
  });
  switch (condition.kind) {
    case "price":
      return {
        conditionKind: "price",
        maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
        targetPrice: condition.targetPrice, priceDirection: condition.direction,
        nearMinPct: 0.2, nearMaxPct: 0.5, ...empty,
      };
    case "ma":
      return {
        conditionKind: "ma",
        maType: condition.maType, maLength: condition.maLength, mode: condition.mode,
        ma2Type: null, ma2Length: null, targetPrice: null, priceDirection: null,
        nearMinPct: condition.nearMinPct, nearMaxPct: condition.nearMaxPct, ...empty,
      };
    case "ma_vs_ma":
      return {
        conditionKind: "ma_vs_ma",
        maType: condition.maType, maLength: condition.maLength, mode: condition.mode,
        ma2Type: condition.ma2Type, ma2Length: condition.ma2Length,
        targetPrice: null, priceDirection: null,
        nearMinPct: 0.2, nearMaxPct: 0.5, ...empty,
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
      };
  }
}

