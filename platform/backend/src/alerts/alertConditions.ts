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
  PIVOT_LEVEL_ANY, ADX_DEFAULTS, BOLLINGER_DEFAULTS, MACD_DEFAULTS, RSI_DEFAULTS,
  STOCHASTIC_DEFAULTS, SUPERTREND_DEFAULTS,
  MAX_ALERT_FILTERS,
  isBollingerBand, isMaType, isRsiTarget, isMacdTarget, isStAtrMethod, isStochasticTarget,
  isFilterKind, isFilterSide, isFilterTimeframe,
  type BollingerBand, type ConditionKind, type MaAlertMode, type MaType,
  type PriceDirection, type SrSide, type RsiTarget, type MacdTarget, type StAtrMethod,
  type StochasticTarget, type FilterTimeframe,
} from "../types/maAlerts";
import { LIQUIDITY_SWING_DEFAULTS, MSB_DEFAULTS, type ObZoneChoice, type SwingArea } from "../ta/core";

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
 * This is a GATE, not a trigger: it never fires anything on its own, it only
 * decides whether the event is worth telling you about. "Alert me when price
 * approaches 1h support, but only while the 1h trend is up" is one alert with a
 * filter, not two alerts to correlate by hand.
 *
 * Every gate is evaluated on the alert's OWN timeframe and symbol, against the
 * same bar as the trigger, so a 1h alert is gated by 1h RSI and the 1h EMA.
 * There is deliberately no per-gate timeframe: allowing one would turn every
 * alert into a multi-timeframe query, and the alert's own timeframe is the one
 * whose event is being judged.
 *
 * Gates are available on EVERY family, not only the level ones. "MACD crosses
 * up, but only while price is above the Supertrend" is the same shape of
 * request as the level version, and refusing it on some families would be an
 * artefact of the order the families were built in rather than a rule.
 */
export interface GateBase {
  /**
   * The timeframe this gate is measured on. Omitted means the alert's own,
   * which is what every gate written before migration 045 meant.
   */
  timeframe?: FilterTimeframe;
  side: Side;
}

/** RSI(length) must sit above/below a fixed `level` on the 0..100 scale. */
export interface RsiGate extends GateBase {
  kind: "rsi";
  length: number;
  level: number;
}

/** The close must sit above/below this moving average. */
export interface MaGate extends GateBase {
  kind: "ma";
  type: MaType;
  length: number;
}

/**
 * Price must be on the named side of the Supertrend — "above" is its uptrend.
 * Read from the indicator's own trend rather than by comparing the close to the
 * drawn line: the two agree by construction, and the trend is the value the
 * study itself acts on.
 */
export interface SupertrendGate extends GateBase {
  kind: "supertrend";
  period: number;
  multiplier: number;
  atrMethod: StAtrMethod;
}

/**
 * RSI against a moving average OF THE RSI ITSELF.
 *
 * Unlike the `rsi` gate this needs no fixed level to be meaningful: it asks
 * whether momentum is above its own recent average, which stays true across
 * regimes where a hard 50 does not.
 */
export interface RsiMaGate extends GateBase {
  kind: "rsi_ma";
  length: number;
  maType: MaType;
  maLength: number;
}

/**
 * The MACD line against its signal, or against zero.
 *
 * This is the STATE a crossover leaves behind, not the crossing. A gate asks
 * "is this true now", and a cross is true for exactly one bar — gating on the
 * cross would let the alert fire on that bar only, which is not what "only
 * while the MACD is bullish" means.
 */
export interface MacdGate extends GateBase {
  kind: "macd";
  fastLength: number;
  slowLength: number;
  signalLength: number;
  target: MacdTarget;
}

export type AlertFilter =
  | RsiGate | MaGate | SupertrendGate | RsiMaGate | MacdGate;

/**
 * The gates an alert carries, in the order the user arranged them.
 *
 * A LIST rather than one slot per kind: "the 1h RSI above its EMA 14 and the
 * 4h RSI above its EMA 21" is two gates of the same kind, and the fixed-slot
 * shape this replaced could not express it at all.
 */
export type AlertFilters = AlertFilter[];

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
/**
 * Price against one level of an Auto Fib Retracement — "price reached the 0.618".
 *
 * The level is resolved by the runner with `autoFib` from `ta/core`, the same
 * function the chart's Auto Fib study draws with, over this alert's own
 * timeframe. It moves when the zig-zag confirms a new swing, as the indicator
 * does; the comparison is the shared one every level family uses.
 */
export interface FibLevelCondition {
  kind: "fib_level";
  /** Zig-zag deviation multiplier (the indicator's "Deviation"). */
  deviation: number;
  /** Zig-zag depth (the indicator's "Depth"). */
  depth: number;
  /** Swap which end of the swing is 0 and which is 1. */
  reverse: boolean;
  /** The ratio: 0.618 is the 61.8% retracement. */
  level: number;
  mode: MaMode;
  nearMinPct: number;
  nearMaxPct: number;
}

/**
 * A market structure break from the "Market Structure Break & Order Block"
 * study (`marketStructure` in `ta/core`, the function the chart draws with).
 *
 * The event is the break itself, read from the computation on the evaluated
 * bar: `cross_up` a bullish MSB, `cross_down` a bearish one, `touch` either.
 */
export interface MsbCondition {
  kind: "msb";
  zigzagLength: number;
  fibFactor: number;
  mode: "cross_up" | "cross_down" | "touch";
}

/**
 * Price ENTERING one of the zones a structure break leaves: an order block
 * (Bu-OB / Be-OB) or a breaker/mitigation block (Bu-BB / Be-BB). Fires on the
 * bar the study first reports "price in zone" for a zone, not on every bar
 * spent inside it.
 */
export interface OrderBlockCondition {
  kind: "order_block";
  zigzagLength: number;
  fibFactor: number;
  zone: ObZoneChoice;
}

/**
 * Price against the live Liquidity Swings [LuxAlgo] level — the latest swing
 * high (or low) that no close has crossed yet. Same touch / cross / near
 * grammar as every level family.
 */
export interface LiquiditySwingCondition {
  kind: "liquidity_swing";
  length: number;
  area: SwingArea;
  side: "high" | "low" | "either";
  mode: MaMode;
  nearMinPct: number;
  nearMaxPct: number;
}

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
  /** Read when `target` is "sma" or "ema": the length of the RSI-based average. */
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

/** One canonical candlestick formation, evaluated only on a closed bar. */
export interface CandlestickPatternCondition {
  kind: "candlestick_pattern";
  patternId: string;
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
  | SrZoneCondition | PivotLevelCondition | FibLevelCondition
  | RsiCondition | MacdCondition | SupertrendCondition
  | BollingerCondition | StochasticCondition | AdxCondition
  | CandlestickPatternCondition
  | MsbCondition | OrderBlockCondition | LiquiditySwingCondition
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
  /** RSI reading for a filter gate, resolved on the alert's own timeframe. */
  /**
   * One reading per gate, positionally matched to the alert's `filters`.
   *
   * Every gate reduces to a SIGNED SPREAD: the gate opens when the reading is
   * positive for side "above" and negative for side "below". RSI against a
   * level subtracts the level, price against a moving average subtracts the
   * line, and the two that compare two computed series — `rsi_ma` and `macd` —
   * subtract one from the other. Supertrend already had this shape, since its
   * trend is +1 or -1.
   *
   * `undefined` at a position means that gate's input has not resolved, and
   * `filtersPass` treats it as shut. See `filterReadings` in `alertPlan.ts`.
   */
  filterReadings?: readonly (number | undefined)[];
  /** Stable ids recognized on this exact completed bar by the canonical service. */
  patternIds?: readonly string[];
  patternName?: string;
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
    case "msb": {
      // `indicatorValue` is the market state, `indicatorReference` the
      // direction of a break ON this bar (0 when none).
      const market = sample.indicatorValue;
      const broke = sample.indicatorReference ?? 0;
      const reference = sample.refValue ?? NaN;
      if (market === undefined || !Number.isFinite(market)) {
        return { side: prevSide, distancePct: 0, triggered: false, reference };
      }
      const side: Side = market > 0 ? "above" : "below";
      const triggered = broke !== 0 && (condition.mode === "touch"
        || (condition.mode === "cross_up" && broke > 0)
        || (condition.mode === "cross_down" && broke < 0));
      const distancePct = Number.isFinite(reference) ? distance(sample.close, reference) : 0;
      return { side, distancePct, triggered, reference };
    }
    case "order_block": {
      // `indicatorValue` is 1 on the bar price entered a matching zone.
      const entered = sample.indicatorValue === 1;
      const reference = sample.refValue ?? NaN;
      const distancePct = Number.isFinite(reference) ? distance(sample.close, reference) : 0;
      return { side: entered ? "above" : "below", distancePct, triggered: entered, reference };
    }
    case "liquidity_swing": {
      const reference = sample.refValue ?? NaN;
      if (!Number.isFinite(reference)) {
        return { side: prevSide, distancePct: 0, triggered: false, reference };
      }
      return evaluateAgainstReference(
        condition.mode, condition.nearMinPct, condition.nearMaxPct,
        reference, sample, prevSide);
    }
    case "fib_level": {
      // Fewer than two zig-zag legs has no fib at all. Keep the stored side
      // rather than compare against NaN: a side invented now would report a
      // cross on the first bar the fib becomes computable.
      const reference = sample.refValue ?? NaN;
      if (!Number.isFinite(reference)) {
        return { side: prevSide, distancePct: 0, triggered: false, reference };
      }
      return evaluateAgainstReference(
        condition.mode, condition.nearMinPct, condition.nearMaxPct,
        reference, sample, prevSide);
    }
    case "rsi":
      return evaluateRsi(condition, sample, prevSide);
    case "macd":
      return evaluateMacd(condition, sample, prevSide);
    case "supertrend":
      return evaluateSupertrend(condition, sample, prevSide);
    case "candlestick_pattern":
      return {
        side: "above", distancePct: 0,
        triggered: sample.patternIds?.includes(condition.patternId) === true,
        reference: sample.close,
      };
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
 * **Fails closed.** A gate whose input has not resolved — RSI still warming up,
 * an EMA without enough history — blocks the alert rather than passing it. The
 * user asked for "only when the trend is up"; firing because the trend is
 * *unknown* answers a different question, and would do so silently.
 */
export function filtersPass(
  filters: AlertFilters | undefined, sample: Sample
): boolean {
  if (!filters || filters.length === 0) return true;
  const readings = sample.filterReadings ?? [];

  for (let i = 0; i < filters.length; i++) {
    const gate = filters[i];
    if (!gate) return false;
    const reading = readings[i];
    // An input that has not resolved leaves the gate SHUT. The user asked for
    // "only while the trend is up"; firing because the trend is *unknown*
    // answers a different question, and would do so silently.
    if (reading === undefined || !Number.isFinite(reading)) return false;
    if (gate.side === "above" ? !(reading > 0) : !(reading < 0)) return false;
  }

  return true;
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
    case "candlestick_pattern":
      return `${condition.patternId.replaceAll("_", " ")} confirmed`;
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
        : `its ${condition.target.toUpperCase()} ${condition.maLength}`;
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
    case "msb": {
      const what = msbLabel(condition);
      return condition.mode === "cross_up" ? `bullish ${what}`
        : condition.mode === "cross_down" ? `bearish ${what}` : `${what} (either direction)`;
    }
    case "order_block":
      return `price enters ${obZoneLabel(condition.zone)}${msbTuning(condition)}`;
    case "liquidity_swing": {
      const line = liquidityLabel(condition);
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
    case "fib_level": {
      const line = fibLabel(condition);
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
  }
  return "condition met";
}

/**
 * "0.618 auto fib level", with the zig-zag inputs named only when they are not
 * the indicator's defaults (Deviation 3, Depth 30), and "reversed" when it is.
 */
const msbTuning = (c: Pick<MsbCondition, "zigzagLength" | "fibFactor">): string =>
  c.zigzagLength !== MSB_DEFAULTS.zigzagLength || c.fibFactor !== MSB_DEFAULTS.fibFactor
    ? ` (zigzag ${c.zigzagLength}, fib ${c.fibFactor})` : "";

/** "market structure break", with the zig-zag inputs when they are not the study's. */
export function msbLabel(c: Pick<MsbCondition, "zigzagLength" | "fibFactor">): string {
  return `market structure break${msbTuning(c)}`;
}

const OB_ZONE_LABELS: Record<ObZoneChoice, string> = {
  bu_ob: "a bullish order block (Bu-OB)", be_ob: "a bearish order block (Be-OB)",
  bu_bb: "a bullish breaker block (Bu-BB/MB)", be_bb: "a bearish breaker block (Be-BB/MB)",
  bullish: "a bullish order or breaker block", bearish: "a bearish order or breaker block",
  any: "an order or breaker block",
};
export const obZoneLabel = (z: ObZoneChoice): string => OB_ZONE_LABELS[z];

/** "swing high liquidity level", with the lookback when it is not 20. */
export function liquidityLabel(c: Pick<LiquiditySwingCondition, "side" | "length" | "area">): string {
  const which = c.side === "high" ? "swing high" : c.side === "low" ? "swing low" : "nearest swing";
  const tuned = c.length !== LIQUIDITY_SWING_DEFAULTS.length ? ` (lookback ${c.length})` : "";
  const area = c.area !== LIQUIDITY_SWING_DEFAULTS.area ? " (wick area)" : "";
  return `${which} liquidity level${tuned}${area}`;
}

export function fibLabel(c: Pick<FibLevelCondition, "level" | "deviation" | "depth" | "reverse">): string {
  const tuned = c.deviation !== 3 || c.depth !== 30 ? ` (dev ${c.deviation}, depth ${c.depth})` : "";
  return `${c.level} auto fib level${tuned}${c.reverse ? " (reversed)" : ""}`;
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
    case "fib_level": return [];
    case "msb": return [];
    case "order_block": return [];
    case "liquidity_swing": return [];
    case "rsi": return [];
    case "macd": return [];
    case "supertrend": return [];
    case "bollinger": return [];
    case "stochastic": return [];
    case "adx": return [];
    case "candlestick_pattern": return [];
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
    case "candlestick_pattern":
      if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(condition.patternId)) {
        return "patternId must be a stable lowercase catalog id";
      }
      return filterError(condition.filters);
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

    case "msb":
    case "order_block":
      if (!Number.isInteger(condition.zigzagLength) || condition.zigzagLength < 1 || condition.zigzagLength > 500) {
        return "msbZigzagLength must be an integer between 1 and 500";
      }
      if (!Number.isFinite(condition.fibFactor) || condition.fibFactor < 0 || condition.fibFactor > 1) {
        return "msbFibFactor must be a number between 0 and 1";
      }
      if (condition.kind === "msb" && !["cross_up", "cross_down", "touch"].includes(condition.mode)) {
        return "mode must be cross_up (bullish), cross_down (bearish) or touch (either)";
      }
      if (condition.kind === "order_block" && !(condition.zone in OB_ZONE_LABELS)) {
        return `obZone must be one of ${Object.keys(OB_ZONE_LABELS).join(", ")}`;
      }
      return filterError(condition.filters);

    case "liquidity_swing":
      if (!Number.isInteger(condition.length) || condition.length < 1 || condition.length > 500) {
        return "lsLength must be an integer between 1 and 500";
      }
      if (condition.area !== "wick" && condition.area !== "full") return "lsArea must be wick or full";
      if (!["high", "low", "either"].includes(condition.side)) return "lsSide must be high, low or either";
      return filterError(condition.filters)
        ?? nearBandError(condition.mode, condition.nearMinPct, condition.nearMaxPct);

    case "fib_level":
      if (!Number.isFinite(condition.deviation) || condition.deviation < 0 || condition.deviation > 100) {
        return "fibDeviation must be a number between 0 and 100";
      }
      if (!Number.isInteger(condition.depth) || condition.depth < 2 || condition.depth > 500) {
        return "fibDepth must be an integer between 2 and 500";
      }
      if (!Number.isFinite(condition.level) || condition.level < -5 || condition.level > 10) {
        return "fibLevel must be a number between -5 and 10";
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
      if (!condition.anchor.trim()) return "anchor timeframe is required";
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
 * Read the gates back out of whatever the database returned.
 *
 * ── Why this refuses rather than drops ────────────────────────────────────
 *
 * The obvious shape for a tolerant reader is "skip what you cannot parse".
 * That is WRONG here, and dangerously so: a gate kind this build does not
 * recognise — a row written by a newer deploy, or by a rollback's newer
 * sibling — would be read back as NO gate, and the alert would then fire
 * completely UNGATED while its stored filter still says otherwise. The user
 * asked for a precondition and would get none, silently.
 *
 * The type checker cannot catch that, because the value arrives as `unknown`.
 * So an unrecognised or malformed gate makes the WHOLE list unreadable, and
 * `conditionFromRow` then treats the alert as not evaluable — which the runner
 * already logs and skips. Refusing to evaluate is the safe direction; firing
 * without the precondition is not.
 */
export function parseStoredFilters(raw: unknown): AlertFilters | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  // A widening CHECK bounds this in the database too; enforced here as well so
  // a row written before the cap moved cannot outrun the evaluator.
  if (raw.length > MAX_ALERT_FILTERS) return null;

  const out: AlertFilter[] = [];
  for (const entry of raw) {
    const gate = parseStoredGate(entry);
    if (!gate) return null; // refuse the list, never the gate
    out.push(gate);
  }
  return out;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function parseStoredGate(raw: unknown): AlertFilter | null {
  if (typeof raw !== "object" || raw === null) return null;
  const g = raw as Record<string, unknown>;

  const kind = g.kind;
  if (typeof kind !== "string" || !isFilterKind(kind)) return null;

  const side = g.side;
  if (typeof side !== "string" || !isFilterSide(side)) return null;

  // Absent means "the alert's own timeframe". Present but unrecognised is a
  // gate this build cannot measure, which is refused rather than silently
  // measured somewhere else.
  let timeframe: FilterTimeframe | undefined;
  if (g.timeframe != null) {
    if (typeof g.timeframe !== "string" || !isFilterTimeframe(g.timeframe)) return null;
    timeframe = g.timeframe;
  }

  const base = timeframe ? { side, timeframe } : { side };

  switch (kind) {
    case "rsi": {
      const length = num(g.length), level = num(g.level);
      if (length == null || level == null) return null;
      return { ...base, kind, length, level };
    }
    case "ma": {
      const length = num(g.length);
      const type = g.type;
      if (length == null || typeof type !== "string" || !isMaType(type)) return null;
      return { ...base, kind, type, length };
    }
    case "supertrend": {
      const period = num(g.period), multiplier = num(g.multiplier);
      const atrMethod = g.atrMethod;
      if (period == null || multiplier == null) return null;
      if (typeof atrMethod !== "string" || !isStAtrMethod(atrMethod)) return null;
      return { ...base, kind, period, multiplier, atrMethod };
    }
    case "rsi_ma": {
      const length = num(g.length), maLength = num(g.maLength);
      const maType = g.maType;
      if (length == null || maLength == null) return null;
      if (typeof maType !== "string" || !isMaType(maType)) return null;
      return { ...base, kind, length, maType, maLength };
    }
    case "macd": {
      const fastLength = num(g.fastLength), slowLength = num(g.slowLength);
      const signalLength = num(g.signalLength);
      const target = g.target;
      if (fastLength == null || slowLength == null || signalLength == null) return null;
      if (typeof target !== "string" || !isMacdTarget(target)) return null;
      // A fast length at or above the slow one INVERTS the line, which would
      // make "above the signal" mean its opposite. Refused, not normalised.
      if (fastLength >= slowLength) return null;
      return { ...base, kind, fastLength, slowLength, signalLength, target };
    }
  }
}

/**
 * Rebuild the gates for one row: the `filters` list if it has one, else the
 * legacy per-kind columns.
 *
 * A half-written legacy gate — a length with no side — is treated as no gate at
 * all rather than guessed at, so a row that cannot express a complete rule can
 * never silently become a different one.
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
  if (row.filters != null) {
    // `conditionFromRow` refuses the row outright when this cannot be read, so
    // by the time we are here the list either parses or the caller never ran.
    const parsed = parseStoredFilters(row.filters);
    if (parsed) return { filters: parsed };
    return {};
  }

  const filters: AlertFilter[] = [];
  const side = (v: string | null | undefined): Side | null =>
    v === "above" || v === "below" ? v : null;

  const rsiSide = side(row.filterRsiSide);
  if (row.filterRsiLength != null && row.filterRsiLevel != null && rsiSide) {
    filters.push({
      kind: "rsi", length: row.filterRsiLength, level: row.filterRsiLevel, side: rsiSide,
    });
  }
  const maSide = side(row.filterMaSide);
  if (row.filterMaType != null && row.filterMaLength != null && maSide) {
    filters.push({
      kind: "ma", type: row.filterMaType, length: row.filterMaLength, side: maSide,
    });
  }
  const stSide = side(row.filterStSide);
  const stMethod = row.filterStAtrMethod;
  if (
    row.filterStPeriod != null && row.filterStMultiplier != null && stSide &&
    stMethod != null && isStAtrMethod(stMethod)
  ) {
    filters.push({
      kind: "supertrend",
      period: row.filterStPeriod,
      multiplier: row.filterStMultiplier,
      atrMethod: stMethod,
      side: stSide,
    });
  }
  return filters.length > 0 ? { filters } : {};
}

/** "RSI(50) is above 50" / "price is above the EMA 200" — the gates, for the UI list. */
export function describeFilters(filters: AlertFilters | undefined): string {
  if (!filters || filters.length === 0) return "";
  const parts = filters.map(describeGate);
  return parts.length > 0 ? ` — only while ${parts.join(" and ")}` : "";
}

/**
 * The timeframe a gate names, as a prefix, or "" when it is on the alert's own.
 *
 * Deliberately WITHOUT an article: the phrases that need one already carry it
 * ("price is above the 1h EMA 200"), and the ones that start with the
 * indicator supply their own ("the 1h RSI(50) is above 50").
 */
const tfPrefix = (gate: AlertFilter): string =>
  gate.timeframe ? `${gate.timeframe} ` : "";

/** "the 1h RSI…" / "RSI…" — an article only when a timeframe precedes it. */
const leading = (gate: AlertFilter): string => (gate.timeframe ? "the " : "");

/**
 * One gate as a sentence fragment.
 *
 * ── Why the MACD gate says "bullish" ──────────────────────────────────────
 *
 * Against the SIGNAL line the sides are named for the mood they describe:
 * "MACD is above signal line" is the same rule wearing a name nobody
 * recognises, and it was asked for a second time by someone who had already
 * been given it. Against ZERO they keep above/below, because there the mood
 * words would be WRONG — the centreline says which way the trend leans, not
 * whether momentum has turned.
 *
 * The RSI's LENGTH is bracketed — "RSI(50) is above 50" — because the bare
 * form put two numbers side by side ("RSI 50 is above 50") and a reader could
 * not tell which one was the period and which the level.
 *
 * This sentence exists twice, here for the notification and again in the
 * frontend for the alert list. Both assert the same literals in their tests,
 * because nothing else stops them drifting the moment one is edited.
 */
export function describeGate(gate: AlertFilter): string {
  const tf = tfPrefix(gate);
  const lead = leading(gate);
  switch (gate.kind) {
    case "rsi":
      return `${lead}${tf}RSI(${gate.length}) is ${gate.side} ${gate.level}`;
    case "ma":
      return `price is ${gate.side} the ${tf}${maLabel(gate.type, gate.length)}`;
    case "supertrend":
      return `price is ${gate.side} the ${tf}${stLabel(gate)}`;
    case "rsi_ma":
      return `${lead}${tf}RSI(${gate.length}) is ${gate.side} its ` +
        `${maLabel(gate.maType, gate.maLength)}`;
    case "macd": {
      const macdLabel =
        `MACD ${gate.fastLength}/${gate.slowLength}/${gate.signalLength}`;
      if (gate.target === "zero") {
        return `${lead}${tf}${macdLabel} is ${gate.side} zero`;
      }
      const mood = gate.side === "above"
        ? "bullish (above signal)"
        : "bearish (below signal)";
      return `${lead}${tf}${macdLabel} is ${mood}`;
    }
  }
}

/**
 * The gate rules. A gate that cannot be satisfied is worse than no gate: the
 * alert would look armed and stay silent forever, which is indistinguishable
 * from a market that never met the condition.
 */
function filterError(filters: AlertFilters | undefined): string | null {
  if (!filters || filters.length === 0) return null;
  if (filters.length > MAX_ALERT_FILTERS) {
    return `an alert may carry at most ${MAX_ALERT_FILTERS} gates`;
  }
  for (const gate of filters) {
    const err = gateError(gate);
    if (err) return err;
  }
  return null;
}

function gateError(gate: AlertFilter): string | null {
  if (gate.side !== "above" && gate.side !== "below") {
    return "a gate's side must be above or below";
  }
  if (gate.timeframe != null && !isFilterTimeframe(gate.timeframe)) {
    return "a gate's timeframe is not one this build can measure";
  }
  switch (gate.kind) {
    case "rsi": {
      const { length, level } = gate;
      if (!Number.isInteger(length) || length < 1) {
        return "filterRsiLength must be a positive integer";
      }
      // RSI is bounded 0..100, so a gate outside that range is either always
      // open or permanently shut.
      if (!Number.isFinite(level) || level <= 0 || level >= 100) {
        return "filterRsiLevel must be between 0 and 100 (exclusive)";
      }
      return null;
    }
    case "ma": {
      if (!Number.isInteger(gate.length) || gate.length < 1) {
        return "filterMaLength must be a positive integer";
      }
      if (!isMaType(gate.type)) return "filterMaType is not a moving average this build knows";
      return null;
    }
    case "supertrend": {
      const { period, multiplier, atrMethod } = gate;
      if (!Number.isInteger(period) || period < 1) {
        return "filterStPeriod must be a positive integer";
      }
      if (!Number.isFinite(multiplier) || multiplier <= 0) {
        return "filterStMultiplier must be a positive number";
      }
      if (!isStAtrMethod(atrMethod)) return "filterStAtrMethod must be rma or sma";
      return null;
    }
    case "rsi_ma": {
      const { length, maLength, maType } = gate;
      if (!Number.isInteger(length) || length < 1) {
        return "filterRsiLength must be a positive integer";
      }
      if (!Number.isInteger(maLength) || maLength < 1) {
        return "filterRsiMaLength must be a positive integer";
      }
      if (!isMaType(maType)) return "filterRsiMaType is not a moving average this build knows";
      return null;
    }
    case "macd": {
      const { fastLength, slowLength, signalLength, target } = gate;
      if (!Number.isInteger(fastLength) || fastLength < 1) {
        return "filterMacdFast must be a positive integer";
      }
      if (!Number.isInteger(slowLength) || slowLength < 1) {
        return "filterMacdSlow must be a positive integer";
      }
      if (!Number.isInteger(signalLength) || signalLength < 1) {
        return "filterMacdSignal must be a positive integer";
      }
      // Refused rather than normalised: a fast length at or above the slow one
      // inverts the line, which would make "is bullish" mean its opposite.
      if (fastLength >= slowLength) {
        return "filterMacdFast must be shorter than filterMacdSlow";
      }
      if (!isMacdTarget(target)) return "filterMacdTarget must be signal or zero";
      return null;
    }
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
  filters?: unknown;
  fibDeviation?: number | null;
  fibDepth?: number | null;
  fibReverse?: boolean | null;
  fibLevel?: number | null;
  msbZigzagLength?: number | null;
  msbFibFactor?: number | null;
  obZone?: string | null;
  lsLength?: number | null;
  lsArea?: string | null;
  lsSide?: string | null;
  maType: MaType | null;
  maLength: number | null;
  mode: MaAlertMode | null;
  ma2Type: MaType | null;
  ma2Length: number | null;
  targetPrice: number | null;
  priceDirection: PriceDirection | null;
  patternId?: string | null;
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
  // Gates that cannot be read make the alert NOT EVALUABLE, never ungated.
  // The runner logs this row and skips it, which is the safe direction: an
  // alert whose stored precondition this build cannot understand must not fire
  // as though it had no precondition at all.
  if (row.filters != null && parseStoredFilters(row.filters) === null) return null;

  switch (row.conditionKind) {
    case "candlestick_pattern":
      return row.patternId ? {
        ...filtersFromRow(row), kind: "candlestick_pattern", patternId: row.patternId,
      } : null;
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

    case "msb": {
      if (row.msbZigzagLength == null || row.msbFibFactor == null
          || (row.mode !== "cross_up" && row.mode !== "cross_down" && row.mode !== "touch")) return null;
      return {
        ...filtersFromRow(row), kind: "msb",
        zigzagLength: row.msbZigzagLength, fibFactor: row.msbFibFactor, mode: row.mode,
      };
    }
    case "order_block": {
      if (row.msbZigzagLength == null || row.msbFibFactor == null
          || row.obZone == null || !(row.obZone in OB_ZONE_LABELS)) return null;
      return {
        ...filtersFromRow(row), kind: "order_block",
        zigzagLength: row.msbZigzagLength, fibFactor: row.msbFibFactor, zone: row.obZone as ObZoneChoice,
      };
    }
    case "liquidity_swing": {
      if (row.lsLength == null || (row.lsArea !== "wick" && row.lsArea !== "full")
          || (row.lsSide !== "high" && row.lsSide !== "low" && row.lsSide !== "either")
          || row.mode === null) return null;
      return {
        ...filtersFromRow(row), kind: "liquidity_swing",
        length: row.lsLength, area: row.lsArea, side: row.lsSide, mode: row.mode,
        nearMinPct: row.nearMinPct, nearMaxPct: row.nearMaxPct,
      };
    }
    case "fib_level": {
      if (row.fibDeviation == null || row.fibDepth == null || row.fibLevel == null
          || row.fibReverse == null || row.mode === null) return null;
      return {
        ...filtersFromRow(row),
        kind: "fib_level",
        deviation: row.fibDeviation,
        depth: row.fibDepth,
        reverse: row.fibReverse,
        level: row.fibLevel,
        mode: row.mode,
        nearMinPct: row.nearMinPct,
        nearMaxPct: row.nearMaxPct,
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
