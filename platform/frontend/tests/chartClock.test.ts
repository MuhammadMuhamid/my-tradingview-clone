/**
 * The chart's clock, and the one axis label the settings dialog can change.
 *
 * `lib/chartClock` is the single answer to "what time is it on this chart" —
 * UTC throughout, stated rather than inferred from the reader's machine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  dayOfWeekTickFormatter, fmtChartBarTime, fmtChartClock, hour24Formatter,
} from "../lib/chartClock";

test("R6 SC-5(d) — a day label carries its weekday, and nothing else is touched", () => {
  /*
   * The reference writes `Mon 29` on the tick that starts a day and leaves
   * every other weight to the library, so `localization.dateFormat` and the
   * 12/24-hour choice stay authoritative. `null` is lightweight-charts' own
   * "you format it": returning anything else for a Time or Month tick would
   * silently take those two settings over.
   */
  const DAY = 2, TIME = 3, MONTH = 1, YEAR = 0;
  // Monday 29 September 1997, 00:00 UTC.
  const monday = Date.UTC(1997, 8, 29) / 1000;
  assert.equal(dayOfWeekTickFormatter(monday, DAY), "Mon 29");
  assert.equal(dayOfWeekTickFormatter(monday + 86_400, DAY), "Tue 30");
  for (const type of [TIME, MONTH, YEAR]) {
    assert.equal(dayOfWeekTickFormatter(monday, type), null,
      "only the day tick is this setting's business");
  }
  // A business-day object rather than a timestamp is the library's other time
  // shape; it is handed back rather than mis-read.
  assert.equal(dayOfWeekTickFormatter({ year: 1997, month: 9, day: 29 }, DAY), null);
});

test("C-03 — a selected IANA zone shifts clock and axis labels without shifting data", () => {
  const instant = Date.UTC(2026, 8, 15, 12, 34, 56);
  assert.equal(fmtChartClock(instant, "UTC"), "12:34:56");
  assert.equal(fmtChartClock(instant, "Asia/Karachi"), "17:34:56");
  assert.equal(hour24Formatter(instant / 1000, "Asia/Karachi"), "17:34");
  assert.equal(fmtChartBarTime(instant, 60_000, "Asia/Karachi"), "2026-09-15 17:34");
});
