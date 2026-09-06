/**
 * The correlation matrix, against relationships built by construction.
 *
 * Each case makes two series whose true relationship is known before the code
 * runs — identical, exactly opposite, independent, or overlapping only partly
 * — so a wrong answer is wrong against arithmetic rather than against a
 * previous run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_OBSERVATIONS, betaFromMatrix, correlationMatrix, strongestPairs,
  type MatrixSeries,
} from "../lib/correlationMatrix";

const T0 = 1_700_000_000_000;
const STEP = 60_000;

function times(count: number, from = 0): number[] {
  return Array.from({ length: count }, (_, i) => T0 + (i + from) * STEP);
}

/** A series whose closes follow a given multiplicative path. */
function series(symbol: string, steps: readonly number[], from = 0): MatrixSeries {
  const closes: number[] = [100];
  for (const step of steps) closes.push(closes[closes.length - 1]! * Math.exp(step));
  return { symbol, openTimes: times(closes.length, from), closes };
}

const wobble = (n: number, phase = 0): number[] =>
  Array.from({ length: n }, (_, i) => Math.sin(i / 4 + phase) * 0.01);

test("an empty set and a single instrument both produce a usable table", () => {
  const empty = correlationMatrix([], 100);
  assert.deepEqual(empty.symbols, []);
  assert.deepEqual(empty.cells, []);
  assert.equal(empty.bars, 0);

  const one = correlationMatrix([series("A", wobble(60))], 50);
  assert.deepEqual(one.symbols, ["A"]);
  // Floating point, not doubt: a series against itself sums the same products
  // twice through two different accumulations, so it lands a bit short of 1.
  assert.ok(Math.abs(one.cells[0]![0]!.correlation! - 1) < 1e-12);
  assert.equal(one.observationRange.max, 0, "there are no pairs to have observations");
});

test("an instrument correlates perfectly with itself and with a scaled copy", () => {
  const steps = wobble(80);
  const matrix = correlationMatrix([series("A", steps), series("B", steps)], 60);
  assert.ok(Math.abs(matrix.cells[0]![0]!.correlation! - 1) < 1e-12);
  assert.ok(Math.abs(matrix.cells[0]![1]!.correlation! - 1) < 1e-12);
  // Symmetric, and the same object, so the two halves cannot disagree.
  assert.equal(matrix.cells[0]![1], matrix.cells[1]![0]);
});

test("an exactly opposite instrument correlates at minus one", () => {
  const steps = wobble(80);
  const matrix = correlationMatrix(
    [series("A", steps), series("B", steps.map((s) => -s))], 60);
  assert.ok(Math.abs(matrix.cells[0]![1]!.correlation! + 1) < 1e-12);
});

test("a constant instrument has no correlation, rather than a perfect one", () => {
  const flat: MatrixSeries = {
    symbol: "FLAT", openTimes: times(80), closes: Array.from({ length: 80 }, () => 50),
  };
  const matrix = correlationMatrix([series("A", wobble(79)), flat], 60);
  assert.equal(matrix.cells[0]![1]!.correlation, null,
    "dividing by zero dispersion must not be reported as agreement");
  assert.equal(matrix.cells[1]![1]!.correlation, null);
  assert.equal(matrix.volatility[1], 0);
  // The covariance of a constant with anything is zero, and that IS a number.
  assert.equal(matrix.cells[0]![1]!.covariance, 0);
});

test("covariance and correlation agree with the volatilities beside them", () => {
  const matrix = correlationMatrix(
    [series("A", wobble(200)), series("B", wobble(200, 1.1))], 150);
  const cell = matrix.cells[0]![1]!;
  const rebuilt = cell.covariance! / (matrix.volatility[0]! * matrix.volatility[1]!);
  assert.ok(Math.abs(rebuilt - cell.correlation!) < 1e-12,
    "the table must be internally consistent, or one of the two numbers is decoration");
});

test("beta is derived from the same numbers the table shows", () => {
  const steps = wobble(200);
  // B moves exactly twice as much as A, so beta(B vs A) is 2 and beta(A vs B)
  // is 0.5 — both by construction, not by measurement.
  const matrix = correlationMatrix(
    [series("A", steps), series("B", steps.map((s) => s * 2))], 150);
  assert.ok(Math.abs(betaFromMatrix(matrix, "B", "A")! - 2) < 1e-9);
  assert.ok(Math.abs(betaFromMatrix(matrix, "A", "B")! - 0.5) < 1e-9);
  assert.equal(betaFromMatrix(matrix, "A", "MISSING"), null);
});

test("a pair is computed over the bars both have, and says how many that was", () => {
  /*
   * A runs from bar 0, B from bar 100. They overlap for 60 bars, so a
   * 200-bar window must report 60 observations rather than 200 — and rather
   * than silently filling the first hundred with invented zeros.
   */
  const a = series("A", wobble(160));
  const b = series("B", wobble(60), 100);
  const matrix = correlationMatrix([a, b], 200);
  const cell = matrix.cells[0]![1]!;
  assert.ok(cell.observations > 0 && cell.observations <= 61, `${cell.observations}`);
  assert.ok(cell.observations < 100, "bars A has and B does not are not observations");
  assert.equal(matrix.observationRange.min, cell.observations);
});

test("instruments that never overlap get no number at all", () => {
  const a = series("A", wobble(40));
  const b = series("B", wobble(40), 500);
  const matrix = correlationMatrix([a, b], 200);
  assert.equal(matrix.cells[0]![1]!.correlation, null);
  assert.equal(matrix.cells[0]![1]!.observations, 0);
});

test("too few overlapping bars produce no correlation, and the count says why", () => {
  const a = series("A", wobble(40));
  const b = series("B", wobble(MIN_OBSERVATIONS - 3), 30);
  const matrix = correlationMatrix([a, b], 200);
  const cell = matrix.cells[0]![1]!;
  assert.ok(cell.observations < MIN_OBSERVATIONS);
  assert.equal(cell.correlation, null);
  assert.equal(cell.covariance, null);
});

test("a gap is not a return, so a hole does not become a large move", () => {
  /*
   * B is missing the middle of the window entirely. The bar after the hole
   * must not contribute a return spanning it — that would be a several-hour
   * move put beside another instrument's one-minute moves.
   */
  const closes = [100, 101, 102, 103, 104, 105];
  const b: MatrixSeries = {
    symbol: "B",
    openTimes: [T0, T0 + STEP, T0 + STEP * 2, T0 + STEP * 40, T0 + STEP * 41, T0 + STEP * 42],
    closes,
  };
  const a = series("A", wobble(60));
  const matrix = correlationMatrix([a, b], 200);
  // Two returns before the hole, two after: never a fifth spanning it.
  assert.ok(matrix.cells[0]![1]!.observations <= 4, `${matrix.cells[0]![1]!.observations}`);
});

test("the window is the last N bars, and shortening it changes the answer", () => {
  const steps = [...wobble(100), ...wobble(100, 3.14159)];
  const other = [...wobble(100), ...wobble(100)];
  const long = correlationMatrix([series("A", steps), series("B", other)], 200);
  const short = correlationMatrix([series("A", steps), series("B", other)], 50);
  assert.notEqual(long.cells[0]![1]!.correlation, short.cells[0]![1]!.correlation);
  assert.ok(short.cells[0]![1]!.observations <= 50);
  assert.ok(long.cells[0]![1]!.observations > 50);
});

test("the window is bounded, so a hand-edited setting cannot ask for everything", () => {
  const matrix = correlationMatrix([series("A", wobble(30))], 10_000_000);
  assert.ok(matrix.window <= 5_000);
  assert.equal(correlationMatrix([series("A", wobble(30))], 0).window, 2);
});

test("the strongest pairs are ranked by how related they are, sign included", () => {
  const steps = wobble(300);
  const matrix = correlationMatrix([
    series("A", steps),
    series("B", steps.map((s) => -s)),
    series("C", steps.map((s, i) => Math.sin(i / 3.3 + 2) * 0.01)),
  ], 250);
  const ranked = strongestPairs(matrix, 2);
  assert.equal(ranked.length, 2);
  assert.equal(Math.abs(ranked[0]!.correlation).toFixed(6), "1.000000",
    "an exactly opposite pair is as related as an identical one");
  assert.ok(Math.abs(ranked[0]!.correlation) >= Math.abs(ranked[1]!.correlation));
  assert.equal(strongestPairs(correlationMatrix([], 100)).length, 0);
});

test("adding a thin instrument does not change any other pair's number", () => {
  /*
   * The whole reason the table is pairwise-complete rather than listwise: one
   * short history must not silently rewrite every other cell.
   */
  const a = series("A", wobble(300));
  const b = series("B", wobble(300, 0.7));
  const before = correlationMatrix([a, b], 200).cells[0]![1]!;
  const after = correlationMatrix([a, b, series("C", wobble(15), 280)], 200).cells[0]![1]!;
  assert.deepEqual(after, before);
});
