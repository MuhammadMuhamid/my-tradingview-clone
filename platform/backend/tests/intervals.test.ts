/**
 * Characterization of the timeframe registry. Everything that reasons about
 * bars — the chart API, the MA alert runner, gap detection, the MTF merge —
 * derives its arithmetic from INTERVALS/INTERVAL_MS, so the registry itself is
 * the thing worth pinning: a timeframe added to one list and not the other
 * produces NaN bar maths at runtime rather than a type error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INTERVALS, INTERVAL_MS, isInterval } from "../src/types/market";

test("the supported timeframe set is exactly these eleven, in ascending order", () => {
  assert.deepEqual([...INTERVALS], [
    "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d",
  ]);
  const ms = INTERVALS.map((i) => INTERVAL_MS[i]);
  for (let i = 1; i < ms.length; i++) {
    assert.ok(ms[i]! > ms[i - 1]!, `${INTERVALS[i]} must be longer than ${INTERVALS[i - 1]}`);
  }
});

test("every interval has a millisecond length and no extras exist", () => {
  assert.deepEqual(Object.keys(INTERVAL_MS).sort(), [...INTERVALS].sort());
  for (const i of INTERVALS) {
    assert.ok(Number.isInteger(INTERVAL_MS[i]) && INTERVAL_MS[i] > 0, i);
  }
});

test("interval lengths match their names", () => {
  const MIN = 60_000;
  const expected: Record<string, number> = {
    "1m": MIN, "3m": 3 * MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN,
    "1h": 60 * MIN, "2h": 120 * MIN, "4h": 240 * MIN, "6h": 360 * MIN,
    "12h": 720 * MIN, "1d": 1440 * MIN,
  };
  for (const i of INTERVALS) assert.equal(INTERVAL_MS[i], expected[i], i);
});

test("every interval divides a day exactly, so bar grids align to UTC midnight", () => {
  const DAY = 86_400_000;
  for (const i of INTERVALS) assert.equal(DAY % INTERVAL_MS[i], 0, i);
});

test("isInterval accepts only registry members", () => {
  for (const i of INTERVALS) assert.equal(isInterval(i), true, i);
  for (const bad of ["1M", "1w", "45m", "8h", "", "1h ", "1H"]) {
    assert.equal(isInterval(bad), false, JSON.stringify(bad));
  }
});
