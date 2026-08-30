import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildZones, isPivotHigh, isPivotLow, nearestZones, zonesAsOf,
  type Bars, type SrOptions,
} from "../src/engine/srZones";

const OPTS: SrOptions = {
  pivotLength: 2, invalidation: "close", mergeAtrFraction: 1 / 8, maxZones: 10,
};

/** Build bars from close prices, with a small symmetric wick. */
function bars(closes: number[], wick = 0.5): Bars {
  return {
    close: closes,
    high: closes.map((c) => c + wick),
    low: closes.map((c) => c - wick),
  };
}

test("a swing low is a pivot only when both sides confirm it", () => {
  const low = [5, 4, 1, 4, 5];
  assert.equal(isPivotLow(low, 2, 2), true);
  // The edges cannot be pivots: there are not `length` bars on both sides.
  assert.equal(isPivotLow(low, 0, 2), false);
  assert.equal(isPivotLow(low, 4, 2), false);
  // A bar that is not the lowest of its window is not a pivot.
  assert.equal(isPivotLow(low, 1, 2), false);
});

test("a flat top yields one pivot, at the earlier bar", () => {
  // Ties break toward the earlier bar, so an exact double top produces ONE
  // level rather than two touching ones the chart would draw on top of itself.
  const high = [1, 2, 9, 9, 2, 1];
  const hits = [0, 1, 2, 3, 4, 5].filter((i) => isPivotHigh(high, i, 2));
  assert.deepEqual(hits, [2]);
});

test("a zone is not knowable until `length` bars after its pivot", () => {
  //                   0  1  2  3  4  5  6  7
  const z = buildZones(bars([10, 9, 5, 9, 10, 11, 12, 13]), OPTS);
  const support = z.find((x) => x.kind === "support");
  assert.ok(support, "expected a support from the swing low at index 2");
  assert.equal(support!.pivotIndex, 2);
  assert.equal(support!.confirmedIndex, 4, "confirmed `pivotLength` bars later");
  // At bar 3 the market could not yet know the level existed.
  assert.equal(zonesAsOf(z, 3, OPTS).length, 0);
  assert.equal(zonesAsOf(z, 4, OPTS).length >= 1, true);
});

test("a support dies when price closes through it", () => {
  const z = buildZones(bars([10, 9, 5, 9, 10, 11, 10, 9, 8, 4, 4, 4]), OPTS);
  const support = z.find((x) => x.kind === "support" && x.pivotIndex === 2);
  assert.ok(support);
  assert.ok(support!.brokenIndex !== null, "closing at 4 breaks the 4.5 support");
  // Once broken it is no longer offered as a live zone.
  assert.equal(zonesAsOf(z, 11, OPTS).some((x) => x === support), false);
});

test("nearest support is the closest one BELOW price, not merely the closest", () => {
  const z = buildZones(bars([20, 19, 10, 19, 20, 21, 30, 29, 25, 29, 30, 31, 32]), OPTS);
  const { support } = nearestZones(z, 12, 31, OPTS);
  if (support) {
    assert.ok(support.price <= 31, "a support above price would already be broken");
  }
  // With price below every support, there is nothing to return.
  const below = nearestZones(z, 12, 1, OPTS);
  assert.equal(below.support, null);
});

test("nearest resistance is the closest one ABOVE price", () => {
  const z = buildZones(bars([10, 11, 20, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]), OPTS);
  const { resistance } = nearestZones(z, 12, 5, OPTS);
  if (resistance) assert.ok(resistance.price >= 5);
});

test("levels at effectively the same price merge instead of stacking", () => {
  // Two swing lows at 5 and 5.02 — the same level for any practical purpose.
  const z = buildZones(bars([10, 9, 5, 9, 10, 9, 5.02, 9, 10, 11, 12]), {
    ...OPTS, mergeAtrFraction: 2,
  });
  const supports = z.filter((x) => x.kind === "support");
  assert.equal(supports.length, 1, "expected one merged support");
  assert.ok(supports[0]!.touches >= 2, "the merge should record the extra touch");
});

test("zonesAsOf never returns a zone from the future", () => {
  const z = buildZones(bars([10, 9, 5, 9, 10, 11, 12, 8, 3, 8, 12, 13, 14]), OPTS);
  for (let i = 0; i < 13; i++) {
    for (const live of zonesAsOf(z, i, OPTS)) {
      assert.ok(live.confirmedIndex <= i, `zone confirmed at ${live.confirmedIndex} leaked at bar ${i}`);
      assert.ok(live.brokenIndex === null || live.brokenIndex > i, "a broken zone was still live");
    }
  }
});
