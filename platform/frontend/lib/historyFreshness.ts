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
 * TIME. Everything here is arithmetic on the canonical interval durations in
 * `lib/types` — there is no second duration table, and no constant that means
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
import { INTERVAL_MS, type Candle, type Interval } from "./types";

/** The open time of the slot that is forming at `now`. */
export function formingOpenTime(now: number, interval: Interval): number {
  const step = INTERVAL_MS[interval];
  return Math.floor(now / step) * step;
}

/** The open time of the newest slot that has fully closed at `now`. */
export function lastClosedOpenTime(now: number, interval: Interval): number {
  return formingOpenTime(now, interval) - INTERVAL_MS[interval];
}

/**
 * Slots the window is behind the grid.
 *
 * Zero when the newest stored bar is the newest closed slot OR the forming
 * one. Never negative: a bar stamped in the future is a clock disagreement,
 * not a reason to claim the window is ahead of the market.
 */
export function barsBehind(
  lastOpenTime: number | null, interval: Interval, now: number
): number {
  if (lastOpenTime === null || !Number.isFinite(lastOpenTime)) return Number.POSITIVE_INFINITY;
  const behind = (lastClosedOpenTime(now, interval) - lastOpenTime) / INTERVAL_MS[interval];
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
  /** `behind` exceeds the boundary tolerance: the tail needs repairing. */
  stale: boolean;
}

export function inspectTail(
  candles: readonly Candle[], interval: Interval, now: number
): TailFreshness {
  const lastOpenTime = candles.length > 0 ? candles[candles.length - 1]!.openTime : null;
  const behind = barsBehind(lastOpenTime, interval, now);
  return { lastOpenTime, behind, stale: behind > TAIL_TOLERANCE_BARS };
}

/** True when this window's newest bar is too far behind the interval grid. */
export function isTailStale(
  candles: readonly Candle[], interval: Interval, now: number
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
  lastOpenTime: number | null, interval: Interval, now: number, maxBars: number
): { from: number; to: number } {
  const step = INTERVAL_MS[interval];
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
  key: string, now: number, cooldownMs = REPAIR_COOLDOWN_MS
): boolean {
  const previous = repairAttempts.get(key);
  if (previous !== undefined && now - previous < cooldownMs) return false;
  repairAttempts.set(key, now);
  // Bounded: a session that walks many instruments must not grow this forever.
  if (repairAttempts.size > 64) {
    const oldest = repairAttempts.keys().next();
    if (!oldest.done) repairAttempts.delete(oldest.value);
  }
  return true;
}

export function resetTailRepairs(): void {
  repairAttempts.clear();
}
