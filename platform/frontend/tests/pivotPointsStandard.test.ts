/**
 * Pivot Points Standard draws as TradingView draws it: one horizontal segment
 * per level per period, "R3 (5.577)" at its left end, every level orange — not
 * a continuous red/green step line joined by vertical risers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pivotPeriodFor, pivotPointsStudy } from "../lib/native/levels";
import { defaultParams } from "../lib/native/registry";
import { runNativeStudy, newNativeStudy } from "../lib/native/compute";
import { pivotLevels } from "../lib/ta/core";
import type { Candle } from "../lib/types";

const fixture = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "nearusdt-1h.json"), "utf8")) as { bars: number[][] };
const candles: Candle[] = fixture.bars.map(([t, o, h, l, c, v, ct]) => ({
  symbol: "NEARUSDT", interval: "1h", openTime: t!, open: o!, high: h!, low: l!, close: c!,
  volume: v!, closeTime: ct!,
}));
const DAY = 86_400_000;

test("Auto picks the period TradingView picks", () => {
  assert.equal(pivotPeriodFor("auto", 15 * 60_000), "1d");
  assert.equal(pivotPeriodFor("auto", 60 * 60_000), "1w");
  assert.equal(pivotPeriodFor("auto", DAY), "1M");
  assert.equal(pivotPeriodFor("auto", 7 * DAY), "12M");
  assert.equal(pivotPeriodFor("1d", 60 * 60_000), "1d");
});

test("each period's levels are segments over the NEXT period, labelled at the left", () => {
  const applied = newNativeStudy(pivotPointsStudy, "pv");
  const out = runNativeStudy(pivotPointsStudy, applied, candles, "1h", 3);
  const d = out.drawings!;
  assert.ok(out.overlays.every((o) => o.data.length === 0), "no step-line series");
  // The newest drawn period is today's, from yesterday's high, low and close.
  const lastStart = Math.floor(candles[candles.length - 1]!.openTime / DAY) * DAY;
  const y = candles.filter((c) => c.openTime >= lastStart - DAY && c.openTime < lastStart);
  const period = {
    open: y[0]!.open, high: Math.max(...y.map((c) => c.high)), low: Math.min(...y.map((c) => c.low)),
    close: y[y.length - 1]!.close,
  };
  const want = pivotLevels(period, "Fibonacci");
  const today = d.lines.filter((l) => l.x1 === lastStart / 1000);
  assert.equal(today.length, want.length);
  for (const level of want) {
    const line = today.find((l) => Math.abs(l.y1 - level.price) < 1e-12)!;
    assert.ok(line, `no ${level.name} segment`);
    assert.equal(line.x2, (lastStart + DAY) / 1000, "a segment ends where its period does");
    assert.equal(line.color, "#fb8c00");
    const label = d.labels.find((l) => l.x === line.x1 && l.y === level.price)!;
    assert.equal(label.text, `${level.name} (${level.price.toFixed(3)})`);
    assert.equal(label.style, "style_label_right", "labels sit to the LEFT of the segment");
    assert.equal(label.color, "", "the label is its text alone");
  }
  // Number of Pivots Back: 15 periods, no more.
  const starts = new Set(d.lines.map((l) => l.x1));
  assert.equal(starts.size, 15);
});

test("Style rows switch a level off and recolour it", () => {
  const applied = { ...newNativeStudy(pivotPointsStudy, "pv"),
    styles: { R3: { visible: false }, P: { color: "#2962ff", width: 2 } } };
  const d = runNativeStudy(pivotPointsStudy, applied, candles, "1h", 3).drawings!;
  assert.ok(!d.labels.some((l) => l.text.startsWith("R3")));
  const p = d.labels.filter((l) => l.text.startsWith("P "));
  assert.ok(p.length > 0 && p.every((l) => l.textColor === "#2962ff"));
  assert.ok(d.lines.filter((l) => l.color === "#2962ff").every((l) => l.width === 2));
});

test("labels and prices can each be turned off, and moved to the right", () => {
  const params = { ...defaultParams(pivotPointsStudy), showPrices: false, labelsPosition: "Right" };
  const applied = { ...newNativeStudy(pivotPointsStudy, "pv"), params };
  const d = runNativeStudy(pivotPointsStudy, applied, candles, "1h", 3).drawings!;
  assert.ok(d.labels.every((l) => /^(P|R\d|S\d)$/.test(l.text)));
  assert.ok(d.labels.every((l) => l.style === "style_label_left"));
  const none = runNativeStudy(pivotPointsStudy, {
    ...applied, params: { ...params, showLabels: false },
  }, candles, "1h", 3).drawings!;
  assert.equal(none.labels.length, 0);
});
