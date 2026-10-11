/**
 * W2A-06: a drawing's opacity, carried in its colour (`lib/colorAlpha`), and
 * read by the renderer and the price axis as that colour says.
 *
 * The picker's slider is asserted in `tests/dom/drawingStyleBar.test.tsx`;
 * this is the other half — that `#rrggbbaa` is what reaches the canvas, and
 * that the places which must stay opaque (the axis chip) do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { opaque, splitAlpha, withAlpha } from "../lib/colorAlpha";
import { drawOne, type ToPx } from "../components/tv/DrawingCanvas";
import { drawingAxisTags } from "../lib/drawingAxisLabels";
import type { Drawing } from "../lib/drawings";

test("opacity round-trips through the colour string", () => {
  assert.equal(withAlpha("#2962ff", 50), "#2962ff80");
  assert.deepEqual(splitAlpha("#2962ff80"), { hex: "#2962ff", opacity: 50 });
  assert.equal(withAlpha("#2962ff80", 25), "#2962ff40", "a new opacity replaces the old one");
  assert.equal(withAlpha("#2962FF", 0), "#2962ff00");
});

test("fully opaque is the six-digit colour, byte for byte as before", () => {
  assert.equal(withAlpha("#2962ff80", 100), "#2962ff");
  assert.equal(withAlpha("#2962ff", 140), "#2962ff", "out of range clamps rather than inventing a byte");
  assert.deepEqual(splitAlpha("#2962ff"), { hex: "#2962ff", opacity: 100 });
});

test("a colour it does not understand is left alone", () => {
  assert.equal(withAlpha("", 50), "", "the theme's own colour has no alpha to set");
  assert.equal(withAlpha("rgb(1, 2, 3)", 50), "rgb(1, 2, 3)");
  assert.equal(opaque("var(--ts-ink)"), "var(--ts-ink)");
});

const toPx: ToPx = (p) => ({ x: p.time, y: p.price });
const line = (color: string): Drawing => ({
  id: "d1", tool: "rect",
  points: [{ time: 100, price: 100 }, { time: 300, price: 200 }],
  style: { color, width: 2, filled: true },
});

test("the canvas is handed the translucent colour, not an opaque one", () => {
  const strokes: string[] = [];
  const fills: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (key === "measureText") return (t: string) => ({ width: t.length * 6 });
      if (key === "getLineDash") return () => [];
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, key, value) {
      if (key === "strokeStyle") strokes.push(String(value));
      if (key === "fillStyle") fills.push(String(value));
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  drawOne(ctx, line("#2962ff80"), toPx, 800, 400, false, false, []);
  assert.ok(strokes.includes("#2962ff80"), `the outline was stroked in ${JSON.stringify(strokes)}`);
  assert.ok(fills.includes("#2962ff80"), `the fill was painted in ${JSON.stringify(fills)}`);
});

test("the price axis tags a translucent level with an opaque chip", () => {
  const level: Drawing = {
    id: "h1", tool: "hline", points: [{ time: 100, price: 42 }], style: { color: "#f2364540", width: 1 },
  };
  assert.deepEqual(drawingAxisTags([level], "1h"), [{ price: 42, color: "#f23645" }]);
});
