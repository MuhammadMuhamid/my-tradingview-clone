import type { Candle } from "@/lib/types";
import type { Drawing } from "@/lib/drawings";

/**
 * How fast a Replay steps, in bars per second.
 *
 * 10× is here because reviewing a whole session at 5× takes long enough that
 * people stop doing it. It is a ceiling rather than a step on the way to more:
 * beyond ten bars a second the chart is not being READ, and a speed nobody can
 * follow is a speed nobody should be offered.
 */
export const REPLAY_SPEEDS = [1, 2, 5, 10] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * Replay's only evaluation clock is `horizonCloseTime`: the close time of the
 * current chart bar. `availableThroughCloseTime` freezes the completed history
 * that existed when replay started, so reaching its end cannot become live.
 */
export interface ReplaySession {
  horizonCloseTime: number;
  availableThroughCloseTime: number;
  playing: boolean;
  speed: ReplaySpeed;
}

export function lastBarIndexAtOrBefore(
  candles: readonly Candle[],
  closeTime: number,
  availableThroughCloseTime = Number.POSITIVE_INFINITY,
): number {
  const cutoff = Math.min(closeTime, availableThroughCloseTime);
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candles[mid]!.closeTime <= cutoff) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export function replayCandles(
  candles: readonly Candle[],
  session: ReplaySession | null,
): Candle[] {
  // Normal chart mode keeps the existing array identity and cost profile.
  if (!session) return candles as Candle[];
  const end = lastBarIndexAtOrBefore(
    candles,
    session.horizonCloseTime,
    session.availableThroughCloseTime,
  );
  return end < 0 ? [] : candles.slice(0, end + 1);
}

/** Resolve a requested wall time onto an actual completed chart-bar close. */
export function startReplay(
  candles: readonly Candle[],
  requestedTime: number,
  now = Date.now(),
  speed: ReplaySpeed = 1,
): ReplaySession | null {
  const end = lastBarIndexAtOrBefore(candles, now);
  if (end < 0) return null;
  const availableThroughCloseTime = candles[end]!.closeTime;
  const selected = lastBarIndexAtOrBefore(
    candles,
    requestedTime,
    availableThroughCloseTime,
  );
  if (selected < 0) return null;
  return {
    horizonCloseTime: candles[selected]!.closeTime,
    availableThroughCloseTime,
    playing: false,
    speed,
  };
}

/**
 * Preserve the replay timestamp across a symbol/timeframe/history reload and
 * resolve it to that context's last completed bar at or before the old T.
 *
 * ── IO-A2: two events, one code path, and only one of them was served ──────
 *
 * This is called for a NAVIGATION — the user changed symbol or timeframe — and
 * for a REFRESH of the window the session is already in. The caller's effect
 * is keyed on the `candles` array identity, and a refresh changes that
 * identity: a feed coming back from stale reloads, a depth repair reloads, and
 * on a canonical instrument the provider stream and a fifteen-second REST tail
 * both call `mergeLiveBars`.
 *
 * Both branches returned `playing: false`. For a navigation that is deliberate
 * — you land paused on the equivalent bar. For a refresh it meant that pressing
 * Play started a session which stopped itself within fifteen seconds, with the
 * transport still lit and nothing said, so it read as a product that does not
 * work rather than as something that had happened.
 *
 * This function cannot tell the two apart. The caller can, and now says which
 * it is. A refresh keeps whatever the session was doing; a refresh that has
 * LOST the point still stops, because playing on from a horizon that is no
 * longer in the bars is worse than stopping.
 */
export function reconcileReplay(
  session: ReplaySession,
  candles: readonly Candle[],
  options: { sameWindow?: boolean } = {},
): ReplaySession {
  const selected = lastBarIndexAtOrBefore(
    candles,
    session.horizonCloseTime,
    session.availableThroughCloseTime,
  );
  if (selected < 0) return { ...session, playing: false };
  return {
    ...session,
    horizonCloseTime: candles[selected]!.closeTime,
    playing: options.sameWindow === true ? session.playing : false,
  };
}

/**
 * Whether the session's point exists in the bars this context has loaded.
 *
 * ── The blank chart ────────────────────────────────────────────────────────
 *
 * TVP8 round two. Start a replay on 1d at a point sixty days back, then switch
 * the pane to 1m. The 1m window loads the most recent bars — at the default
 * depth, about a week of them — and every one of them closes AFTER the
 * session's T. `reconcileReplay` finds no bar at or before it, returns the
 * session unchanged with `playing: false`, and `replayCandles` slices nothing:
 * a white pane, Prev / Next / Play all disabled, and not one word anywhere
 * about why. The session is still perfectly valid; it is the WINDOW that
 * cannot show it.
 *
 * This is the question the strip has to be able to ask, so it is here with the
 * rest of the replay arithmetic rather than inferred from an empty array at
 * the call site — "no bars" and "no bars AT T" want different sentences, and
 * only the second one has a way out.
 */
export type ReplayCoverage = "covered" | "before-history" | "no-bars";

export function replayCoverage(
  session: ReplaySession,
  candles: readonly Candle[],
): ReplayCoverage {
  if (candles.length === 0) return "no-bars";
  const at = lastBarIndexAtOrBefore(
    candles,
    session.horizonCloseTime,
    session.availableThroughCloseTime,
  );
  return at < 0 ? "before-history" : "covered";
}

/**
 * How deep this window would have to load for the session's point to be in it.
 *
 * The answer is often absurd — sixty days at 1m is 86,400 bars — and that is
 * the useful part: a caller can compare it against what it is willing to
 * request and offer either a button or an explanation, rather than silently
 * firing a request that will take a minute and may still not arrive.
 *
 * Counted from the NEWEST loaded bar rather than from now, because that is
 * where the window's far edge actually is, plus `CONTEXT_BARS` so the point
 * lands with some history behind it instead of against the left edge.
 */
export const REPLAY_CONTEXT_BARS = 300;

export function barsToCoverReplay(
  session: ReplaySession,
  candles: readonly Candle[],
  intervalMs: number,
): number | null {
  const newest = candles[candles.length - 1];
  if (!newest || intervalMs <= 0) return null;
  /*
   * Nothing to ask for when the window already reaches the point. Asked as
   * COVERAGE rather than as a time comparison: a window whose newest bar is
   * later than T tells you nothing on its own, since that is true of every
   * window that already contains T.
   */
  if (replayCoverage(session, candles) === "covered") return null;
  const target = Math.min(session.horizonCloseTime, session.availableThroughCloseTime);
  if (newest.closeTime <= target) return null;
  const span = Math.ceil((newest.closeTime - target) / intervalMs);
  return span + REPLAY_CONTEXT_BARS;
}

export function stepReplay(
  session: ReplaySession,
  candles: readonly Candle[],
  direction: -1 | 1,
): ReplaySession {
  const current = lastBarIndexAtOrBefore(
    candles,
    session.horizonCloseTime,
    session.availableThroughCloseTime,
  );
  if (current < 0) return { ...session, playing: false };
  const end = lastBarIndexAtOrBefore(
    candles,
    session.availableThroughCloseTime,
    session.availableThroughCloseTime,
  );
  const wanted = current + direction;
  if (wanted < 0 || wanted > end) return { ...session, playing: false };
  return {
    ...session,
    horizonCloseTime: candles[wanted]!.closeTime,
    playing: direction > 0 && wanted === end ? false : session.playing,
  };
}

export function replayTick(
  session: ReplaySession,
  candles: readonly Candle[],
): ReplaySession {
  return session.playing ? stepReplay(session, candles, 1) : session;
}

export function canStepReplay(
  session: ReplaySession,
  candles: readonly Candle[],
  direction: -1 | 1,
): boolean {
  const current = lastBarIndexAtOrBefore(
    candles,
    session.horizonCloseTime,
    session.availableThroughCloseTime,
  );
  if (current < 0) return false;
  if (direction < 0) return current > 0;
  const end = lastBarIndexAtOrBefore(
    candles,
    session.availableThroughCloseTime,
    session.availableThroughCloseTime,
  );
  return current < end;
}

export interface ReplayQuote {
  last: number;
  chg: number;
  chgPct: number;
}

/** The active symbol's only price readout while Replay is active. */
export function activeReplayQuote(
  candles: readonly Candle[],
  session: ReplaySession | null,
): ReplayQuote | null {
  if (!session) return null;
  const visible = replayCandles(candles, session);
  const last = visible[visible.length - 1];
  if (!last) return null;
  const basis = visible[visible.length - 2]?.close ?? last.open;
  const chg = last.close - basis;
  return {
    last: last.close,
    chg,
    chgPct: basis === 0 ? 0 : (chg / basis) * 100,
  };
}

/** Persisted drawings have no creation provenance, so Replay V1 never shows them. */
export function drawingsAtReplayHorizon(
  session: ReplaySession | null,
  persisted: readonly Drawing[],
  replaySessionDrawings: readonly Drawing[],
): Drawing[] {
  return (session ? replaySessionDrawings : persisted) as Drawing[];
}

/** Central guard used by every chart-originated live trading/alert affordance. */
export function liveActionsDisabled(session: ReplaySession | null): boolean {
  return session !== null;
}

export function replayDelayMs(speed: ReplaySpeed): number {
  return 1000 / speed;
}
