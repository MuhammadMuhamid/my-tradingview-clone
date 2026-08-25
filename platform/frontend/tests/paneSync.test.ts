import { test } from "node:test";
import assert from "node:assert/strict";
import { snapToBarIndex, DEFAULT_SYNC, SYNC_LABELS } from "../lib/paneSync";

/** Bar open times, in seconds, for `count` bars of `stepSec` from `startSec`. */
const bars = (startSec: number, stepSec: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => startSec + i * stepSec);

const H = 3600;
const M15 = 900;

test("an exact bar open time selects that bar", () => {
  const t = bars(0, H, 10);
  assert.equal(snapToBarIndex(t, 0), 0);
  assert.equal(snapToBarIndex(t, 5 * H), 5);
  assert.equal(snapToBarIndex(t, 9 * H), 9);
});

test("a time inside a bar selects the bar that was forming", () => {
  // The whole point of the function: 14:07 on a 15m chart must land on the
  // 14:00 bar of a 1h chart, not the 15:00 one.
  const hourly = bars(0, H, 10);
  assert.equal(snapToBarIndex(hourly, 5 * H + 1), 5);
  assert.equal(snapToBarIndex(hourly, 5 * H + H - 1), 5);
  assert.equal(snapToBarIndex(hourly, 6 * H), 6);
});

test("a 15m crosshair maps onto the containing 1h bar", () => {
  const hourly = bars(0, H, 24);
  for (let i = 0; i < 4; i++) {
    // Four 15m bars inside hour 9 all resolve to the same hourly bar.
    assert.equal(snapToBarIndex(hourly, 9 * H + i * M15), 9);
  }
});

test("a time before every loaded bar draws nothing rather than clamping", () => {
  const t = bars(1000, H, 5);
  assert.equal(snapToBarIndex(t, 999), -1);
  assert.equal(snapToBarIndex(t, 0), -1);
});

test("a time after the last bar selects the last bar", () => {
  const t = bars(0, H, 5);
  assert.equal(snapToBarIndex(t, 100 * H), 4);
});

test("an empty series selects nothing", () => {
  assert.equal(snapToBarIndex([], 12345), -1);
});

test("the result is always the newest bar at or before the time", () => {
  // Property check across a coarse and a fine series.
  const t = bars(0, M15, 200);
  for (let probe = 0; probe < 200 * M15; probe += 137) {
    const i = snapToBarIndex(t, probe);
    assert.ok(t[i]! <= probe, `bar ${t[i]} should be <= ${probe}`);
    if (i + 1 < t.length) assert.ok(t[i + 1]! > probe, "next bar should be later");
  }
});

test("crosshair is on by default and every option has a label", () => {
  assert.equal(DEFAULT_SYNC.crosshair, true);
  assert.equal(DEFAULT_SYNC.interval, false);
  const ids = SYNC_LABELS.map((o) => o.id).sort();
  assert.deepEqual(ids, ["crosshair", "dateRange", "interval", "symbol", "time"]);
  // Every declared option must be renderable, or the menu silently drops one.
  for (const o of SYNC_LABELS) assert.ok(o.label && o.help, `${o.id} needs a label and help`);
});
