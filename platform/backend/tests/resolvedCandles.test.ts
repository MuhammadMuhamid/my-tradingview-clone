/**
 * Serving a resolution the candle store does not hold.
 *
 * The store holds native Binance klines. A chart may be on `45m` or `30s`, and
 * the only honest way to answer that is to read the source rows and add them
 * up — which is what `resolveWindow` does, and what these pin.
 *
 * What could go wrong, and is therefore asserted:
 *
 *   the fold is not exact, so a derived bar's OHLCV is not its source's;
 *   the first bucket is served half-built, drawn full-width beside whole bars;
 *   the read asks for as many SOURCE rows as it wants DERIVED bars, and returns
 *     a fortieth of the window a caller asked for;
 *   a resolution names a source the store does not hold, and serves nothing
 *     while looking like it served something.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SOURCE_ROWS, resolveWindow, sourceInterval,
} from "../src/data/resolvedCandles";
import {
  parseResolution, sourceBarsNeeded, type FoldableBar,
} from "../src/data/resolution";

const FIFTEEN = 900_000;

function source(count: number, step = FIFTEEN, from = 0): FoldableBar[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = from + i * step;
    return {
      symbol: "SOLUSDT", interval: "15m", openTime,
      open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i, volume: 1,
      quoteVolume: 10, tradeCount: 2,
      closeTime: openTime + step - 1,
    };
  });
}

test("a native resolution is passed through, relabelled and copied", () => {
  const plan = parseResolution("15m")!;
  const rows = source(3);
  const out = resolveWindow(rows, plan);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((b) => b.openTime), rows.map((b) => b.openTime));
  assert.notEqual(out[0], rows[0], "the repository's rows must not be handed out");
});

test("A DERIVED BAR IS ITS SOURCE BARS, EXACTLY", () => {
  const plan = parseResolution("45m")!;
  const out = resolveWindow(source(6), plan);
  assert.equal(out.length, 2, "six 15m bars are two 45m bars");

  const first = out[0]!;
  assert.equal(first.interval, "45m", "the bar names the resolution it IS");
  assert.equal(first.openTime, 0);
  assert.equal(first.closeTime, 45 * 60_000 - 1);
  assert.equal(first.open, 100, "the first source bar's open");
  assert.equal(first.close, 107, "the last source bar's close");
  assert.equal(first.high, 112, "the maximum source high");
  assert.equal(first.low, 90, "the minimum source low");
  assert.equal(first.volume, 3, "the sum");
  assert.equal(first.quoteVolume, 30);
  assert.equal(first.tradeCount, 6);
});

test("a leading bucket the read began inside is dropped, not served half-built", () => {
  const plan = parseResolution("45m")!;
  /*
   * The read starts at the SECOND source bar of the first bucket. That bucket
   * has two thirds of its span, and a bar drawn at full width beside whole ones
   * would be a bar whose body means something different from its neighbours'.
   */
  const rows = source(5, FIFTEEN, FIFTEEN);
  const out = resolveWindow(rows, plan);
  assert.equal(out[0]!.openTime, 45 * 60_000,
    "the partial leading bucket must not be returned");
  assert.equal(out.length, 1);

  // When the read DOES begin on a bucket boundary, nothing is dropped.
  assert.equal(resolveWindow(source(3), plan)[0]!.openTime, 0);
});

test("the newest bucket is returned incomplete — that one is the forming bar", () => {
  const plan = parseResolution("45m")!;
  const out = resolveWindow(source(4), plan, undefined, 45 * 60_000 + 1);
  assert.equal(out.length, 2);
  const forming = out[1]!;
  assert.equal(forming.openTime, 45 * 60_000);
  assert.equal(forming.volume, 1, "one of its three source bars exists so far");
  // Its close time is the grid's, so `now > closeTime` stays the single
  // definition of "closed" for a derived bar and a native one alike.
  assert.equal(forming.closeTime, 90 * 60_000 - 1);
});

test("FC1-H2 rejects a missing constituent in every closed bucket position", () => {
  const plan = parseResolution("45m")!;
  for (const missing of [3, 4, 5]) {
    const rows = source(9).filter((_, index) => index !== missing);
    assert.throws(
      () => resolveWindow(rows, plan, undefined, 3 * plan.ms),
      /closed 45m candle.*incomplete/,
      `missing constituent ${missing}`
    );
  }
});

test("FC1-H2 newest incomplete bucket is marked only while genuinely forming", () => {
  const plan = parseResolution("45m")!;
  const rows = source(4);
  const forming = resolveWindow(rows, plan, undefined, plan.ms + 1).at(-1)!;
  assert.equal(forming.complete, false);
  assert.equal(forming.sourceBarCount, 1);
  assert.equal(forming.expectedSourceBarCount, 3);
  assert.throws(() => resolveWindow(rows, plan, undefined, 2 * plan.ms + 1), /incomplete/);
});

test("FC1-H2 rejects duplicate, out-of-order, and off-grid source rows", () => {
  const plan = parseResolution("45m")!;
  const rows = source(3);
  assert.throws(() => resolveWindow([rows[0]!, rows[0]!], plan), /duplicate or out-of-order/);
  assert.throws(() => resolveWindow([rows[1]!, rows[0]!], plan), /out-of-order/);
  assert.throws(() => resolveWindow([{ ...rows[0]!, openTime: 1 }], plan), /off-grid/);
});

test("the limit counts BARS OF THE RESOLUTION, not source rows", () => {
  const plan = parseResolution("45m")!;
  /*
   * Ten thousand bars on a 45-minute chart is ten thousand 45-minute bars.
   * Reading ten thousand source rows and folding them would have returned a
   * third of the window, on every derived chart, silently.
   */
  assert.equal(sourceBarsNeeded(plan, 100), 303);
  const out = resolveWindow(source(303), plan, 100);
  assert.equal(out.length, 100);
  assert.equal(out[out.length - 1]!.openTime, 100 * plan.ms);
});

test("the source read is capped, so an extreme resolution returns fewer bars — not wrong ones", () => {
  const plan = parseResolution("1439m")!;
  assert.equal(plan.source, "1m");
  assert.equal(plan.factor, 1439);
  // 10,000 bars of a 1,439-minute resolution would be fourteen million rows.
  assert.ok(sourceBarsNeeded(plan, 10_000) > MAX_SOURCE_ROWS);
  assert.equal(MAX_SOURCE_ROWS, 200_000);
});

test("a resolution whose source the store does not hold FAILS LOUDLY", () => {
  assert.equal(sourceInterval(parseResolution("45m")!), "15m");
  assert.equal(sourceInterval(parseResolution("1s")!), "1s");
  /*
   * `resolution.ts` is byte-identical with the browser's copy and imports
   * nothing, so it can only call a source a `string`. If an edit ever added a
   * native resolution there without adding it to `INTERVALS`, every read of it
   * would return an empty series — a blank chart that looks like a quiet
   * market. It throws instead.
   */
  assert.throws(
    () => sourceInterval({
      id: "9x", ms: 1, source: "9x", factor: 1, native: true, unit: "s", count: 1,
    }),
    /the candle store does not hold/);
});
