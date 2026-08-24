/**
 * Feed health: the honest answer to "is this data live?".
 *
 * Two defects sit behind this module.
 *
 * `BE-14` — `ensureCandles` accepted a feed as covered when it held 98.5 % of
 * the expected bars, with no contiguity check, no padding and no log line. For
 * `mtf_lean`'s 2100-bar 15m warmup that is 31 absent bars, nearly eight hours,
 * and `toBars` then packs whatever rows exist into a contiguous array — so
 * every rolling indicator computed over a silently compressed timeline.
 *
 * `FE-09` / `BE-14` — the websocket exposed an `isConnected()` that nothing
 * called. A connection that stays OPEN but stops delivering, or a half-open TCP
 * socket, produced no signal at all: prices froze while still being displayed,
 * and the runner kept evaluating whatever the database happened to hold.
 *
 * The state machine is pure so it can be asserted directly, and so the same
 * vocabulary is used by the runner, the health endpoint and the UI badge.
 */
import type { Candle, Interval } from "../types/market";
import { INTERVAL_MS } from "../types/market";
import { checkSeries } from "./candleSeries";

/**
 * The states an operator or a chart badge may be shown. Every one of them is
 * either observed or explicitly unknown — none is a guess.
 */
export const FEED_STATES = [
  /** Contiguous, and the newest bar is the one that should exist by now. */
  "live",
  /** Contiguous, but the newest bar is older than it should be. */
  "delayed",
  /** The transport is down and a reconnect is in progress. */
  "reconnecting",
  /** Bars are missing from the interior of the series. */
  "gap",
  /** The feed could not be read at all. */
  "error",
  /** Not yet assessed. Never render this as "live". */
  "unknown",
] as const;
export type FeedState = (typeof FEED_STATES)[number];

export interface FeedAssessment {
  state: FeedState;
  /** Bars absent from the interval grid the series spans. */
  missingBars: number;
  /** How many whole bars behind the expected newest bar the feed is. */
  barsBehind: number;
  lastBarOpenTime: number | null;
  detail: string;
  /** May a strategy be evaluated on this feed? Only ever true for `live`. */
  evaluable: boolean;
}

/**
 * How many bars behind the newest CLOSED bar a feed may be and still count as
 * live. One, not zero: a bar closes and the websocket message, the database
 * write and this check all happen within a bar of each other, so demanding
 * zero would flap on every boundary.
 */
export const MAX_BARS_BEHIND_LIVE = 1;

/** The open time of the newest bar that has finished closing by `now`. */
export function newestClosedBarOpenTime(interval: Interval, now: number): number {
  const step = INTERVAL_MS[interval];
  // The bar containing `now` is still open, so step back one.
  return Math.floor(now / step) * step - step;
}

/**
 * Assess a candle series that is believed to be the newest window of a feed.
 *
 * `transportDown` is passed in rather than inferred: a series can look perfect
 * while the socket is dead, and "the last bar arrived on time but we are no
 * longer connected" is `reconnecting`, not `live`.
 */
export function assessFeed(
  candles: Candle[],
  interval: Interval,
  opts: { now?: number; transportDown?: boolean } = {}
): FeedAssessment {
  const now = opts.now ?? Date.now();
  const step = INTERVAL_MS[interval];

  if (candles.length === 0) {
    return {
      state: opts.transportDown ? "reconnecting" : "error",
      missingBars: 0,
      barsBehind: 0,
      lastBarOpenTime: null,
      detail: "no candles available for this feed",
      evaluable: false,
    };
  }

  const check = checkSeries(candles, interval);
  const last = candles[candles.length - 1]!;
  const expected = newestClosedBarOpenTime(interval, now);
  const barsBehind = Math.max(0, Math.round((expected - last.openTime) / step));
  const missingBars = check.gaps.reduce((n, g) => n + g.missingBars, 0);

  // Order matters: a structural defect outranks lateness, because a gapped
  // series is wrong regardless of how recent its newest bar is.
  if (check.outOfOrder.length > 0 || check.duplicates.length > 0 || check.misaligned.length > 0) {
    return {
      state: "error",
      missingBars,
      barsBehind,
      lastBarOpenTime: last.openTime,
      detail:
        `series is malformed: ${check.outOfOrder.length} out of order, ` +
        `${check.duplicates.length} duplicated, ${check.misaligned.length} off-grid`,
      evaluable: false,
    };
  }

  if (missingBars > 0) {
    const worst = check.gaps.reduce((a, b) => (b.missingBars > a.missingBars ? b : a));
    return {
      state: "gap",
      missingBars,
      barsBehind,
      lastBarOpenTime: last.openTime,
      detail:
        `${missingBars} bar(s) missing; largest gap is ${worst.missingBars} bar(s) ` +
        `after ${new Date(worst.afterOpenTime).toISOString()}`,
      evaluable: false,
    };
  }

  if (opts.transportDown) {
    return {
      state: "reconnecting",
      missingBars: 0,
      barsBehind,
      lastBarOpenTime: last.openTime,
      detail: "websocket is not connected; a reconnect is in progress",
      evaluable: false,
    };
  }

  if (barsBehind > MAX_BARS_BEHIND_LIVE) {
    return {
      state: "delayed",
      missingBars: 0,
      barsBehind,
      lastBarOpenTime: last.openTime,
      detail:
        `newest bar is ${barsBehind} bar(s) behind; expected the bar opening at ` +
        `${new Date(expected).toISOString()}`,
      evaluable: false,
    };
  }

  return {
    state: "live",
    missingBars: 0,
    barsBehind,
    lastBarOpenTime: last.openTime,
    detail: "contiguous and current",
    evaluable: true,
  };
}

/**
 * Assess a feed for the purpose of EVALUATING a strategy on a specific bar.
 *
 * Distinct from `assessFeed` because the runner is not asking "is this feed
 * current now" — it is asking "was this feed complete up to and including the
 * bar I am about to evaluate". A backfill that finishes a second after the bar
 * closes is fine; a hole in the middle of the warmup window is not.
 */
export function assessForEvaluation(
  candles: Candle[],
  interval: Interval,
  barTime: number
): FeedAssessment {
  if (candles.length === 0) {
    return {
      state: "error", missingBars: 0, barsBehind: 0, lastBarOpenTime: null,
      detail: "no candles available for this feed", evaluable: false,
    };
  }
  const step = INTERVAL_MS[interval];
  const check = checkSeries(candles, interval);
  const last = candles[candles.length - 1]!;
  const missingBars = check.gaps.reduce((n, g) => n + g.missingBars, 0);

  if (check.outOfOrder.length > 0 || check.duplicates.length > 0 || check.misaligned.length > 0) {
    return {
      state: "error", missingBars, barsBehind: 0, lastBarOpenTime: last.openTime,
      detail: "series is malformed", evaluable: false,
    };
  }
  if (missingBars > 0) {
    const worst = check.gaps.reduce((a, b) => (b.missingBars > a.missingBars ? b : a));
    return {
      state: "gap", missingBars, barsBehind: 0, lastBarOpenTime: last.openTime,
      detail:
        `refusing to evaluate: ${missingBars} bar(s) missing from the warmup window, ` +
        `largest gap ${worst.missingBars} bar(s) after ` +
        `${new Date(worst.afterOpenTime).toISOString()}`,
      evaluable: false,
    };
  }

  // The bar being evaluated must actually be present, and must be the last one.
  // A feed whose newest bar predates the signal bar cannot support the decision.
  const barsBehind = Math.max(0, Math.round((barTime - last.openTime) / step));
  if (last.openTime < barTime) {
    return {
      state: "delayed", missingBars: 0, barsBehind, lastBarOpenTime: last.openTime,
      detail:
        `refusing to evaluate: newest bar ${new Date(last.openTime).toISOString()} ` +
        `is behind the signal bar ${new Date(barTime).toISOString()}`,
      evaluable: false,
    };
  }

  return {
    state: "live", missingBars: 0, barsBehind: 0, lastBarOpenTime: last.openTime,
    detail: "contiguous through the signal bar", evaluable: true,
  };
}

/** The worst state across several feeds — what a single badge should show. */
export function worstFeedState(states: FeedState[]): FeedState {
  const severity: Record<FeedState, number> = {
    live: 0, delayed: 2, reconnecting: 3, gap: 4, error: 5, unknown: 1,
  };
  return states.reduce<FeedState>(
    (worst, s) => (severity[s] > severity[worst] ? s : worst),
    "live"
  );
}

/**
 * Silence after which a connection that is still nominally OPEN is treated as
 * dead and rebuilt.
 *
 * Binance sends a kline update roughly every second on an active stream, and a
 * ping every three minutes. Ninety seconds of complete silence across every
 * subscribed stream means the socket is half-open or the server has stopped
 * sending — either way, reconnecting is cheaper than continuing to trust it.
 */
export const WS_SILENCE_TIMEOUT_MS = 90_000;
