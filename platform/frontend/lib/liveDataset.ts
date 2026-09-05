/**
 * Which dataset a live tick may touch.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * A pane that switches from BTCUSDT to SOLUSDT keeps BTC's bars on screen
 * while SOL's 10,000-bar history loads (deliberately: a blank chart between
 * two symbols is worse). The kline feed re-subscribes to SOL at once, and
 * SOL's first frame arrives within a couple of seconds — before the history.
 * The tick handler used to look the bar's open time up in whatever candles
 * it held, find BTC's forming bar at the same minute, and draw SOL's price
 * as the last bar of BTC's series. Autoscale then spanned both price regimes
 * and the new bar sat at the very top or bottom of the pane until the
 * history arrived and replaced everything.
 *
 * The invariant, stated once: a tick is applied only to the dataset it
 * belongs to — same symbol, same interval — and never to the bars of another.
 * While the matching history is still loading the tick is held, and applied
 * the moment that history is on screen, so no update is lost either.
 *
 * Pure, so `tests/candleDataset.test.ts` can drive the exact sequence
 * (old dataset → new request → new tick → history arrives) without a chart.
 */
import type { Interval } from "./types";

export interface DatasetIdentity {
  symbol: string;
  interval: Interval;
}

/** The identity two things must share before one may mutate the other. */
export function datasetKey(dataset: DatasetIdentity): string {
  return `${dataset.symbol.toUpperCase()}|${dataset.interval}`;
}

export interface LiveTickLike extends DatasetIdentity {
  openTime: number;
}

export type TickDecision = "apply" | "hold";

/**
 * Decides, for one chart, whether a tick may be applied to the bars it holds.
 *
 * `adopt()` is called whenever the chart's dataset changes (a new symbol's
 * history landed, a reload finished). `decide()` is called per tick. A tick
 * for a dataset the chart does not hold is remembered — only the newest —
 * and handed back by `adopt()` when its dataset arrives, provided it is not
 * older than that dataset's last bar.
 */
export class LiveTickGate<T extends LiveTickLike = LiveTickLike> {
  private held: string | null = null;
  private pending: T | null = null;
  private heldCount = 0;

  /** The dataset key the chart currently holds, or null before any. */
  get datasetKey(): string | null { return this.held; }

  /** Ticks held back because they belonged to a dataset not yet on screen. */
  get heldTicks(): number { return this.heldCount; }

  decide(tick: T): TickDecision {
    if (this.held !== null && datasetKey(tick) === this.held) return "apply";
    // Not ours. Keep the newest so nothing is lost when its dataset arrives.
    this.pending = tick;
    this.heldCount += 1;
    return "hold";
  }

  /**
   * The chart now holds `dataset`, whose newest bar opens at `lastOpenTime`
   * (or null when it holds no bars). Returns the held tick to apply, if it
   * belongs to this dataset and is not older than its last bar.
   */
  adopt(dataset: DatasetIdentity, lastOpenTime: number | null): T | null {
    this.held = datasetKey(dataset);
    const pending = this.pending;
    this.pending = null;
    if (!pending || datasetKey(pending) !== this.held) return null;
    if (lastOpenTime !== null && pending.openTime < lastOpenTime) return null;
    return pending;
  }

  /** Forget everything — the chart was torn down. */
  reset(): void {
    this.held = null;
    this.pending = null;
  }
}
