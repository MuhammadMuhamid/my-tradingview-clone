/**
 * What an alert watches, and whether it is true right now.
 *
 * This extends the existing moving-average alert family with price targets and
 * indicator-versus-indicator conditions, deliberately as an EXTENSION rather
 * than a second engine: the MA modes keep their exact semantics, the same
 * runner evaluates all of them, and the same Web Push path delivers them.
 *
 * ── The one rule that shapes everything here ──────────────────────────────
 *
 * A "cross" needs a known PREVIOUS side. On the first evaluation after an alert
 * is created there is none, so the alert seeds its side and stays quiet rather
 * than firing on whichever side the market happens to be. Without that, arming
 * "notify me when price crosses above 100" while price is already at 105 fires
 * immediately — which is not what was asked, and is the single most common way
 * an alert system loses a user's trust.
 *
 * Everything is pure: a condition, a sample, and the previous side go in; a
 * verdict comes out. No database, no clock, no delivery.
 */
import {
  PIVOT_TYPES, isPivotType, pivotLevels, type PivotType,
} from "../engine/pivotLevels";
import { DEFAULT_SR_OPTIONS } from "../engine/srZones";
import {
  CONDITION_KINDS, PRICE_DIRECTIONS,
  PIVOT_LEVEL_ANY,
  type ConditionKind, type MaAlertMode, type MaType, type PriceDirection,
  type SrSide,
} from "../types/maAlerts";

export type Side = "above" | "below";

/*
 * The vocabularies live in `types/maAlerts.ts` because the database, the HTTP
 * routes and the UI all need them without pulling in the evaluator. They are
 * re-exported here so a reader of this module can see what it accepts.
 *
 *   price      price against a fixed numeric target
 *   ma         price against a moving average — the pre-existing family
 *   ma_vs_ma   one moving average against another
 *
 * and for a price target:
 *
 *   cross_up   from below to above
 *   cross_down from above to below
 *   either     reached from either direction, which is what a user dragging a
 *              line onto the price scale almost always means
 */
export { CONDITION_KINDS, PRICE_DIRECTIONS };
export type { SrSide };
export type { ConditionKind, PriceDirection };

export type MaMode = MaAlertMode;

/** MA-versus-MA: the classic golden/death cross, expressed generally. */
export const MA_CROSS_MODES = ["cross_up", "cross_down"] as const;
export type MaCrossMode = (typeof MA_CROSS_MODES)[number];

export interface PriceCondition {
  kind: "price";
  targetPrice: number;
  direction: PriceDirection;
}

export interface MaCondition {
  kind: "ma";
  maType: MaType;
  maLength: number;
  mode: MaMode;
  nearMinPct: number;
  nearMaxPct: number;
}

export interface MaVsMaCondition {
  kind: "ma_vs_ma";
  /** The FAST line — the one doing the crossing. */
  maType: MaType;
  maLength: number;
  /** The SLOW line being crossed. */
  ma2Type: MaType;
  ma2Length: number;
  mode: MaCrossMode;
}

/**
 * The nearest live support or resistance on the alert's own timeframe.
 *
 * There is no length or level to name: the reference is whichever zone price
 * is currently approaching, which is the question a trader actually asks.
 */
export interface SrZoneCondition {
  kind: "sr_zone";
  srSide: SrSide;
  mode: MaMode;
  nearMinPct: number;
  nearMaxPct: number;
  /** Swing length used to detect the zones. */
  pivotLength: number;
  invalidation: "close" | "wick";
}

/** A named pivot level computed from a completed anchor period. */
export interface PivotLevelCondition {
  kind: "pivot_level";
  pivotType: PivotType;
  /** "P", "S1"… or `PIVOT_LEVEL_ANY` for whichever level is nearest. */
  levelName: string;
  /** The period the levels come from, e.g. "1d". Not the evaluation cadence. */
  anchor: string;
  mode: MaMode;
  nearMinPct: number;
  nearMaxPct: number;
}

export type AlertCondition =
  | PriceCondition | MaCondition | MaVsMaCondition
  | SrZoneCondition | PivotLevelCondition;

// ── Evaluation ──────────────────────────────────────────────────────────────

/**
 * One observation. A closed candle and a forming one have the same shape; the
 * difference is `isClosedBar`, which the frequency layer reads.
 */
export interface Sample {
  high: number;
  low: number;
  close: number;
  /** The condition's primary reference series at this bar, when it has one. */
  maValue?: number;
  /** The second series, for `ma_vs_ma`. */
  ma2Value?: number;
  /**
   * Reference price resolved by the runner for kinds whose level is not a
   * moving average — the nearest S/R zone, or a pivot level.
   */
  refValue?: number;
  /** What that reference is called, for the notification: "S1", "1h support". */
  refLabel?: string;
}

export interface Evaluation {
  /** Which side of the reference this sample sits on. Persisted for crosses. */
  side: Side;
  /** Signed distance from the reference, in percent. */
  distancePct: number;
  triggered: boolean;
  /** The reference value the sample was compared against. */
  reference: number;
}

/**
 * A cross is evaluated on the CLOSE, not the wick.
 *
 * A candle that pokes through a level and closes back on the original side has
 * not crossed it. That is what `touch` and `either` exist to catch, and keeping
 * the two distinct is what lets a user ask for the one they actually mean.
 */
function crossed(
  prevSide: Side | null,
  currentSide: Side,
  wanted: "up" | "down"
): boolean {
  if (prevSide === null) return false;
  return wanted === "up"
    ? prevSide === "below" && currentSide === "above"
    : prevSide === "above" && currentSide === "below";
}

/** Signed percentage distance of `value` from `reference`. */
function distance(value: number, reference: number): number {
  if (!Number.isFinite(reference) || reference === 0) return 0;
  return ((value - reference) / reference) * 100;
}

/**
 * True when this bar's RANGE contains the level — the wick case.
 *
 * Used by `either` and by the MA `touch` mode. On a forming candle the range
 * grows through the bar, so this can become true intrabar and stay true, which
 * is precisely why the intrabar frequencies cap repeats.
 */
const rangeContains = (sample: Sample, level: number): boolean =>
  sample.low <= level && level <= sample.high;

export function evaluateCondition(
  condition: AlertCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  switch (condition.kind) {
    case "price":
      return evaluatePrice(condition, sample, prevSide);
    case "ma":
      return evaluateMa(condition, sample, prevSide);
    case "ma_vs_ma":
      return evaluateMaVsMa(condition, sample, prevSide);
    case "sr_zone":
      return evaluateSrZone(condition, sample, prevSide);
    case "pivot_level":
      return evaluatePivotLevel(condition, sample, prevSide);
  }
}

function evaluatePrice(
  condition: PriceCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  const reference = condition.targetPrice;
  const side: Side = sample.close >= reference ? "above" : "below";
  const distancePct = distance(sample.close, reference);

  let triggered = false;
  switch (condition.direction) {
    case "cross_up":
      triggered = crossed(prevSide, side, "up") && sample.close > reference;
      break;
    case "cross_down":
      triggered = crossed(prevSide, side, "down") && sample.close < reference;
      break;
    case "either":
      /*
       * "Reached the target" is a RANGE test, not a close test, and it does not
       * need a previous side.
       *
       * A user who drags a line to 100 wants to know when price got there — a
       * candle that spikes to 100.4 and closes at 99.8 did reach it. Requiring a
       * close beyond the level would silently miss exactly the move they were
       * watching for. The frequency mode is what stops this repeating while the
       * range keeps containing the level.
       */
      triggered = rangeContains(sample, reference);
      break;
  }

  return { side, distancePct, triggered, reference };
}

/**
 * near / touch / cross against a reference price.
 *
 * Shared by `ma`, `sr_zone` and `pivot_level`: those kinds differ only in where
 * the reference comes from, and three copies of this would be three chances for
 * "0.3% above" to mean something slightly different depending on the line.
 */
function evaluateAgainstReference(
  mode: MaMode,
  nearMinPct: number,
  nearMaxPct: number,
  reference: number,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  // No reference resolved (unseeded MA, no live zone, no completed period):
  // report untriggered and leave the side alone, so a NaN comparison cannot
  // corrupt the stored cross state.
  if (!Number.isFinite(reference)) {
    return { side: prevSide ?? "above", distancePct: 0, triggered: false, reference };
  }
  const side: Side = sample.close >= reference ? "above" : "below";
  const distancePct = distance(sample.close, reference);

  let triggered = false;
  switch (mode) {
    case "touch":
      triggered = rangeContains(sample, reference);
      break;
    case "cross_up":
      triggered = crossed(prevSide, side, "up") && sample.close > reference;
      break;
    case "cross_down":
      triggered = crossed(prevSide, side, "down") && sample.close < reference;
      break;
    case "near_above":
      triggered = distancePct >= nearMinPct && distancePct <= nearMaxPct;
      break;
    case "near_below":
      triggered = -distancePct >= nearMinPct && -distancePct <= nearMaxPct;
      break;
  }
  return { side, distancePct, triggered, reference };
}

function evaluateSrZone(
  condition: SrZoneCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  return evaluateAgainstReference(
    condition.mode, condition.nearMinPct, condition.nearMaxPct,
    sample.refValue ?? NaN, sample, prevSide
  );
}

function evaluatePivotLevel(
  condition: PivotLevelCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  return evaluateAgainstReference(
    condition.mode, condition.nearMinPct, condition.nearMaxPct,
    sample.refValue ?? NaN, sample, prevSide
  );
}

function evaluateMa(
  condition: MaCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  const reference = sample.maValue ?? NaN;
  // Not enough history to seed this MA: report untriggered and leave the side
  // alone, so a NaN comparison cannot corrupt the stored cross state.
  if (!Number.isFinite(reference)) {
    return { side: prevSide ?? "above", distancePct: 0, triggered: false, reference };
  }

  return evaluateAgainstReference(
    condition.mode, condition.nearMinPct, condition.nearMaxPct,
    reference, sample, prevSide
  );
}

function evaluateMaVsMa(
  condition: MaVsMaCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  const fast = sample.maValue ?? NaN;
  const slow = sample.ma2Value ?? NaN;
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) {
    return { side: prevSide ?? "above", distancePct: 0, triggered: false, reference: slow };
  }

  // The "side" is the FAST line's position relative to the SLOW one — the
  // quantity that crosses. Using the close here would answer a different
  // question entirely.
  const side: Side = fast >= slow ? "above" : "below";
  const distancePct = distance(fast, slow);
  const triggered =
    condition.mode === "cross_up"
      ? crossed(prevSide, side, "up") && fast > slow
      : crossed(prevSide, side, "down") && fast < slow;

  return { side, distancePct, triggered, reference: slow };
}

// ── Description ─────────────────────────────────────────────────────────────

const maLabel = (type: MaType, length: number): string => `${type.toUpperCase()} ${length}`;

/** What the alert is watching, for the notification body and the UI list. */
export function describeCondition(condition: AlertCondition): string {
  switch (condition.kind) {
    case "price":
      switch (condition.direction) {
        case "cross_up": return `crosses above ${condition.targetPrice}`;
        case "cross_down": return `crosses below ${condition.targetPrice}`;
        case "either": return `reaches ${condition.targetPrice}`;
      }
      break;
    case "ma": {
      const line = maLabel(condition.maType, condition.maLength);
      switch (condition.mode) {
        case "touch": return `touches the ${line}`;
        case "cross_up": return `crosses above the ${line}`;
        case "cross_down": return `crosses below the ${line}`;
        case "near_above":
          return `is ${condition.nearMinPct}–${condition.nearMaxPct}% above the ${line}`;
        case "near_below":
          return `is ${condition.nearMinPct}–${condition.nearMaxPct}% below the ${line}`;
      }
      break;
    }
    case "ma_vs_ma": {
      const fast = maLabel(condition.maType, condition.maLength);
      const slow = maLabel(condition.ma2Type, condition.ma2Length);
      return condition.mode === "cross_up"
        ? `${fast} crosses above the ${slow}`
        : `${fast} crosses below the ${slow}`;
    }
  }
  return "condition met";
}

/**
 * Which distinct MA series an alert needs computed.
 *
 * The runner uses this to compute each `(type, length)` once per feed rather
 * than once per alert — the 15 SMA shared by a touch alert and a near alert is
 * one computation.
 */
export function requiredSeries(condition: AlertCondition): { type: MaType; length: number }[] {
  switch (condition.kind) {
    case "price": return [];
    case "ma": return [{ type: condition.maType, length: condition.maLength }];
    case "ma_vs_ma":
      return [
        { type: condition.maType, length: condition.maLength },
        { type: condition.ma2Type, length: condition.ma2Length },
      ];
    // These resolve their reference from zones or a pivot period, not an MA.
    case "sr_zone": return [];
    case "pivot_level": return [];
  }
}

/**
 * Validate a condition before it is stored.
 *
 * Returns a message rather than throwing, because every caller wants to turn it
 * into a 400 with that text.
 */
export function validateCondition(condition: AlertCondition): string | null {
  switch (condition.kind) {
    case "price":
      if (!Number.isFinite(condition.targetPrice) || condition.targetPrice <= 0) {
        return "targetPrice must be a positive number";
      }
      if (!(PRICE_DIRECTIONS as readonly string[]).includes(condition.direction)) {
        return `direction must be one of ${PRICE_DIRECTIONS.join(", ")}`;
      }
      return null;

    case "ma":
      if (!Number.isInteger(condition.maLength) || condition.maLength < 1 || condition.maLength > 1000) {
        return "maLength must be an integer between 1 and 1000";
      }
      if (condition.mode === "near_above" || condition.mode === "near_below") {
        if (!Number.isFinite(condition.nearMinPct) || condition.nearMinPct < 0) {
          return "nearMinPct must be a non-negative number";
        }
        if (!(condition.nearMaxPct > condition.nearMinPct)) {
          return "nearMaxPct must be greater than nearMinPct";
        }
      }
      return null;

    case "ma_vs_ma":
      for (const [name, len] of [["maLength", condition.maLength], ["ma2Length", condition.ma2Length]] as const) {
        if (!Number.isInteger(len) || len < 1 || len > 1000) {
          return `${name} must be an integer between 1 and 1000`;
        }
      }
      if (condition.maType === condition.ma2Type && condition.maLength === condition.ma2Length) {
        // Two identical lines never cross, so this alert can never fire. Saying
        // so is better than storing something inert.
        return "the two moving averages must differ, or the condition can never be met";
      }
      return null;

    case "sr_zone":
      if (!Number.isInteger(condition.pivotLength) || condition.pivotLength < 2 || condition.pivotLength > 100) {
        return "pivotLength must be an integer between 2 and 100";
      }
      return nearBandError(condition.mode, condition.nearMinPct, condition.nearMaxPct);

    case "pivot_level":
      if (!isPivotType(condition.pivotType)) {
        return `pivotType must be one of ${PIVOT_TYPES.join(", ")}`;
      }
      if (condition.levelName !== PIVOT_LEVEL_ANY) {
        // A level the chosen type does not define would arm an alert that can
        // never fire — Fibonacci has no R4, for instance.
        const names = pivotLevels({ open: 1, high: 2, low: 0, close: 1 }, condition.pivotType)
          .map((l) => l.name);
        if (!names.includes(condition.levelName.toUpperCase())) {
          return `${condition.pivotType} has no level "${condition.levelName}" ` +
            `(it defines ${names.join(", ")})`;
        }
      }
      if (!condition.anchor.trim()) return "anchor timeframe is required";
      return nearBandError(condition.mode, condition.nearMinPct, condition.nearMaxPct);
  }
}

/** The near-band rule, shared by every kind that offers `near_above`/`near_below`. */
function nearBandError(mode: MaMode, minPct: number, maxPct: number): string | null {
  if (mode !== "near_above" && mode !== "near_below") return null;
  if (!Number.isFinite(minPct) || minPct < 0) return "nearMinPct must be a non-negative number";
  if (!(maxPct > minPct)) return "nearMaxPct must be greater than nearMinPct";
  return null;
}

/**
 * The condition an alert row describes.
 *
 * Returns null for a row whose columns do not form a complete condition. The
 * database CHECK makes that unreachable for rows written through the API, but a
 * row is data and this is a decision path: refusing to evaluate an incoherent
 * row is better than evaluating it against `NaN` and quietly never firing.
 */
export function conditionFromRow(row: {
  conditionKind: ConditionKind;
  maType: MaType | null;
  maLength: number | null;
  mode: MaAlertMode | null;
  ma2Type: MaType | null;
  ma2Length: number | null;
  targetPrice: number | null;
  priceDirection: PriceDirection | null;
  nearMinPct: number;
  nearMaxPct: number;
  srSide?: SrSide | null;
  srPivotLength?: number | null;
  srInvalidation?: string | null;
  pivotType?: string | null;
  pivotLevelName?: string | null;
  pivotAnchor?: string | null;
}): AlertCondition | null {
  switch (row.conditionKind) {
    case "price":
      if (row.targetPrice === null || row.priceDirection === null) return null;
      return { kind: "price", targetPrice: row.targetPrice, direction: row.priceDirection };

    case "ma":
      if (row.maType === null || row.maLength === null || row.mode === null) return null;
      return {
        kind: "ma",
        maType: row.maType,
        maLength: row.maLength,
        mode: row.mode,
        nearMinPct: row.nearMinPct,
        nearMaxPct: row.nearMaxPct,
      };

    case "ma_vs_ma":
      if (
        row.maType === null || row.maLength === null ||
        row.ma2Type === null || row.ma2Length === null ||
        (row.mode !== "cross_up" && row.mode !== "cross_down")
      ) return null;
      return {
        kind: "ma_vs_ma",
        maType: row.maType,
        maLength: row.maLength,
        ma2Type: row.ma2Type,
        ma2Length: row.ma2Length,
        mode: row.mode,
      };

    case "sr_zone": {
      if (!row.srSide || row.mode === null) return null;
      const invalidation = row.srInvalidation === "wick" ? "wick" : "close";
      return {
        kind: "sr_zone",
        srSide: row.srSide,
        mode: row.mode,
        nearMinPct: row.nearMinPct,
        nearMaxPct: row.nearMaxPct,
        pivotLength: row.srPivotLength ?? DEFAULT_SR_OPTIONS.pivotLength,
        invalidation,
      };
    }

    case "pivot_level": {
      const type = row.pivotType ?? "";
      if (!isPivotType(type) || !row.pivotLevelName || !row.pivotAnchor || row.mode === null) {
        return null;
      }
      return {
        kind: "pivot_level",
        pivotType: type,
        levelName: row.pivotLevelName,
        anchor: row.pivotAnchor,
        mode: row.mode,
        nearMinPct: row.nearMinPct,
        nearMaxPct: row.nearMaxPct,
      };
    }
  }
}
