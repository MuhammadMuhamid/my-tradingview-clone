import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pivotLevels, nearestLevel, levelByName, isPivotType, type Period,
} from "../src/engine/pivotLevels";

const P: Period = { open: 10, high: 120, low: 80, close: 100 };
const PIVOT = (P.high + P.low + P.close) / 3;   // 100
const RANGE = P.high - P.low;                    // 40

const priceOf = (levels: { name: string; price: number }[], n: string): number =>
  levels.find((l) => l.name === n)!.price;

test("Fibonacci defines P and three levels either side, and no fourth", () => {
  const lv = pivotLevels(P, "Fibonacci");
  assert.equal(priceOf(lv, "P"), PIVOT);
  assert.ok(Math.abs(priceOf(lv, "R1") - (PIVOT + 0.382 * RANGE)) < 1e-9);
  assert.ok(Math.abs(priceOf(lv, "S1") - (PIVOT - 0.382 * RANGE)) < 1e-9);
  assert.ok(Math.abs(priceOf(lv, "R2") - (PIVOT + 0.618 * RANGE)) < 1e-9);
  assert.ok(Math.abs(priceOf(lv, "S2") - (PIVOT - 0.618 * RANGE)) < 1e-9);
  assert.equal(priceOf(lv, "R3"), PIVOT + RANGE);
  assert.equal(priceOf(lv, "S3"), PIVOT - RANGE);
  // The chart hides S4/S5 and R4/R5 for Fibonacci; so does this.
  assert.equal(levelByName(lv, "R4"), null);
  assert.equal(levelByName(lv, "S5"), null);
  assert.equal(lv.length, 7);
});

test("Traditional keeps all eleven levels", () => {
  const lv = pivotLevels(P, "Traditional");
  assert.equal(lv.length, 11);
  assert.equal(priceOf(lv, "R1"), 2 * PIVOT - P.low);
  assert.equal(priceOf(lv, "S3"), P.low - 2 * (P.high - PIVOT));
  assert.equal(priceOf(lv, "R5"), P.high + 4 * (PIVOT - P.low));
});

test("Woodie weights the open into the pivot; Fibonacci does not", () => {
  const woodie = pivotLevels(P, "Woodie");
  assert.equal(priceOf(woodie, "P"), (P.high + P.low + 2 * P.open) / 4);
  assert.notEqual(priceOf(woodie, "P"), priceOf(pivotLevels(P, "Fibonacci"), "P"));
});

test("Camarilla is anchored on the close", () => {
  const lv = pivotLevels(P, "Camarilla");
  assert.ok(Math.abs(priceOf(lv, "R1") - (P.close + RANGE * 1.1 / 12)) < 1e-9);
  assert.ok(Math.abs(priceOf(lv, "S4") - (P.close - RANGE * 1.1 / 2)) < 1e-9);
});

test("an incomplete period yields no levels rather than NaN ones", () => {
  assert.deepEqual(pivotLevels({ open: 1, high: NaN, low: 1, close: 1 }, "Fibonacci"), []);
});

test("nearestLevel finds the closest level to a price", () => {
  const lv = pivotLevels(P, "Fibonacci");
  // Just above the pivot: P is nearer than R1 at ~115.3.
  assert.equal(nearestLevel(lv, 101)!.name, "P");
  const r1 = priceOf(lv, "R1");
  assert.equal(nearestLevel(lv, r1 + 0.1)!.name, "R1");
  assert.equal(nearestLevel([], 100), null);
});

test("level lookup is case-insensitive and misses cleanly", () => {
  const lv = pivotLevels(P, "Fibonacci");
  assert.equal(levelByName(lv, "s1")!.price, priceOf(lv, "S1"));
  assert.equal(levelByName(lv, "nope"), null);
});

test("only the supported type names are accepted", () => {
  assert.equal(isPivotType("Fibonacci"), true);
  assert.equal(isPivotType("DM"), false, "DM is not implemented and must not be silently accepted");
});
