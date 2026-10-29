/**
 * Support & Resistance (MTF) | Flux Charts, ported.
 *
 * The golden here is TradingView itself: on NEARUSDT 1h the user's TradingView
 * chart labelled these zones (screenshot, 2026-10-15) — 6.000, 5.578, 5.595,
 * 5.540, 5.440, 5.190, 5.168, 4.890, 4.732, 4.590, 4.548, 4.301, 4.100 — with
 * 6.000, 5.578, 5.190, 4.301 and 4.100 still valid (extended right). The
 * fixture ends a few hours after that screenshot, which is why one zone the
 * screenshot showed (4.635) has since been superseded and is not asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  computeFluxSr, fluxSrStudy, formatTimeframe, pineTimeframe, type FluxSrOptions,
} from "../lib/native/fluxSr";
import { defaultParams } from "../lib/native/registry";
import type { Candle } from "../lib/types";

const fixture = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "nearusdt-1h.json"), "utf8")) as { bars: number[][] };
const candles: Candle[] = fixture.bars.map(([t, o, h, l, c, v, ct]) => ({
  symbol: "NEARUSDT", interval: "1h", openTime: t!, open: o!, high: h!, low: l!, close: c!,
  volume: v!, closeTime: ct!,
}));
const AFTER = candles[candles.length - 1]!.closeTime + 1;

function options(over: Partial<FluxSrOptions> = {}): FluxSrOptions {
  return {
    pivotLength: 15, strength: 1, invalidation: "Close", expand: "Only Valid", showInvalidated: true,
    timeframes: [{ enabled: true, tf: "" }, { enabled: false, tf: "D" }, { enabled: false, tf: "W" }],
    showBreaks: true, showRetests: true, avoidFalseBreaks: false, breakVolumeThreshold: 0.3,
    inverseBrokenLineColor: false, styleMode: "Zones", lineStyle: "____", lineWidth: 2, zoneSize: 1.5,
    supportColor: "#08998180", resistanceColor: "#f2364580", breakColor: "#2196f3", textColor: "#ffffff80",
    ...over,
  };
}

test("timeframe names are the script's", () => {
  assert.equal(pineTimeframe("1h"), "60");
  assert.equal(pineTimeframe("1d"), "D");
  assert.equal(formatTimeframe("", "60"), "1 Hour");
  assert.equal(formatTimeframe("240", "60"), "4 Hours");
  assert.equal(formatTimeframe("15", "60"), "15 Min");
  assert.equal(formatTimeframe("D", "60"), "1D");
  assert.equal(formatTimeframe("W", "60"), "1W");
});

test("the zones TradingView drew on NEARUSDT 1h, valid ones extended", () => {
  const d = computeFluxSr(candles, "1h", options(), 3, AFTER);
  const titles = d.boxes.map((b) => b.text);
  for (const price of ["6.000", "5.578", "5.595", "5.540", "5.440", "5.190", "5.169",
    "4.890", "4.732", "4.590", "4.548", "4.301", "4.100"]) {
    assert.ok(titles.includes(`1 Hour | ${price}`), `missing zone ${price}: ${titles.join(", ")}`);
  }
  const valid = d.boxes.filter((b) => b.extend === "both").map((b) => b.text).sort();
  assert.deepEqual(valid, ["1 Hour | 4.100", "1 Hour | 4.301", "1 Hour | 5.190", "1 Hour | 5.578",
    "1 Hour | 6.000"]);
  // Zones are borderless fills in the type's colour, text right-aligned when extended.
  for (const b of d.boxes) {
    assert.equal(b.borderWidth, 0);
    assert.ok(b.bgColor === "#08998180" || b.bgColor === "#f2364580");
    assert.equal(b.textHalign, b.extend === "none" ? "center" : "right");
  }
  // A broken zone ends at its break, which carries a blue "B".
  const broken = d.boxes.filter((b) => b.extend === "none");
  assert.ok(broken.length > 0);
  const breaks = d.labels.filter((l) => l.text === "B");
  for (const b of broken) {
    assert.ok(breaks.some((l) => l.x === b.right), `no B label at the end of ${b.text}`);
  }
  assert.ok(breaks.every((l) => l.color === "#2196f3" && l.textColor === "#ffffff"));
});

test("Lines style draws a line and a text label per level instead of a zone", () => {
  const d = computeFluxSr(candles, "1h", options({ styleMode: "Lines", lineStyle: "----" }), 3, AFTER);
  assert.equal(d.boxes.length, 0);
  assert.ok(d.lines.length > 0);
  assert.ok(d.lines.every((l) => l.style === "dashed" && l.width === 2));
  const texts = d.labels.filter((l) => l.style === "style_none").map((l) => l.text);
  assert.ok(texts.includes("1 Hour | 6.000"));
});

test("hiding invalidated levels leaves only the valid ones", () => {
  const d = computeFluxSr(candles, "1h", options({ showInvalidated: false }), 3, AFTER);
  assert.ok(d.boxes.length > 0);
  assert.ok(d.boxes.every((b) => b.extend !== "none"));
});

test("a higher timeframe adds its own zones, named by it", () => {
  const d = computeFluxSr(candles, "1h", options({
    pivotLength: 3,
    timeframes: [{ enabled: true, tf: "" }, { enabled: true, tf: "240" }, { enabled: false, tf: "W" }],
  }), 3, AFTER);
  assert.ok(d.boxes.some((b) => b.text.includes("4 Hours")), d.boxes.map((b) => b.text).join(", "));
});

test("the study's defaults are the user's TradingView settings", () => {
  const p = defaultParams(fluxSrStudy);
  assert.equal(p.pivotLength, 15);
  assert.equal(p.styleMode, "Lines");
  assert.equal(p.zoneSize, 1);
  assert.equal(p.lineWidth, 2);
  assert.equal(p.expand, "Only Valid");
  assert.equal(p.tf1On, true);
  assert.equal(p.tf2On, false);
  assert.equal(p.tf3On, false);
  assert.equal(p.tf2, "D");
  assert.equal(p.tf3, "W");
});

test("a forming bar is not confirmed and does not move the zones", () => {
  const formingNow = candles[candles.length - 1]!.closeTime - 1;
  const a = computeFluxSr(candles, "1h", options(), 3, formingNow);
  const shorter = computeFluxSr(candles.slice(0, -1), "1h", options(), 3, AFTER);
  assert.deepEqual(a.boxes.map((b) => b.text).sort(), shorter.boxes.map((b) => b.text).sort());
});
