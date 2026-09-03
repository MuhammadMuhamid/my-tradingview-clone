/**
 * Which timeframes are one click away, and which are one click behind a menu.
 *
 * ── Why this is data rather than a literal in the toolbar ───────────────────
 *
 * The backend serves eleven intervals (`INTERVAL_VALUES`). The toolbar used to
 * hard-code six of them and the pane header hard-coded the same six again, so
 * the other five — 3m, 30m, 2h, 6h, 12h — were reachable only by editing
 * persisted state by hand, despite being fully supported by the candle store,
 * the alert evaluator and the Pine runner. That is not a design decision; it is
 * a list that fell out of date twice.
 *
 * The split lives here so the quick strip and the overflow are provably
 * complementary: `QUICK_INTERVALS ∪ MORE_INTERVALS === INTERVAL_VALUES`, and no
 * value can appear in either list unless the backend already serves it. Nothing
 * here invents an interval or changes how a bar is aggregated — it only decides
 * what the strip shows first.
 */
import { INTERVAL_VALUES, type Interval } from "./types";

/**
 * The intervals kept directly on the toolbar.
 *
 * These are the six the workspace has always exposed, which is deliberate: the
 * point of this module is to stop hiding the other five, not to relitigate
 * which ones a scalper reaches for.
 */
export const QUICK_INTERVALS: readonly Interval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

/** Everything else the backend serves, in the backend's own order. */
export const MORE_INTERVALS: readonly Interval[] =
  INTERVAL_VALUES.filter((i) => !QUICK_INTERVALS.includes(i));

export function isQuickInterval(interval: Interval): boolean {
  return QUICK_INTERVALS.includes(interval);
}

export interface TimeframeStrip {
  /** Rendered as individual buttons. */
  quick: readonly Interval[];
  /** Rendered inside the overflow popover. */
  more: readonly Interval[];
  /**
   * What the overflow button says. When the chart is on an uncommon interval
   * the button names it, so the current timeframe is never invisible — a strip
   * with nothing pressed and a "More" button beside it reads as "no timeframe".
   */
  moreLabel: string;
  /** The current interval lives in the overflow list. */
  moreActive: boolean;
}

export function timeframeStrip(current: Interval): TimeframeStrip {
  const moreActive = MORE_INTERVALS.includes(current);
  return {
    quick: QUICK_INTERVALS,
    more: MORE_INTERVALS,
    moreLabel: moreActive ? current : "More",
    moreActive,
  };
}
