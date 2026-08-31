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
  type AlertCondition, type AlertFilters, type Sample, type Side,
} from "./alertConditions";
import {
  acceptsIntrabarSample, decideFire, stateAfterFire,
  type AlertFrequency, type FireState, type SuppressionReason,
} from "./alertFrequency";
import type { MaType, SrSide, RsiTarget, MacdTarget } from "../types/maAlerts";
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
      side: Side;
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

/** Attach the MA values this condition compares against, if any. */
function withSeries(condition: AlertCondition, sample: FeedSample): Sample {
  const base: Sample = { high: sample.high, low: sample.low, close: sample.close };
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
      return {
        ...base, refValue: zone?.price, refLabel: zone?.label,
        ...filterValues(condition.filters, sample),
      };
    }
    case "pivot_level": {
      const level = sample.pivotLevel?.(
        condition.pivotType, condition.anchor, condition.levelName
      );
      return {
        ...base, refValue: level?.price, refLabel: level?.label,
        ...filterValues(condition.filters, sample),
      };
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
  }
}

/**
 * Resolve the gate inputs from the feed.
 *
 * Both come from resolvers the runner already provides for their own alert
 * families, so a gate costs no extra computation beyond the cache lookup: the
 * 200 EMA a filter reads is the same array an MA alert on that line uses.
 */
function filterValues(
  filters: AlertFilters | undefined, sample: FeedSample
): { filterRsiValue?: number; filterMaValue?: number } {
  if (!filters) return {};
  const out: { filterRsiValue?: number; filterMaValue?: number } = {};
  if (filters.rsi) {
    // The gate only needs the reading, so the target it is compared against
    // here is irrelevant — "level" keeps the resolver on its cheapest path.
    out.filterRsiValue = sample.rsi?.(
      filters.rsi.length, "level", filters.rsi.level, filters.rsi.length
    )?.value;
  }
  if (filters.ma) {
    out.filterMaValue = sample.series(filters.ma.type, filters.ma.length);
  }
  return out;
}

/** The alert state to persist after acting on `plan`. */
export function stateAfterPlan(
  spec: AlertSpec,
  plan: Extract<AlertPlan, { act: true }>,
  ctx: { barTime: number; now: number; delivered: boolean }
): { lastSide: Side; lastBarTime: number; fireState: FireState } {
  return {
    lastSide: plan.side,
    lastBarTime: ctx.barTime,
    fireState: plan.fire
      ? stateAfterFire(spec.frequency, spec.fireState, ctx)
      : spec.fireState,
  };
}
