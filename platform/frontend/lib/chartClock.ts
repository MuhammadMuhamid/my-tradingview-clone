/**
 * What time the chart is showing, and whose time it is.
 *
 * ── The one fact this module states ────────────────────────────────────────
 *
 * Binance klines are stamped in UTC and stay stamped in UTC. A display-zone
 * setting changes only how the immutable instant is labelled: clock,
 * crosshair, legend and every time-axis weight must agree. lightweight-charts
 * otherwise formats axis ticks from UTC fields internally, so a non-UTC zone
 * needs an explicit formatter for intraday ticks as well as day boundaries.
 */

import type { ChartTimeZone } from "./chartSettings";

export const CHART_TIME_ZONE = "UTC";

export const CHART_TIME_ZONES: readonly { value: ChartTimeZone; label: string; short: string }[] = [
  { value: "UTC", label: "UTC", short: "UTC" },
  { value: "America/New_York", label: "(UTC−5) New York", short: "New York" },
  { value: "Europe/London", label: "(UTC+0) London", short: "London" },
  { value: "Asia/Karachi", label: "(UTC+5) Karachi", short: "Karachi" },
  { value: "Asia/Tokyo", label: "(UTC+9) Tokyo", short: "Tokyo" },
];

export function chartTimeZoneLabel(zone: ChartTimeZone): string {
  return CHART_TIME_ZONES.find((item) => item.value === zone)?.short ?? zone;
}

export const CHART_TIME_ZONE_NOTE =
  "Chart times are UTC — the exchange's own bar timestamps.";

const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** `HH:MM:SS`, in UTC. */
export function fmtChartClock(ms: number, timeZone: ChartTimeZone = "UTC"): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  if (timeZone === "UTC") {
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(d);
}

/** `YYYY-MM-DD`, in the chart's display zone. */
export function fmtChartDate(ms: number, timeZone: ChartTimeZone = "UTC"): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "————-——";
  if (timeZone !== "UTC") {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const value = (kind: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === kind)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  }
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
export function fmtChartBarTime(
  ms: number, intervalMs: number, timeZone: ChartTimeZone = "UTC",
): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const date = fmtChartDate(ms, timeZone);
  if (intervalMs >= 86_400_000) return date;
  if (timeZone !== "UTC") {
    return `${date} ${new Intl.DateTimeFormat("en-GB", {
      timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(d)}`;
  }
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
const YEAR_TICK = 0;
const MONTH_TICK = 1;
const TIME_TICK = 3;
const TIME_WITH_SECONDS_TICK = 4;

export function dayOfWeekTickFormatter(
  time: unknown, tickMarkType: number, timeZone: ChartTimeZone = "UTC",
): string | null {
  if (tickMarkType !== DAY_OF_MONTH_TICK || typeof time !== "number") return null;
  const d = new Date(time * 1000);
  if (timeZone !== "UTC") {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, weekday: "short", day: "numeric",
    }).formatToParts(d);
    return `${parts.find((part) => part.type === "weekday")?.value ?? ""} ${parts.find((part) => part.type === "day")?.value ?? ""}`.trim();
  }
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/*
 * ── R6b-13/14: `undefined` is not "off" ────────────────────────────────────
 *
 * `tickMarkFormatter: undefined` and `timeFormatter: undefined` were how this
 * product turned the two formatters OFF. lightweight-charts merges options with
 * an object spread, and a key whose value is `undefined` overwrites nothing —
 * so the formatter installed when the setting was ON stayed installed for ever
 * and both rows were inert on every chart that had ever had them on. (Day of
 * week defaults to ON, so that row could only ever be inert.)
 *
 * The cure is that OFF is a FUNCTION too. `defaultTickFormatter` returns `null`
 * for every tick, which is the library's own "you did not format it, use your
 * own" — the axis goes back to `29`, `Sep`, `07:00`. `hour24Formatter` and
 * `hour12Formatter` are a real pair, so the 12/24 row moves in both directions
 * rather than only into 12-hour and never back out.
 */

/** OFF, as a function: every tick falls back to the library's own label. */
export function defaultTickFormatter(): string | null {
  return null;
}

/** `15:00` — the library's own intraday label, written by us so OFF can exist. */
export function hour24Formatter(time: unknown, timeZone: ChartTimeZone = "UTC"): string {
  const d = new Date((typeof time === "number" ? time : 0) * 1000);
  if (timeZone !== "UTC") {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(d);
  }
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `3:00 pm`, in UTC — the 12-hour half of the `Time hours format` row. */
export function hour12Formatter(time: unknown, timeZone: ChartTimeZone = "UTC"): string {
  const d = new Date((typeof time === "number" ? time : 0) * 1000);
  if (timeZone !== "UTC") {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h12",
    }).format(d).toLowerCase();
  }
  const h = d.getUTCHours();
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${pad(d.getUTCMinutes())} ${h < 12 ? "am" : "pm"}`;
}

/** The pair the `Time hours format` row chooses between. */
export function hoursFormatter(
  twentyFourHour: boolean, timeZone: ChartTimeZone = "UTC",
): (time: unknown) => string {
  return twentyFourHour
    ? (time) => hour24Formatter(time, timeZone)
    : (time) => hour12Formatter(time, timeZone);
}

/** The pair the `Day of week on labels` row chooses between. */
export function dayOfWeekFormatter(
  on: boolean, timeZone: ChartTimeZone = "UTC",
): (time: unknown, tickMarkType: number) => string | null {
  return on ? (time, type) => dayOfWeekTickFormatter(time, type, timeZone) : defaultTickFormatter;
}

/**
 * The complete time-axis formatter for a selected display zone.
 *
 * UTC deliberately preserves the library's native month/year/intraday labels
 * and only adds the existing weekday option. For any other zone, returning
 * `null` would hand that tick back to the library's UTC formatter, recreating
 * a split-zone axis; every tick weight therefore gets a zoned label.
 */
export function axisTickFormatter(
  dayOfWeek: boolean,
  twentyFourHour: boolean,
  timeZone: ChartTimeZone = "UTC",
): (time: unknown, tickMarkType: number) => string | null {
  if (timeZone === "UTC") return dayOfWeekFormatter(dayOfWeek, timeZone);
  return (time, tickMarkType) => {
    if (typeof time !== "number") return null;
    const date = new Date(time * 1000);
    if (tickMarkType === TIME_TICK) {
      return twentyFourHour
        ? hour24Formatter(time, timeZone)
        : hour12Formatter(time, timeZone);
    }
    if (tickMarkType === TIME_WITH_SECONDS_TICK) {
      return new Intl.DateTimeFormat(twentyFourHour ? "en-GB" : "en-US", {
        timeZone, hour: twentyFourHour ? "2-digit" : "numeric",
        minute: "2-digit", second: "2-digit",
        hourCycle: twentyFourHour ? "h23" : "h12",
      }).format(date).toLowerCase();
    }
    if (tickMarkType === DAY_OF_MONTH_TICK) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone, ...(dayOfWeek ? { weekday: "short" as const } : {}), day: "numeric",
      }).formatToParts(date);
      const day = parts.find((part) => part.type === "day")?.value ?? "";
      const weekday = parts.find((part) => part.type === "weekday")?.value;
      return weekday ? `${weekday} ${day}` : day;
    }
    if (tickMarkType === MONTH_TICK) {
      return new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(date);
    }
    if (tickMarkType === YEAR_TICK) {
      return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(date);
    }
    return null;
  };
}

/**
 * A calendar date and minute, as a wall clock in one zone reads it.
 *
 * W2D-08: the Replay picker built its calendar and its time field from the
 * BROWSER's zone, beside a replay clock and a time axis printed in the
 * chart's — so in New York, on a UTC chart, the field said `03:59 AM` for the
 * bar the clock called `07:59:59`, and a time typed into it landed four hours
 * from where the user meant. These two functions are the conversion both
 * directions go through. `timeZone` omitted means the browser's own zone,
 * which is what a surface with no chart zone of its own (Go to…) still uses.
 */
export interface WallClock {
  year: number;
  /** 0–11, as `Date` counts them. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

export function wallClockOf(ms: number, timeZone?: string): WallClock {
  const d = new Date(ms);
  if (timeZone === undefined) {
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(),
      hour: d.getHours(), minute: d.getMinutes() };
  }
  if (timeZone === "UTC") {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
  let format = wallFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hourCycle: "h23",
    });
    wallFormatters.set(timeZone, format);
  }
  const parts = format.formatToParts(d);
  const value = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value ?? NaN);
  return { year: value("year"), month: value("month") - 1, day: value("day"),
    hour: value("hour") % 24, minute: value("minute") };
}

/**
 * The instant a wall clock in `timeZone` names.
 *
 * Fields out of range roll over as `Date.UTC` rolls them (day 32 is the next
 * month's first), which is what lets a calendar step a day or a month by
 * adding one. Two offset passes, so a time just across a DST change resolves
 * against the offset in force AT that time rather than the guess's.
 */
export function instantOfWallClock(wall: WallClock, timeZone?: string): number {
  if (timeZone === undefined) {
    return new Date(wall.year, wall.month, wall.day, wall.hour, wall.minute, 0, 0).getTime();
  }
  const asUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  if (timeZone === "UTC") return asUtc;
  const offset = (ms: number): number => {
    const w = wallClockOf(ms, timeZone);
    return Date.UTC(w.year, w.month, w.day, w.hour, w.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const first = asUtc - offset(asUtc);
  return asUtc - offset(first);
}

/** `YYYY-MM-DD HH:MM` in `timeZone` — the replay clock's own form, to the minute. */
export function fmtChartMinute(ms: number, timeZone: ChartTimeZone = "UTC"): string {
  if (Number.isNaN(new Date(ms).getTime())) return "—";
  const w = wallClockOf(ms, timeZone);
  return `${w.year}-${pad(w.month + 1)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}
