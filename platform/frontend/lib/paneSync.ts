"use client";

/**
 * What panes follow from one another, mirroring TradingView's "Sync in layout"
 * menu.
 *
 * ── Every toggle here does something ───────────────────────────────────────
 *
 * That is worth stating because it was not true. In the two-pane design, four
 * of these five were dead: `symbol` was never read at all (the second pane was
 * handed pane 1's symbol unconditionally, so turning it off changed nothing),
 * and `crosshair`, `time` and `dateRange` were written into state tagged
 * `pane: 2` that only a `pane === 1` reader consumed — a reader that could
 * never fire, because pane 1 was never given the emitting props. The menu
 * showed five switches and one of them worked.
 *
 * The helpers below are the whole mechanism now, and they take pane ids rather
 * than the literals 1 and 2, so a signal from the ninth pane reaches the other
 * fifteen the same way the second one reached the first.
 */

export interface SyncOptions {
  /** A symbol change in one pane applies to the others. */
  symbol: boolean;
  /** A timeframe change in one pane applies to the others. */
  interval: boolean;
  /** Crosshair position is mirrored across panes. */
  crosshair: boolean;
  /** Panes track the same right edge, each keeping its own zoom. */
  time: boolean;
  /** Panes show the exact same visible span. */
  dateRange: boolean;
}

/**
 * Symbol and crosshair on, the rest off — matching TradingView, and the only
 * combination that is useful without first being configured: reading several
 * resolutions of one instrument at the same instant.
 */
export const DEFAULT_SYNC: SyncOptions = {
  symbol: true,
  interval: false,
  crosshair: true,
  time: false,
  dateRange: false,
};

export const SYNC_LABELS: { id: keyof SyncOptions; label: string; help: string }[] = [
  { id: "symbol", label: "Symbol", help: "Every pane shows the same instrument" },
  { id: "interval", label: "Interval", help: "Every pane uses the same timeframe" },
  { id: "crosshair", label: "Crosshair", help: "The crosshair position is mirrored" },
  { id: "time", label: "Time", help: "Panes stay on the same moment, each keeping its own zoom" },
  { id: "dateRange", label: "Date range", help: "Every pane shows the same visible span" },
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

// ── view mirroring, by pane id ─────────────────────────────────────────────

/** Where the pointer is, and which pane it is in. */
export interface CrosshairSignal {
  paneId: string;
  /** Bar time in seconds, or null when the pointer left the plot. */
  time: number | null;
}

/** A visible span, and the pane that produced it. */
export interface RangeSignal {
  paneId: string;
  from: number;
  to: number;
}

/**
 * The crosshair time a pane should draw, or null for none.
 *
 * A pane never receives its own signal back. That single rule is what makes
 * mirroring safe for any number of panes: the source is excluded at the point
 * of read, so there is no echo to damp and no oscillation to break.
 */
export function crosshairForPane(
  signal: CrosshairSignal | null, paneId: string, sync: SyncOptions
): number | null {
  if (!sync.crosshair || !signal || signal.paneId === paneId) return null;
  return signal.time;
}

/**
 * The exact span a pane should adopt, or null.
 *
 * `dateRange` wins over `time`: showing the same span already implies sharing
 * the right edge, and applying both would fight over the zoom.
 */
export function visibleRangeForPane(
  signal: RangeSignal | null, paneId: string, sync: SyncOptions
): { from: number; to: number } | null {
  if (!sync.dateRange || !signal || signal.paneId === paneId) return null;
  return { from: signal.from, to: signal.to };
}

/** The right edge a pane should track while keeping its own zoom, or null. */
export function followEdgeForPane(
  signal: RangeSignal | null, paneId: string, sync: SyncOptions
): number | null {
  if (!sync.time || sync.dateRange || !signal || signal.paneId === paneId) return null;
  return signal.to;
}

/** Whether any pane needs to publish its crosshair at all. */
export const crosshairSyncActive = (sync: SyncOptions): boolean => sync.crosshair;

/** Whether any pane needs to publish its visible range at all. */
export const rangeSyncActive = (sync: SyncOptions): boolean => sync.time || sync.dateRange;

/**
 * The bar in `openTimesSec` that was forming at `timeSec` — the newest one at
 * or before it.
 *
 * This is what makes crosshair sync work across resolutions. Hovering 14:07 on
 * a 15m chart must light up the 14:00 bar of a 1h chart, so an exact time
 * match is the exception rather than the rule. Returns -1 when the time
 * predates every loaded bar, which is a "draw nothing", not a clamp to bar 0 —
 * and that is also how panes on different symbols degrade: a pane with no bar
 * at that moment simply draws no crosshair instead of guessing one.
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

/**
 * The same search over the candles themselves.
 *
 * The array-of-times form allocated a fresh `number[]` of every loaded bar on
 * each crosshair event — ten thousand numbers per mouse move, per pane, to
 * perform a binary search that only ever reads a handful of them.
 */
export function snapToBarIndexBy<T>(
  bars: readonly T[], timeSec: number, timeOf: (bar: T) => number
): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeOf(bars[mid]!) <= timeSec) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}

/**
 * Whether a visible range is different enough from the last one published to
 * be worth publishing again.
 *
 * Mirroring is already loop-free by construction — `visibleRangeForPane` never
 * hands a pane its own signal back. This is the second, quieter guard: two
 * panes on different resolutions do not land on byte-identical spans, so a
 * range applied to pane B can come back out of the library a fraction of a
 * second different, be republished, and set the pair oscillating around a
 * fixed point instead of settling on it.
 *
 * A bar boundary is the natural resolution of a chart viewport, so half a
 * second is below anything a user can see and above the float noise the
 * library's own coordinate round-trip produces.
 */
export const RANGE_EPSILON_SEC = 0.5;

export function rangeChanged(
  previous: { from: number; to: number } | null,
  next: { from: number; to: number },
  epsilonSec: number = RANGE_EPSILON_SEC
): boolean {
  if (!previous) return true;
  return Math.abs(previous.from - next.from) > epsilonSec
    || Math.abs(previous.to - next.to) > epsilonSec;
}
