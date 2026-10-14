/**
 * A moving average's colour, width and dash — chosen by the user, saved with
 * the chart, and drawn exactly as chosen.
 *
 * What is pinned: a chart saved before these existed draws unchanged; a saved
 * look round-trips; a malformed part drops only itself, never the line; a
 * style change never shows or hides a line; and Reset gives the default back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMaOverlays, defaultMaLines, maColor, type MaLine,
} from "../lib/movingAverages";
import {
  createWorkspace, parseWorkspace, setMaLineStyle, type ChartWorkspace,
} from "../lib/workspace";
import type { Candle } from "../lib/types";

const candles: Candle[] = Array.from({ length: 300 }, (_, i) => ({
  openTime: 1_700_000_000_000 + i * 60_000, closeTime: 1_700_000_000_000 + (i + 1) * 60_000 - 1,
  open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100 + i * 0.1, volume: 1,
} as Candle));

const ema50 = (lines: MaLine[]) => lines.find((l) => l.type === "ema" && l.length === 50)!;
const overlay = (lines: MaLine[]) =>
  buildMaOverlays(candles, lines.map((l) => ({ ...l, visible: l.type === "ema" && l.length === 50 })))[0]!;

test("a line nobody restyled draws exactly as before", () => {
  const o = overlay(defaultMaLines());
  assert.equal(o.color, maColor(50));
  assert.equal(o.width, 1);
  assert.equal(o.lineStyle, "dashed", "EMAs stay dashed by default");
  assert.equal(o.dashed, true);
});

test("the chart draws the colour, width and dash the user chose", () => {
  const lines = defaultMaLines().map((l) =>
    l.type === "ema" && l.length === 50 ? { ...l, color: "#ff00aa", width: 3, style: "dotted" as const } : l);
  const o = overlay(lines);
  assert.equal(o.color, "#ff00aa");
  assert.equal(o.width, 3);
  assert.equal(o.lineStyle, "dotted");
  assert.equal(o.dashed, false, "dotted is not dashed");
});

const SEED = { symbol: "BTCUSDT", interval: "15m" as const };
const paneId = (ws: ChartWorkspace) => ws.panes[0]!.id;

test("a look is saved with the chart and comes back", () => {
  let ws = createWorkspace(SEED as never);
  ws = setMaLineStyle(ws, paneId(ws), "ema", 50, { color: "#123456", width: 2, style: "solid" });
  const back = parseWorkspace(JSON.parse(JSON.stringify(ws)))!;
  const l = ema50(back.panes[0]!.maLines);
  assert.deepEqual({ c: l.color, w: l.width, s: l.style }, { c: "#123456", w: 2, s: "solid" });
});

test("a malformed part of a saved look drops only that part, never the line", () => {
  const ws = createWorkspace(SEED as never);
  const raw = JSON.parse(JSON.stringify(ws));
  const lines = raw.panes[0].maLines as Record<string, unknown>[];
  const target = lines.find((l) => l.type === "ema" && l.length === 50)!;
  Object.assign(target, { color: "red; background:url(x)", width: 99, style: "wavy" });
  const back = parseWorkspace(raw);
  assert.ok(back, "the whole chart still loads");
  const l = ema50(back!.panes[0]!.maLines);
  assert.equal(l.color, undefined);
  assert.equal(l.width, undefined);
  assert.equal(l.style, undefined);
  assert.equal(back!.panes[0]!.maLines.length, lines.length, "no line was lost");
});

test("restyling never shows or hides a line, and Reset restores the default", () => {
  let ws = createWorkspace(SEED as never);
  const before = ema50(ws.panes[0]!.maLines).visible;
  ws = setMaLineStyle(ws, paneId(ws), "ema", 50, { color: "#abcdef" });
  assert.equal(ema50(ws.panes[0]!.maLines).visible, before);
  ws = setMaLineStyle(ws, paneId(ws), "ema", 50, null);
  const l = ema50(ws.panes[0]!.maLines);
  assert.deepEqual([l.color, l.width, l.style], [undefined, undefined, undefined]);
  assert.equal(l.visible, before);
});
