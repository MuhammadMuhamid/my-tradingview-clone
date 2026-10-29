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
  type AlertCondition, type AlertFilter, type AlertFilters, type Sample, type Side,
  type SrTouchGate,
} from "./alertConditions";
import {
  acceptsIntrabarSample, decideFire, stateAfterFire,
  type AlertFrequency, type FireState, type SuppressionReason,
} from "./alertFrequency";
import type {
  MaType, SrSide, RsiTarget, MacdTarget, StAtrMethod,
  BollingerBand, StochasticTarget,
} from "../types/maAlerts";
import type { PivotType } from "../engine/pivotLevels";
import type { ObZoneChoice, SwingArea } from "../ta/core";

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
   * One level of the Auto Fib Retracement on this feed's own bars, or
   * undefined while the zig-zag has fewer than two legs. Computed with
   * `autoFib` from `ta/core` — the function the chart's study draws with.
   */
  fibLevel?: (
    deviation: number, depth: number, reverse: boolean, level: number
  ) => { price: number; label: string } | undefined;
  /**
   * The MSB-OB study on this feed's bars at the evaluated bar: the market
   * state, a break ON this bar (+1 / -1 / 0, with the level it broke), and
   * the zone price ENTERED on this bar, if one of `zone` matches.
   */
  msb?: (zigzagLength: number, fibFactor: number) =>
    { market: number; broke: number; price: number } | undefined;
  orderBlock?: (zigzagLength: number, fibFactor: number, zone: ObZoneChoice) =>
    { entered: boolean; price: number; label: string } | undefined;
  /** The live Liquidity Swings level for this bar, as price meets it. */
  liquiditySwing?: (length: number, area: SwingArea, side: "high" | "low" | "either") =>
    { price: number; label: string } | undefined;
  /**
   * RSI at this bar, and the reference it is compared against — the fixed
   * level, or the RSI-based SMA. Both come from the runner because only it
   * holds the bar history the oscillator needs.
   */
  rsi?: (
    length: number, target: RsiTarget, level: number, maLength: number
  ) => { value: number; reference: number } | undefined;
  /**
   * RSI at this bar against a moving average OF THE RSI ITSELF, in the type the
   * gate named. Separate from `rsi` because that resolver's "sma" target is
   * fixed to a simple average, and this one must honour `maType`.
   */
  rsiMa?: (
    length: number, maType: MaType, maLength: number
  ) => { value: number; reference: number } | undefined;
  /** MACD line and its reference: the signal line, or zero. */
  macd?: (
    fast: number, slow: number, signal: number, target: MacdTarget
  ) => { value: number; reference: number } | undefined;
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
  /**
   * Whether price retested a live Flux Charts support (or resistance) within
   * the last `lookback` bars and bounced — `fluxSrTouchBounce` on this feed's
   * bars. Undefined while the history cannot answer.
   */
  srTouch?: (gate: SrTouchGate) => boolean | undefined;
  /** Canonical server result for this exact completed bar. */
  patterns?: { ids: readonly string[]; nameFor: (id: string) => string | undefined };
  /**
   * A feed per DISTINCT gate timeframe on this symbol, for gates measured
   * somewhere other than the alert's own timeframe.
   *
   * The runner builds one entry per timeframe any active alert on the symbol
   * gates on, and shares it across every alert there — so ten gates spread
   * over two timeframes cost the two fetches that two gates would.
   *
   * A timeframe missing from this map is a gate that cannot be read, which
   * `filtersPass` treats as SHUT.
   */
  gateFeeds?: Readonly<Record<string, FeedSample | undefined>>;

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
    case "candlestick_pattern":
      return {
        ...base, patternIds: sample.patterns?.ids,
        refLabel: sample.patterns?.nameFor(condition.patternId),
      };
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
    case "msb": {
      const m = sample.msb?.(condition.zigzagLength, condition.fibFactor);
      return {
        ...base, indicatorValue: m?.market, indicatorReference: m?.broke,
        refValue: m?.price, refLabel: m && m.broke > 0 ? "bullish" : m && m.broke < 0 ? "bearish" : undefined,
      };
    }
    case "order_block": {
      const z = sample.orderBlock?.(condition.zigzagLength, condition.fibFactor, condition.zone);
      return { ...base, indicatorValue: z?.entered ? 1 : 0, refValue: z?.price, refLabel: z?.label };
    }
    case "liquidity_swing": {
      const lvl = sample.liquiditySwing?.(condition.length, condition.area, condition.side);
      return { ...base, refValue: lvl?.price, refLabel: lvl?.label };
    }
    case "fib_level": {
      const fib = sample.fibLevel?.(
        condition.deviation, condition.depth, condition.reverse, condition.level
      );
      return { ...base, refValue: fib?.price, refLabel: fib?.label };
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
 * Resolve one reading per gate, positionally matched to `filters`.
 *
 * ── The uniform shape ─────────────────────────────────────────────────────
 *
 * Every gate reduces to a SIGNED SPREAD, so `filtersPass` only ever tests a
 * sign and never needs to know which kind it is looking at. RSI against a
 * level subtracts the level; price against a moving average subtracts the
 * line; the two that compare two computed series — `rsi_ma` and `macd` —
 * subtract one series from the other. Supertrend already had this shape,
 * because its trend is +1 or -1.
 *
 * ── Where each gate is measured ───────────────────────────────────────────
 *
 * A gate with no timeframe reads `sample`, the alert's own. A gate that names
 * one reads the FeedSample the runner built for that timeframe, handed in via
 * `sample.gateFeeds`. A named timeframe with no feed — the fetch failed, or it
 * is not a timeframe the runner subscribes to — yields `undefined`, which
 * `filtersPass` treats as a shut gate rather than an open one.
 *
 * Every resolver here is one the runner already provides for that family's own
 * alerts, so a gate costs no extra computation beyond the cache lookup: the
 * 200 EMA a gate reads is the same array an MA alert on that line uses.
 */
function filterReadings(
  filters: AlertFilters | undefined, sample: FeedSample
): { filterReadings?: readonly (number | undefined)[] } {
  if (!filters || filters.length === 0) return {};
  return { filterReadings: filters.map((gate) => gateReading(gate, sample)) };
}

function gateReading(gate: AlertFilter, own: FeedSample): number | undefined {
  const feed = gate.timeframe ? own.gateFeeds?.[gate.timeframe] : own;
  if (!feed) return undefined;

  const finite = (v: number | undefined): number | undefined =>
    v !== undefined && Number.isFinite(v) ? v : undefined;
  const spread = (a: number | undefined, b: number | undefined): number | undefined => {
    const x = finite(a), y = finite(b);
    return x === undefined || y === undefined ? undefined : x - y;
  };

  switch (gate.kind) {
    case "rsi": {
      // The gate only needs the reading, so the target it is compared against
      // inside the resolver is irrelevant — "level" keeps it on its cheapest
      // path, and the subtraction happens here.
      const v = feed.rsi?.(gate.length, "level", gate.level, gate.length)?.value;
      return spread(v, gate.level);
    }
    case "ma":
      return spread(feed.close, finite(feed.series(gate.type, gate.length)));
    case "supertrend":
      // The indicator's own direction: +1 uptrend, -1 downtrend. Comparing the
      // close to the drawn line instead would agree on every bar but one — the
      // flip bar, where the line has already moved to the other side of price.
      return finite(
        feed.supertrend?.(gate.period, gate.multiplier, gate.atrMethod)?.trend
      );
    case "rsi_ma": {
      // NOT `feed.rsi` with the "sma" target: that resolver hardcodes a simple
      // average, so an EMA gate would be silently measured as an SMA and the
      // rule would not be the one the user wrote.
      const r = feed.rsiMa?.(gate.length, gate.maType, gate.maLength);
      return spread(r?.value, r?.reference);
    }
    case "macd": {
      const m = feed.macd?.(
        gate.fastLength, gate.slowLength, gate.signalLength, gate.target
      );
      // Against zero the resolver's reference IS zero, so one subtraction
      // covers both targets. This is the STATE the crossover left behind,
      // which is what a gate must ask — a cross is true for one bar only.
      return spread(m?.value, m?.reference);
    }
    case "sr_touch": {
      // A yes/no, signed for the side asked: +1 opens an "above" (support
      // bounce) gate, -1 a "below" (resistance rejection) one, and 0 shuts
      // either. No touch is a shut gate, not an unknown one.
      const above = gate.side === "above";
      const hit = feed.srTouch?.(gate);
      if (hit === undefined) return undefined;
      return hit ? (above ? 1 : -1) : 0;
    }
  }
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
