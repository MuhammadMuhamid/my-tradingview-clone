import { test } from "node:test";
import assert from "node:assert/strict";
import { PineInterpreter } from "../src/pine/interpreter";
import type { Bars } from "../src/engine/mtf";
import type { Interval } from "../src/types/market";

const MIN = 60_000;

/** A synthetic feed: `count` bars of `stepMs`, with values driven by `f`. */
function feed(
  interval: Interval, startMs: number, stepMs: number, count: number,
  f: (i: number) => { o: number; h: number; l: number; c: number }
): Bars {
  const time: number[] = [], open: number[] = [], high: number[] = [];
  const low: number[] = [], close: number[] = [], volume: number[] = [], closeTime: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = f(i);
    time.push(startMs + i * stepMs);
    open.push(v.o); high.push(v.h); low.push(v.l); close.push(v.c);
    volume.push(1);
    closeTime.push(startMs + (i + 1) * stepMs - 1);
  }
  return { symbol: "T", interval, time, open, high, low, close, volume, closeTime, length: count };
}

const T0 = Date.UTC(2026, 0, 1);
/** Four 15m bars per hour, 8 hours. */
const chart = feed("15m", T0, 15 * MIN, 32, (i) => ({ o: i, h: i, l: i, c: i }));
/** Hourly bars whose high is 100 + the hour index, so each hour is identifiable. */
const hourly = feed("1h", T0, 60 * MIN, 8, (i) => ({ o: 0, h: 100 + i, l: 200 + i, c: 300 + i }));

function run(source: string, htf?: Record<string, Bars>) {
  const interp = new PineInterpreter(source);
  return interp.run({ bars: chart, startIdx: 0, endIdx: chart.length - 1, htf });
}

test("compile reports the timeframes a script needs", () => {
  const { meta, errors } = PineInterpreter.compile(`//@version=6
indicator("t")
plot(request.security(syminfo.tickerid, "60", high))`);
  assert.deepEqual(errors, []);
  assert.deepEqual(meta.securityTimeframes, ["60"]);
});

test("the chart's own timeframe needs no extra feed", () => {
  const { meta } = PineInterpreter.compile(`//@version=6
indicator("t")
plot(request.security(syminfo.tickerid, timeframe.period, close))`);
  assert.deepEqual(meta.securityTimeframes, []);
});

test("a requested timeframe with no feed supplied fails by name", () => {
  assert.throws(
    () => run(`//@version=6\nindicator("t")\nplot(request.security(syminfo.tickerid, "60", high))`),
    /no feed loaded/
  );
});

test("higher-timeframe values are held flat across the chart bars of that period", () => {
  const out = run(
    `//@version=6\nindicator("t")\nplot(request.security(syminfo.tickerid, "60", high), "h")`,
    { "60": hourly }
  );
  const series = out.plots[0]!.data;
  // Bars 4..7 are the second hour; all four must read the same hourly value.
  const second = series.slice(4, 8);
  assert.equal(new Set(second).size, 1, `expected one value across the hour, got ${second}`);
});

test("only CLOSED higher-timeframe bars are visible — no lookahead", () => {
  const out = run(
    `//@version=6\nindicator("t")\nplot(request.security(syminfo.tickerid, "60", high), "h")`,
    { "60": hourly }
  );
  const series = out.plots[0]!.data;
  // The first hour has no completed hourly bar behind it.
  assert.equal(series[0], null, "first chart bar must have no HTF value yet");
  // Chart bars of hour 1 (index 4..7) see hour 0's high, which is 100 — NOT
  // hour 1's 101. Reading 101 there would be the classic lookahead leak.
  assert.equal(series[4], 100);
  assert.equal(series[7], 100);
  assert.equal(series[8], 101);
});

test("two different timeframes can be requested from one script", () => {
  const twoHourly = feed("2h", T0, 120 * MIN, 4, (i) => ({ o: 0, h: 500 + i, l: 0, c: 0 }));
  const out = run(
    `//@version=6
indicator("t")
plot(request.security(syminfo.tickerid, "60", high), "a")
plot(request.security(syminfo.tickerid, "120", high), "b")`,
    { "60": hourly, "120": twoHourly }
  );
  const a = out.plots.find((p) => p.title === "a")!.data;
  const b = out.plots.find((p) => p.title === "b")!.data;
  assert.equal(a[8], 101, "hourly series should be reading hour 1");
  assert.equal(b[8], 500, "2h series should still be reading its first bar");
});

test("an expression, not just a bare series, is evaluated on the HTF feed", () => {
  const out = run(
    `//@version=6\nindicator("t")\nplot(request.security(syminfo.tickerid, "60", ta.sma(high, 2)), "s")`,
    { "60": hourly }
  );
  const series = out.plots[0]!.data;
  // At chart bar 8 the last closed hourly bar is index 1, so the 2-period SMA
  // of highs is (100 + 101) / 2. Computed on the HOURLY series, not the chart.
  assert.equal(series[8], 100.5);
});
