/**
 * ── B-12: a 1m chart with a Pine strategy ran nothing, and said nothing ───
 *
 * The chart runs Pine from BACKTEST_START (2025-11-01) to today. On 1m that is
 * 496,800 bars, the server's limit for one run is 120,000
 * (`backend/src/api/routes/pine.ts` MAX_RUN_BARS), and every run came back
 * 400 "range is too large" — while the legend showed `∅ ∅` with no word about
 * why. The start is now clamped so a run never asks for more than the server
 * will give, and a run that fails says so in the legend, in plain language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PINE_MAX_RUN_BARS, pineRunRange, pineRunStatus } from "../lib/indicators";

const START = "2025-11-01T00:00:00.000Z";
const END = "2026-10-11T23:59:59.999Z";
const bars = (r: { startTime: string; endTime: string }, stepMs: number): number =>
  (Date.parse(r.endTime) - Date.parse(r.startTime)) / stepMs;

test("PINE_MAX_RUN_BARS stays under the server's 120,000-bar limit", () => {
  assert.ok(PINE_MAX_RUN_BARS <= 120_000);
});

test("B-12 — a 1m run is clamped to what the server will run", () => {
  const range = pineRunRange({ startTime: START, endTime: END }, "1m");
  assert.ok(bars(range, 60_000) <= 120_000,
    `the run asks for ${bars(range, 60_000)} one-minute bars`);
  assert.equal(range.endTime, END, "only the START moves; the end is the horizon");
});

test("a run that already fits is left exactly as asked", () => {
  for (const tf of ["15m", "1h", "4h", "1d"] as const) {
    assert.deepEqual(pineRunRange({ startTime: START, endTime: END }, tf),
      { startTime: START, endTime: END }, tf);
  }
  // And without a timeframe the boundary is the old exact one.
  assert.deepEqual(pineRunRange({ startTime: START, endTime: END }),
    { startTime: START, endTime: END });
});

test("B-12 — a run error reads as a sentence, never as the server's words", () => {
  assert.match(pineRunStatus("line 4: Undeclared identifier 'x'") ?? "", /^Script error on line 4/);
  const tooLarge = pineRunStatus(
    "range is too large: 496,800 bars exceeds the 120,000 limit for one run") ?? "";
  assert.ok(!/496|120,000|range is too large/.test(tooLarge), `raw server text: ${tooLarge}`);
  assert.match(tooLarge, /could not run/i);
  assert.equal(pineRunStatus(null), null);
});
