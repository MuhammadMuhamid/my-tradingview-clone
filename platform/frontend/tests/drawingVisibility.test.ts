import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CURSOR_TOOLS, drawingVisibleOnTimeframe, TEXT_TOOLS, TOOL_POINTS,
  type Drawing, type DrawingTool,
} from "../lib/drawings";

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
    // TVP8 round three: the Icons cell. `icon` paints a Unicode glyph at one
    // anchor, so it has a renderer branch like every other drawing.
    "icon",
    "regression", "schiffPitchfork", "fibChannel", "gannBox", "xabcd",
    "elliottImpulse", "cyclicLines", "positionForecast", "rotatedRectangle", "table",
  ];
  for (const tool of variants) {
    assert.ok(Object.prototype.hasOwnProperty.call(TOOL_POINTS, tool), `${tool} lacks anchor semantics`);
    assert.match(toolbar, new RegExp(`tool: "${tool}"`), `${tool} is not reachable from the toolbar`);
    assert.ok(canvas.includes(`"${tool}"`), `${tool} has no canvas renderer branch`);
  }

  /*
   * The two cells that are one tool each, and are therefore not in a group.
   * `zoom` is in the tool union because the union is the rail's only channel
   * to the canvas — arming it makes a drag select a span of time and hand it
   * to the chart's own `setVisibleRange`. Nothing is committed, which is why
   * it is checked here and not among the variants above.
   */
  /*
   * The reference's second cursor is a MODE, not a shape: it selects and drags
   * exactly as the cross does and differs only in the pointer it paints. So it
   * has no renderer branch, and what must be true of it is that the canvas
   * asks `isCursorMode` rather than `tool === "cursor"` — otherwise arming it
   * would start a freeform draft nothing could finish.
   */
  assert.ok(CURSOR_TOOLS.has("arrowCursor" as DrawingTool));
  assert.match(toolbar, /tool: "arrowCursor"/, "the Arrow cursor is not on the rail");
  assert.match(canvas, /isCursorMode\(/,
    "the canvas still hard-codes one cursor, so a second one draws instead of selecting");
  assert.doesNotMatch(canvas, /tool(?:Ref\.current)? [=!]== "cursor"/,
    "every cursor-vs-draw decision must go through isCursorMode");

  for (const tool of ["ruler", "zoom"] as DrawingTool[]) {
    assert.ok(Object.prototype.hasOwnProperty.call(TOOL_POINTS, tool), `${tool} lacks anchor semantics`);
    assert.match(toolbar, new RegExp(`tool: "${tool}"`), `${tool} is not reachable from the rail`);
    assert.ok(canvas.includes(`"${tool}"`), `${tool} is not handled by the canvas`);
  }
  for (const tool of ["note", "priceNote", "comment", "signpost", "flagMark"] as DrawingTool[]) {
    assert.ok(TEXT_TOOLS.has(tool), `${tool} must collect its caption through the shared text flow`);
  }
});

test("advanced TradingView families share persisted anchor-template semantics", () => {
  const toolbar = read("components/tv/DrawingToolbar.tsx");
  const canvas = read("components/tv/DrawingCanvas.tsx");
  const advanced: DrawingTool[] = [
    "regression", "flatTopBottom", "schiffPitchfork", "modifiedSchiffPitchfork", "insidePitchfork",
    "fibChannel", "fibTimeZone", "trendFibTime", "fibSpeedResistanceFan", "fibSpeedResistanceArcs",
    "fibCircles", "fibSpiral", "fibWedge", "pitchfan", "gannBox", "gannSquareFixed", "gannSquare", "gannFan",
    "xabcd", "cypher", "headAndShoulders", "abcdPattern", "trianglePattern", "threeDrives",
    "elliottImpulse", "elliottCorrection", "elliottTriangle", "elliottDoubleCombo", "elliottTripleCombo",
    "cyclicLines", "timeCycles", "sineLine", "positionForecast", "barsPattern", "sector", "rotatedRectangle", "table",
  ];
  for (const tool of advanced) {
    assert.equal(typeof TOOL_POINTS[tool], "number", `${tool} has no anchor count`);
    assert.match(toolbar, new RegExp(`tool: "${tool}"`), `${tool} is not exposed`);
    assert.ok(canvas.includes(`"${tool}"`), `${tool} is not handled by the shared renderer`);
  }
});
