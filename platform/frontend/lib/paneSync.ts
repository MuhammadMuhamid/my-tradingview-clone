"use client";

/**
 * What the second chart follows from the first, mirroring TradingView's
 * "Sync in layout" menu.
 *
 * Each is independent on purpose: the common split is the SAME symbol at a
 * different resolution, so `interval` is normally off while `symbol` is on.
 */
export interface SyncOptions {
  /** Split pane adopts pane 1's symbol. */
  symbol: boolean;
  /** Split pane adopts pane 1's timeframe. */
  interval: boolean;
  /** Crosshair position mirrors between panes. */
  crosshair: boolean;
  /** Right edge tracks the other pane, each keeping its own zoom. */
  time: boolean;
  /** Both panes show the exact same visible span. */
  dateRange: boolean;
}

/**
 * Crosshair on by default and the rest off — matching TradingView, and the
 * only combination that is useful without first being configured: reading two
 * resolutions of one symbol at the same instant.
 */
export const DEFAULT_SYNC: SyncOptions = {
  symbol: true,
  interval: false,
  crosshair: true,
  time: false,
  dateRange: false,
};

export const SYNC_LABELS: { id: keyof SyncOptions; label: string; help: string }[] = [
  { id: "symbol", label: "Symbol", help: "Both panes show the same instrument" },
  { id: "interval", label: "Interval", help: "Both panes use the same timeframe" },
  { id: "crosshair", label: "Crosshair", help: "The crosshair position is mirrored" },
  { id: "time", label: "Time", help: "Panes stay on the same moment, each keeping its own zoom" },
  { id: "dateRange", label: "Date range", help: "Both panes show the same visible span" },
];

const KEY = "tv.paneSync.v1";

export function loadSync(): SyncOptions {
  if (typeof window === "undefined") return DEFAULT_SYNC;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SYNC;
    // Merge onto the defaults so a stored object written by an older build
    // gains any option added since, rather than reading as `undefined`.
    return { ...DEFAULT_SYNC, ...(JSON.parse(raw) as Partial<SyncOptions>) };
  } catch {
    return DEFAULT_SYNC;
  }
}

export function saveSync(value: SyncOptions): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch { /* quota — the panes still sync for this session */ }
}

/**
 * The bar in `openTimesSec` that was forming at `timeSec` — the newest one at
 * or before it.
 *
 * This is what makes crosshair sync work across resolutions. Hovering 14:07 on
 * a 15m chart must light up the 14:00 bar of a 1h chart, so an exact time
 * match is the exception rather than the rule. Returns -1 when the time
 * predates every loaded bar, which is a "draw nothing", not a clamp to bar 0.
 *
 * `openTimesSec` must be ascending; binary search assumes it.
 */
export function snapToBarIndex(openTimesSec: number[], timeSec: number): number {
  let lo = 0;
  let hi = openTimesSec.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (openTimesSec[mid]! <= timeSec) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}
