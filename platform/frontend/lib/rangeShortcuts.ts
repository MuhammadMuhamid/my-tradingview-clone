/**
 * The bottom range bar: "show me the last month", not "switch to monthly bars".
 *
 * ── The distinction this file exists to hold ───────────────────────────────
 *
 * `1D` here is a VISIBLE RANGE of one day. It never touches the timeframe: a
 * 5-minute chart asked for `1D` stays a 5-minute chart and shows one day of
 * five-minute bars. Nothing in this module returns an interval, so the
 * confusion cannot be expressed.
 *
 * ── Why availability is computed rather than listed ────────────────────────
 *
 * A pane loads a fixed number of bars (10,000 by default). At 1-minute that is
 * about seven days, so `1Y` cannot be honoured on it — the chart would scroll
 * to a window that contains no data and present an empty plot as if it were a
 * year of quiet market. And at the daily timeframe `1D` is a single bar, which
 * is a range you cannot read.
 *
 * So the offered set is derived from the history the pane actually holds:
 *
 *   offered  ⇔  the loaded window spans at least the requested range
 *           AND the requested range contains at least a few bars
 *
 * Both halves are the same rule from opposite ends — do not offer a range the
 * data cannot fill, and do not offer one the timeframe cannot resolve.
 *
 * ── Replay ─────────────────────────────────────────────────────────────────
 *
 * The caller passes the bars it is actually drawing, which under Bar Replay
 * are already clipped to the horizon. Every window this module returns ends at
 * the newest of those bars, so a range shortcut cannot reveal a bar replay is
 * hiding and cannot ask for data after the horizon. That is a property of
 * taking the anchor from the input rather than from the clock, and the tests
 * pin it.
 */

export type RangeShortcutId = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "ALL";

export interface RangeShortcut {
  id: RangeShortcutId;
  label: string;
  hint: string;
  /**
   * The span in seconds, or null when the start is computed some other way
   * (`YTD` from the calendar, `ALL` from the loaded history).
   */
  spanSec: number | null;
}

const DAY = 86_400;

/**
 * Calendar spans are the conventional approximations — a month is 30 days and
 * a year is 365. A range button is a viewport shortcut, not an accounting
 * period, and anchoring "3M" to real month boundaries would make the same
 * button show a different amount of chart depending on the date.
 */
export const RANGE_SHORTCUTS: readonly RangeShortcut[] = [
  { id: "1D", label: "1D", hint: "The last day of bars", spanSec: DAY },
  { id: "5D", label: "5D", hint: "The last five days of bars", spanSec: 5 * DAY },
  { id: "1M", label: "1M", hint: "The last 30 days of bars", spanSec: 30 * DAY },
  { id: "3M", label: "3M", hint: "The last 90 days of bars", spanSec: 90 * DAY },
  { id: "6M", label: "6M", hint: "The last 180 days of bars", spanSec: 180 * DAY },
  { id: "YTD", label: "YTD", hint: "From the start of this year (UTC)", spanSec: null },
  { id: "1Y", label: "1Y", hint: "The last 365 days of bars", spanSec: 365 * DAY },
  { id: "ALL", label: "All", hint: "Every bar this pane has loaded", spanSec: null },
];

export function rangeShortcut(id: RangeShortcutId): RangeShortcut | null {
  return RANGE_SHORTCUTS.find((r) => r.id === id) ?? null;
}

/** The bars a pane is drawing, reduced to what a range decision needs. */
export interface LoadedWindow {
  /** Open time of the oldest loaded bar, in SECONDS. */
  firstOpenSec: number;
  /** Open time of the newest loaded bar, in SECONDS — the replay horizon under replay. */
  lastOpenSec: number;
  /** The pane's timeframe in milliseconds, so a range can be counted in bars. */
  intervalMs: number;
}

/**
 * Fewer bars than this and the "range" is a handful of candles stretched over
 * the whole width, which is not a view of a day — it is a misleading one.
 */
export const MIN_BARS_IN_RANGE = 4;

/** Midnight on 1 January of the year containing `sec`, in UTC seconds. */
export function startOfYearSec(sec: number): number {
  const d = new Date(sec * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / 1000);
}

/** True when the loaded window can honour this shortcut truthfully. */
export function rangeShortcutAvailable(
  shortcut: RangeShortcut, window_: LoadedWindow
): boolean {
  const { firstOpenSec, lastOpenSec, intervalMs } = window_;
  if (!Number.isFinite(firstOpenSec) || !Number.isFinite(lastOpenSec)) return false;
  const loaded = lastOpenSec - firstOpenSec;
  if (loaded <= 0) return false;
  if (shortcut.id === "ALL") return true;

  const wanted = shortcut.id === "YTD"
    ? lastOpenSec - startOfYearSec(lastOpenSec)
    : shortcut.spanSec ?? 0;
  if (wanted <= 0) return false;
  // Do not offer a window the loaded history cannot fill…
  if (loaded < wanted) return false;
  // …nor one this timeframe resolves into a few unreadable bars.
  const barSec = intervalMs / 1000;
  if (!Number.isFinite(barSec) || barSec <= 0) return false;
  return wanted / barSec >= MIN_BARS_IN_RANGE;
}

/** The shortcuts this pane may offer, in menu order. */
export function availableRangeShortcuts(window_: LoadedWindow): RangeShortcut[] {
  return RANGE_SHORTCUTS.filter((shortcut) => rangeShortcutAvailable(shortcut, window_));
}

/**
 * The visible window a shortcut resolves to, or null when it cannot be
 * honoured.
 *
 * `to` is always the newest bar the pane holds — never `Date.now()`, so a
 * replay-clipped pane cannot be scrolled past its horizon and a stale pane
 * cannot be scrolled into a gap it has no data for. `from` is clamped to the
 * oldest loaded bar, so the window is always one the chart can actually draw.
 */
export function resolveRangeShortcut(
  id: RangeShortcutId, window_: LoadedWindow
): { from: number; to: number } | null {
  const shortcut = rangeShortcut(id);
  if (!shortcut || !rangeShortcutAvailable(shortcut, window_)) return null;
  const to = window_.lastOpenSec;
  const start = shortcut.id === "ALL" ? window_.firstOpenSec
    : shortcut.id === "YTD" ? startOfYearSec(to)
    : to - (shortcut.spanSec ?? 0);
  const from = Math.max(window_.firstOpenSec, start);
  return from < to ? { from, to } : null;
}

/**
 * The loaded window for a bar series, or null when there is not enough of one.
 *
 * Takes the bars themselves so callers cannot accidentally describe a window
 * that is wider than the data — which is the whole failure mode this module is
 * here to prevent.
 */
export function loadedWindow(
  bars: readonly { openTime: number }[], intervalMs: number
): LoadedWindow | null {
  if (bars.length < 2) return null;
  const firstOpenSec = Math.floor(bars[0]!.openTime / 1000);
  const lastOpenSec = Math.floor(bars[bars.length - 1]!.openTime / 1000);
  if (!(lastOpenSec > firstOpenSec)) return null;
  return { firstOpenSec, lastOpenSec, intervalMs };
}

/**
 * Whether a viewport is still, in substance, the one a shortcut asked for.
 *
 * `setVisibleRange` is a request, not a command: lightweight-charts snaps the
 * span to whole bars and to its own bar spacing, so the range that comes back
 * out of the change event is never byte-identical to the one that went in. A
 * strict comparison would therefore clear the pressed state of the button the
 * user had just pressed, on the very event that button caused.
 *
 * The tolerance is proportional because the error is: a few bars out of a day
 * and a few bars out of a year are the same amount of wrong to a reader, and a
 * fixed number of seconds would be neither on one of them.
 */
export function sameViewport(
  target: { from: number; to: number } | null,
  actual: { from: number; to: number },
  tolerance = 0.05
): boolean {
  if (!target) return false;
  const span = target.to - target.from;
  if (!(span > 0)) return false;
  const slack = span * tolerance;
  return Math.abs(target.from - actual.from) <= slack
    && Math.abs(target.to - actual.to) <= slack;
}
