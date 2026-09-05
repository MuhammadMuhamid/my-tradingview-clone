/**
 * The browser computes what the server alerts on.
 *
 * Two claims, both of which must hold for the native-study platform to be
 * trustworthy at all:
 *
 *   the browser's canonical maths is the server's, byte for byte;
 *   the moving-average overlays the chart has always drawn did not move when
 *   they were routed through it.
 *
 * The second is the one that could have gone wrong silently. `lib/movingAverages`
 * carried its own `sma`/`ema` — written to return `null` rather than `NaN`, and
 * seeded the same way by intention rather than by sharing code. If routing them
 * through the core shifted a value by a bar, an armed "price touches EMA 200"
 * alert would fire on a different line from the one on screen.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../lib/ta/core";
import { buildMaOverlays, currentMaValues, defaultMaLines, ema, sma } from "../lib/movingAverages";
import type { Candle } from "../lib/types";

test("the browser's copy of the core is byte-identical to the server's", () => {
  const browser = readFileSync(join(__dirname, "..", "lib", "ta", "core.ts"), "utf8");
  const server = readFileSync(
    join(__dirname, "..", "..", "backend", "src", "ta", "core.ts"), "utf8");
  assert.equal(browser, server,
    "one canonical implementation, stored twice by necessity; a divergence in " +
    "a formula OR in a comment is a divergence");
  assert.doesNotMatch(browser, /^\s*import\s/m, "the core imports nothing");
});

// ── a reproducible price series ─────────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candles(n: number, seed = 11): Candle[] {
  const next = rng(seed);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.02;
    out.push({
      symbol: "BTCUSDT", interval: "1m", openTime: i * 60_000, closeTime: i * 60_000 + 59_999,
      open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999,
      close: price, volume: 100 + next() * 900,
    });
  }
  return out;
}

test("the chart's moving averages are the canonical ones, value for value", () => {
  const bars = candles(600);
  const closes = bars.map((c) => c.close);
  for (const length of [15, 21, 50, 100, 200]) {
    const chartSma = sma(closes, length);
    const chartEma = ema(closes, length);
    const canonSma = core.sma(closes, length);
    const canonEma = core.ema(closes, length);
    for (let i = 0; i < closes.length; i++) {
      // The chart says `null` where the canonical layer says `na`; that is a
      // rendering convention (a break in the line), not a different answer.
      assert.equal(chartSma[i] === null, Number.isNaN(canonSma[i]!),
        `SMA ${length} disagrees about whether bar ${i} has a value`);
      assert.equal(chartEma[i] === null, Number.isNaN(canonEma[i]!),
        `EMA ${length} disagrees about whether bar ${i} has a value`);
      if (chartSma[i] !== null) {
        assert.ok(Math.abs(chartSma[i]! - canonSma[i]!) < 1e-9,
          `SMA ${length} bar ${i}: ${chartSma[i]} vs ${canonSma[i]}`);
      }
      if (chartEma[i] !== null) {
        assert.ok(Math.abs(chartEma[i]! - canonEma[i]!) < 1e-9,
          `EMA ${length} bar ${i}: ${chartEma[i]} vs ${canonEma[i]} — an armed ` +
          `alert would fire on a different line from the one on screen`);
      }
    }
  }
});

test("the overlays and the legend readouts still come out of that same maths", () => {
  const bars = candles(400, 5);
  const lines = defaultMaLines();
  const overlays = buildMaOverlays(bars, lines);
  assert.equal(overlays.length, lines.length, "one overlay per visible line");

  const closes = bars.map((c) => c.close);
  const values = currentMaValues(bars, lines);
  for (const line of lines) {
    const canonical = line.type === "sma"
      ? core.sma(closes, line.length) : core.ema(closes, line.length);
    const last = canonical[canonical.length - 1]!;
    const shown = values[`ma-${line.type}-${line.length}`];
    assert.ok(shown !== null && shown !== undefined);
    assert.ok(Math.abs(shown - last) < 1e-9,
      `${line.type} ${line.length} legend value is not the canonical value`);
  }
});

test("an empty or short series produces overlays with no values rather than throwing", () => {
  assert.deepEqual(buildMaOverlays([], defaultMaLines()), []);
  const short = candles(3);
  const overlays = buildMaOverlays(short, defaultMaLines());
  for (const overlay of overlays) {
    assert.equal(overlay.data.length, 3, "aligned bar-for-bar with the input");
    assert.ok(overlay.data.every((p) => p.value === null),
      "a window that cannot be filled draws nothing, rather than a partial answer");
  }
});
