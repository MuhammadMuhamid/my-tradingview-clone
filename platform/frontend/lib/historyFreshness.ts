/**
 * Is the history we just loaded actually current, and what does it cost to say so?
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 *
 * `loadCandleWindow` accepted a stored window on COUNT alone: ten thousand
 * bars was ten thousand bars, whether the newest of them closed a minute ago
 * or last Tuesday. A machine that was asleep, a backend that was down, or a
 * pair nobody has charted since the last backfill therefore produced a chart
 * that looked complete, drew a plausible price, and was hours behind — until
 * the first live kline appended a bar across a visible gap. The toolbar's
 * Last and the price-alert prefill both read that stale close and presented
 * it as the market.
 *
 * Count is the wrong question. A window is current when its newest bar is the
 * newest bar the interval grid has produced, and that is a statement about
 * TIME. Everything here is arithmetic on the canonical resolution durations in
 * `lib/resolution` — there is no second duration table, and no constant that means
 * "recent" independently of the timeframe on screen.
 *
 * ── Which bar counts as "newest" ───────────────────────────────────────────
 *
 * Binance stamps a bar with the open time of its slot. At any instant one slot
 * is FORMING (`formingOpenTime`) and the one before it is the newest that has
 * CLOSED (`lastClosedOpenTime`). A stored window may legitimately end at
 * either: the backfill path stores closed bars, and the live path appends the
 * forming one. Both are current, so both must measure as zero bars behind.
 *
 * ── Why the threshold is two, and not one ──────────────────────────────────
 *
 * At the exact moment a slot closes, the bar that just ended has not yet been
 * fetched into our store by anyone — it is one slot behind for as long as it
 * takes a backfill to notice. Treating that as stale would fire a repair at
 * every single interval boundary, on every pane, forever: a refresh storm
 * dressed up as a correctness fix. One slot of tolerance absorbs the boundary;
 * two or more slots behind is a gap no boundary can explain.
 *
 * The audit proposed "older than two intervals" as a hypothesis. Checked
 * against the timestamp semantics above, it holds — with the tolerance
 * measured from the newest CLOSED slot rather than from wall clock, which is
 * what makes the exact-boundary case quiet rather than noisy.
 */
import type { Candle } from "./types";
import { resolutionMs, type Resolution } from "./resolution";

/** The open time of the slot that is forming at `now`. */
export function formingOpenTime(now: number, interval: Resolution): number {
  const step = resolutionMs(interval);
  return Math.floor(now / step) * step;
}

/** The open time of the newest slot that has fully closed at `now`. */
export function lastClosedOpenTime(now: number, interval: Resolution): number {
  return formingOpenTime(now, interval) - resolutionMs(interval);
}

/**
 * Slots the window is behind the grid.
 *
 * Zero when the newest stored bar is the newest closed slot OR the forming
 * one. Never negative: a bar stamped in the future is a clock disagreement,
 * not a reason to claim the window is ahead of the market.
 */
export function barsBehind(
  lastOpenTime: number | null, interval: Resolution, now: number
): number {
  if (lastOpenTime === null || !Number.isFinite(lastOpenTime)) return Number.POSITIVE_INFINITY;
  const behind = (lastClosedOpenTime(now, interval) - lastOpenTime) / resolutionMs(interval);
  return behind <= 0 ? 0 : Math.floor(behind);
}

/**
 * Slots a window may be behind before it is called stale.
 *
 * One, so that the moment of a bar close — when the newly closed bar is not
 * in anyone's store yet — is not a repair trigger. See the module header.
 */
export const TAIL_TOLERANCE_BARS = 1;

export interface TailFreshness {
  /** Newest stored bar's open time, or null for an empty window. */
  lastOpenTime: number | null;
  /** Whole slots between that bar and the newest closed slot. */
  behind: number;
  /** Whole slots missing between the newest bar and the one before it. */
  gap: number;
  /**
   * The window is behind the grid, or holds a hole at its tail. Either way a
   * tail repair is what closes it, and until one does the chart must say so.
   */
  stale: boolean;
}

/**
 * Slots missing between the newest bar and the one before it.
 *
 * ── Why the tail's own contiguity is part of freshness ────────────────────
 *
 * A chart left open across a sleep or an outage receives its first kline after
 * reconnection for the CURRENT slot. Appending it makes the newest bar current
 * — `barsBehind` becomes zero — while a multi-hour hole sits immediately
 * behind it. Measuring only the distance to the grid would report that window
 * as fresh, which is worse than reporting it as stale: the chart would be
 * visibly wrong and affirmatively claiming to be right.
 *
 * Only the LAST pair is examined. An older exchange-downtime gap is a fact
 * about history that a tail repair cannot fix and should not nag about; a hole
 * at the tail is exactly what a tail repair does fix.
 */
export function tailGapBars(candles: readonly Candle[], interval: Resolution): number {
  if (candles.length < 2) return 0;
  const last = candles[candles.length - 1]!.openTime;
  const previous = candles[candles.length - 2]!.openTime;
  const missing = (last - previous) / resolutionMs(interval) - 1;
  return Number.isFinite(missing) && missing > 0 ? Math.floor(missing) : 0;
}

export function inspectTail(
  candles: readonly Candle[], interval: Resolution, now: number
): TailFreshness {
  const lastOpenTime = candles.length > 0 ? candles[candles.length - 1]!.openTime : null;
  const behind = barsBehind(lastOpenTime, interval, now);
  const gap = tailGapBars(candles, interval);
  return {
    lastOpenTime, behind, gap,
    stale: behind > TAIL_TOLERANCE_BARS || gap > TAIL_TOLERANCE_BARS,
  };
}

/** True when this window's newest bar is too far behind the interval grid. */
export function isTailStale(
  candles: readonly Candle[], interval: Resolution, now: number
): boolean {
  return inspectTail(candles, interval, now).stale;
}

/**
 * The bounded range a tail repair should ask for.
 *
 * Deliberately NOT the whole window. A ten-thousand-bar 1m chart that is two
 * hours behind needs a hundred and twenty bars, not ten thousand; re-fetching
 * the window would turn a correctness repair into a multi-megabyte download
 * on every stale load.
 *
 * The lower bound is the newest stored bar itself rather than the slot after
 * it, so the repair overlaps by one bar and a boundary the store got wrong is
 * overwritten rather than stitched around. `maxBars` caps the request for the
 * pathological case — an empty or ancient window — at the window's own depth,
 * because beyond that the thin-history backfill path is the right repair.
 */
export function tailRepairRange(
  lastOpenTime: number | null, interval: Resolution, now: number, maxBars: number
): { from: number; to: number } {
  const step = resolutionMs(interval);
  const floor = formingOpenTime(now, interval) - Math.max(1, Math.ceil(maxBars)) * step;
  const from = lastOpenTime === null ? floor : Math.max(floor, lastOpenTime);
  return { from, to: now };
}

/**
 * Splice a freshly fetched tail onto a held window.
 *
 * Pure, and the only place the two are joined. Bars at or after the tail's
 * first open time are dropped from the held side — the tail is the newer
 * authority for every slot it covers, including the one they overlap on — and
 * the result is capped to the window depth so a repair cannot grow the series
 * past what the pane asked for.
 *
 * A tail that is empty, or that is older than what is already held, changes
 * nothing: an upstream that answered with nothing useful must not be able to
 * truncate a good window.
 */
export function spliceTail(
  held: readonly Candle[], tail: readonly Candle[], maxBars: number
): Candle[] {
  if (tail.length === 0) return held as Candle[];
  const heldNewest = held.length > 0 ? held[held.length - 1]!.openTime : null;
  const tailNewest = tail[tail.length - 1]!.openTime;
  // A tail that ends no later than what is already held answers nothing this
  // window did not have, and splicing it would drop every bar after it.
  if (heldNewest !== null && tailNewest < heldNewest) return held as Candle[];
  const boundary = tail[0]!.openTime;
  const merged = [...held.filter((c) => c.openTime < boundary), ...tail];
  return merged.length > maxBars ? merged.slice(-maxBars) : merged;
}

/**
 * One repair attempt per window per cooldown.
 *
 * A pair that genuinely has no newer bars — delisted, halted, or simply not
 * traded — is stale on every load and would ask for a repair on every load.
 * The cooldown makes the repair a bounded event rather than a loop, and is
 * keyed by the window so a stale BTCUSDT 1m cannot suppress a stale ETHUSDT
 * 1h. Cleared by `resetTailRepairs` for the tests.
 */
const REPAIR_COOLDOWN_MS = 60_000;
const repairAttempts = new Map<string, number>();

export function claimTailRepair(
  key: string, now: number,
  options: { cooldownMs?: number; force?: boolean } = {}
): boolean {
  const cooldownMs = options.cooldownMs ?? REPAIR_COOLDOWN_MS;
  const previous = repairAttempts.get(key);
  // An explicit reload is the user saying "try again now". The cooldown exists
  // to stop an automatic path looping, not to make a deliberate refresh a
  // no-op after one failed attempt.
  if (!options.force && previous !== undefined && now - previous < cooldownMs) return false;
  // Delete before set so insertion order is recency order and the eviction
  // below drops the least recently claimed key rather than the hottest one.
  repairAttempts.delete(key);
  repairAttempts.set(key, now);
  // Bounded: a session that walks many instruments must not grow this forever.
  while (repairAttempts.size > 64) {
    const oldest = repairAttempts.keys().next();
    if (oldest.done) break;
    repairAttempts.delete(oldest.value);
  }
  return true;
}

/**
 * Forget one window's claim, so the next load may repair it immediately.
 *
 * This is what an explicit reload does. The cooldown exists to stop an
 * automatic path looping; it is not there to make a deliberate refresh a
 * no-op after one failed attempt.
 */
export function releaseTailRepair(key: string): void {
  repairAttempts.delete(key);
}

export function resetTailRepairs(): void {
  repairAttempts.clear();
}
