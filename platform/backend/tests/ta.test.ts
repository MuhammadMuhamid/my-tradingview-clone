import { test } from "node:test";
import assert from "node:assert/strict";
import * as ta from "../src/engine/ta";

const approx = (a: number, b: number, eps = 1e-9): void => {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
};

test("sma: NaN until window filled, exact values after", () => {
  const out = ta.sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  approx(out[2]!, 2);
  approx(out[3]!, 3);
  approx(out[4]!, 4);
});

test("ema: seeds with SMA then recurses with alpha=2/(n+1)", () => {
  const src = [1, 2, 3, 4, 5, 6];
  const out = ta.ema(src, 3);
  assert.ok(Number.isNaN(out[1]));
  approx(out[2]!, 2);            // seed = sma(1,2,3)
  approx(out[3]!, 0.5 * 4 + 0.5 * 2); // alpha = 0.5
  approx(out[4]!, 0.5 * 5 + 0.5 * 3);
});

test("rma: Wilder smoothing with alpha=1/n", () => {
  const out = ta.rma([2, 4, 6, 8], 2);
  approx(out[1]!, 3);            // seed = sma(2,4)
  approx(out[2]!, 0.5 * 6 + 0.5 * 3);
});

test("wma: linear weights, newest heaviest", () => {
  const out = ta.wma([1, 2, 3], 3);
  approx(out[2]!, (1 * 1 + 2 * 2 + 3 * 3) / 6);
});

test("rsi: 100 on a pure uptrend, NaN before seeding", () => {
  const src = Array.from({ length: 20 }, (_, i) => 100 + i);
  const out = ta.rsi(src, 14);
  assert.ok(Number.isNaN(out[13]!)); // change() NaN on bar 0 delays seeding by 1
  approx(out[14]!, 100);
  approx(out[19]!, 100);
});

test("crossover/crossunder", () => {
  const a = [1, 2, 3, 2, 1];
  const b = [2, 2, 2, 2, 2];
  assert.deepEqual(ta.crossover(a, b), [false, false, true, false, false]);
  assert.deepEqual(ta.crossunder(a, b), [false, false, false, false, true]);
});

test("pivotlow: confirms `right` bars after the pivot, strict inequality", () => {
  //           0  1  2  3  4  5  6
  const src = [5, 4, 1, 4, 5, 6, 7];
  const out = ta.pivotlow(src, 2, 2);
  // pivot at index 2 (value 1) confirmed at index 4
  assert.ok(Number.isNaN(out[3]!));
  approx(out[4]!, 1);
  assert.ok(Number.isNaN(out[5]!));
});

test("valuewhen occurrence 0 and 1", () => {
  const cond = [false, true, false, true, false];
  const src = [10, 20, 30, 40, 50];
  const v0 = ta.valuewhen(cond, src, 0);
  const v1 = ta.valuewhen(cond, src, 1);
  approx(v0[1]!, 20);
  approx(v0[2]!, 20);
  approx(v0[3]!, 40);
  approx(v0[4]!, 40);
  assert.ok(Number.isNaN(v1[2]!));
  approx(v1[3]!, 20);
});

test("linreg: exact endpoint on a perfect line", () => {
  const src = [1, 2, 3, 4, 5, 6];
  const out = ta.linreg(src, 4, 0);
  approx(out[3]!, 4);
  approx(out[5]!, 6);
});

test("atr: first bar uses high-low, then Wilder-smooths", () => {
  const high = [10, 12, 11];
  const low = [8, 9, 10];
  const close = [9, 11, 10.5];
  const out = ta.atr(high, low, close, 2);
  // tr(true) = [2, 3, 1]; rma seed at i=1 = (2+3)/2 = 2.5; i=2 = 0.5*1 + 0.5*2.5
  approx(out[1]!, 2.5);
  approx(out[2]!, 1.75);
});

test("highest/lowest windows", () => {
  const out = ta.highest([1, 5, 3, 2, 8], 3);
  assert.ok(Number.isNaN(out[1]!));
  approx(out[2]!, 5);
  approx(out[4]!, 8);
  const lo = ta.lowest([4, 2, 6, 1], 2);
  approx(lo[1]!, 2);
  approx(lo[3]!, 1);
});

test("barssince: NaN before first hit, 0 on the hit", () => {
  const out = ta.barssince([false, true, false, false]);
  assert.ok(Number.isNaN(out[0]!));
  approx(out[1]!, 0);
  approx(out[3]!, 2);
});
