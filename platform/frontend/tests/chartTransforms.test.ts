/**
 * Heikin Ashi and Renko: the arithmetic, and the safety properties that make
 * them safe to draw on a live trading chart.
 *
 * These are pure-function tests over `lib/chartTransforms`. That is deliberate:
 * both transforms are recursive, so the interesting failures are not "the
 * wrong number appeared once" but "the tail was computed differently from the
 * whole", "a bar saw the future", and "a replayed prefix leaked bars the user
 * has not reached yet". Those are properties of the fold, and a property is
 * what a test can hold.
 *
 * The boundary tests at the end are the ones that matter most: nothing here
 * may become an input to an order, an alert, a strategy or a stored candle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createRenkoState, createTransformCursor, DEFAULT_RENKO_ATR_PERIOD, foldRenko,
  heikinAshiBar, heikinAshiBars, renkoBricks, transformAll, transformStep,
  type OhlcBar,
} from "../lib/chartTransforms";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

const bar = (i: number, o: number, h: number, l: number, c: number): OhlcBar =>
  ({ openTime: T0 + i * MINUTE, open: o, high: h, low: l, close: c });

/** A deterministic, non-repeating source series. No randomness anywhere here. */
function series(count: number, shape: (i: number) => number): OhlcBar[] {
  const out: OhlcBar[] = [];
  for (let i = 0; i < count; i++) {
    const c = shape(i);
    const previous = i === 0 ? c : shape(i - 1);
    out.push(bar(i, previous, Math.max(previous, c) + 0.5, Math.min(previous, c) - 0.5, c));
  }
  return out;
}

const clone = (bars: readonly OhlcBar[]): OhlcBar[] => bars.map((b) => ({ ...b }));

// ── Heikin Ashi ────────────────────────────────────────────────────────────

test("HEIKIN ASHI matches the rule on a worked fixture", () => {
  // Chosen so every value is exact in binary floating point and can be checked
  // by hand against the definition rather than against this implementation.
  const source: OhlcBar[] = [
    bar(0, 100, 110, 90, 104),
    bar(1, 104, 112, 100, 108),
    bar(2, 108, 116, 102, 106),
  ];
  const ha = heikinAshiBars(source);

  // Bar 0 — the first-bar rule: haOpen is the source bar's own midpoint.
  assert.equal(ha[0]!.close, (100 + 110 + 90 + 104) / 4);   // 101
  assert.equal(ha[0]!.open, (100 + 104) / 2);               // 102
  assert.equal(ha[0]!.high, 110);                           // max(110, 102, 101)
  assert.equal(ha[0]!.low, 90);                             // min(90, 102, 101)

  // Bar 1 — the recursive rule: haOpen is the PREVIOUS ha bar's midpoint, not
  // the previous source bar's.
  assert.equal(ha[1]!.close, (104 + 112 + 100 + 108) / 4);  // 106
  assert.equal(ha[1]!.open, (102 + 101) / 2);               // 101.5
  assert.equal(ha[1]!.high, 112);
  assert.equal(ha[1]!.low, 100);

  assert.equal(ha[2]!.close, (108 + 116 + 102 + 106) / 4);  // 108
  assert.equal(ha[2]!.open, (101.5 + 106) / 2);             // 103.75
  assert.equal(ha[2]!.high, 116);
  assert.equal(ha[2]!.low, 102);

  // The extremes are clamped by the ha body, not only by the source bar: a
  // carried-over haOpen outside the source range widens the bar it is drawn on.
  const above = heikinAshiBar({ open: 200, close: 200 }, bar(3, 100, 101, 99, 100));
  assert.equal(above.high, 200, "haHigh must include haOpen when it exceeds the source high");
  assert.equal(above.low, 99, "haLow is the source low when nothing derived goes under it");
  const below = heikinAshiBar({ open: 10, close: 10 }, bar(3, 100, 101, 99, 100));
  assert.equal(below.low, 10, "haLow must include haOpen when it falls under the source low");
  assert.equal(below.high, 101);
});

test("HEIKIN ASHI keeps the canonical timestamps and never touches the source", () => {
  const source = series(50, (i) => 100 + Math.sin(i / 3) * 5);
  const before = JSON.stringify(source);
  const ha = heikinAshiBars(source);
  assert.equal(JSON.stringify(source), before, "the source candles were mutated");
  assert.equal(ha.length, source.length, "Heikin Ashi is one bar per canonical bar");
  for (let i = 0; i < ha.length; i++) {
    assert.equal(ha[i]!.openTime, source[i]!.openTime);
  }
});

test("HEIKIN ASHI cannot see the future", () => {
  const source = series(60, (i) => 100 + i * 0.7);
  const baseline = heikinAshiBars(source);

  // Rewrite everything after bar 30 into a different market. Bars 0..30 must
  // be bit-identical, which is only possible if none of them read forward.
  const altered = clone(source);
  for (let i = 31; i < altered.length; i++) {
    altered[i] = bar(i, 500, 900, 100, 500 + i);
  }
  const after = heikinAshiBars(altered);
  for (let i = 0; i <= 30; i++) {
    assert.deepEqual(after[i], baseline[i], `bar ${i} changed when a LATER bar changed`);
  }
});

test("HEIKIN ASHI clipped for replay is the prefix of the full series", () => {
  const source = series(80, (i) => 100 + Math.cos(i / 5) * 8 + i * 0.2);
  const full = heikinAshiBars(source);
  for (const horizon of [0, 1, 2, 17, 79, 80]) {
    const clipped = heikinAshiBars(source.slice(0, horizon));
    assert.deepEqual(clipped, full.slice(0, horizon),
      `a replay clipped at ${horizon} bars did not match the same prefix of the whole`);
  }
});

// ── Renko ──────────────────────────────────────────────────────────────────

const renkoParams = { atrPeriod: DEFAULT_RENKO_ATR_PERIOD };

/**
 * Fourteen bars whose true range is exactly `range` and whose close never
 * moves, so ATR(14) is exactly `range` and the anchor is exactly `price`.
 *
 * The first bar has no previous close and contributes `high - low`; every
 * other contributes `max(high - low, |high - prev|, |low - prev|)`, which is
 * the same `range` because the close is flat. Nothing here is approximate.
 */
function atrSeed(price: number, range: number, count = DEFAULT_RENKO_ATR_PERIOD): OhlcBar[] {
  return Array.from({ length: count }, (_, i) =>
    bar(i, price, price + range / 2, price - range / 2, price));
}

/**
 * A bar that simply closes at `to` from `from`, drawn as tightly as possible
 * around the move so its true range is exactly `|to - from|`.
 *
 * That is what makes these fixtures checkable by hand: a move of one ATR
 * leaves ATR unchanged, and a larger move raises it by a known amount — which
 * it must, because the brick size is the ATR *at* this bar.
 */
function moveBar(index: number, from: number, to: number): OhlcBar {
  return bar(index, from, Math.max(from, to), Math.min(from, to), to);
}

/**
 * A bar that swings a full `range` around `from` and settles at `to`, so its
 * true range is exactly `range` even though its close barely moved. Used to
 * put a bar on the chart that must NOT draw a brick without disturbing ATR.
 */
function holdBar(index: number, from: number, to: number, range: number): OhlcBar {
  return bar(index, from, from + range / 2, from - range / 2, to);
}

/** ATR after `atrSeed(_, range)` plus one bar whose true range is `tr`. */
const atrAfterMove = (range: number, tr: number, period = DEFAULT_RENKO_ATR_PERIOD): number =>
  (range * (period - 1) + tr) / period;

test("RENKO fabricates nothing before ATR(14) exists", () => {
  // Thirteen bars that move six hundred points. There is plenty of movement;
  // what is missing is a brick size, and a size guessed from short history is
  // an invented one.
  const short = Array.from({ length: 13 }, (_, i) => moveBar(i, 100 + i * 50, 150 + i * 50));
  assert.equal(renkoBricks(short, renkoParams).length, 0,
    "thirteen bars is not enough history for ATR(14)");

  // The fourteenth bar completes the seed — and is spent anchoring, not drawn.
  assert.equal(renkoBricks(atrSeed(100, 2), renkoParams).length, 0,
    "the bar that first makes ATR available has no prior brick to measure from");
});

test("RENKO brick size is ATR(14), and one whole move makes one whole brick", () => {
  // Seed: ATR = 2 exactly, anchor = 100. Every bar below has a true range of
  // exactly 2, so the brick size stays 2 and the thresholds are whole numbers.
  const source = [
    ...atrSeed(100, 2),
    holdBar(14, 100, 101, 2),   // swings a full range but closes short of 102
    moveBar(15, 101, 103),      // crosses 102 — one brick, not two
    moveBar(16, 103, 105),      // crosses 104 — one more
  ];
  const bricks = renkoBricks(source, renkoParams);

  assert.equal(bricks.length, 2, "a close short of the threshold must draw nothing");
  assert.ok(bricks.every((b) => b.size === 2), "the brick size is the ATR(14) value at that bar");
  assert.deepEqual([bricks[0]!.open, bricks[0]!.close], [100, 102]);
  assert.equal(bricks[0]!.direction, 1);
  // Bricks are bodies: a wick would claim a price the brick never measured.
  assert.equal(bricks[0]!.high, 102);
  assert.equal(bricks[0]!.low, 100);
  assert.deepEqual([bricks[1]!.open, bricks[1]!.close], [102, 104]);
  // Each brick is stamped with the canonical bar that completed it.
  assert.equal(bricks[0]!.sourceOpenTime, T0 + 15 * MINUTE);
  assert.equal(bricks[1]!.sourceOpenTime, T0 + 16 * MINUTE);
});

test("RENKO turns one large move into several bricks, in order", () => {
  // Seed ATR = 14, anchor = 100. One bar closes 98 higher, so its own true
  // range is 98 and ATR becomes (14 x 13 + 98) / 14 = 20 exactly. A 98-point
  // move contains four whole 20-point bricks and part of a fifth.
  const source = [...atrSeed(100, 14), moveBar(14, 100, 198)];
  assert.equal(atrAfterMove(14, 98), 20);

  const bricks = renkoBricks(source, renkoParams);
  assert.equal(bricks.length, 4);
  assert.ok(bricks.every((b) => b.size === 20 && b.direction === 1));
  assert.deepEqual(bricks.map((b) => [b.open, b.close]),
    [[100, 120], [120, 140], [140, 160], [160, 180]]);

  // They all came from one canonical bar, and they are still strictly ordered
  // in time so the renderer can draw them at all.
  assert.ok(bricks.every((b) => b.sourceOpenTime === T0 + 14 * MINUTE));
  for (let i = 1; i < bricks.length; i++) {
    assert.ok(bricks[i]!.openTime > bricks[i - 1]!.openTime,
      "bricks from one bar must still be strictly increasing in time");
  }
  assert.equal(bricks[0]!.openTime, T0 + 14 * MINUTE, "the first brick keeps its bar's own time");
});

test("RENKO reverses only after two brick sizes against the trend", () => {
  // ATR pinned at 2 by moves of exactly 2. Anchor 100, up to 104, then back.
  const source = [
    ...atrSeed(100, 2),
    moveBar(14, 100, 102),
    moveBar(15, 102, 104),
    moveBar(16, 104, 102),   // one size back — NOT a reversal
    moveBar(17, 102, 100),   // two sizes back — a reversal
  ];
  const bricks = renkoBricks(source, renkoParams);

  assert.equal(bricks.length, 3);
  assert.deepEqual(
    bricks.map((b) => [b.direction, b.open, b.close]),
    [[1, 100, 102], [1, 102, 104], [-1, 102, 100]]
  );
  // The reversal brick starts at the last brick's OPEN — two sizes from its
  // close — which is what makes the reversal a two-brick move.
  assert.equal(bricks[2]!.open, bricks[1]!.open);
  assert.equal(bricks[2]!.sourceOpenTime, T0 + 17 * MINUTE,
    "the bar one size back must not have drawn anything");
});

test("RENKO continues down after a reversal without needing another two sizes", () => {
  const source = [
    ...atrSeed(100, 2),
    moveBar(14, 100, 102),   // brick [100, 102] up
    moveBar(15, 102, 100),   // one size back — nothing
    moveBar(16, 100, 98),    // two sizes back — reversal from the brick's open
    moveBar(17, 98, 96),     // only one more size is needed to continue
  ];
  assert.deepEqual(
    renkoBricks(source, renkoParams).map((b) => [b.direction, b.open, b.close]),
    [[1, 100, 102], [-1, 100, 98], [-1, 98, 96]]
  );
});

test("RENKO opens in either direction from the anchor", () => {
  const down = renkoBricks([...atrSeed(100, 2), moveBar(14, 100, 98)], renkoParams);
  assert.deepEqual(down.map((b) => [b.direction, b.open, b.close]), [[-1, 100, 98]]);
});

test("RENKO never mutates the canonical candles", () => {
  const source = series(120, (i) => 100 + Math.sin(i / 7) * 12 + i * 0.4);
  const before = JSON.stringify(source);
  renkoBricks(source, renkoParams);
  assert.equal(JSON.stringify(source), before, "the source candles were mutated");
});

test("RENKO cannot see the future", () => {
  const source = series(140, (i) => 100 + Math.sin(i / 6) * 10 + i * 0.3);
  const cutoff = 90;
  const baseline = renkoBricks(source, renkoParams);
  const altered = clone(source);
  for (let i = cutoff; i < altered.length; i++) altered[i] = bar(i, 500, 700, 300, 500 + i * 3);
  const after = renkoBricks(altered, renkoParams);

  // Every brick produced by a bar before the cutoff must be untouched.
  const untouched = baseline.filter((b) => b.sourceOpenTime < T0 + cutoff * MINUTE);
  assert.ok(untouched.length > 0, "the fixture must actually produce bricks before the cutoff");
  assert.deepEqual(after.slice(0, untouched.length), untouched);
});

test("RENKO clipped for replay is the prefix of the full series", () => {
  const source = series(200, (i) => 100 + Math.sin(i / 9) * 15 + i * 0.25);
  const full = renkoBricks(source, renkoParams);
  for (const horizon of [0, 5, 14, 15, 63, 199, 200]) {
    const clipped = renkoBricks(source.slice(0, horizon), renkoParams);
    assert.ok(clipped.length <= full.length);
    assert.deepEqual(clipped, full.slice(0, clipped.length),
      `a replay clipped at ${horizon} bars disagreed with the same prefix of the whole`);
    // And it must not have run ahead of the horizon.
    for (const brick of clipped) {
      assert.ok(brick.sourceOpenTime < T0 + horizon * MINUTE,
        "a clipped replay produced a brick from a bar the user has not reached");
    }
  }
});

test("RENKO ATR uses only bars up to the one being processed", () => {
  // Fold by hand and compare the ATR-derived brick size against Wilder's
  // definition computed independently over the same prefix.
  const source = series(40, (i) => 100 + i * 3);
  const period = DEFAULT_RENKO_ATR_PERIOD;
  const trs: number[] = [];
  let state = createRenkoState();
  for (let i = 0; i < source.length; i++) {
    const b = source[i]!;
    const previousClose = i === 0 ? null : source[i - 1]!.close;
    trs.push(previousClose === null
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - previousClose), Math.abs(b.low - previousClose)));
    let expected: number | null = null;
    if (trs.length >= period) {
      expected = trs.slice(0, period).reduce((a, x) => a + x, 0) / period;
      for (let k = period; k < trs.length; k++) expected = (expected * (period - 1) + trs[k]!) / period;
    }
    const stepped = foldRenko(state, b, { atrPeriod: period });
    state = stepped.state;
    for (const brick of stepped.bricks) {
      assert.ok(Math.abs(brick.size - expected!) < 1e-9,
        `bar ${i} used a brick size that is not the Wilder ATR over bars 0..${i}`);
    }
  }
});

// ── incremental == full recomputation ──────────────────────────────────────

for (const kind of ["heikinAshi", "renko"] as const) {
  test(`${kind}: stepping bar by bar equals recomputing the whole series`, () => {
    const source = series(300, (i) => 100 + Math.sin(i / 11) * 20 + Math.cos(i / 3) * 4 + i * 0.1);
    const whole = transformAll(kind, source).output;

    // The renderer's shape: a cursor over the closed bars, re-stepping the
    // forming one. Assert the drawn series at EVERY horizon, which is what the
    // live chart actually walks through.
    let cursor = createTransformCursor(kind);
    const committed: OhlcBar[] = [];
    for (let i = 0; i < source.length; i++) {
      const forming = transformStep(cursor, source[i]!);
      const drawn = [...committed, ...forming.emitted];
      assert.deepEqual(drawn, transformAll(kind, source.slice(0, i + 1)).output,
        `the incremental series after ${i + 1} bars is not a clean recomputation`);
      cursor = forming.cursor;
      committed.push(...forming.emitted);
    }
    assert.deepEqual(committed, whole);
  });

  test(`${kind}: re-stepping a forming bar many times leaves the history alone`, () => {
    const closed = series(60, (i) => 100 + i * 1.5);
    const { cursor, output } = transformAll(kind, closed);
    const frozen = JSON.stringify(output);
    const open = closed[closed.length - 1]!.close;

    // One bar forming: each tick widens its extremes and moves its close, the
    // way a real kline does. The closed history must not move, and the drawn
    // series must equal a clean recomputation of exactly these candles.
    let high = open;
    let low = open;
    for (const price of [open + 1, open + 40, open - 8, open + 75, open + 18]) {
      high = Math.max(high, price);
      low = Math.min(low, price);
      const forming = bar(60, open, high, low, price);
      const drawn = [...output, ...transformStep(cursor, forming).emitted];
      assert.equal(JSON.stringify(output), frozen, "a tick rewrote closed history");
      assert.deepEqual(drawn.slice(0, output.length), output,
        "a tick disturbed bars that were already closed");
      assert.deepEqual(drawn, transformAll(kind, [...closed, forming]).output,
        "the live series diverged from a clean recomputation of the same candles");
    }
  });
}

test("a Renko cursor is not disturbed by stepping it — steps are pure", () => {
  const source = series(40, (i) => 100 + i * 2);
  const { cursor } = transformAll("renko", source.slice(0, 30));
  const snapshot = JSON.stringify(cursor);
  transformStep(cursor, source[30]!);
  transformStep(cursor, source[31]!);
  assert.equal(JSON.stringify(cursor), snapshot, "transformStep mutated the cursor it was given");
});

test("Renko parameters travel with the cursor and default to ATR(14)", () => {
  assert.equal(DEFAULT_RENKO_ATR_PERIOD, 14);
  assert.equal(createTransformCursor("renko").params.atrPeriod, 14);
  assert.equal(createTransformCursor("renko", { atrPeriod: 7 }).params.atrPeriod, 7);

  // And a different period is genuinely a different chart, so "persisted"
  // means something.
  const source = series(200, (i) => 100 + Math.sin(i / 8) * 14 + i * 0.2);
  const fourteen = transformAll("renko", source, { atrPeriod: 14 }).output;
  const seven = transformAll("renko", source, { atrPeriod: 7 }).output;
  assert.notDeepEqual(fourteen, seven);
});

// ── the canonical / synthetic boundary ─────────────────────────────────────

test("THE TRANSFORMS ARE A LEAF: nothing outside the chart can reach them", () => {
  // A structural test, because the property is "no importer exists" and no
  // amount of unit testing can show that.
  const roots = ["lib", "components", "app", "hooks"];
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  for (const root of roots) walk(path.join(ROOT, root));

  const importers = files.filter((f) =>
    /from\s+["'](@\/lib\/|\.\.?\/)chartTransforms["']/.test(fs.readFileSync(f, "utf8")));
  const relative = importers.map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(relative, ["components/CandleChart.tsx", "lib/chartType.ts"],
    "a synthetic transform became reachable from somewhere that is not the chart");
});

test("THE TRANSFORM MODULE DEPENDS ON NOTHING", () => {
  const source = read("lib/chartTransforms.ts");
  assert.ok(!/^\s*import\s/m.test(source),
    "chartTransforms must stay a pure leaf: an import here is a route for canonical state to flow in");
});

test("NO TRADING, ALERT, STRATEGY OR SCIENTIFIC PATH DRAWS FROM A TRANSFORM", () => {
  // The chart is the only consumer, and inside the chart the transform output
  // reaches exactly one thing: the main price series. These are the surfaces
  // that must keep reading `candles`.
  const chart = read("components/CandleChart.tsx");
  for (const canonical of [
    // markers and price lines are placed from the canonical candles/trades
    /const firstT = candles\[0\] \? candles\[0\]\.openTime \/ 1000 : 0/,
    // the drawing layers and the legend are handed `candles`, never `display`
    /<DrawingCanvas[\s\S]*?candles=\{candles\}/,
    /<PineDrawingLayer[\s\S]*?candles=\{candles\}/,
    /const list = candlesRef\.current;/,
  ]) {
    assert.match(chart, canonical, `a canonical-price surface stopped reading the canonical candles`);
  }
  /*
   * The transformed array reaches the price series, the OHLC legend and the
   * crosshair's brick-to-canonical mapping — three display surfaces — and
   * nothing else. The cap is a tripwire on that list growing; the checks
   * under it are the actual rule.
   */
  const sinks = chart.match(/displayRef\.current/g) ?? [];
  assert.ok(sinks.length > 0 && sinks.length <= 12,
    "the transformed series grew more consumers than the display surfaces");
  assert.ok(!/priceLines[\s\S]{0,120}display/.test(chart),
    "an order/price line was derived from transformed bars");

  // The two effects that place trading evidence read the canonical candles
  // and never the transform output.
  const markerEffect = chart.slice(
    chart.indexOf("// Markers update independently"),
    chart.indexOf("// Live stop / target / entry levels"));
  assert.ok(markerEffect.length > 200);
  assert.equal(markerEffect.includes("displayRef"), false,
    "a marker was placed from transformed bars");
  const levelsAt = chart.indexOf("// Live stop / target / entry levels");
  const levelEffect = chart.slice(levelsAt, levelsAt + 900);
  assert.equal(levelEffect.includes("displayRef"), false,
    "a stop/target/entry level was placed from transformed bars");

  // What the crosshair publishes upwards is a canonical bar time, resolved
  // through `canonicalOpenTime`, never a brick's own rendering position.
  assert.match(chart, /canonicalOpenTime\(brick\)/);
  assert.equal(/onCrosshairRef\.current\?\.\(\s*(param|raw)?\.?time/.test(chart), false,
    "the raw axis position must not be published while a transform is active");
});
