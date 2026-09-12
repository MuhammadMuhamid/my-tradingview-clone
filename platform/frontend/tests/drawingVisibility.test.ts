import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drawingVisibleOnTimeframe, TEXT_TOOLS, TOOL_POINTS, type Drawing, type DrawingTool } from "../lib/drawings";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const drawing: Drawing = {
  id: "d1", tool: "trend", points: [{ time: 1, price: 1 }, { time: 2, price: 2 }],
  style: { color: "#fff", width: 1 },
};

test("drawing visibility defaults to every timeframe for backward compatibility", () => {
  assert.equal(drawingVisibleOnTimeframe(drawing, "1m"), true);
  assert.equal(drawingVisibleOnTimeframe({ ...drawing, visibleOn: [] }, "1h"), true);
});

test("drawing visibility allow-lists are enforced by timeframe", () => {
  const scoped = { ...drawing, visibleOn: ["5m", "1h"] };
  assert.equal(drawingVisibleOnTimeframe(scoped, "5m"), true);
  assert.equal(drawingVisibleOnTimeframe(scoped, "1m"), false);
});

test("new drawing variants are registered, exposed and rendered by shared primitives", () => {
  const toolbar = read("components/tv/DrawingToolbar.tsx");
  const canvas = read("components/tv/DrawingCanvas.tsx");
  const variants: DrawingTool[] = [
    "dot", "trendAngle", "infoline", "crossline", "disjointChannel", "circle",
    "polyline", "arc", "curve", "doubleCurve", "highlighter", "arrowMarker",
    "arrowUp", "arrowDown", "note", "priceNote", "pin", "comment", "signpost", "flagMark",
    "avprofile", "datePriceRange",
  ];
  for (const tool of variants) {
    assert.ok(Object.prototype.hasOwnProperty.call(TOOL_POINTS, tool), `${tool} lacks anchor semantics`);
    assert.match(toolbar, new RegExp(`tool: "${tool}"`), `${tool} is not reachable from the toolbar`);
    assert.match(canvas, new RegExp(`case "${tool}"`), `${tool} has no canvas renderer branch`);
  }
  for (const tool of ["note", "priceNote", "comment", "signpost", "flagMark"] as DrawingTool[]) {
    assert.ok(TEXT_TOOLS.has(tool), `${tool} must collect its caption through the shared text flow`);
  }
});
