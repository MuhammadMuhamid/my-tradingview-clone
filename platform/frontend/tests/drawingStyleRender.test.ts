/**
 * The settings dialog writes these keys. This asserts the CANVAS reads them.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * Eleven controls shipped in `DrawingSettingsModal` that changed the stored
 * drawing and nothing else: Extend, Middle point, Price labels, Stats and its
 * position and persistence, and the whole Text tab — colour, size, bold,
 * italic and both alignments. `lineStyle: "dotted"` drew identically to
 * dashed, because the renderer read only the older boolean beside it.
 *
 * Nothing caught it, and the reason is worth writing down:
 * `tests/dom/drawingSettings.test.tsx` asserts the dialog's SHAPE — that the
 * rows exist, are enabled, and write the style. Every one of those assertions
 * passed the entire time the picture ignored the result. A dialog test cannot
 * see a renderer that does not listen, so the assertions have to be made
 * against a recording context instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drawOne, type ToPx } from "../components/tv/DrawingCanvas";
import type { Drawing, DrawingStyle } from "../lib/drawings";

interface Recorded {
  dashes: number[][];
  fonts: string[];
  fillStyles: string[];
  aligns: string[];
  baselines: string[];
  texts: { text: string; x: number; y: number }[];
  lines: { x1: number; y1: number; x2: number; y2: number }[];
  arcs: { x: number; y: number; r: number }[];
}

/**
 * A context that remembers what it was told.
 *
 * Only the calls these tests assert on are recorded; everything else is a
 * no-op, because the point is what the renderer ASKS FOR, not what a real
 * canvas would then paint.
 */
function recorder(): { ctx: CanvasRenderingContext2D; rec: Recorded } {
  const rec: Recorded = {
    dashes: [], fonts: [], fillStyles: [], aligns: [], baselines: [],
    texts: [], lines: [], arcs: [],
  };
  let cursor = { x: 0, y: 0 };
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {},
    fillRect() {}, strokeRect() {}, clip() {}, rect() {}, setTransform() {},
    translate() {}, rotate() {}, scale() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (t: string) => ({ width: t.length * 6 }),
    setLineDash(d: number[]) { rec.dashes.push([...d]); },
    getLineDash: () => [],
    moveTo(x: number, y: number) { cursor = { x, y }; },
    lineTo(x: number, y: number) {
      rec.lines.push({ x1: cursor.x, y1: cursor.y, x2: x, y2: y });
      cursor = { x, y };
    },
    arc(x: number, y: number, r: number) { rec.arcs.push({ x, y, r }); },
    fillText(text: string, x: number, y: number) { rec.texts.push({ text, x, y }); },
    strokeText() {},
    set font(v: string) { rec.fonts.push(v); },
    get font() { return rec.fonts[rec.fonts.length - 1] ?? ""; },
    set fillStyle(v: string) { rec.fillStyles.push(v); },
    get fillStyle() { return rec.fillStyles[rec.fillStyles.length - 1] ?? ""; },
    set textAlign(v: string) { rec.aligns.push(v); },
    get textAlign() { return rec.aligns[rec.aligns.length - 1] ?? "left"; },
    set textBaseline(v: string) { rec.baselines.push(v); },
    get textBaseline() { return rec.baselines[rec.baselines.length - 1] ?? "alphabetic"; },
    strokeStyle: "", lineWidth: 1, lineJoin: "round", lineCap: "round", globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, rec };
}

const W = 800, H = 400;

/** Anchors are already in a price/time space the test controls directly. */
const toPx: ToPx = (p) => ({ x: p.time, y: p.price });

const drawing = (
  tool: Drawing["tool"], style: Partial<DrawingStyle>, points = [
    { time: 100, price: 100 }, { time: 300, price: 200 },
  ]
): Drawing => ({
  id: "d1", tool, points, style: { color: "#2962ff", width: 2, ...style },
} as Drawing);

const render = (d: Drawing, selected = false) => {
  const { ctx, rec } = recorder();
  drawOne(ctx, d, toPx, W, H, selected, false, []);
  return rec;
};

// ── line style ────────────────────────────────────────────────────────────

test("a dotted line is drawn dotted, not as a second dashed line", () => {
  // The whole defect: the renderer read the boolean beside `lineStyle`, so
  // dotted and dashed produced the identical dash array.
  const dotted = render(drawing("trend", { lineStyle: "dotted", dashed: true }));
  const dashed = render(drawing("trend", { lineStyle: "dashed", dashed: true }));
  assert.deepEqual(dotted.dashes[0], [2, 3]);
  assert.deepEqual(dashed.dashes[0], [6, 4]);
  assert.notDeepEqual(dotted.dashes[0], dashed.dashes[0]);
});

test("a drawing saved before lineStyle existed still draws as it did", () => {
  assert.deepEqual(render(drawing("trend", { dashed: true })).dashes[0], [6, 4]);
  assert.deepEqual(render(drawing("trend", {})).dashes[0], []);
  assert.deepEqual(render(drawing("trend", { lineStyle: "solid", dashed: true })).dashes[0], []);
});

// ── extend ────────────────────────────────────────────────────────────────

test("Extend projects the line past the anchors it is told to", () => {
  const plain = render(drawing("trend", {})).lines[0]!;
  assert.equal(plain.x1, 100, "an unextended line starts at its first anchor");
  assert.equal(plain.x2, 300);

  const right = render(drawing("trend", { extend: "right" })).lines[0]!;
  assert.equal(right.x1, 100, "extending right leaves the first anchor alone");
  assert.ok(right.x2 > 300, "and pushes the second one away");

  const left = render(drawing("trend", { extend: "left" })).lines[0]!;
  assert.ok(left.x1 < 100);
  assert.equal(left.x2, 300);

  const both = render(drawing("trend", { extend: "both" })).lines[0]!;
  assert.ok(both.x1 < 100 && both.x2 > 300);
});

// ── middle point and price labels ────────────────────────────────────────

test("Middle point draws a handle at the midpoint, and only when asked", () => {
  assert.equal(render(drawing("trend", {})).arcs.length, 0);
  const arcs = render(drawing("trend", { middlePoint: true })).arcs;
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0]!.x, 200, "midway between 100 and 300");
  assert.equal(arcs[0]!.y, 150, "midway between 100 and 200");
});

test("Price labels tag every anchor's price, once per row", () => {
  assert.equal(render(drawing("trend", {})).texts.length, 0);
  const tagged = render(drawing("trend", { priceLabels: true })).texts;
  assert.equal(tagged.length, 2, "one per anchor");

  // A horizontal line's two anchors share a row; two identical tags stacked on
  // the same pixel is a smudge, not information.
  const flat = render(drawing("trend", { priceLabels: true }, [
    { time: 100, price: 150 }, { time: 300, price: 150 },
  ])).texts;
  assert.equal(flat.length, 1);
});

// ── the info block ────────────────────────────────────────────────────────

test("Stats are a selection affordance until Always show is set", () => {
  const style = { stats: true } as Partial<DrawingStyle>;
  assert.equal(render(drawing("trend", style), false).texts.length, 0, "not selected");
  assert.ok(render(drawing("trend", style), true).texts.length > 0, "selected");
  assert.ok(
    render(drawing("trend", { stats: true, alwaysShowStats: true }), false).texts.length > 0,
    "always shown survives deselection"
  );
});

test("the info block reports change, duration and angle", () => {
  const text = render(drawing("trend", { stats: true }), true).texts[0]!.text;
  assert.match(text, /\+/, "a rise is signed");
  assert.match(text, /%/, "a percentage is given");
  assert.match(text, /°/, "and the angle");
});

test("Stats position moves the block rather than being decorative", () => {
  const at = (statsPosition: DrawingStyle["statsPosition"]) =>
    render(drawing("trend", { stats: true, statsPosition }), true).texts[0]!.x;
  assert.ok(at("left") < at("center"), "left sits before centre");
  assert.ok(at("center") < at("right"), "and centre before right");
});

// ── the Text tab ──────────────────────────────────────────────────────────

test("the Text tab's size, weight and slant reach the font", () => {
  const plain = render(drawing("text", { text: "hi" })).fonts;
  assert.ok(plain.some((f) => f.includes("13px")), "unset keeps the old 13px");

  const styled = render(drawing("text", {
    text: "hi", fontSize: 20, bold: true, italic: true,
  })).fonts.join("|");
  assert.match(styled, /20px/);
  assert.match(styled, /bold/);
  assert.match(styled, /italic/);
});

test("the label's own colour is used, and falls back to the line colour", () => {
  assert.ok(
    render(drawing("text", { text: "hi", textColor: "#ff0000" })).fillStyles.includes("#ff0000")
  );
  // A drawing that never set one must look exactly as it did.
  assert.ok(
    render(drawing("text", { text: "hi" })).fillStyles.includes("#2962ff")
  );
});

test("both alignments are applied, and neither leaks to the next drawing", () => {
  const rec = render(drawing("text", {
    text: "hi", textHAlign: "center", textVAlign: "middle",
  }));
  assert.ok(rec.aligns.includes("center"));
  assert.ok(rec.baselines.includes("middle"));
  // The context is shared with every other branch, so a leaked textAlign would
  // move labels that never asked to move.
  assert.equal(rec.aligns[rec.aligns.length - 1], "left");
  assert.equal(rec.baselines[rec.baselines.length - 1], "alphabetic");
});
