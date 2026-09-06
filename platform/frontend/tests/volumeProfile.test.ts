/**
 * The volume profile, as arithmetic that can be checked by hand.
 *
 * Every case here is small enough that the expected answer is derived in the
 * comment rather than copied from the implementation, because a profile is
 * exactly the kind of thing that looks plausible while being wrong: a POC one
 * row out, or a value area that stops a row early, draws a confident line at
 * the wrong price and nothing about the picture says so.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROFILE_SETTINGS, MAX_ROWS, MIN_ROWS,
  barsInRange, computeVolumeProfile, emptyProfile, normalizeProfileSettings,
  profileBasisNotice, type VolumeProfileSettings,
} from "../lib/volumeProfile";
import type { Candle } from "../lib/types";

const MINUTE = 60_000;

function bar(
  index: number, open: number, high: number, low: number, close: number, volume: number
): Candle {
  return {
    openTime: 1_700_000_000_000 + index * MINUTE,
    open, high, low, close, volume,
    closeTime: 1_700_000_000_000 + (index + 1) * MINUTE - 1,
  } as Candle;
}

const settings = (over: Partial<VolumeProfileSettings> = {}): VolumeProfileSettings =>
  normalizeProfileSettings({ ...DEFAULT_PROFILE_SETTINGS, ...over });

test("an empty range profiles to nothing rather than to NaN", () => {
  const profile = computeVolumeProfile([], settings(), "1m");
  assert.equal(profile.rows.length, 0);
  assert.equal(profile.pocIndex, -1);
  assert.equal(profile.poc, null);
  assert.equal(profile.valueAreaHigh, null);
  assert.equal(profile.totalVolume, 0);
  assert.deepEqual(profile, emptyProfile("1m"));
});

test("one bar spread across rows keeps every unit of its volume", () => {
  // A single bar 100→110 with 300 volume, cut into 10 rows of 1.0 each.
  const profile = computeVolumeProfile(
    [bar(0, 100, 110, 100, 105, 300)], settings({ rowSize: 10 }), "1m");
  assert.equal(profile.rows.length, 10);
  assert.ok(Math.abs(profile.totalVolume - 300) < 1e-9, `${profile.totalVolume}`);
  // The bar covers the whole range uniformly, so every row holds 30.
  for (const row of profile.rows) assert.ok(Math.abs(row.total - 30) < 1e-9);
  // close 105 >= open 100, so all of it is up volume.
  for (const row of profile.rows) assert.ok(Math.abs(row.down) < 1e-9);
});

test("a bar that covers part of a row is credited that part and no more", () => {
  /*
   * Range 0→10 in 10 rows of height 1. One bar spans 2.5→4.5 with volume 100.
   * Row 2 [2,3) holds 0.5 of the bar's 2.0 range → 25; row 3 [3,4) holds 1.0
   * → 50; row 4 [4,5) holds 0.5 → 25. Rows 0,1,5..9 hold nothing.
   *
   * The anchoring bar exists only to fix the profile's price range at 0→10,
   * and carries no volume of its own.
   */
  const profile = computeVolumeProfile(
    [bar(0, 0, 10, 0, 10, 0), bar(1, 2.5, 4.5, 2.5, 4.5, 100)],
    settings({ rowSize: 10 }), "1m");
  const totals = profile.rows.map((r) => Number(r.total.toFixed(9)));
  assert.deepEqual(totals, [0, 0, 25, 50, 25, 0, 0, 0, 0, 0]);
  assert.equal(profile.pocIndex, 3);
  assert.ok(profile.poc !== null && Math.abs(profile.poc - 3.5) < 1e-9);
});

test("close allocation puts the whole bar at its close and nowhere else", () => {
  const profile = computeVolumeProfile(
    [bar(0, 0, 10, 0, 10, 0), bar(1, 2.5, 4.5, 2.5, 4.5, 100)],
    settings({ rowSize: 10, allocation: "close" }), "1m");
  const totals = profile.rows.map((r) => Number(r.total.toFixed(9)));
  // Close 4.5 falls in row 4 — and the anchoring bar's close of 10 falls in
  // the top row, but it carries no volume, so the top row stays empty.
  assert.deepEqual(totals, [0, 0, 0, 0, 100, 0, 0, 0, 0, 0]);
});

test("up and down follow TradingView's rule, with a doji counted as up", () => {
  const rising = computeVolumeProfile(
    [bar(0, 10, 10, 10, 11, 50)], settings(), "1m");
  assert.equal(rising.rows[0]!.up, 50);
  assert.equal(rising.rows[0]!.down, 0);

  const falling = computeVolumeProfile(
    [bar(0, 11, 11, 11, 10, 50)], settings(), "1m");
  assert.equal(falling.rows[0]!.up, 0);
  assert.equal(falling.rows[0]!.down, 50);

  // close === open: "closes above OR EQUAL TO its open" is an up bar.
  const doji = computeVolumeProfile(
    [bar(0, 10, 10, 10, 10, 50)], settings(), "1m");
  assert.equal(doji.rows[0]!.up, 50);
  assert.equal(doji.rows[0]!.down, 0);
});

test("every row's up and down add back to its total", () => {
  const bars = Array.from({ length: 60 }, (_, i) =>
    bar(i, 100 + i, 100 + i + 2, 100 + i - 2, 100 + (i % 3) - 1 + i, 10 + (i % 7)));
  const profile = computeVolumeProfile(bars, settings({ rowSize: 40 }), "5m");
  for (const row of profile.rows) {
    assert.ok(Math.abs(row.up + row.down - row.total) < 1e-9);
    assert.ok(row.up >= -1e-12 && row.down >= -1e-12);
  }
  const sum = profile.rows.reduce((n, r) => n + r.total, 0);
  const volume = bars.reduce((n, b) => n + b.volume, 0);
  assert.ok(Math.abs(sum - volume) < 1e-6, `${sum} vs ${volume}`);
  assert.ok(Math.abs(profile.totalVolume - volume) < 1e-6);
});

test("the value area expands from the point of control, larger side first", () => {
  /*
   * Rows of height 1 over 0→5, built by placing each bar entirely inside one
   * row. Volumes, low row to high row: 10, 30, 100, 25, 5. Total 170; 70 % of
   * that is 119.
   *
   *   start POC (row 2) = 100
   *   above row 3 = 25, below row 1 = 30 → below wins → 130 ≥ 119, stop.
   *
   * So the value area is rows 1..2: VAL = 1, VAH = 3.
   */
  const bars = [10, 30, 100, 25, 5].map((v, i) =>
    bar(i, i + 0.5, i + 0.5, i + 0.5, i + 0.5, v));
  // An anchor bar to fix the range at 0→5 exactly.
  bars.push(bar(9, 0, 5, 0, 5, 0));
  const profile = computeVolumeProfile(bars, settings({ rowSize: 5 }), "1m");
  assert.equal(profile.pocIndex, 2);
  assert.deepEqual(profile.valueAreaRows, [1, 2]);
  assert.equal(profile.valueAreaLow, 1);
  assert.equal(profile.valueAreaHigh, 3);
  assert.equal(profile.valueAreaVolume, 130);
});

test("a tie in the value area takes the row nearer the point of control", () => {
  /*
   * Volumes low→high: 40, 5, 100, 5, 40. Total 190; 70 % is 133.
   *
   *   POC row 2 = 100.
   *   above row 3 = 5, below row 1 = 5 → tie, distances both 1 → take ABOVE.
   *     running 105.
   *   above row 4 = 40, below row 1 = 5 → above wins. running 145 ≥ 133, stop.
   *
   * Value area rows 2..4, so VAL = 2 and VAH = 5. The tie rule is what decides
   * this: taking below first would have produced 2..4 by a different path but
   * 1..3 in the general case, so it is worth pinning.
   */
  const bars = [40, 5, 100, 5, 40].map((v, i) =>
    bar(i, i + 0.5, i + 0.5, i + 0.5, i + 0.5, v));
  bars.push(bar(9, 0, 5, 0, 5, 0));
  const profile = computeVolumeProfile(bars, settings({ rowSize: 5 }), "1m");
  assert.equal(profile.pocIndex, 2);
  assert.deepEqual(profile.valueAreaRows, [2, 3, 4]);
});

test("a value area of 100 % covers every row that holds volume", () => {
  const bars = [10, 30, 100, 25, 5].map((v, i) =>
    bar(i, i + 0.5, i + 0.5, i + 0.5, i + 0.5, v));
  bars.push(bar(9, 0, 5, 0, 5, 0));
  const profile = computeVolumeProfile(
    bars, settings({ rowSize: 5, valueAreaPercent: 100 }), "1m");
  assert.deepEqual(profile.valueAreaRows, [0, 1, 2, 3, 4]);
  assert.equal(profile.valueAreaVolume, 170);
});

test("a flat range is one row rather than none or many of zero height", () => {
  const profile = computeVolumeProfile(
    [bar(0, 25, 25, 25, 25, 8), bar(1, 25, 25, 25, 25, 12)],
    settings({ rowSize: 30 }), "1h");
  assert.equal(profile.rows.length, 1);
  assert.equal(profile.rows[0]!.total, 20);
  assert.equal(profile.poc, 25);
  assert.equal(profile.valueAreaLow, 25);
  assert.equal(profile.valueAreaHigh, 25);
});

test("bars with no volume profile to rows of zero, not to a false point of control", () => {
  const profile = computeVolumeProfile(
    [bar(0, 10, 12, 9, 11, 0), bar(1, 11, 13, 10, 12, 0)],
    settings(), "1m");
  assert.equal(profile.totalVolume, 0);
  assert.equal(profile.pocIndex, -1);
  assert.equal(profile.poc, null);
  assert.equal(profile.valueAreaRows.length, 0);
});

test("the point of control ties to the lower row, every time", () => {
  const bars = [50, 20, 50].map((v, i) =>
    bar(i, i + 0.5, i + 0.5, i + 0.5, i + 0.5, v));
  bars.push(bar(9, 0, 3, 0, 3, 0));
  const profile = computeVolumeProfile(bars, settings({ rowSize: 3 }), "1m");
  assert.equal(profile.pocIndex, 0);
});

test("row height layout cuts by price rather than by count", () => {
  // Range 100→110 with a requested row height of 2.5 → four rows.
  const profile = computeVolumeProfile(
    [bar(0, 100, 110, 100, 105, 40)],
    settings({ layout: "height", rowSize: 2.5 }), "1m");
  assert.equal(profile.rows.length, 4);
  assert.ok(Math.abs(profile.rows[0]!.high - profile.rows[0]!.low - 2.5) < 1e-9);
  assert.ok(Math.abs(profile.totalVolume - 40) < 1e-9);
});

test("settings from storage are coerced rather than trusted", () => {
  const hostile = normalizeProfileSettings({
    layout: "sideways" as never, rowSize: Number.NaN,
    valueAreaPercent: 5_000, allocation: "guess" as never,
  });
  assert.equal(hostile.layout, "rows");
  assert.equal(hostile.rowSize, DEFAULT_PROFILE_SETTINGS.rowSize);
  assert.equal(hostile.valueAreaPercent, 100);
  assert.equal(hostile.allocation, "range");

  assert.equal(normalizeProfileSettings({ rowSize: 1 }).rowSize, MIN_ROWS);
  assert.equal(normalizeProfileSettings({ rowSize: 10_000 }).rowSize, MAX_ROWS);
  assert.equal(normalizeProfileSettings(undefined).rowSize, DEFAULT_PROFILE_SETTINGS.rowSize);
  // A row HEIGHT is a price and is not rounded to a whole number.
  assert.equal(normalizeProfileSettings({ layout: "height", rowSize: 0.25 }).rowSize, 0.25);
  assert.equal(
    normalizeProfileSettings({ layout: "height", rowSize: -3 }).rowSize,
    DEFAULT_PROFILE_SETTINGS.rowSize);
});

test("a row count is bounded so a dragged setting cannot ask for a million rows", () => {
  const bars = Array.from({ length: 5 }, (_, i) => bar(i, 1, 1 + i, 1, 1 + i, 5));
  const profile = computeVolumeProfile(
    bars, settings({ layout: "height", rowSize: 1e-9 }), "1m");
  assert.ok(profile.rows.length <= MAX_ROWS);
});

test("barsInRange slices inclusively at both ends and either way round", () => {
  const bars = Array.from({ length: 10 }, (_, i) => bar(i, 1, 2, 1, 2, 1));
  const from = bars[2]!.openTime;
  const to = bars[6]!.openTime;
  assert.equal(barsInRange(bars, from, to).length, 5);
  assert.equal(barsInRange(bars, to, from).length, 5);
  assert.equal(barsInRange(bars, from, from).length, 1);
  assert.equal(barsInRange(bars, 0, 1).length, 0);
  assert.equal(barsInRange(bars, 0, Number.MAX_SAFE_INTEGER).length, 10);
  assert.equal(barsInRange([], from, to).length, 0);
});

test("the basis is stated rather than implied", () => {
  const chart = computeVolumeProfile([bar(0, 1, 2, 1, 2, 5)], settings(), "1d");
  assert.equal(chart.basis, "chart");
  assert.equal(chart.sourceInterval, "1d");
  assert.match(profileBasisNotice(chart), /this chart's own 1d bars/);
  assert.match(profileBasisNotice(chart), /does not say where inside a bar/);

  const refined = computeVolumeProfile([bar(0, 1, 2, 1, 2, 5)], settings(), "1m", "refined");
  assert.equal(refined.basis, "refined");
  assert.match(profileBasisNotice(refined), /1m bars loaded for this range/);
  assert.doesNotMatch(profileBasisNotice(refined), /does not say/);

  assert.equal(profileBasisNotice(emptyProfile("1h")), "No bars in this range.");
});

test("a refined profile of the same range agrees on totals and disagrees on shape", () => {
  /*
   * The same hour, twice: once as a single 1h bar, once as four 15m bars that
   * traded in the lower half. The totals must match exactly — no volume is
   * created or lost by looking closer — while the point of control moves,
   * which is the entire reason finer bars are worth loading.
   */
  const coarse = [bar(0, 100, 110, 100, 101, 400)];
  const fine = [
    bar(0, 100, 102, 100, 101, 100),
    bar(1, 101, 102, 100, 100.5, 100),
    bar(2, 100.5, 102, 100, 101, 100),
    bar(3, 101, 110, 100, 101, 100),
  ];
  const a = computeVolumeProfile(coarse, settings({ rowSize: 10 }), "1h");
  const b = computeVolumeProfile(fine, settings({ rowSize: 10 }), "15m", "refined");
  assert.ok(Math.abs(a.totalVolume - b.totalVolume) < 1e-9);
  assert.equal(a.priceLow, b.priceLow);
  assert.equal(a.priceHigh, b.priceHigh);
  // The coarse profile is flat, so its POC is the tie-break row: the lowest.
  assert.equal(a.pocIndex, 0);
  // The fine one concentrates in the bottom two rows.
  assert.ok(b.rows[0]!.total > b.rows[9]!.total);
});
