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
import type { Resolution } from "./resolution";

export interface DatasetIdentity {
  symbol: string;
  /** The resolution the bars ARE — `45m`, not the `15m` they were folded from. */
  interval: Resolution;
}

/** The identity two things must share before one may mutate the other. */
export function datasetKey(dataset: DatasetIdentity): string {
  return `${dataset.symbol.toUpperCase()}|${dataset.interval}`;
}

export interface LiveTickLike extends DatasetIdentity {
  openTime: number;
}

/**
 * `stale` is the third answer, and it is not the same as `hold`.
 *
 * ── TVP8 round two ────────────────────────────────────────────────────────
 *
 * `hold` means "not this chart's dataset, keep it for when that dataset
 * arrives". `stale` means "this chart's dataset, but OLDER than what is
 * already drawn" — which lightweight-charts does not tolerate:
 *
 *   Error: Cannot update oldest data, last time=… new time=…
 *
 * That throw is not caught by the series call, so it escapes the tick handler
 * and reaches the route's error boundary: the entire chart page is replaced by
 * "This page stopped working" because one websocket frame arrived out of
 * order. Observed live on the production build.
 *
 * A late or duplicated frame is a fact of a real socket — a reconnect replays,
 * a slow frame overtakes, a venue relabels — and the only correct response is
 * to drop it. Holding it would be wrong too: it is not waiting for anything.
 */
export type TickDecision = "apply" | "hold" | "stale";

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
  /** The newest bar this chart has drawn, so an older frame can be refused. */
  private newest: number | null = null;
  private staleCount = 0;

  /** The dataset key the chart currently holds, or null before any. */
  get datasetKey(): string | null { return this.held; }

  /** Ticks held back because they belonged to a dataset not yet on screen. */
  get heldTicks(): number { return this.heldCount; }

  /** Ticks dropped for arriving behind the bar already drawn. */
  get staleTicks(): number { return this.staleCount; }

  decide(tick: T): TickDecision {
    if (this.held !== null && datasetKey(tick) === this.held) {
      /*
       * EQUAL is not stale. A tick for the bar currently forming arrives many
       * times a second with the same `openTime` and a moving close, and that
       * is the ordinary case — refusing it would freeze the live bar.
       */
      if (this.newest !== null && tick.openTime < this.newest) {
        this.staleCount += 1;
        return "stale";
      }
      this.newest = this.newest === null ? tick.openTime : Math.max(this.newest, tick.openTime);
      return "apply";
    }
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
    const changed = this.held !== datasetKey(dataset);
    this.held = datasetKey(dataset);
    /*
     * The watermark comes from the HISTORY, not from what was applied before.
     * A different dataset's newest bar says nothing about this one's, and
     * carrying it across a symbol change would refuse every tick of an
     * instrument whose bars happen to be older.
     */
    if (changed || lastOpenTime === null) this.newest = lastOpenTime;
    else this.newest = Math.max(this.newest ?? lastOpenTime, lastOpenTime);
    const pending = this.pending;
    this.pending = null;
    if (!pending || datasetKey(pending) !== this.held) return null;
    if (lastOpenTime !== null && pending.openTime < lastOpenTime) return null;
    this.newest = this.newest === null ? pending.openTime : Math.max(this.newest, pending.openTime);
    return pending;
  }

  /** Forget everything — the chart was torn down. */
  reset(): void {
    this.held = null;
    this.pending = null;
    this.newest = null;
  }
}
