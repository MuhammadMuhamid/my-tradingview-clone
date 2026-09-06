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
 */
export function reconcileReplay(
  session: ReplaySession,
  candles: readonly Candle[],
): ReplaySession {
  const selected = lastBarIndexAtOrBefore(
    candles,
    session.horizonCloseTime,
    session.availableThroughCloseTime,
  );
  return selected < 0
    ? { ...session, playing: false }
    : {
        ...session,
        horizonCloseTime: candles[selected]!.closeTime,
        playing: false,
      };
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
