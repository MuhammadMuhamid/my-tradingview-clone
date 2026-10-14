/**
 * Auto Fib Retracement: the zig-zag it anchors to, and the levels it draws.
 *
 * The chart and the alert engine both call these `ta/core` functions, so a
 * level the chart shows is the level an alert fires on. The zig-zag is a port
 * of TradingView's ZigZag/7 as the "Auto fib retracement" script drives it.
 * Path-dependent: one misclassified pivot moves every leg after it, which is
 * why the golden fixture checks EVERY leg on real candles, not only the last.
 * Its expected legs came from an independent Python transcription of the Pine
 * semantics, not from this code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AUTO_FIB_DEFAULTS, AUTO_FIB_LEVELS, autoFib, autoFibLevelPrice, zigZagLegs } from "../src/ta/core";

const golden = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "autoFibGolden.json"), "utf8")) as {
  high: number[]; low: number[]; close: number[];
  legs: [number, number, number, number, boolean][];
};

test("every zig-zag leg on 1000 real NEARUSDT 1h bars matches the independent transcription", () => {
  const legs = zigZagLegs(golden.high, golden.low, golden.close, 3, 30)
    .map((g) => [g.start.index, g.start.price, g.end.index, g.end.price, g.isHigh]);
  assert.equal(legs.length, golden.legs.length);
  assert.deepEqual(legs, golden.legs);
});

/** A clean swing: down to 101.25, up to 200, then a drift that confirms the top. */
const swing = () => {
  const close: number[] = [];
  for (let i = 0; i < 40; i++) close.push(150 - i * 1.25);             // down to 101.25
  for (let i = 0; i < 60; i++) close.push(100 + (i + 1) * (100 / 60)); // up to 200
  for (let i = 0; i < 40; i++) close.push(200 - (i + 1) * 0.5);        // drift down
  return { high: close.map((c) => c + 0.01), low: close.map((c) => c - 0.01), close };
};

test("levels run from the latest pivot (0) back to the one before it (1)", () => {
  const s = swing();
  const fib = autoFib(s.high, s.low, s.close, 0.1, 10)!;
  assert.ok(fib, "the swing has two legs");
  assert.ok(Math.abs(autoFibLevelPrice(fib, 0) - 200.01) < 1e-9, "0 is the swing high");
  assert.ok(Math.abs(autoFibLevelPrice(fib, 1) - 101.24) < 1e-9, "1 is the swing low before it");
  assert.ok(Math.abs(autoFibLevelPrice(fib, 0.618) - (200.01 - 0.618 * (200.01 - 101.24))) < 1e-9);
});

test("Reverse swaps which end is 0", () => {
  const s = swing();
  const fib = autoFib(s.high, s.low, s.close, 0.1, 10, true)!;
  assert.ok(Math.abs(autoFibLevelPrice(fib, 0) - 101.24) < 1e-9);
  assert.ok(Math.abs(autoFibLevelPrice(fib, 1) - 200.01) < 1e-9);
});

test("fewer than two legs draws nothing, as the script refuses to", () => {
  const flat = Array.from({ length: 200 }, () => 100);
  assert.equal(autoFib(flat, flat, flat, 3, 30), null);
  assert.equal(autoFib([1, 2], [1, 2], [1, 2], 3, 30), null);
});

test("a pivot is only knowable half the depth later — no lookahead", () => {
  const s = swing();
  // Truncate right after the top: the high cannot be a pivot yet.
  const cut = 100 + 2; // top at bar 99, window for depth 10 is 5
  const fib = autoFib(s.high.slice(0, cut), s.low.slice(0, cut), s.close.slice(0, cut), 0.1, 10);
  assert.ok(!fib || autoFibLevelPrice(fib, 0) < 200, "the unconfirmed top must not anchor level 0");
});

test("defaults are the owner's chart: deviation 3, depth 30, 0–1 on but 0.65 off", () => {
  assert.deepEqual(AUTO_FIB_DEFAULTS, { deviation: 3, depth: 30, reverse: false });
  const on = AUTO_FIB_LEVELS.filter((l) => l.on).map((l) => l.value);
  assert.deepEqual(on, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
});
