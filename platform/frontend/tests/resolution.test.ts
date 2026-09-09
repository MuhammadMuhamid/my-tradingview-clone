/**
 * A resolution is either published or arithmetic. There is no third thing.
 *
 * This is the file that has to be right for the interval work to mean anything.
 * A 30-second candle assembled from one-minute candles, or a 45-minute candle
 * assembled from hours, is not a smaller timeframe: it is a picture of a bigger
 * one with a smaller label. Every assertion below is aimed at making that
 * impossible rather than merely discouraged.
 *
 * The rules being pinned:
 *
 *   1. sub-minute resolutions fold from `1s` and NEVER from `1m`;
 *   2. a source always divides its resolution exactly, so the bars tile;
 *   3. folding is exact — open, high, low, close and volume are the source's;
 *   4. boundaries come from the grid, not from the bars that happen to exist;
 *   5. one resolution has one spelling, so one identity;
 *   6. the browser's copy of the arithmetic is the server's, byte for byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DAY_MS, MAX_RESOLUTION_MS, NATIVE_RESOLUTIONS, NATIVE_RESOLUTION_MS,
  bucketOpenTime, canonicalResolutionId, describeResolution, explainResolution,
  foldBars, isNativeResolution, isResolution, parseResolution, resolutionMs,
  sourceBarsNeeded, sourceFor, type FoldableBar,
} from "../lib/resolution";
import { INTERVAL_MS, INTERVAL_VALUES } from "../lib/types";

// ── the two copies ──────────────────────────────────────────────────────────

test("the browser's copy of the resolution arithmetic is the server's, byte for byte", () => {
  const browser = readFileSync(join(__dirname, "..", "lib", "resolution.ts"), "utf8");
  const server = readFileSync(
    join(__dirname, "..", "..", "backend", "src", "data", "resolution.ts"), "utf8");
  assert.equal(browser, server,
    "the server folds source bars when it answers a history request and the " +
    "browser folds the same bars again when they arrive as live frames; if " +
    "those two disagreed by one boundary the newest bar would change shape " +
    "every time history reloaded");
  assert.doesNotMatch(browser, /^\s*import\s/m,
    "a module that must be storable twice cannot depend on either side's graph");
});

test("the native list is exactly what the candle store holds", () => {
  assert.deepEqual([...NATIVE_RESOLUTIONS], [...INTERVAL_VALUES],
    "a resolution folded from a source the store does not hold serves nothing");
  for (const id of NATIVE_RESOLUTIONS) {
    assert.equal(NATIVE_RESOLUTION_MS[id], INTERVAL_MS[id as keyof typeof INTERVAL_MS],
      `${id} has two different durations depending on which table is read`);
  }
});

// ── what is a resolution, and what is not ───────────────────────────────────

test("every native interval parses as itself, with nothing to fold", () => {
  for (const id of NATIVE_RESOLUTIONS) {
    const plan = parseResolution(id);
    assert.ok(plan, `${id} must be a resolution`);
    assert.equal(plan.native, true);
    assert.equal(plan.source, id);
    assert.equal(plan.factor, 1);
    assert.equal(plan.ms, NATIVE_RESOLUTION_MS[id]);
    assert.ok(isNativeResolution(id));
  }
});

test("SUB-MINUTE RESOLUTIONS FOLD FROM 1s AND NEVER FROM 1m", () => {
  // The single most important assertion in this file. `1s` is a real Binance
  // Spot kline, published back to 2017 — see the phase evidence — so there is
  // no reason to reach for a coarser source, and every reason not to.
  for (const seconds of [2, 3, 5, 10, 15, 20, 30, 45, 59]) {
    const plan = parseResolution(`${seconds}s`);
    assert.ok(plan, `${seconds}s must be a resolution`);
    assert.equal(plan.source, "1s", `${seconds}s must fold from one-second bars`);
    assert.equal(plan.factor, seconds);
    assert.equal(plan.native, false);
    assert.equal(plan.ms, seconds * 1000);
  }
});

test("a source always divides its resolution exactly, and is the coarsest that does", () => {
  const cases: [string, string, number][] = [
    ["45m", "15m", 3],
    ["10m", "5m", 2],
    ["7m", "1m", 7],
    ["90m", "30m", 3],
    ["3h", "1h", 3],
    ["5h", "1h", 5],
    ["9h", "1h", 9],
    ["30s", "1s", 30],
  ];
  for (const [id, source, factor] of cases) {
    const plan = parseResolution(id);
    assert.ok(plan, `${id} must be a resolution`);
    assert.equal(plan.source, source, `${id} folded from the wrong source`);
    assert.equal(plan.factor, factor);
    assert.equal(plan.factor * NATIVE_RESOLUTION_MS[plan.source]!, plan.ms,
      `${id}'s source bars do not tile it exactly`);
  }
  // Exhaustively: no resolution may name a source that does not divide it.
  for (let minutes = 1; minutes <= 1439; minutes++) {
    const plan = parseResolution(canonicalResolutionId(minutes * 60_000)!);
    assert.ok(plan, `${minutes}m must resolve`);
    assert.equal(plan.ms % NATIVE_RESOLUTION_MS[plan.source]!, 0,
      `${plan.id} folds from ${plan.source}, which does not divide it`);
    assert.ok(NATIVE_RESOLUTION_MS[plan.source]! <= plan.ms);
  }
});

test("a resolution that cannot be built out of whole venue bars is REFUSED", () => {
  for (const bad of [
    "1w", "2w", "1M", "3M",          // calendar objects, not multiples
    "2d", "3d", "7d", "365d",        // beyond the day ceiling
    "24h", "48h",                    // 24h IS 1d; two spellings would be two identities
    "60s", "120s", "60m", "1440m",   // ditto, in the other direction
    "0s", "0m", "-5m", "1.5h",       // not whole positive counts
    "7", "m", "", "  ", "1x", "1S1", // not resolutions at all
    null, undefined, 15, {}, [],
  ] as unknown[]) {
    assert.equal(parseResolution(bad), null,
      `${JSON.stringify(bad)} must not be accepted as a resolution`);
    assert.equal(isResolution(bad), false);
  }
  assert.throws(() => resolutionMs("1w"), /not a resolution/);
});

test("one resolution has one spelling, which is what makes one identity", () => {
  // `60m` and `1h` name the same thing. Accepting both would split the history
  // cache, the live gate and the persisted pane state between two ids.
  assert.equal(canonicalResolutionId(3_600_000), "1h");
  assert.equal(canonicalResolutionId(60_000), "1m");
  assert.equal(canonicalResolutionId(DAY_MS), "1d");
  assert.equal(canonicalResolutionId(2_700_000), "45m");
  assert.equal(canonicalResolutionId(30_000), "30s");
  assert.equal(canonicalResolutionId(1), null, "sub-second has no truthful source");
  assert.equal(canonicalResolutionId(MAX_RESOLUTION_MS + 1), null);

  assert.equal(parseResolution("60m"), null);
  // `1M` is a MONTH everywhere a user has seen an interval written, so an
  // uppercase unit is refused rather than lowercased into a one-minute chart.
  assert.equal(parseResolution("1H"), null);
  assert.equal(parseResolution("1M"), null);
  assert.equal(parseResolution("1D"), null);
});

test("sourceFor refuses what it cannot tile", () => {
  assert.equal(sourceFor(1), null, "nothing divides a millisecond");
  assert.deepEqual(sourceFor(2_700_000), { source: "15m", factor: 3 });
  assert.deepEqual(sourceFor(60_000), { source: "1m", factor: 1 });
});

// ── folding ─────────────────────────────────────────────────────────────────

const bar = (openTime: number, o: number, h: number, l: number, c: number, v: number,
  interval = "15m"): FoldableBar => ({
  symbol: "SOLUSDT", interval, openTime, open: o, high: h, low: l, close: c, volume: v,
  closeTime: openTime + NATIVE_RESOLUTION_MS[interval]! - 1,
});

const FIFTEEN = 900_000;

test("FOLDING IS EXACT: open first, close last, high highest, low lowest, volume summed", () => {
  const plan = parseResolution("45m")!;
  const source = [
    bar(0, 100, 110, 95, 105, 1),
    bar(FIFTEEN, 105, 130, 104, 120, 2),
    bar(FIFTEEN * 2, 120, 121, 80, 90, 4),
  ];
  const [folded, ...rest] = foldBars(source, plan);
  assert.equal(rest.length, 0, "three 15m bars are exactly one 45m bar");
  assert.deepEqual(folded, {
    symbol: "SOLUSDT",
    interval: "45m",
    openTime: 0,
    open: 100,          // the first source bar's open
    high: 130,          // the maximum source high
    low: 80,            // the minimum source low
    close: 90,          // the last source bar's close
    volume: 7,          // the sum
    closeTime: 45 * 60_000 - 1,
    complete: true,
    sourceBarCount: 3,
    expectedSourceBarCount: 3,
  });
});

test("a bucket's boundaries come from the grid, not from the bars that exist", () => {
  const plan = parseResolution("45m")!;
  /*
   * The first source bar of the bucket is missing — a thin pair with no trades
   * in that quarter hour. The bar it produces is a bar with less inside it, at
   * the place the grid says, not a bar somewhere else. Anything else would make
   * a series whose boundaries depended on liquidity.
   */
  const folded = foldBars([bar(FIFTEEN, 105, 130, 104, 120, 2)], plan);
  assert.equal(folded.length, 1);
  assert.equal(folded[0]!.openTime, 0);
  assert.equal(folded[0]!.closeTime, 45 * 60_000 - 1);
  assert.equal(folded[0]!.open, 105);
});

test("the newest bucket is returned incomplete, because that is the forming bar", () => {
  const plan = parseResolution("45m")!;
  const folded = foldBars([
    bar(0, 1, 1, 1, 1, 1), bar(FIFTEEN, 1, 1, 1, 1, 1), bar(FIFTEEN * 2, 1, 1, 1, 1, 1),
    bar(FIFTEEN * 3, 2, 3, 2, 3, 5),
  ], plan);
  assert.equal(folded.length, 2);
  const forming = folded[1]!;
  assert.equal(forming.openTime, 45 * 60_000);
  // Its close time is the GRID's, so `now > closeTime` remains the single
  // definition of "this bar has closed" for derived and native alike.
  assert.equal(forming.closeTime, 90 * 60_000 - 1);
  assert.equal(forming.volume, 5);
});

test("quote volume and trade count are summed when present, and absent when not", () => {
  const plan = parseResolution("45m")!;
  const withExtras = [
    { ...bar(0, 1, 1, 1, 1, 1), quoteVolume: 10, tradeCount: 3 },
    { ...bar(FIFTEEN, 1, 1, 1, 1, 1), quoteVolume: 5, tradeCount: 4 },
  ];
  const [folded] = foldBars(withExtras, plan);
  assert.equal(folded!.quoteVolume, 15);
  assert.equal(folded!.tradeCount, 7);

  const [plain] = foldBars([bar(0, 1, 1, 1, 1, 1), bar(FIFTEEN, 1, 1, 1, 1, 1)], plan);
  assert.equal(plain!.quoteVolume, undefined);
  assert.equal(plain!.tradeCount, undefined);
});

test("a native plan relabels, copies, and marks its single source complete", () => {
  const plan = parseResolution("15m")!;
  const source = [bar(0, 1, 2, 0.5, 1.5, 9)];
  const folded = foldBars(source, plan);
  assert.deepEqual(folded, source.map((item) => ({
    ...item, complete: true, sourceBarCount: 1, expectedSourceBarCount: 1,
  })), "a native resolution is one complete source row");
  assert.notEqual(folded[0], source[0], "and never hands back the caller's object");
});

test("folding tiles a whole day at every size, losing and inventing nothing", () => {
  /*
   * A property, not an example.
   *
   * The plan is built from one-minute source bars for every size rather than
   * taken from `parseResolution`, because a NATIVE plan short-circuits the fold
   * — the server reads its rows directly and there is nothing to aggregate.
   * What is under test here is the aggregation itself, at every scale a chart
   * can ask for.
   */
  const minute = 60_000;
  const source = Array.from({ length: 1440 }, (_, i) =>
    bar(i * minute, i, i + 2, i - 1, i + 1, 1, "1m"));
  for (const id of ["2m", "5m", "45m", "1h", "3h", "8h", "12h", "1d"]) {
    const size = resolutionMs(id);
    const plan = {
      id, ms: size, source: "1m", factor: size / minute, native: false,
      unit: id.slice(-1) as "s" | "m" | "h" | "d", count: Number(id.slice(0, -1)),
    };
    const folded = foldBars(source, plan);
    assert.equal(folded.length, DAY_MS / plan.ms, `${id} does not tile a day`);
    assert.equal(folded.reduce((n, b) => n + b.volume, 0), 1440,
      `${id} lost or invented volume`);
    for (const [i, b] of folded.entries()) {
      assert.equal(b.openTime, i * plan.ms, `${id} bar ${i} is off the grid`);
      assert.equal(b.closeTime, (i + 1) * plan.ms - 1);
      assert.equal(b.interval, id);
    }
  }
});

test("bucketOpenTime floors onto the epoch-UTC grid", () => {
  assert.equal(bucketOpenTime(0, FIFTEEN), 0);
  assert.equal(bucketOpenTime(FIFTEEN - 1, FIFTEEN), 0);
  assert.equal(bucketOpenTime(FIFTEEN, FIFTEEN), FIFTEEN);
});

test("a window asks for one extra bucket, so it is never short by its first bar", () => {
  const derived = parseResolution("45m")!;
  assert.equal(sourceBarsNeeded(derived, 100), 100 * 3 + 3);
  assert.equal(sourceBarsNeeded(parseResolution("15m")!, 100), 100);
});

// ── what a resolution says about itself ─────────────────────────────────────

test("a resolution can say what it is and what it is made of", () => {
  assert.equal(describeResolution("1m"), "1 minute");
  assert.equal(describeResolution("45m"), "45 minutes");
  assert.equal(describeResolution("1d"), "1 day");
  assert.equal(describeResolution("30s"), "30 seconds");

  assert.equal(explainResolution("15m"), "15m bars come from the venue directly");
  assert.equal(explainResolution("45m"), "45m bars are 3 whole 15m bars, aggregated");
  assert.match(explainResolution("1w"), /not a resolution/);
});
