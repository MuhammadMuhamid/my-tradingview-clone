/**
 * W2D (independent review, production build at 3f57ea9) — the arithmetic
 * behind four repairs, pinned without a browser.
 *
 *   W2D-10  Replay 10× ran at about 6×: a clock that counts bars owed since
 *           Play started, so render cost cannot be added to every interval.
 *   W2D-01  The last-price plate read 00:00:00 until the forming bar landed:
 *           the countdown is the interval's grid and the clock.
 *   W2D-01  A study window was computed with a viewport measured on another
 *           window; a live bar could turn an empty window into a "dataset".
 *   W2D-08  The replay picker read the browser's zone beside a UTC chart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../lib/types";
import {
  advanceReplay, replayClockDelay, replayClockTick, startReplay, startReplayClock,
  type ReplayClock, type ReplaySpeed,
} from "../lib/replay";
import { barCloseCountdownMs, countdownText } from "../lib/barCountdown";
import { computeWindow, viewportForWindow } from "../lib/native/compute";
import { heldWindow, mergeLiveBarsInto } from "../lib/useCandleHistory";
import { CandleHistoryCache } from "../lib/candleHistory";
import { fmtChartMinute, instantOfWallClock, wallClockOf } from "../lib/chartClock";
import { monthGrid } from "../components/tv/CalendarField";

const MIN = 60_000;

function bars(count: number, stepMs = MIN, symbol = "BTCUSDT", interval: Candle["interval"] = "1m"): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol, interval, openTime: i * stepMs, closeTime: (i + 1) * stepMs - 1,
    open: 1, high: 2, low: 0.5, close: 1.5, volume: 1,
  }));
}

/* ── W2D-10 ──────────────────────────────────────────────────────────────── */

/**
 * Drive the clock the way the page does — a timeout for the next due bar,
 * then the work of rendering it — and count the bars stepped in `spanMs`.
 */
function simulate(speed: ReplaySpeed, spanMs: number, renderMs: number): number {
  let now = 0;
  let clock: ReplayClock = startReplayClock(now, speed);
  let stepped = 0;
  for (;;) {
    now += replayClockDelay(clock, now);
    if (now > spanMs) break;
    const paid = replayClockTick(clock, now);
    clock = paid.clock;
    stepped += paid.steps;
    now += paid.steps > 0 ? renderMs : 0; // the render the old chain added to every delay
  }
  return stepped;
}

test("W2D-10 — N× steps N bars a second whatever a render costs", () => {
  // The reviewer's measurement was 5 bars / 6 s at 1× and 35 / 6 s at 10×:
  // a fixed delay plus ~70 ms of render per step. The clock is not slowed by it.
  for (const speed of [1, 2, 5, 10] as const) {
    for (const renderMs of [0, 70, 150]) {
      const stepped = simulate(speed, 6_000, renderMs);
      assert.ok(Math.abs(stepped - speed * 6) <= 1,
        `${speed}× with ${renderMs} ms renders stepped ${stepped} bars in 6 s, not ${speed * 6}`);
    }
  }
  // And the old chain, stated as the same arithmetic, is what the reviewer saw.
  const oldChain = (speed: number, renderMs: number): number =>
    Math.floor(6_000 / (1000 / speed + renderMs));
  assert.ok(oldChain(10, 70) <= 36, "the model of the defect is not the defect");
});

test("W2D-10 — bars owed are floor(elapsed × speed), and a late tick is made up", () => {
  const clock = startReplayClock(1_000, 10);
  assert.deepEqual(replayClockTick(clock, 1_000).steps, 0);
  assert.equal(replayClockDelay(clock, 1_000), 100);
  // A tick that fires 250 ms late owes two bars, not one.
  const late = replayClockTick(clock, 1_250);
  assert.equal(late.steps, 2);
  assert.equal(late.clock.taken, 2);
  // And the next is due on the original grid, not 100 ms after the late tick.
  assert.equal(replayClockDelay(late.clock, 1_250), 50);
  assert.equal(replayClockDelay(late.clock, 2_000), 0, "a delay is never negative");
});

test("W2D-10 — a stall is not replayed as a lurch", () => {
  // A background tab: a minute at 10× would be 600 bars at once.
  const clock = startReplayClock(0, 10);
  const after = replayClockTick(clock, 60_000);
  assert.equal(after.steps, 10, "at most one second's worth after a stall");
  assert.equal(after.clock.startedAt, 60_000, "and the clock counts from now again");
  assert.equal(replayClockTick(after.clock, 60_100).steps, 1);
});

test("W2D-10 — advancing several bars stops exactly where single steps would", () => {
  const candles = bars(10);
  const session = { ...startReplay(candles, candles[2]!.closeTime, Number.MAX_SAFE_INTEGER)!, playing: true };
  const three = advanceReplay(session, candles, 3);
  assert.equal(three.horizonCloseTime, candles[5]!.closeTime);
  assert.equal(three.playing, true);
  const past = advanceReplay(session, candles, 50);
  assert.equal(past.horizonCloseTime, candles[9]!.closeTime, "never past the history");
  assert.equal(past.playing, false, "and Play stops at the end, as a single step does");
  assert.equal(advanceReplay(session, candles, 0), session);
});

/* ── W2D-01 (c): the countdown ───────────────────────────────────────────── */

test("W2D-01 — the countdown is the interval's grid, not a bar that has already closed", () => {
  const HOUR = 60 * MIN;
  const open = Date.UTC(2026, 9, 10, 7, 0, 0);
  const close = open + HOUR - 1;
  // The forming bar is held: its own close is the answer.
  assert.equal(countdownText(barCloseCountdownMs(close, HOUR, open + 15 * MIN)), "00:45:00");
  // The newest bar held CLOSED a minute ago (a cold load, a provider history
  // that ends on completed bars): the plate counts to the slot the clock is in.
  assert.equal(countdownText(barCloseCountdownMs(close, HOUR, close + MIN + 1)), "00:59:00");
  // Several slots behind still lands in the current slot.
  assert.equal(countdownText(barCloseCountdownMs(close, HOUR, close + 3 * HOUR + 30 * MIN + 1)), "00:30:00");
  // 1D: right after switching, never 00:00:00.
  const DAY = 24 * HOUR;
  const dayClose = Date.UTC(2026, 9, 10) - 1;
  assert.equal(countdownText(barCloseCountdownMs(dayClose, DAY, Date.UTC(2026, 9, 10, 14, 0, 0))), "10:00:00");
  for (let t = close + 1; t < close + 2 * HOUR; t += 7 * MIN + 13) {
    assert.notEqual(countdownText(barCloseCountdownMs(close, HOUR, t)), "00:00:00", `at ${t}`);
  }
});

/* ── W2D-01 (a/b): a study's window ──────────────────────────────────────── */

test("W2D-01 — a viewport measured on one window is never applied to another", () => {
  const daily = bars(90, 86_400_000, "SOLUSDT", "1d");
  const fiveMinute = bars(800, 5 * MIN, "SOLUSDT", "5m");
  // Measured on 1D: the whole 90-bar history is on screen.
  const measured = { datasetKey: "SOLUSDT|1d", firstOpenTime: daily[0]!.openTime,
    viewport: { firstVisibleIndex: 0, visibleBars: 200 } };
  // The defect: that index, applied to 5m, computes over its OLDEST bars.
  const stale = computeWindow(fiveMinute, 280, measured.viewport, false);
  assert.notEqual(stale[stale.length - 1], fiveMinute[fiveMinute.length - 1],
    "the model of the defect is not the defect");
  // The rule: another window gets no viewport, which means the newest bars.
  assert.equal(viewportForWindow(measured, "SOLUSDT|5m", fiveMinute[0]!.openTime), undefined);
  assert.equal(viewportForWindow(measured, "SOLUSDT|1d", daily[5]!.openTime), undefined,
    "a reload of the same dataset that starts elsewhere is another window too");
  assert.equal(viewportForWindow(measured, null, null), undefined);
  assert.deepEqual(viewportForWindow(measured, "SOLUSDT|1d", daily[0]!.openTime), measured.viewport);
});

test("W2D-01 — a live bar never turns an empty window into a dataset", () => {
  const empty = heldWindow([], { symbol: "BTCUSDT", interval: "1m", bars: 10_000 });
  const tail = bars(3);
  const merged = mergeLiveBarsInto(empty, tail[1]!, tail[2]!);
  assert.equal(merged, empty, "two live bars became the window every study computed over");
  assert.equal(merged.candles.length, 0);

  // The shared cache holds itself to the same rule: an entry a load stored
  // empty is not extended into a two-bar "history" for the next pane to peek.
  const cache = new CandleHistoryCache();
  const request = { symbol: "BTCUSDT", interval: "1m" as const, bars: 10_000 };
  cache.store(request, []);
  cache.applyLiveBar("BTCUSDT", "1m", tail[2]!);
  assert.deepEqual(cache.peek(request), []);
  // A real window still takes the bar.
  cache.store(request, tail.slice(0, 2));
  cache.applyLiveBar("BTCUSDT", "1m", tail[2]!);
  assert.equal(cache.peek(request)!.length, 3);
});

/* ── W2D-08: the replay picker's zone ────────────────────────────────────── */

test("W2D-08 — a wall clock in the chart's zone round-trips, whatever the browser's zone", () => {
  const instant = Date.UTC(2026, 9, 10, 7, 59, 59, 999); // the replay clock's 07:59:59
  assert.equal(fmtChartMinute(instant, "UTC"), "2026-10-10 07:59");
  assert.equal(fmtChartMinute(instant, "America/New_York"), "2026-10-10 03:59");
  assert.equal(fmtChartMinute(instant, "Asia/Tokyo"), "2026-10-10 16:59");
  for (const zone of ["UTC", "America/New_York", "Europe/London", "Asia/Karachi", "Asia/Tokyo"]) {
    const wall = wallClockOf(instant, zone);
    assert.equal(instantOfWallClock(wall, zone), Math.floor(instant / MIN) * MIN, zone);
  }
  // A typed 07:59 on a UTC chart is 07:59 UTC — not the browser's 07:59.
  assert.equal(instantOfWallClock({ year: 2026, month: 9, day: 10, hour: 7, minute: 59 }, "UTC"),
    Date.UTC(2026, 9, 10, 7, 59));
  // Across a DST change the offset in force AT that time is used.
  assert.equal(instantOfWallClock({ year: 2026, month: 10, day: 1, hour: 12, minute: 0 }, "America/New_York"),
    Date.UTC(2026, 10, 1, 17, 0), "New York is UTC−5 after 1 Nov 2026");
  assert.equal(instantOfWallClock({ year: 2026, month: 9, day: 31, hour: 12, minute: 0 }, "America/New_York"),
    Date.UTC(2026, 9, 31, 16, 0), "and UTC−4 before it");
});

test("W2D-08 — the calendar's days are the chart zone's midnights, Monday first", () => {
  const grid = monthGrid(Date.UTC(2026, 9, 10, 7, 59), "UTC");
  assert.equal(grid.length % 7, 0);
  assert.equal(new Date(grid[0]!).getUTCDay(), 1, "the grid starts on a Monday");
  for (const day of grid) {
    const w = wallClockOf(day, "UTC");
    assert.equal(w.hour, 0); assert.equal(w.minute, 0);
  }
  assert.ok(grid.includes(Date.UTC(2026, 9, 1)) && grid.includes(Date.UTC(2026, 9, 31)));
  const tokyo = monthGrid(Date.UTC(2026, 9, 10), "Asia/Tokyo");
  assert.ok(tokyo.includes(Date.UTC(2026, 9, 9, 15)), "Tokyo's 10 Oct starts at 15:00 UTC on the 9th");
});
