/**
 * MSB-OB and Liquidity Swings [LuxAlgo] as built-in studies: the owner's
 * TradingView defaults, the added MSB line colours, and drawings that follow
 * the shared computation the alert runner fires on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  drawLiquiditySwings, drawMsbOb, formatVolume, liquiditySwingsStudy, msbObStudy,
} from "../lib/native/structureStudies";
import { defaultParams } from "../lib/native/registry";
import { liquiditySwings, marketStructure } from "../lib/ta/core";
import type { Candle } from "../lib/types";

const fx = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "nearusdt-1h.json"), "utf8")) as { bars: number[][] };
const candles: Candle[] = fx.bars.map(([t, o, h, l, c, v, ct]) => ({
  symbol: "NEARUSDT", interval: "1h", openTime: t!, open: o!, high: h!, low: l!, close: c!,
  volume: v!, closeTime: ct!,
}));
const arr = (k: keyof Candle) => candles.map((c) => c[k] as number);

test("MSB-OB defaults are the owner's TradingView settings (image 1)", () => {
  const p = defaultParams(msbObStudy);
  assert.equal(p.zigzagLength, 9);
  assert.equal(p.showZigzag, true);
  assert.equal(p.fibFactor, 0.33);
  assert.equal(p.textSize, "tiny");
  assert.equal(p.deleteBoxes, false);
  assert.equal(p.msbBullColor, "#4caf50");
  assert.equal(p.msbBearColor, "#f23645");
});

test("MSB lines take their own colours and width, and every break is labelled", () => {
  const params = { ...defaultParams(msbObStudy), msbBullColor: "#00ffff", msbBearColor: "#ff00ff", msbWidth: 3 };
  const d = drawMsbOb(candles, "1h", params);
  const ms = marketStructure(arr("open"), arr("high"), arr("low"), arr("close"), 9, 0.33);
  const msbLines = d.lines.filter((l) => l.width === 3);
  assert.equal(msbLines.length, ms.breaks.length);
  for (const b of ms.breaks) {
    const want = b.direction === 1 ? "#00ffff" : "#ff00ff";
    assert.ok(msbLines.some((l) => l.y1 === b.price && l.color === want), `break at ${b.index}`);
  }
  assert.equal(d.labels.filter((l) => l.text === "MSB").length, ms.breaks.length);
  assert.equal(d.lines.filter((l) => l.width === 1).length, ms.zigzag.length, "the zigzag");
  const hidden = drawMsbOb(candles, "1h", { ...params, showZigzag: false });
  assert.equal(hidden.lines.filter((l) => l.width === 1).length, 0);
});

test("zones are drawn as the script draws them, and broken ones go only when asked", () => {
  const params = defaultParams(msbObStudy);
  const ms = marketStructure(arr("open"), arr("high"), arr("low"), arr("close"), 9, 0.33);
  const kept = drawMsbOb(candles, "1h", params);
  assert.equal(kept.boxes.length, ms.zones.length, "Delete Old/Broken Boxes is off by default");
  const texts = new Set(kept.boxes.map((b) => b.text));
  for (const t of ["Bu-OB", "Be-OB"]) assert.ok(texts.has(t));
  for (const b of kept.boxes) {
    assert.equal(b.textHalign, "align_right");
    assert.equal(b.textSize, "tiny");
    assert.equal(b.borderWidth, 1);
  }
  const deleted = drawMsbOb(candles, "1h", { ...params, deleteBoxes: true });
  assert.equal(deleted.boxes.length, ms.zones.filter((z) => z.removed === null).length);
});

test("Liquidity Swings defaults are the owner's TradingView settings (image 2)", () => {
  const p = defaultParams(liquiditySwingsStudy);
  assert.equal(p.length, 20);
  assert.equal(p.area, "full");
  assert.equal(p.filterBy, "count");
  assert.equal(p.filterValue, 0);
  assert.equal(p.showTop, true);
  assert.equal(p.showBtm, true);
  assert.equal(p.labelSize, "tiny");
});

test("swing levels: solid while live, dashed and stopped once a close crosses them", () => {
  const params = defaultParams(liquiditySwingsStudy);
  const d = drawLiquiditySwings(candles, "1h", params);
  const ls = liquiditySwings(arr("open"), arr("high"), arr("low"), arr("close"), arr("volume"), 20, "full");
  const t = (i: number) => Math.floor(candles[i]!.openTime / 1000);
  for (const s of ls.swings.filter((x) => x.count > 0)) {
    const line = d.lines.find((l) => l.x1 === t(s.x) && l.y1 === s.level);
    assert.ok(line, `swing at ${s.x} has its level`);
    assert.equal(line!.style, s.crossed !== null ? "dashed" : "solid");
    if (s.crossed !== null) assert.equal(line!.x2, t(s.crossed));
    assert.equal(line!.color, s.side === "high" ? "#f23645" : "#089981");
    const label = d.labels.find((l) => l.x === t(s.x) && l.y === s.level)!;
    assert.equal(label.text, formatVolume(s.volume));
    assert.equal(label.size, "tiny");
  }
  const noHighs = drawLiquiditySwings(candles, "1h", { ...params, showTop: false });
  assert.ok(noHighs.lines.every((l) => l.color !== "#f23645"));
});

test("volumes print as Pine's format.volume does", () => {
  assert.equal(formatVolume(3695981), "3.696M");
  assert.equal(formatVolume(12345.6), "12.346K");
  assert.equal(formatVolume(950), "950");
  assert.equal(formatVolume(2.5e9), "2.5B");
});
