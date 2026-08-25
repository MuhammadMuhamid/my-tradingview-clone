import { test } from "node:test";
import assert from "node:assert/strict";
import { PineInterpreter } from "../src/pine/interpreter";
import { INDICATOR_LIBRARY } from "../src/pine/library";
import type { Bars } from "../src/engine/mtf";
import type { Interval } from "../src/types/market";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

const PIVOTS = INDICATOR_LIBRARY.find((s) => s.name === "Pivot Points Standard")!;

function feed(
  interval: Interval, stepMs: number,
  rows: { o: number; h: number; l: number; c: number }[]
): Bars {
  return {
    symbol: "T", interval,
    time: rows.map((_, i) => T0 + i * stepMs),
    open: rows.map((r) => r.o), high: rows.map((r) => r.h),
    low: rows.map((r) => r.l), close: rows.map((r) => r.c),
    volume: rows.map(() => 1),
    closeTime: rows.map((_, i) => T0 + (i + 1) * stepMs - 1),
    length: rows.length,
  };
}

/** Two days of hourly chart bars. */
const chart = feed("1h", 60 * MIN, Array.from({ length: 48 }, () => ({ o: 1, h: 1, l: 1, c: 1 })));
/** Day 0 is the period every level below is derived from. */
const D0 = { o: 10, h: 120, l: 80, c: 100 };
const daily = feed("1d", 24 * 60 * MIN, [D0, { o: 1, h: 2, l: 1, c: 2 }]);

function runPivots(params: Record<string, number | string | boolean>) {
  const interp = new PineInterpreter(PIVOTS.source);
  const out = interp.run({
    bars: chart, startIdx: 0, endIdx: chart.length - 1,
    params, htf: { "1440": daily },
  });
  const at = 30; // well inside day 1, so day 0 is the completed anchor
  const byTitle = new Map(out.plots.map((p) => [p.title, p.data]));
  return (title: string): number | null => byTitle.get(title)?.[at] ?? null;
}

const P = (D0.h + D0.l + D0.c) / 3;
const RANGE = D0.h - D0.l;

test("the library ships a Pivot Points that compiles", () => {
  const { errors, meta } = PineInterpreter.compile(PIVOTS.source);
  assert.deepEqual(errors, []);
  assert.equal(meta.overlay, true);
  assert.deepEqual(meta.securityTimeframes, ["1440"]);
});

test("Traditional levels match the definition exactly", () => {
  const v = runPivots({ typeInput: "Traditional", show45: true });
  assert.equal(v("P"), P);
  assert.equal(v("R1"), 2 * P - D0.l);
  assert.equal(v("S1"), 2 * P - D0.h);
  assert.equal(v("R2"), P + RANGE);
  assert.equal(v("S2"), P - RANGE);
  assert.equal(v("R3"), D0.h + 2 * (P - D0.l));
  assert.equal(v("S3"), D0.l - 2 * (D0.h - P));
  assert.equal(v("R4"), D0.h + 3 * (P - D0.l));
  assert.equal(v("S5"), D0.l - 4 * (D0.h - P));
});

test("Fibonacci uses the documented retracements of the period's range", () => {
  const v = runPivots({ typeInput: "Fibonacci" });
  assert.equal(v("P"), P);
  assert.ok(Math.abs(v("R1")! - (P + 0.382 * RANGE)) < 1e-9);
  assert.ok(Math.abs(v("S2")! - (P - 0.618 * RANGE)) < 1e-9);
  assert.equal(v("R3"), P + RANGE);
});

test("Camarilla is anchored on the close, not the pivot", () => {
  const v = runPivots({ typeInput: "Camarilla" });
  assert.ok(Math.abs(v("R1")! - (D0.c + RANGE * 1.1 / 12)) < 1e-9);
  assert.ok(Math.abs(v("S3")! - (D0.c - RANGE * 1.1 / 4)) < 1e-9);
});

test("Woodie weights the period's open into the pivot", () => {
  const v = runPivots({ typeInput: "Woodie" });
  const woodieP = (D0.h + D0.l + 2 * D0.o) / 4;
  assert.equal(v("P"), woodieP);
  // Different pivot, so the first support moves with it.
  assert.equal(v("S1"), 2 * woodieP - D0.h);
});

test("a level that is switched off plots nothing rather than zero", () => {
  const v = runPivots({ typeInput: "Traditional", show45: false });
  assert.equal(v("R4"), null);
  assert.equal(v("S4"), null);
  // The enabled ones are unaffected.
  assert.equal(v("P"), P);
});

test("levels are unavailable until a period has completed", () => {
  const interp = new PineInterpreter(PIVOTS.source);
  const out = interp.run({
    bars: chart, startIdx: 0, endIdx: chart.length - 1,
    params: {}, htf: { "1440": daily },
  });
  const p = out.plots.find((x) => x.title === "P")!.data;
  // Hour 0 of day 0: no completed daily bar exists behind it yet.
  assert.equal(p[0], null);
  // Deep into day 1 the first day has completed.
  assert.equal(p[30], P);
});
