/**
 * What time the chart is showing, and whose time it is.
 *
 * ── The one fact this module states ────────────────────────────────────────
 *
 * lightweight-charts formats every axis tick and every crosshair label from
 * the UTC fields of the timestamp it is given (`getUTCHours`, `getUTCDate`, …
 * in its own tick-mark formatter). Binance klines are stamped in UTC. So the
 * chart's time axis has always been UTC, and nothing here changes that — it
 * only says so out loud, because the rest of the product formats timestamps
 * with `toLocaleString`, i.e. in the reader's own zone, and a user comparing
 * a crosshair against a trade row has no way to know the two are in different
 * zones unless one of them is labelled.
 *
 * This is deliberately NOT a timezone system. There is no setting, no
 * preference and no conversion: there is one authority — the exchange's UTC
 * bar timestamps — and a label that names it. Choosing a display zone is a
 * product decision this wave was told not to invent.
 */

export const CHART_TIME_ZONE = "UTC";

export const CHART_TIME_ZONE_NOTE =
  "Chart times are UTC — the exchange's own bar timestamps.";

const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** `HH:MM:SS`, in UTC. */
export function fmtChartClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** `YYYY-MM-DD`, in UTC. */
export function fmtChartDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "————-——";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * A bar's time, at the resolution the timeframe actually carries.
 *
 * A daily bar printed as `2026-09-03 00:00` invites the reader to believe the
 * zero means something. Intervals of a day or more therefore print the date
 * alone, and everything shorter prints the minute — seconds are never part of
 * a bar open time on any timeframe this product offers.
 */
export function fmtChartBarTime(ms: number, intervalMs: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const date = fmtChartDate(ms);
  if (intervalMs >= 86_400_000) return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * `Mon 29` rather than `29` on a day-boundary axis label (R6 SC-5(d)).
 *
 * Lives here rather than in `CandleChart` because the visible time axis is not
 * always the price chart's: with a study pane on screen the axis is drawn once,
 * under the LOWEST pane, by that pane's own chart. Two charts, one rule.
 *
 * Only the day tick is touched — every other weight returns `null`, which is
 * lightweight-charts' own "you format it", so `localization.dateFormat` and the
 * 12/24-hour choice stay authoritative over the rest of the axis. Fixed English
 * abbreviations, not `toLocaleDateString`: this axis is UTC throughout, the
 * reference writes them this way, and a locale-dependent width would make the
 * tick spacing the library computed for one machine wrong on another.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `TickMarkType.DayOfMonth` in lightweight-charts 4.2. */
const DAY_OF_MONTH_TICK = 2;

export function dayOfWeekTickFormatter(time: unknown, tickMarkType: number): string | null {
  if (tickMarkType !== DAY_OF_MONTH_TICK || typeof time !== "number") return null;
  const d = new Date(time * 1000);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}
