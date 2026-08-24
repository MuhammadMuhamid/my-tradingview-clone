/**
 * A STANDING look-ahead guarantee, not a tool nobody runs.
 *
 * `src/engine/lookaheadAnalysis.ts` answers the question `BE-08` is about —
 * does any chart bar see a value that could not have been known at its close? —
 * and it took a careful reading of three files to even state that question by
 * hand. Having the analysis available is only half of it. This runs it
 * automatically over EVERY feed pair every strategy actually asks for, on the
 * deterministic fixture, so a merge change that introduces look-ahead fails
 * here instead of quietly moving every backtest result.
 *
 * What it can and cannot prove: it checks the ALIGNMENT — that a chart bar is
 * never shown a feed bar that closed after it. It does not execute a strategy,
 * so it cannot catch look-ahead introduced inside a signal function. That is
 * what `tests/strategyGolden.test.ts` pins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedsFor, FIXTURE_SYMBOL, minuteSeries } from "./support/marketFixture";
import { analyseLookahead } from "../src/engine/lookaheadAnalysis";
import { noCorrections } from "../src/engine/corrections";
import type { Interval } from "../src/types/market";
import { maRrV9Module } from "../src/engine/strategies/ma_rr_v9";
import { srTrendV10Module } from "../src/engine/strategies/srtrend_v10";
import { mtfLeanModule } from "../src/engine/strategies/mtf_lean";

const MINUTES = 60 * 24 * 30;   // A month is plenty to cross every 4h boundary.
const BASE = minuteSeries(MINUTES, 20240101);

const CASES = [
  { key: "ma_rr_v9", module: maRrV9Module, chartTf: "15m" as Interval },
  { key: "srtrend_v10", module: srTrendV10Module as unknown as typeof maRrV9Module, chartTf: "1h" as Interval },
  { key: "mtf_lean", module: mtfLeanModule as unknown as typeof maRrV9Module, chartTf: "15m" as Interval },
];

function feedsOf(c: (typeof CASES)[number]): { chart: Interval; feeds: Interval[] } {
  const corrections = noCorrections();
  const p = (c.module.resolveParams as unknown as (x: unknown, k?: unknown) => never)({}, corrections);
  const needs = (c.module.requiredFeeds as unknown as (p: never, tf: Interval, k?: unknown) => { interval: Interval }[])(
    p, c.chartTf, corrections
  );
  return { chart: c.chartTf, feeds: needs.map((n) => n.interval) };
}

for (const c of CASES) {
  test(`${c.key}: NO chart bar sees a feed bar that closed after it`, () => {
    const { chart, feeds } = feedsOf(c);
    const store = feedsFor(BASE, [chart, ...feeds]);
    const chartBars = store.get(FIXTURE_SYMBOL, chart);
    for (const interval of new Set(feeds)) {
      if (interval === chart) continue;
      const report = analyseLookahead(chartBars, store.get(FIXTURE_SYMBOL, interval), "chartClose");
      assert.deepEqual(
        report.violations.slice(0, 3), [],
        `${c.key} ${chart} <- ${interval}: ${report.summary}`
      );
      assert.equal(report.clean, true, report.summary);
      assert.ok(report.barsChecked > 0, "the analysis must have had bars to check");
    }
  });
}

test("THE GUARD IS REAL: given an index that leaks, the analyser says so", () => {
  // Neither shipped convention can leak, for any feed: `buildMergeIndex` picks
  // `j` with `feed.closeTime[j] <= cutoff`, and under `chartClose` that cutoff
  // IS the chart bar's close. That is a structural guarantee, and it is also
  // why the detector cannot be probed with data alone — the probe has to be an
  // index that does leak, which is what a differently-computed merge would
  // produce.
  const store = feedsFor(BASE, ["15m", "1h"]);
  const chart = store.get(FIXTURE_SYMBOL, "15m");
  const feed = store.get(FIXTURE_SYMBOL, "1h");
  // Every chart bar sees the hour it sits INSIDE — the leak BE-08 warns about.
  const leaky = new Int32Array(chart.length);
  for (let i = 0; i < chart.length; i += 1) {
    let j = 0;
    while (j + 1 < feed.length && feed.time[j + 1]! <= chart.time[i]!) j += 1;
    leaky[i] = j;
  }
  const report = analyseLookahead(chart, feed, "chartClose", leaky);
  assert.ok(report.violations.length > 0, "the analyser found no look-ahead in an index that has it");
  assert.equal(report.clean, false);
  assert.match(report.summary, /LOOK-AHEAD/);
  assert.ok(report.violations[0]!.aheadByMs > 0);

  // And the real index over the same pair is clean, which is the contrast.
  assert.equal(analyseLookahead(chart, feed, "chartClose").clean, true);
});

test("the two conventions disagree measurably, which is the size of BE-08", () => {
  const store = feedsFor(BASE, ["15m", "4h"]);
  const report = analyseLookahead(
    store.get(FIXTURE_SYMBOL, "15m"), store.get(FIXTURE_SYMBOL, "4h"), "chartClose"
  );
  assert.ok(
    report.conventionDisagreements > 0,
    "a 15m chart against a 4h feed must have bars where the conventions differ"
  );
  assert.match(report.summary, /\d/);
});

test("a same-interval feed cannot look ahead of itself", () => {
  const store = feedsFor(BASE, ["15m"]);
  const bars = store.get(FIXTURE_SYMBOL, "15m");
  assert.equal(analyseLookahead(bars, bars, "chartClose").clean, true);
});
