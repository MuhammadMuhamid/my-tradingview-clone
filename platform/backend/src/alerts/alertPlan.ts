/**
 * The decision half of the alert runner: given one alert and one observation,
 * decide whether to notify and what to persist.
 *
 * It is separated from `maAlertRunner` because everything interesting about
 * alert correctness is here — cross state, per-candle capping, the intrabar
 * boundary, the staleness guard — and none of it should need a database, a
 * websocket or a clock to test.
 *
 * ── Why an alert only sees samples of its own cadence ──────────────────────
 *
 * `lastSide` is the memory a cross is detected against, and it is persisted per
 * ALERT, not per feed. A `once_per_bar_close` alert must therefore never be
 * shown a forming candle: if a mid-candle wick above the line updated its
 * stored side, the cross would be silently consumed and the alert would not
 * fire at the close — a bar-close alert quietly turned into a worse intrabar
 * one. `shouldEvaluate` enforces that boundary, and it is the reason the
 * intrabar modes can be added without touching bar-close behaviour at all.
 */
import {
  evaluateCondition,
  type AlertCondition, type AlertFilter, type AlertFilters,
  type Sample, type Side,
} from "./alertConditions";
import type { Interval } from "../types/market";
import {
  acceptsIntrabarSample, decideFire, stateAfterFire,
  type AlertFrequency, type FireState, type SuppressionReason,
} from "./alertFrequency";
import type {
  MaType, SrSide, RsiTarget, MacdTarget, StAtrMethod,
  BollingerBand, StochasticTarget,
} from "../types/maAlerts";
import type { PivotType } from "../engine/pivotLevels";

/** Everything the decision needs about one armed alert. */
export interface AlertSpec {
  id: string;
  symbol: string;
  timeframe: string;
  enabled: boolean;
  condition: AlertCondition;
  frequency: AlertFrequency;
  lastSide: Side | null;
  fireState: FireState;
  /**
   * Open time of the most recent bar this alert was evaluated on. Guards
   * against out-of-order delivery: a replayed or late frame for an OLDER bar
   * must not be allowed to rewrite cross state that has already moved on.
   */
  lastBarTime: number | null;
}

/** One observation of a feed. A forming candle and a closed one differ only in `isClosedBar`. */
export interface FeedSample {
  symbol: string;
  timeframe: string;
  /** Open time of the candle this sample belongs to. */
  barTime: number;
  isClosedBar: boolean;
  high: number;
  low: number;
  close: number;
  /** Resolved value of an MA series at this bar, or undefined when unseeded. */
  series: (type: MaType, length: number) => number | undefined;
  /**
   * The nearest live support/resistance for this feed, or undefined when none
   * is knowable yet. Resolved by the runner, which owns the bar history the
   * zones are derived from.
   */
  srZone?: (
    side: SrSide, pivotLength: number, invalidation: "close" | "wick"
  ) => { price: number; label: string } | undefined;
  /**
   * A pivot level from the anchor period. Returns the matched level's name as
   * well as its price, so an `any` alert can say which line it fired on.
   */
  pivotLevel?: (
    type: PivotType, anchor: string, levelName: string
  ) => { price: number; label: string } | undefined;
  /**
   * RSI at this bar, and the reference it is compared against — the fixed
   * level, or the RSI-based SMA. Both come from the runner because only it
   * holds the bar history the oscillator needs.
   */
  rsi?: (
    length: number, target: RsiTarget, level: number, maLength: number
  ) => { value: number; reference: number } | undefined;
  /** MACD line and its reference: the signal line, or zero. */
  macd?: (
    fast: number, slow: number, signal: number, target: MacdTarget
  ) => { value: number; reference: number } | undefined;
  /**
   * One gate's reading on a timeframe that is NOT this feed's.
   *
   * The runner resolves it from that timeframe's bars truncated to
   * `closeTime <= this bar's closeTime`, so the value is the last CLOSED bar
   * of the gate's period — the same rule `engine/mtf.ts` uses for
   * `lookahead_off`. Returns undefined when that timeframe has no usable bar
   * yet, which fails the gate closed.
   */
  otherTimeframe?: (timeframe: Interval, filter: AlertFilter) => number | undefined;
  /**
   * Supertrend at this bar: its direction (+1 / -1) and the band it is
   * currently drawing. Both come from the runner, which holds the bar history
   * the stateful bands are built from — they cannot be recomputed from a
   * single sample.
   */
  supertrend?: (
    period: number, multiplier: number, atrMethod: StAtrMethod
  ) => { trend: number; line: number } | undefined;
  /**
   * One Bollinger band's PRICE at this bar, with the name to put in the
   * notification. A price, so it resolves through the same reference path a
   * pivot level and an S/R zone use rather than through the oscillator path.
   */
  bollinger?: (
    length: number, mult: number, maType: MaType, band: BollingerBand
  ) => { price: number; label: string } | undefined;
  /** Stochastic %K and what it is compared against: its %D, or a level. */
  stochastic?: (
    kLength: number, kSmooth: number, dSmooth: number,
    target: StochasticTarget, level: number
  ) => { value: number; reference: number } | undefined;
  /** ADX and the strength threshold it is compared against. */
  adx?: (
    diLength: number, smoothing: number, level: number
  ) => { value: number; reference: number } | undefined;
}

export type SkipReason =
  | "disabled"
  | "wrong_symbol"
  | "wrong_timeframe"
  | "stale_bar"
  | "wrong_sample_kind";

export type AlertPlan =
  /** The alert must not be touched at all — no notification, no state write. */
  | { act: false; reason: SkipReason }
  /** The alert was evaluated. `fire` says whether to notify; state is written either way. */
  | {
      act: true;
      fire: boolean;
      /** Present when the condition was true but the frequency withheld it. */
      suppressed: SuppressionReason | null;
      side: Side | null;
      distancePct: number;
      reference: number;
      triggered: boolean;
      /** What the reference turned out to be: "S1", "1h support". */
      label: string | null;
    };

/**
 * Whether this alert may look at this sample at all.
 *
 * The symbol and timeframe comparisons are not defensive noise. Feeds are
 * multiplexed onto one websocket and re-subscribed on every reconnect, so a
 * frame for a stream that has just been unsubscribed, or a REST response that
 * arrives after the user switched timeframe, is a normal event rather than an
 * exotic one. Either would otherwise evaluate an alert against the wrong
 * market's prices.
 */
export function shouldEvaluate(spec: AlertSpec, sample: FeedSample): SkipReason | null {
  if (!spec.enabled) return "disabled";
  if (spec.symbol !== sample.symbol) return "wrong_symbol";
  if (spec.timeframe !== sample.timeframe) return "wrong_timeframe";
  if (spec.lastBarTime !== null && sample.barTime < spec.lastBarTime) return "stale_bar";
  if (!sample.isClosedBar && !acceptsIntrabarSample(spec.frequency)) return "wrong_sample_kind";
  return null;
}

/** Decide what to do with one alert on one sample. Pure. */
export function planAlert(spec: AlertSpec, sample: FeedSample, now: number): AlertPlan {
  const skip = shouldEvaluate(spec, sample);
  if (skip) return { act: false, reason: skip };

  const resolved = withSeries(spec.condition, sample);
  const evaluation = evaluateCondition(spec.condition, resolved, spec.lastSide);

  let fire = false;
  let suppressed: SuppressionReason | null = null;
  if (evaluation.triggered) {
    const decision = decideFire(spec.frequency, spec.fireState, {
      barTime: sample.barTime,
      sampleIsClosedBar: sample.isClosedBar,
      now,
    });
    fire = decision.fire;
    if (!decision.fire) suppressed = decision.reason;
  }

  return {
    act: true,
    fire,
    suppressed,
    side: evaluation.side,
    distancePct: evaluation.distancePct,
    reference: evaluation.reference,
    triggered: evaluation.triggered,
    label: resolved.refLabel ?? null,
  };
}

/**
 * Attach the values this condition compares against, plus its gate readings.
 *
 * The gate readings are attached for EVERY kind, in one place, for the same
 * reason `evaluateCondition` applies the gates in one place: a family that
 * forgot them would present as an alert whose filter is configured, displayed,
 * and silently ignored.
 */
function withSeries(condition: AlertCondition, sample: FeedSample): Sample {
  const base: Sample = {
    high: sample.high, low: sample.low, close: sample.close,
    ...filterReadings(condition.filters, sample),
  };
  switch (condition.kind) {
    case "price":
      return base;
    case "ma":
      return { ...base, maValue: sample.series(condition.maType, condition.maLength) };
    case "ma_vs_ma":
      return {
        ...base,
        maValue: sample.series(condition.maType, condition.maLength),
        ma2Value: sample.series(condition.ma2Type, condition.ma2Length),
      };
    case "sr_zone": {
      const zone = sample.srZone?.(
        condition.srSide, condition.pivotLength, condition.invalidation
      );
      return { ...base, refValue: zone?.price, refLabel: zone?.label };
    }
    case "pivot_level": {
      const level = sample.pivotLevel?.(
        condition.pivotType, condition.anchor, condition.levelName
      );
      return { ...base, refValue: level?.price, refLabel: level?.label };
    }
    case "rsi": {
      const r = sample.rsi?.(
        condition.rsiLength, condition.target, condition.level, condition.maLength
      );
      return { ...base, indicatorValue: r?.value, indicatorReference: r?.reference };
    }
    case "macd": {
      const m = sample.macd?.(
        condition.fastLength, condition.slowLength, condition.signalLength,
        condition.target
      );
      return { ...base, indicatorValue: m?.value, indicatorReference: m?.reference };
    }
    case "supertrend": {
      const st = sample.supertrend?.(
        condition.period, condition.multiplier, condition.atrMethod
      );
      // The direction decides the event; the line is what the notification
      // names, so it rides along as the reference price.
      return { ...base, indicatorValue: st?.trend, refValue: st?.line };
    }
    case "bollinger": {
      // A band is a price level, so it resolves into `refValue` exactly as a
      // pivot level or an S/R zone does and the comparison is the shared one.
      const band = sample.bollinger?.(
        condition.length, condition.mult, condition.maType, condition.band
      );
      return { ...base, refValue: band?.price, refLabel: band?.label };
    }
    case "stochastic": {
      const s = sample.stochastic?.(
        condition.kLength, condition.kSmooth, condition.dSmooth,
        condition.target, condition.level
      );
      return { ...base, indicatorValue: s?.value, indicatorReference: s?.reference };
    }
    case "adx": {
      const a = sample.adx?.(condition.diLength, condition.smoothing, condition.level);
      return { ...base, indicatorValue: a?.value, indicatorReference: a?.reference };
    }
  }
}

/**
 * Resolve one reading per gate, in order.
 *
 * A gate on the alert's own timeframe reads from the feed already loaded, so
 * it costs a cache lookup: the 200 EMA a gate reads is the same array an MA
 * alert on that line uses. A gate naming another timeframe goes through
 * `otherTimeframe`, which the runner backs with that timeframe's bars
 * truncated to the alert bar's close — see `AlertFilter`.
 *
 * An unresolved reading is left `undefined` rather than defaulted, because
 * `filtersPass` fails closed on it. A gate whose series has not warmed up must
 * silence the alert, not wave it through.
 */
function filterReadings(
  filters: AlertFilters | undefined, sample: FeedSample
): { filterReadings?: (number | undefined)[] } {
  if (!filters || filters.length === 0) return {};

  const readings = filters.map((filter) => {
    /*
     * A pivot gate is anchored to a completed period rather than sampled on a
     * chart interval, so it is always resolved from this feed's own resolver —
     * `otherTimeframe` would have no series to compute it from.
     */
    const own = filter.kind === "pivot"
      || filter.timeframe === null
      || filter.timeframe === sample.timeframe;
    if (!own) return sample.otherTimeframe?.(filter.timeframe!, filter);

    switch (filter.kind) {
      case "rsi":
        // The gate needs the reading only, so the target it would be compared
        // against is irrelevant — "level" keeps the resolver on its cheapest path.
        return sample.rsi?.(filter.length, "level", filter.level, filter.length)?.value;
      case "ma":
        return sample.series(filter.type, filter.length);
      case "supertrend":
        return sample.supertrend?.(
          filter.period, filter.multiplier, filter.atrMethod
        )?.trend;
      case "pivot":
        /*
         * The LEVEL's price. `filtersPass` turns that into a distance from the
         * close, so the runner resolves a level and nothing else — the same
         * resolver a `pivot_level` alert already uses, on the same completed
         * anchor period.
         */
        return sample.pivotLevel?.(
          filter.pivotType, filter.anchor, filter.levelName
        )?.price;
    }
  });

  return { filterReadings: readings };
}

/** The alert state to persist after acting on `plan`. */
export function stateAfterPlan(
  spec: AlertSpec,
  plan: Extract<AlertPlan, { act: true }>,
  ctx: { barTime: number; now: number; delivered: boolean }
): { lastSide: Side | null; lastBarTime: number; fireState: FireState } {
  return {
    lastSide: plan.side,
    lastBarTime: ctx.barTime,
    fireState: plan.fire
      ? stateAfterFire(spec.frequency, spec.fireState, ctx)
      : spec.fireState,
  };
}
