/**
 * Characterization of the timeframe registry. Everything that reasons about
 * bars — the chart API, the MA alert runner, gap detection, the MTF merge —
 * derives its arithmetic from INTERVALS/INTERVAL_MS, so the registry itself is
 * the thing worth pinning: a timeframe added to one list and not the other
 * produces NaN bar maths at runtime rather than a type error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_INTERVALS, INTERVALS, INTERVAL_MS, isAlertInterval, isInterval,
} from "../src/types/market";
import { NATIVE_RESOLUTIONS, NATIVE_RESOLUTION_MS } from "../src/data/resolution";

test("the stored timeframe set is exactly these thirteen, in ascending order", () => {
  assert.deepEqual([...INTERVALS], [
    "1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d",
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
    "1s": 1_000,
    "1m": MIN, "3m": 3 * MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN,
    "1h": 60 * MIN, "2h": 120 * MIN, "4h": 240 * MIN, "6h": 360 * MIN,
    "8h": 480 * MIN, "12h": 720 * MIN, "1d": 1440 * MIN,
  };
  for (const i of INTERVALS) assert.equal(INTERVAL_MS[i], expected[i], i);
});

test("every interval divides a day exactly, so bar grids align to UTC midnight", () => {
  const DAY = 86_400_000;
  for (const i of INTERVALS) assert.equal(DAY % INTERVAL_MS[i], 0, i);
});

test("isInterval accepts only registry members", () => {
  for (const i of INTERVALS) assert.equal(isInterval(i), true, i);
  // `45m` is a real chart RESOLUTION now — three stored 15m bars — but it is
  // not a stored interval, and the distinction is the whole of what keeps a
  // derived chart out of the alert runner and the backtester.
  for (const bad of ["1M", "1w", "45m", "30s", "3d", "", "1h ", "1H"]) {
    assert.equal(isInterval(bad), false, JSON.stringify(bad));
  }
});

test("the store's own list and the resolution module's native list are one list", () => {
  /*
   * Two lists that must agree, in two files that cannot import each other:
   * `data/resolution.ts` is byte-identical with the browser's copy and therefore
   * imports nothing, so it declares the native set itself. A resolution folded
   * from a source the store does not hold would read an empty series and serve
   * a blank chart, which is exactly the failure this pins.
   */
  assert.deepEqual([...NATIVE_RESOLUTIONS], [...INTERVALS]);
  for (const i of INTERVALS) assert.equal(NATIVE_RESOLUTION_MS[i], INTERVAL_MS[i], i);
});

test("an alert may be armed on every stored interval except one-second bars", () => {
  assert.deepEqual([...ALERT_INTERVALS], INTERVALS.filter((i) => i !== "1s"));
  assert.equal(isAlertInterval("1s"), false,
    "the runner throttles intrabar evaluation to one sample every two seconds, " +
    "so it could not honour once-per-bar-close on a one-second bar");
  assert.equal(isAlertInterval("15m"), true);
  assert.equal(isAlertInterval("45m"), false, "not a stored interval at all");
});
