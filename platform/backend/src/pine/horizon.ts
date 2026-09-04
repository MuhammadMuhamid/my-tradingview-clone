import type { Candle } from "../types/market";

/**
 * Pine and every request.security feed must be cut on completed-bar close,
 * not repository open-time bounds. This leaves BE-08's inclusive close-time
 * alignment unchanged while preventing a source bar that closes after T from
 * entering a replay run.
 */
export function completedAtOrBefore<T extends Pick<Candle, "closeTime">>(
  candles: readonly T[],
  horizonCloseTime: number,
): T[] {
  return candles.filter((candle) => candle.closeTime <= horizonCloseTime);
}
