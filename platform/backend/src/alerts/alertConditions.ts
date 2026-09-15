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
import { isInterval, type Interval } from "../types/market";
import {
  CONDITION_KINDS, PRICE_DIRECTIONS,
  PIVOT_LEVEL_ANY, ADX_DEFAULTS, BOLLINGER_DEFAULTS, MACD_DEFAULTS, RSI_DEFAULTS,
  STOCHASTIC_DEFAULTS, SUPERTREND_DEFAULTS, MAX_ALERT_FILTERS,
  PIVOT_ANCHORS, isPivotAnchor, type PivotAnchor,
  isBollingerBand, isMaType, isRsiTarget, isMacdTarget, isStAtrMethod, isStochasticTarget,
  type BollingerBand, type ConditionKind, type MaAlertMode, type MaType,
  type PriceDirection, type SrSide, type RsiTarget, type MacdTarget, type StAtrMethod,
  type StochasticTarget,
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
 * A precondition that must hold for an alert to notify.
 *
 * A gate is not a trigger: it never fires anything on its own, it only decides
 * whether the event is worth telling you about. "Alert me when price
 * approaches 15m support, but only while the 1h trend is up" is one alert with
 * a filter, not two alerts to correlate by hand.
 *
 * ── Each gate names its own timeframe ──────────────────────────────────────
 *
 * `timeframe: null` means the alert's own, which is what every gate written
 * before this existed did. Naming a different one makes the gate a
 * multi-timeframe question, which is the point: a 15m level alert can require
 * that the 1h RSI agrees.
 *
 * The value read from another timeframe is the one from that timeframe's
 * LAST CLOSED bar at or before the alert's bar — `closeTime <= closeTime`.
 * That is the same `chartClose` rule `engine/mtf.ts` implements for
 * `request.security(..., lookahead_off)`, and it is what stops a gate seeing
 * into a period that has not finished. It also means an HTF gate does not
 * repaint: once the 1h bar has closed, the value the gate used is fixed.
 *
 * The cost is staleness, and it is deliberate. A 1h gate on a 15m alert is
 * reading up to an hour-old data, because the alternative is a gate whose
 * answer changes inside the hour and whose past answers cannot be reproduced.
 */
export type FilterTimeframe = Interval | null;

/** RSI(length) on `timeframe` must sit above/below `level`. */
export interface RsiFilter {
  kind: "rsi";
  timeframe: FilterTimeframe;
  length: number;
  level: number;
  side: Side;
}

/**
 * The close must sit above/below this moving average.
 *
 * When the gate names another timeframe, the moving average is computed from
 * THAT timeframe's bars while the close compared against it is the alert's own
 * — "price is above the 1h EMA 200" read literally. Comparing the 1h close
 * instead would answer a staler question than the one asked.
 */
export interface MaFilter {
  kind: "ma";
  timeframe: FilterTimeframe;
  type: MaType;
  length: number;
  side: Side;
}

/**
 * Price must be on the named side of the Supertrend — "above" is its uptrend.
 *
 * Read from the indicator's own trend rather than by comparing the close to
 * the drawn line: the two agree by construction, and the trend is the value
 * the study itself acts on.
 */
export interface SupertrendFilter {
  kind: "supertrend";
  timeframe: FilterTimeframe;
  period: number;
  multiplier: number;
  atrMethod: StAtrMethod;
  side: Side;
}

/**
 * Price must be within a percentage band of a pivot level.
 *
 * Shaped differently from the other gates on purpose. The rest ask "which side
 * of this line is price on"; this one asks "is price NEAR this line", which is
 * a distance question and needs a band rather than a side. `either` is the
 * default and the reason the side vocabulary was widened — "near S1" usually
 * means near it from whichever direction price happens to approach.
 *
 * The period is an `anchor`, not a `timeframe`. A pivot level comes from a
 * completed day, week or month; it is not an indicator sampled on a chart
 * interval, so reusing `timeframe` here would name the wrong concept.
 */
export interface PivotFilter {
  kind: "pivot";
  /** Unused — a pivot is anchored to a period, not sampled on a timeframe. */
  timeframe: null;
  anchor: PivotAnchor;
  pivotType: PivotType;
  /** "P", "S1"… or `PIVOT_LEVEL_ANY` for whichever level price is nearest. */
  levelName: string;
  side: Side | "either";
  /** Band edges in percent. 0–0.5 reads as "within half a percent". */
  minPct: number;
  maxPct: number;
}

/**
 * RSI(length) must sit above/below a moving average OF THE RSI ITSELF.
 *
 * Distinct from `RsiFilter`, which compares the oscillator to a fixed level.
 * "RSI 50 is above 50" and "RSI 50 is above its own EMA 14" are different
 * questions: the first is an absolute regime test, the second a momentum test
 * that travels with the market. Folding them into one kind by making `level`
 * optional would make the stored gate ambiguous about which was meant.
 *
 * The average is smoothed from the RSI series including its leading NaNs, so
 * it appears on the bar the indicator would draw it and not earlier — the same
 * rule the `rsi` alert family already follows for its SMA.
 */
export interface RsiMaFilter {
  kind: "rsi_ma";
  timeframe: FilterTimeframe;
  /** The RSI's own length. */
  length: number;
  maType: MaType;
  /** The length of the average taken OF the RSI — 14 and 21 are the common pair. */
  maLength: number;
  side: Side;
}

/**
 * The MACD line must sit above/below its signal line, or above/below zero.
 *
 * "Above the signal" is the state a bullish crossover leaves behind, and it is
 * deliberately the state and not the crossing. A gate asks "is this true now",
 * and a cross is true for exactly one bar — gating on the cross itself would
 * mean the alert could only ever fire on that one bar, which is a different
 * and far narrower rule than the one being asked for.
 */
export interface MacdFilter {
  kind: "macd";
  timeframe: FilterTimeframe;
  fastLength: number;
  slowLength: number;
  signalLength: number;
  /** "signal" compares against the signal line; "zero" against the centreline. */
  target: MacdTarget;
  side: Side;
}

export type AlertFilter =
  | RsiFilter | MaFilter | SupertrendFilter | PivotFilter
  | RsiMaFilter | MacdFilter;

/**
 * The gates an alert carries, in order.
 *
 * A list rather than one slot per kind, so an alert can require the 15m RSI
 * AND the 1h RSI at once — the same indicator on two timeframes is the most
 * common multi-timeframe question there is, and one-slot-per-kind could not
 * express it.
 */
export type AlertFilters = AlertFilter[];

export const FILTER_KINDS = [
  "rsi", "ma", "supertrend", "pivot", "rsi_ma", "macd",
] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];
export const isFilterKind = (v: string): v is FilterKind =>
  (FILTER_KINDS as readonly string[]).includes(v);

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

/**
 * RSI against either a fixed level or its own moving average.
 *
 * The quantity that crosses is the OSCILLATOR, not price — an RSI of 48 with
 * price making a new high has still not crossed 50. Both targets are on the
 * 0..100 RSI scale, so distance is reported in RSI points rather than as a
 * percentage of price, which would be meaningless here.
 */
export interface RsiCondition {
  kind: "rsi";
  rsiLength: number;
  target: RsiTarget;
  /** Read when `target` is "level". */
  level: number;
  /** Read when `target` is "sma": the length of the RSI-based SMA. */
  maLength: number;
  mode: MaCrossMode;
}

/**
 * MACD line against its signal, or against zero.
 *
 * Zero-cross and signal-cross are the same comparison with a different
 * reference, so they share one condition rather than becoming two kinds.
 */
export interface MacdCondition {
  kind: "macd";
  fastLength: number;
  slowLength: number;
  signalLength: number;
  target: MacdTarget;
  mode: MaCrossMode;
}

/**
 * A Supertrend flip.
 *
 * The event is the indicator changing DIRECTION, not price touching the line.
 * Those are nearly the same bar and never quite the same event: price can graze
 * the band without the trend flipping, and once it has flipped the line jumps
 * to the other side of price, so a "touched the line" alert on this indicator
 * would fire on the wrong bars in both directions.
 *
 * `cross_up` is the study's Buy label, `cross_down` its Sell.
 */
export interface SupertrendCondition {
  kind: "supertrend";
  period: number;
  multiplier: number;
  atrMethod: StAtrMethod;
  mode: MaCrossMode;
}

/**
 * Price against one Bollinger band.
 *
 * A band is a price level like any other, so this family reuses the exact
 * touch / cross / near grammar the MA and level families already have. What is
 * new is only where the reference comes from: the upper, middle or lower line
 * of a Bollinger computed on the alert's own symbol and timeframe.
 *
 * The band moves every bar, which is precisely why "price touched the upper
 * band" is a different question from "price reached 212.40" and needs its own
 * family rather than a static price alert.
 */
export interface BollingerCondition {
  kind: "bollinger";
  length: number;
  mult: number;
  band: BollingerBand;
  /** The basis MA type; the study's own input. */
  maType: MaType;
  mode: MaMode;
  nearMinPct: number;
  nearMaxPct: number;
}

/**
 * Stochastic %K against its %D signal, or against a level.
 *
 * The quantity that crosses is the OSCILLATOR, on its own 0..100 scale — so
 * distance is reported in stochastic points, not as a percentage of price,
 * exactly as the RSI family does.
 */
export interface StochasticCondition {
  kind: "stochastic";
  kLength: number;
  kSmooth: number;
  dSmooth: number;
  target: StochasticTarget;
  /** Read when `target` is "level". */
  level: number;
  mode: MaCrossMode;
}

/**
 * ADX crossing a strength threshold.
 *
 * Only a level, because ADX has no signal line and inventing one would be a
 * second indicator. `cross_up` is "a trend has become measurable", which is
 * the event this study exists to report.
 */
export interface AdxCondition {
  kind: "adx";
  diLength: number;
  smoothing: number;
  level: number;
  mode: MaCrossMode;
}

/**
 * Every family may carry gates, so the property lives on the union rather than
 * being repeated in each member. Narrowing on `kind` still works through the
 * intersection, and a family added later cannot forget to offer them.
 */
export interface WithFilters {
  /** Optional preconditions; the alert stays silent while any of them fails. */
  filters?: AlertFilters;
}

export type AlertCondition = (
  | PriceCondition | MaCondition | MaVsMaCondition
  | SrZoneCondition | PivotLevelCondition
  | RsiCondition | MacdCondition | SupertrendCondition
  | BollingerCondition | StochasticCondition | AdxCondition
) & WithFilters;

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
  /**
   * Oscillator families resolve two numbers rather than a price: the value
   * that crosses, and what it crosses. Kept separate from `maValue` so a
   * reader can never mistake an RSI reading for a price.
   */
  indicatorValue?: number;
  indicatorReference?: number;
  /**
   * One reading per gate, aligned by index with `condition.filters`.
   *
   * Indexed rather than named because an alert may carry two RSI gates on
   * different timeframes, and a named field could only hold one of them. An
   * entry of `undefined` means the gate's indicator has not resolved — the
   * series is still warming up, or its timeframe has no bars yet.
   *
   * What each reading holds: the RSI value, the moving average, or the
   * Supertrend's direction (+1 / -1).
   */
  filterReadings?: (number | undefined)[];
}

export interface Evaluation {
  /**
   * Which side of the reference this sample sits on. Persisted for crosses.
   *
   * `null` while the reference is UNRESOLVED — during an indicator's warm-up,
   * or when a backfill did not reach far enough back. It used to fall back to
   * `prevSide ?? "above"`, which persisted an invented "above" through warm-up,
   * so the first computable bar that read below the reference detected a
   * `cross_down` the market never made. An alert on a newly listed symbol, or
   * one whose lengths are long enough that history runs out, fired on its very
   * first reading. Unset is the truth here, and `crossed()` already treats a
   * null previous side as no cross.
   */
  side: Side | null;
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

/**
 * Evaluate a condition and apply its gates.
 *
 * The gates are applied HERE, once, rather than inside each family's
 * evaluator. Every family may carry them, and a per-family `gated(...)` call
 * is a line a new family can silently omit — which would present as an alert
 * whose configured filter is simply ignored, with nothing in the UI or the log
 * to say so.
 */
export function evaluateCondition(
  condition: AlertCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  return gated(evaluateTrigger(condition, sample, prevSide), condition.filters, sample);
}

function evaluateTrigger(
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
    case "bollinger":
      return evaluateBollinger(condition, sample, prevSide);
    case "stochastic":
      return evaluateSeriesCross(
        sample.indicatorValue ?? NaN, sample.indicatorReference ?? NaN,
        condition.mode, prevSide, true);
    case "adx":
      return evaluateSeriesCross(
        sample.indicatorValue ?? NaN, sample.indicatorReference ?? NaN,
        condition.mode, prevSide, true);
    case "sr_zone":
      return evaluateSrZone(condition, sample, prevSide);
    case "pivot_level":
      return evaluatePivotLevel(condition, sample, prevSide);
    case "rsi":
      return evaluateRsi(condition, sample, prevSide);
    case "macd":
      return evaluateMacd(condition, sample, prevSide);
    case "supertrend":
      return evaluateSupertrend(condition, sample, prevSide);
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
    return { side: prevSide, distancePct: 0, triggered: false, reference };
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

/**
 * Whether every configured gate currently holds.
 *
 * **Fails closed.** A gate whose input has not resolved — RSI still warming
 * up, an EMA without enough history, a higher timeframe with no closed bar yet
 * — blocks the alert rather than passing it. The user asked for "only when the
 * trend is up"; firing because the trend is *unknown* answers a different
 * question, and would do so silently.
 *
 * Every gate must hold: they are ANDed. "15m RSI above 50 and 1h RSI above 50"
 * is the request this feature exists for, and OR would make a two-gate alert
 * fire more often than a one-gate alert, which is the opposite of what adding
 * a precondition means.
 */
export function filtersPass(
  filters: AlertFilters | undefined, sample: Sample
): boolean {
  if (!filters || filters.length === 0) return true;
  const readings = sample.filterReadings ?? [];

  return filters.every((filter, index) => {
    const value = readings[index];
    if (value === undefined || !Number.isFinite(value)) return false;

    switch (filter.kind) {
      case "rsi":
        return filter.side === "above" ? value > filter.level : value < filter.level;
      case "ma":
        // The close is the alert's own; the average may come from another
        // timeframe. See `MaFilter`.
        return filter.side === "above" ? sample.close > value : sample.close < value;
      case "supertrend":
        // The indicator's own direction: +1 uptrend, -1 downtrend.
        return filter.side === "above" ? value > 0 : value < 0;
      case "rsi_ma":
      case "macd":
        /*
         * `value` is the SPREAD — the line minus what it is measured against
         * (RSI minus its average; MACD minus its signal or zero). Both gates
         * compare two computed numbers rather than one number to a constant,
         * and `filterReadings` carries one scalar per gate, so the runner does
         * the subtraction and the sign is the whole answer.
         *
         * The same shape `supertrend` already uses, for the same reason: what
         * the gate acts on is a direction, not a level a reader could confuse
         * with a price.
         */
        return filter.side === "above" ? value > 0 : value < 0;
      case "pivot": {
        /*
         * `value` is the LEVEL's price; the distance is computed here so the
         * runner only has to resolve the level. A zero or non-finite level
         * would make the percentage meaningless, and the guard above has
         * already rejected non-finite — zero is rejected here.
         */
        if (value === 0) return false;
        const distPct = ((sample.close - value) / value) * 100;
        const from = filter.side === "either" ? Math.abs(distPct)
          : filter.side === "above" ? distPct : -distPct;
        return from >= filter.minPct && from <= filter.maxPct;
      }
    }
  });
}

/**
 * Apply the gates to an evaluation.
 *
 * Only `triggered` is suppressed. `side` and `distancePct` are left exactly as
 * the level test computed them, because they are the memory a cross is detected
 * against: rewriting or withholding them while a gate is shut would leave stale
 * state that fires spuriously the moment the gate opens.
 */
function gated(
  evaluation: Evaluation, filters: AlertFilters | undefined, sample: Sample
): Evaluation {
  if (!evaluation.triggered || filtersPass(filters, sample)) return evaluation;
  return { ...evaluation, triggered: false };
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

/**
 * Price against a Bollinger band.
 *
 * The band is resolved by the runner into `refValue`, exactly as an S/R zone
 * or a pivot level is, so the comparison itself is the shared one. A band that
 * has not warmed up leaves the stored side alone rather than letting a NaN
 * comparison manufacture a cross on the next bar.
 */
function evaluateBollinger(
  condition: BollingerCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  const reference = sample.refValue ?? NaN;
  if (!Number.isFinite(reference)) {
    return { side: prevSide, distancePct: 0, triggered: false, reference };
  }
  return evaluateAgainstReference(
    condition.mode, condition.nearMinPct, condition.nearMaxPct,
    reference, sample, prevSide
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
    return { side: prevSide, distancePct: 0, triggered: false, reference };
  }

  return evaluateAgainstReference(
    condition.mode, condition.nearMinPct, condition.nearMaxPct,
    reference, sample, prevSide
  );
}

/**
 * One series crossing another.
 *
 * Shared by `ma_vs_ma`, `rsi` and `macd`: in all three the thing that crosses
 * is an indicator value rather than the close, and the "side" is that value's
 * position relative to its reference. Using `sample.close` here would answer a
 * different question entirely.
 *
 * `absoluteDistance` is for references that are not prices. An RSI of 55
 * against the 50 line is 5 RSI POINTS away; expressing that as a percentage of
 * 50 would read as a price move to anyone glancing at the notification. MACD
 * goes further — its zero reference makes a percentage undefined outright.
 */
function evaluateSeriesCross(
  value: number,
  reference: number,
  mode: MaCrossMode,
  prevSide: Side | null,
  absoluteDistance = false
): Evaluation {
  if (!Number.isFinite(value) || !Number.isFinite(reference)) {
    return { side: prevSide, distancePct: 0, triggered: false, reference };
  }
  const side: Side = value >= reference ? "above" : "below";
  const distancePct = absoluteDistance ? value - reference : distance(value, reference);
  const triggered =
    mode === "cross_up"
      ? crossed(prevSide, side, "up") && value > reference
      : crossed(prevSide, side, "down") && value < reference;
  return { side, distancePct, triggered, reference };
}

function evaluateMaVsMa(
  condition: MaVsMaCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  return evaluateSeriesCross(
    sample.maValue ?? NaN, sample.ma2Value ?? NaN, condition.mode, prevSide
  );
}

function evaluateRsi(
  condition: RsiCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  return evaluateSeriesCross(
    sample.indicatorValue ?? NaN, sample.indicatorReference ?? NaN,
    condition.mode, prevSide, true
  );
}

function evaluateMacd(
  condition: MacdCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  return evaluateSeriesCross(
    sample.indicatorValue ?? NaN, sample.indicatorReference ?? NaN,
    condition.mode, prevSide, true
  );
}

/**
 * A Supertrend flip.
 *
 * The side is read from the indicator's TREND, not from comparing the close to
 * the line. On the flip bar the line has already jumped to the other side of
 * price, so a close-versus-line test reports the new side one bar early and
 * then reports no cross at all when the flip actually happens.
 *
 * `reference` is still the drawn line, because that is the price a
 * notification should name — "flipped up, line now at 2.19" is what a reader
 * can act on. The distance is a genuine price percentage here, unlike the
 * oscillator families.
 */
function evaluateSupertrend(
  condition: SupertrendCondition,
  sample: Sample,
  prevSide: Side | null
): Evaluation {
  const trend = sample.indicatorValue;
  const reference = sample.refValue ?? NaN;
  // Not warmed up: leave the stored side alone rather than letting a NaN
  // comparison manufacture a flip on the next bar.
  if (trend === undefined || !Number.isFinite(trend)) {
    return { side: prevSide, distancePct: 0, triggered: false, reference };
  }
  const side: Side = trend > 0 ? "above" : "below";
  const distancePct = Number.isFinite(reference) ? distance(sample.close, reference) : 0;
  const triggered = crossed(prevSide, side, condition.mode === "cross_up" ? "up" : "down");
  return { side, distancePct, triggered, reference };
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
    case "rsi": {
      const what = rsiLabel(condition);
      const against = condition.target === "level"
        ? `${condition.level}`
        : `its SMA ${condition.maLength}`;
      return condition.mode === "cross_up"
        ? `${what} crosses above ${against}`
        : `${what} crosses below ${against}`;
    }
    case "macd": {
      const against = condition.target === "signal" ? "the signal line" : "zero";
      return condition.mode === "cross_up"
        ? `${macdLabel(condition)} crosses above ${against}`
        : `${macdLabel(condition)} crosses below ${against}`;
    }
    case "supertrend":
      // "flips up", never "crosses above": the subject is the indicator's
      // direction, and a reader who sees "crosses" looks for a line price went
      // through, which is not the event.
      return condition.mode === "cross_up"
        ? `${stLabel(condition)} flips up`
        : `${stLabel(condition)} flips down`;
    case "bollinger": {
      const line = bollingerLabel(condition);
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
    case "stochastic": {
      const what = stochasticLabel(condition);
      const against = condition.target === "level" ? `${condition.level}` : "its %D";
      return condition.mode === "cross_up"
        ? `${what} crosses above ${against}`
        : `${what} crosses below ${against}`;
    }
    case "adx":
      return condition.mode === "cross_up"
        ? `${adxLabel(condition)} rises through ${condition.level}`
        : `${adxLabel(condition)} falls through ${condition.level}`;
  }
  return "condition met";
}

/**
 * "the upper Bollinger band" for the study's own 20 / 2 / SMA inputs, and the
 * inputs named when they are not.
 *
 * Same rule as every other label here: default parameters on every
 * notification are noise, non-default ones are the only thing separating two
 * alerts in a list.
 */
function bollingerLabel(condition: BollingerCondition): string {
  const where = condition.band === "basis" ? "Bollinger basis" : `${condition.band} Bollinger band`;
  const custom = condition.length !== BOLLINGER_DEFAULTS.length
    || condition.mult !== BOLLINGER_DEFAULTS.mult
    || condition.maType !== BOLLINGER_DEFAULTS.maType;
  return custom
    ? `${where} (${condition.length}, ${condition.mult}${
        condition.maType === BOLLINGER_DEFAULTS.maType ? "" : `, ${condition.maType.toUpperCase()}`})`
    : where;
}

/** "Stochastic %K", with its inputs named only when they are not the defaults. */
function stochasticLabel(condition: StochasticCondition): string {
  const custom = condition.kLength !== STOCHASTIC_DEFAULTS.kLength
    || condition.kSmooth !== STOCHASTIC_DEFAULTS.kSmooth
    || condition.dSmooth !== STOCHASTIC_DEFAULTS.dSmooth;
  return custom
    ? `Stochastic %K ${condition.kLength}/${condition.kSmooth}/${condition.dSmooth}`
    : "Stochastic %K";
}

/** "ADX", with its lengths named only when they are not the defaults. */
function adxLabel(condition: AdxCondition): string {
  const custom = condition.diLength !== ADX_DEFAULTS.diLength
    || condition.smoothing !== ADX_DEFAULTS.smoothing;
  return custom ? `ADX ${condition.diLength}/${condition.smoothing}` : "ADX";
}

/**
 * "Supertrend" for the study's own 10 / 3 / Wilder inputs, "Supertrend 14/2"
 * otherwise — with the ATR method named only when it is the non-default SMA.
 *
 * Same rule as `macdLabel`: default parameters on every notification are noise,
 * non-default ones are the only thing separating two alerts in a list.
 */
export function stLabel(
  c: Pick<SupertrendCondition, "period" | "multiplier" | "atrMethod">
): string {
  const parts: string[] = [];
  if (c.period !== SUPERTREND_DEFAULTS.period || c.multiplier !== SUPERTREND_DEFAULTS.multiplier) {
    parts.push(`${c.period}/${c.multiplier}`);
  }
  if (c.atrMethod !== SUPERTREND_DEFAULTS.atrMethod) parts.push("SMA ATR");
  return parts.length > 0 ? `Supertrend ${parts.join(" ")}` : "Supertrend";
}

/** "RSI 50" — the oscillator, named by its length. */
export const rsiLabel = (c: Pick<RsiCondition, "rsiLength">): string => `RSI ${c.rsiLength}`;

/**
 * "MACD" for the standard 12/26/9, "MACD 8/21/5" otherwise.
 *
 * Spelling out default lengths on every notification is noise; spelling out
 * non-default ones is the difference between two alerts a user cannot
 * otherwise tell apart in the list.
 */
export function macdLabel(
  c: Pick<MacdCondition, "fastLength" | "slowLength" | "signalLength">
): string {
  const isDefault =
    c.fastLength === MACD_DEFAULTS.fast &&
    c.slowLength === MACD_DEFAULTS.slow &&
    c.signalLength === MACD_DEFAULTS.signal;
  return isDefault
    ? "MACD"
    : `MACD ${c.fastLength}/${c.slowLength}/${c.signalLength}`;
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
    // These resolve their reference from zones, a pivot period or an
    // oscillator the runner computes directly — never from a chart MA.
    case "sr_zone": return [];
    case "pivot_level": return [];
    case "rsi": return [];
    case "macd": return [];
    case "supertrend": return [];
    case "bollinger": return [];
    case "stochastic": return [];
    case "adx": return [];
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
      return filterError(condition.filters);

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
      return filterError(condition.filters);

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
      return filterError(condition.filters);

    case "sr_zone":
      if (!Number.isInteger(condition.pivotLength) || condition.pivotLength < 2 || condition.pivotLength > 100) {
        return "pivotLength must be an integer between 2 and 100";
      }
      return filterError(condition.filters)
        ?? nearBandError(condition.mode, condition.nearMinPct, condition.nearMaxPct);

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
      // The anchor has its own vocabulary: weekly and monthly are periods the
      // runner derives from daily candles, not intervals it can subscribe to.
      if (!isPivotAnchor(condition.anchor)) {
        return `anchor must be one of ${PIVOT_ANCHORS.join(", ")}`;
      }
      return filterError(condition.filters)
        ?? nearBandError(condition.mode, condition.nearMinPct, condition.nearMaxPct);

    case "rsi":
      if (!Number.isInteger(condition.rsiLength) || condition.rsiLength < 1) {
        return "rsiLength must be a positive integer";
      }
      if (condition.target === "level") {
        // Bounded oscillator: a level outside 0..100 can never be crossed.
        if (!Number.isFinite(condition.level) || condition.level <= 0 || condition.level >= 100) {
          return "level must be between 0 and 100 (exclusive)";
        }
      } else if (!Number.isInteger(condition.maLength) || condition.maLength < 1) {
        return "rsiMaLength must be a positive integer";
      }
      return filterError(condition.filters);

    case "macd":
      for (const [name, v] of [
        ["macdFast", condition.fastLength],
        ["macdSlow", condition.slowLength],
        ["macdSignal", condition.signalLength],
      ] as const) {
        if (!Number.isInteger(v) || v < 1) return `${name} must be a positive integer`;
      }
      if (condition.fastLength >= condition.slowLength) {
        return "macdFast must be less than macdSlow";
      }
      return filterError(condition.filters);

    case "supertrend":
      if (!Number.isInteger(condition.period) || condition.period < 1) {
        return "stPeriod must be a positive integer";
      }
      // A non-positive multiplier collapses the two bands onto hl2 or inverts
      // them, so the trend would flip on almost every bar or never at all.
      if (!Number.isFinite(condition.multiplier) || condition.multiplier <= 0) {
        return "stMultiplier must be a positive number";
      }
      if (!isStAtrMethod(condition.atrMethod)) {
        return "stAtrMethod must be rma or sma";
      }
      return filterError(condition.filters);

    case "bollinger":
      if (!Number.isInteger(condition.length) || condition.length < 2) {
        // A window of one has no deviation, so the bands would sit exactly on
        // the basis and every "touch" would be a touch.
        return "bbLength must be an integer of at least 2";
      }
      if (!Number.isFinite(condition.mult) || condition.mult <= 0) {
        return "bbMult must be a positive number";
      }
      if (!isBollingerBand(condition.band)) return "bbBand must be upper, basis or lower";
      if (!isMaType(condition.maType)) return "bbMaType must be sma or ema";
      return filterError(condition.filters)
        ?? nearBandError(condition.mode, condition.nearMinPct, condition.nearMaxPct);

    case "stochastic":
      for (const [name, v] of [
        ["stochKLength", condition.kLength],
        ["stochKSmooth", condition.kSmooth],
        ["stochDSmooth", condition.dSmooth],
      ] as const) {
        if (!Number.isInteger(v) || v < 1) return `${name} must be a positive integer`;
      }
      if (condition.target === "level") {
        // Bounded oscillator: a level outside 0..100 can never be crossed.
        if (!Number.isFinite(condition.level) || condition.level <= 0 || condition.level >= 100) {
          return "level must be between 0 and 100 (exclusive)";
        }
      }
      return filterError(condition.filters);

    case "adx":
      for (const [name, v] of [
        ["adxDiLength", condition.diLength],
        ["adxSmoothing", condition.smoothing],
      ] as const) {
        if (!Number.isInteger(v) || v < 1) return `${name} must be a positive integer`;
      }
      if (!Number.isFinite(condition.level) || condition.level <= 0 || condition.level >= 100) {
        return "level must be between 0 and 100 (exclusive)";
      }
      return filterError(condition.filters);
  }
}

/**
 * Rebuild the gates a row carries.
 *
 * Two shapes are read, in this order:
 *
 *  1. `filters` — the JSONB list written since migration 032. Authoritative
 *     whenever it is present, including when it is an empty list, which means
 *     "this alert deliberately has no gates".
 *  2. the legacy `filter_*` columns — one gate per kind, no timeframe. A row
 *     written before 032 and never edited since still has only these, and it
 *     must keep working.
 *
 * A half-written gate — a length with no side — is treated as no gate at all
 * rather than guessed at, in both shapes. A row that cannot express a complete
 * rule must never silently become a different one.
 */
function filtersFromRow(row: {
  filters?: unknown;
  filterRsiLength?: number | null;
  filterRsiLevel?: number | null;
  filterRsiSide?: string | null;
  filterMaType?: MaType | null;
  filterMaLength?: number | null;
  filterMaSide?: string | null;
  filterStPeriod?: number | null;
  filterStMultiplier?: number | null;
  filterStAtrMethod?: string | null;
  filterStSide?: string | null;
}): { filters?: AlertFilters } {
  if (row.filters !== null && row.filters !== undefined) {
    const parsed = parseStoredFilters(row.filters);
    return parsed.length > 0 ? { filters: parsed } : {};
  }
  const legacy = legacyFiltersFromRow(row);
  return legacy.length > 0 ? { filters: legacy } : {};
}

const side = (v: unknown): Side | null =>
  v === "above" || v === "below" ? v : null;

/** Pivot gates are a distance question, so they also accept "either". */
const bandSide = (v: unknown): Side | "either" | null =>
  v === "above" || v === "below" || v === "either" ? v : null;

/**
 * Read the stored JSONB list.
 *
 * Every element is validated rather than trusted. This is a database column,
 * and a row is data: an element that does not describe a complete, evaluable
 * gate is dropped, because carrying it forward would produce a gate whose
 * reading can never resolve — which fails closed and silences the alert
 * forever with nothing to show why.
 */
export function parseStoredFilters(raw: unknown): AlertFilters {
  const list = Array.isArray(raw) ? raw : [];
  const out: AlertFilters = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    // Read per kind below: pivot gates also accept "either", the others do not.
    const s = side(e.side);
    const timeframe = typeof e.timeframe === "string" && isInterval(e.timeframe)
      ? e.timeframe
      : null;

    if (e.kind === "rsi") {
      if (!s) continue;
      if (typeof e.length !== "number" || typeof e.level !== "number") continue;
      out.push({ kind: "rsi", timeframe, length: e.length, level: e.level, side: s });
    } else if (e.kind === "ma") {
      if (!s) continue;
      if (typeof e.length !== "number") continue;
      if (e.type !== "sma" && e.type !== "ema") continue;
      out.push({ kind: "ma", timeframe, type: e.type, length: e.length, side: s });
    } else if (e.kind === "pivot") {
      const bs = bandSide(e.side);
      const anchor = typeof e.anchor === "string" ? e.anchor : "";
      const type = typeof e.pivotType === "string" ? e.pivotType : "";
      if (!bs || !isPivotAnchor(anchor) || !isPivotType(type)) continue;
      if (typeof e.minPct !== "number" || typeof e.maxPct !== "number") continue;
      out.push({
        kind: "pivot", timeframe: null, anchor, pivotType: type,
        levelName: typeof e.levelName === "string" ? e.levelName : PIVOT_LEVEL_ANY,
        side: bs, minPct: e.minPct, maxPct: e.maxPct,
      });
    } else if (e.kind === "rsi_ma") {
      if (!s) continue;
      if (typeof e.length !== "number" || typeof e.maLength !== "number") continue;
      if (e.maType !== "sma" && e.maType !== "ema") continue;
      out.push({
        kind: "rsi_ma", timeframe, length: e.length,
        maType: e.maType, maLength: e.maLength, side: s,
      });
    } else if (e.kind === "macd") {
      if (!s) continue;
      if (
        typeof e.fastLength !== "number" || typeof e.slowLength !== "number"
        || typeof e.signalLength !== "number"
      ) continue;
      const target = typeof e.target === "string" ? e.target : "";
      if (!isMacdTarget(target)) continue;
      out.push({
        kind: "macd", timeframe, fastLength: e.fastLength,
        slowLength: e.slowLength, signalLength: e.signalLength, target, side: s,
      });
    } else if (e.kind === "supertrend") {
      if (!s) continue;
      if (typeof e.period !== "number" || typeof e.multiplier !== "number") continue;
      const method = typeof e.atrMethod === "string" ? e.atrMethod : "";
      if (!isStAtrMethod(method)) continue;
      out.push({
        kind: "supertrend", timeframe, period: e.period,
        multiplier: e.multiplier, atrMethod: method, side: s,
      });
    }
  }
  return out;
}

/** The pre-032 shape: at most one gate per kind, always on the alert's own timeframe. */
function legacyFiltersFromRow(row: {
  filterRsiLength?: number | null;
  filterRsiLevel?: number | null;
  filterRsiSide?: string | null;
  filterMaType?: MaType | null;
  filterMaLength?: number | null;
  filterMaSide?: string | null;
  filterStPeriod?: number | null;
  filterStMultiplier?: number | null;
  filterStAtrMethod?: string | null;
  filterStSide?: string | null;
}): AlertFilters {
  const out: AlertFilters = [];
  const rsiSide = side(row.filterRsiSide);
  if (row.filterRsiLength != null && row.filterRsiLevel != null && rsiSide) {
    out.push({
      kind: "rsi", timeframe: null,
      length: row.filterRsiLength, level: row.filterRsiLevel, side: rsiSide,
    });
  }
  const maSide = side(row.filterMaSide);
  if (row.filterMaType != null && row.filterMaLength != null && maSide) {
    out.push({
      kind: "ma", timeframe: null,
      type: row.filterMaType, length: row.filterMaLength, side: maSide,
    });
  }
  const stSide = side(row.filterStSide);
  const stMethod = row.filterStAtrMethod;
  if (
    row.filterStPeriod != null && row.filterStMultiplier != null && stSide &&
    stMethod != null && isStAtrMethod(stMethod)
  ) {
    out.push({
      kind: "supertrend", timeframe: null,
      period: row.filterStPeriod, multiplier: row.filterStMultiplier,
      atrMethod: stMethod, side: stSide,
    });
  }
  return out;
}

/**
 * "RSI 50 is above 50" / "1h price is above the EMA 200" — the gates, for the
 * notification and the UI list.
 *
 * A gate on the alert's own timeframe is not labelled with one; a gate on any
 * other names it. Labelling both would put "15m" on every gate of a 15m alert,
 * which is noise, and leaving both unlabelled would make the multi-timeframe
 * case — the one this feature exists for — invisible.
 */
export function describeFilters(filters: AlertFilters | undefined): string {
  if (!filters || filters.length === 0) return "";
  const parts = filters.map((f) => {
    const at = f.timeframe ? `${f.timeframe} ` : "";
    switch (f.kind) {
      case "rsi":
        return `${at}RSI ${f.length} is ${f.side} ${f.level}`;
      case "ma":
        return `${at}price is ${f.side} the ${maLabel(f.type, f.length)}`;
      case "supertrend":
        return `${at}price is ${f.side} the ${stLabel(f)}`;
      case "rsi_ma":
        return `${at}RSI ${f.length} is ${f.side} its ${maLabel(f.maType, f.maLength)}`;
      case "macd": {
        const params = `${f.fastLength}/${f.slowLength}/${f.signalLength}`;
        /*
         * Named bullish/bearish rather than above/below when the reference is
         * the signal line. That IS what the two sides mean to a reader, and
         * saying "above" made the gate look like it answered a different
         * question than the one people were asking for — the words are the
         * feature here as much as the comparison is.
         *
         * Against ZERO the words would be wrong: the centreline says which way
         * the trend leans, not whether momentum has turned, so that branch
         * keeps the plain above/below.
         */
        if (f.target === "zero") return `${at}MACD (${params}) is ${f.side} zero`;
        const mood = f.side === "above" ? "bullish" : "bearish";
        const where = f.side === "above" ? "above" : "below";
        return `${at}MACD (${params}) is ${mood} — line ${where} signal`;
      }
      case "pivot": {
        const level = f.levelName === PIVOT_LEVEL_ANY
          ? `the nearest ${f.pivotType} pivot`
          : `${f.pivotType} ${f.levelName}`;
        const where = f.side === "either" ? "either side of"
          : f.side === "above" ? "above" : "below";
        return `price is ${f.minPct}–${f.maxPct}% ${where} ${level} (${f.anchor})`;
      }
    }
  });
  return ` — only while ${parts.join(" and ")}`;
}

/**
 * The gate rules. A gate that cannot be satisfied is worse than no gate: the
 * alert would look armed and stay silent forever, which is indistinguishable
 * from a market that never met the condition.
 */
function filterError(filters: AlertFilters | undefined): string | null {
  if (!filters) return null;
  if (filters.length > MAX_ALERT_FILTERS) {
    return `an alert may carry at most ${MAX_ALERT_FILTERS} filters`;
  }
  for (const f of filters) {
    if (f.timeframe !== null && !isInterval(f.timeframe)) {
      return "filter timeframe is not a supported interval";
    }
    // Only the pivot gate asks a distance question, so only it accepts
    // "either". Allowing it everywhere would make "RSI is either 50" storable.
    const allowed = f.kind === "pivot"
      ? ["above", "below", "either"]
      : ["above", "below"];
    if (!allowed.includes(f.side)) {
      return `filter side must be ${allowed.join(" or ")}`;
    }
    switch (f.kind) {
      case "rsi":
        if (!Number.isInteger(f.length) || f.length < 1 || f.length > 1000) {
          return "filter RSI length must be an integer between 1 and 1000";
        }
        // RSI is bounded 0..100, so a gate outside that range is either always
        // open or permanently shut.
        if (!Number.isFinite(f.level) || f.level <= 0 || f.level >= 100) {
          return "filter RSI level must be between 0 and 100 (exclusive)";
        }
        break;
      case "ma":
        if (!Number.isInteger(f.length) || f.length < 1 || f.length > 1000) {
          return "filter moving-average length must be an integer between 1 and 1000";
        }
        break;
      case "pivot": {
        if (!isPivotAnchor(f.anchor)) {
          return `filter pivot anchor must be one of ${PIVOT_ANCHORS.join(", ")}`;
        }
        if (!isPivotType(f.pivotType)) {
          return `filter pivot type must be one of ${PIVOT_TYPES.join(", ")}`;
        }
        // A level the chosen type does not define would gate on something that
        // can never resolve, silencing the alert forever — Fibonacci has no R4.
        if (f.levelName !== PIVOT_LEVEL_ANY) {
          const names = pivotLevels({ open: 1, high: 2, low: 0, close: 1 }, f.pivotType)
            .map((l) => l.name);
          if (!names.includes(f.levelName.toUpperCase())) {
            return `${f.pivotType} has no level "${f.levelName}" (it defines ${names.join(", ")})`;
          }
        }
        if (!Number.isFinite(f.minPct) || f.minPct < 0) {
          return "filter pivot band must start at zero or above";
        }
        if (!(f.maxPct > f.minPct)) {
          return "filter pivot band must end above where it starts";
        }
        break;
      }
      case "rsi_ma":
        if (!Number.isInteger(f.length) || f.length < 1 || f.length > 1000) {
          return "filter RSI length must be an integer between 1 and 1000";
        }
        if (!isMaType(f.maType)) return "filter RSI average type must be sma or ema";
        if (!Number.isInteger(f.maLength) || f.maLength < 1 || f.maLength > 1000) {
          return "filter RSI average length must be an integer between 1 and 1000";
        }
        break;
      case "macd":
        for (const [name, len] of [
          ["fast", f.fastLength], ["slow", f.slowLength], ["signal", f.signalLength],
        ] as const) {
          if (!Number.isInteger(len) || len < 1 || len > 1000) {
            return `filter MACD ${name} length must be an integer between 1 and 1000`;
          }
        }
        /*
         * A fast length at or above the slow one inverts the histogram: the
         * "MACD line" becomes the negative of itself, so "above the signal"
         * would quietly mean the opposite of what the gate says. Refused
         * rather than normalised, because the user picked both numbers.
         */
        if (f.fastLength >= f.slowLength) {
          return "filter MACD fast length must be shorter than its slow length";
        }
        if (!isMacdTarget(f.target)) {
          return "filter MACD target must be signal or zero";
        }
        break;
      case "supertrend":
        if (!Number.isInteger(f.period) || f.period < 1 || f.period > 1000) {
          return "filter Supertrend ATR period must be an integer between 1 and 1000";
        }
        if (!Number.isFinite(f.multiplier) || f.multiplier <= 0 || f.multiplier > 100) {
          return "filter Supertrend multiplier must be greater than 0 and at most 100";
        }
        if (!isStAtrMethod(f.atrMethod)) {
          return "filter Supertrend ATR method must be rma or sma";
        }
        break;
    }
  }
  /*
   * Two gates that are the same question asked twice are almost certainly a
   * mistake — the user meant two timeframes and picked the same one twice.
   * Storing both would double the cost and change nothing, because a duplicate
   * of an ANDed condition is a no-op.
   */
  const seen = new Set<string>();
  for (const f of filters) {
    const key = JSON.stringify(f);
    if (seen.has(key)) return "two filters are identical — remove one, or change its timeframe";
    seen.add(key);
  }
  return null;
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
  filterRsiLength?: number | null;
  filterRsiLevel?: number | null;
  filterRsiSide?: string | null;
  filterMaType?: MaType | null;
  filterMaLength?: number | null;
  filterMaSide?: string | null;
  filterStPeriod?: number | null;
  filterStMultiplier?: number | null;
  filterStAtrMethod?: string | null;
  filterStSide?: string | null;
  stPeriod?: number | null;
  stMultiplier?: number | null;
  stAtrMethod?: string | null;
  rsiLength?: number | null;
  rsiLevel?: number | null;
  rsiMaLength?: number | null;
  macdFast?: number | null;
  macdSlow?: number | null;
  macdSignal?: number | null;
  indicatorTarget?: string | null;
  bbLength?: number | null;
  bbMult?: number | null;
  bbBand?: string | null;
  bbMaType?: MaType | null;
  stochKLength?: number | null;
  stochKSmooth?: number | null;
  stochDSmooth?: number | null;
  stochLevel?: number | null;
  adxDiLength?: number | null;
  adxSmoothing?: number | null;
  adxLevel?: number | null;
}): AlertCondition | null {
  switch (row.conditionKind) {
    case "price":
      if (row.targetPrice === null || row.priceDirection === null) return null;
      return {
        ...filtersFromRow(row),
        kind: "price", targetPrice: row.targetPrice, direction: row.priceDirection,
      };

    case "ma":
      if (row.maType === null || row.maLength === null || row.mode === null) return null;
      return {
        ...filtersFromRow(row),
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
        ...filtersFromRow(row),
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
        ...filtersFromRow(row),
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
        ...filtersFromRow(row),
        kind: "pivot_level",
        pivotType: type,
        levelName: row.pivotLevelName,
        anchor: row.pivotAnchor,
        mode: row.mode,
        nearMinPct: row.nearMinPct,
        nearMaxPct: row.nearMaxPct,
      };
    }

    case "rsi": {
      const target = row.indicatorTarget ?? "";
      if (
        !isRsiTarget(target) || row.rsiLength === null || row.rsiLength === undefined ||
        (row.mode !== "cross_up" && row.mode !== "cross_down")
      ) return null;
      return {
        ...filtersFromRow(row),
        kind: "rsi",
        rsiLength: row.rsiLength,
        target,
        level: row.rsiLevel ?? RSI_DEFAULTS.level,
        maLength: row.rsiMaLength ?? RSI_DEFAULTS.maLength,
        mode: row.mode,
      };
    }

    case "macd": {
      const target = row.indicatorTarget ?? "";
      if (
        !isMacdTarget(target) ||
        row.macdFast === null || row.macdFast === undefined ||
        row.macdSlow === null || row.macdSlow === undefined ||
        row.macdSignal === null || row.macdSignal === undefined ||
        (row.mode !== "cross_up" && row.mode !== "cross_down")
      ) return null;
      return {
        ...filtersFromRow(row),
        kind: "macd",
        fastLength: row.macdFast,
        slowLength: row.macdSlow,
        signalLength: row.macdSignal,
        target,
        mode: row.mode,
      };
    }

    case "bollinger": {
      const band = row.bbBand ?? "";
      const maType = row.bbMaType ?? "";
      if (
        row.bbLength === null || row.bbLength === undefined ||
        row.bbMult === null || row.bbMult === undefined ||
        !isBollingerBand(band) || !isMaType(maType) || row.mode === null
      ) return null;
      return {
        ...filtersFromRow(row),
        kind: "bollinger",
        length: row.bbLength,
        mult: row.bbMult,
        band,
        maType,
        mode: row.mode,
        nearMinPct: row.nearMinPct,
        nearMaxPct: row.nearMaxPct,
      };
    }

    case "stochastic": {
      const target = row.indicatorTarget ?? "";
      if (
        !isStochasticTarget(target) ||
        row.stochKLength === null || row.stochKLength === undefined ||
        row.stochKSmooth === null || row.stochKSmooth === undefined ||
        row.stochDSmooth === null || row.stochDSmooth === undefined ||
        (row.mode !== "cross_up" && row.mode !== "cross_down")
      ) return null;
      return {
        ...filtersFromRow(row),
        kind: "stochastic",
        kLength: row.stochKLength,
        kSmooth: row.stochKSmooth,
        dSmooth: row.stochDSmooth,
        target,
        level: row.stochLevel ?? STOCHASTIC_DEFAULTS.level,
        mode: row.mode,
      };
    }

    case "adx": {
      if (
        row.adxDiLength === null || row.adxDiLength === undefined ||
        row.adxSmoothing === null || row.adxSmoothing === undefined ||
        (row.mode !== "cross_up" && row.mode !== "cross_down")
      ) return null;
      return {
        ...filtersFromRow(row),
        kind: "adx",
        diLength: row.adxDiLength,
        smoothing: row.adxSmoothing,
        level: row.adxLevel ?? ADX_DEFAULTS.level,
        mode: row.mode,
      };
    }

    case "supertrend": {
      const method = row.stAtrMethod ?? "";
      if (
        row.stPeriod === null || row.stPeriod === undefined ||
        row.stMultiplier === null || row.stMultiplier === undefined ||
        !isStAtrMethod(method) ||
        (row.mode !== "cross_up" && row.mode !== "cross_down")
      ) return null;
      return {
        ...filtersFromRow(row),
        kind: "supertrend",
        period: row.stPeriod,
        multiplier: row.stMultiplier,
        atrMethod: method,
        mode: row.mode,
      };
    }
  }
}
