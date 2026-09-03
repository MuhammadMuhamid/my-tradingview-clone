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
