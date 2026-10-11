/**
 * W2A-03 and W2A-10: drawing style templates and the interval-visibility
 * shortcuts, as pure functions over `lib/drawings`.
 *
 * The three doors to a template — the floating toolbar, the settings dialog's
 * footer and the drawing menu's `Template ›` — are driven in the DOM suites;
 * what they share is here: per-tool lists, content kept out of a style, and
 * apply-REPLACES rather than apply-merges.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDrawingTemplate, defaultDrawingTemplate, deleteDrawingTemplate, DRAWING_TEMPLATES_KEY,
  intervalVisibilityOf, loadDrawingTemplates, saveDrawingTemplate, templatesForTool, visibleOnFor,
} from "../lib/drawings";
import { NATIVE_RESOLUTIONS } from "../lib/resolution";

let cells: Map<string, string>;
beforeEach(() => {
  cells = new Map();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => cells.get(k) ?? null,
        setItem: (k: string, v: string) => { cells.set(k, v); },
        removeItem: (k: string) => { cells.delete(k); },
      },
    },
  });
});

test("a template is saved for its tool, and only offered on that tool", () => {
  let all = saveDrawingTemplate([], "Thin", { color: "#ff9800", width: 1 }, "trend");
  all = saveDrawingTemplate(all, "Thin", { color: "#2962ff", width: 1 }, "fib");
  assert.equal(all.length, 2, "a trendline's Thin and a Fib's Thin are two templates");
  assert.deepEqual(templatesForTool(all, "trend").map((t) => t.style.color), ["#ff9800"]);
  assert.deepEqual(templatesForTool(all, "ray"), []);
  assert.deepEqual(loadDrawingTemplates(), all, "and it is what storage holds");
});

test("a template written before templates were per tool is still offered, everywhere", () => {
  cells.set(DRAWING_TEMPLATES_KEY, JSON.stringify([{ name: "Old", style: { color: "#fff", width: 3 } }]));
  const all = loadDrawingTemplates();
  assert.deepEqual(templatesForTool(all, "trend").map((t) => t.name), ["Old"]);
  assert.deepEqual(templatesForTool(all, "rect").map((t) => t.name), ["Old"]);
});

test("a stored template for a tool this build does not know is dropped, not offered", () => {
  cells.set(DRAWING_TEMPLATES_KEY, JSON.stringify([
    { name: "Future", tool: "hologram", style: { color: "#fff", width: 3 } },
    { name: "Kept", tool: "trend", style: { color: "#fff", width: 3 } },
  ]));
  assert.deepEqual(loadDrawingTemplates().map((t) => t.name), ["Kept"]);
});

test("deleting a template deletes that tool's, and not a namesake on another tool", () => {
  let all = saveDrawingTemplate([], "Thin", { color: "#ff9800", width: 1 }, "trend");
  all = saveDrawingTemplate(all, "Thin", { color: "#2962ff", width: 1 }, "fib");
  all = deleteDrawingTemplate(all, { name: "Thin", tool: "trend" });
  assert.deepEqual(all.map((t) => t.tool), ["fib"]);
});

test("what a drawing SAYS is not part of its style", () => {
  const all = saveDrawingTemplate([], "Label", {
    color: "#ff9800", width: 2, text: "Breakout", glyph: "🚀",
  }, "trend");
  assert.equal(all[0]!.style.text, undefined, "the label was saved into the template");
  assert.equal(all[0]!.style.glyph, undefined);
});

test("applying a template REPLACES the look and keeps the text", () => {
  const current = { color: "#ff9800", width: 4, dashed: true, lineStyle: "dashed" as const, filled: true, text: "Mine" };
  const next = applyDrawingTemplate(current, { color: "#2962ff", width: 1 });
  assert.deepEqual(next, { color: "#2962ff", width: 1, text: "Mine" },
    "a merge would have left the line dashed and filled");
});

test("Apply default is the style a new drawing starts with", () => {
  assert.deepEqual(
    applyDrawingTemplate({ color: "#ff980080", width: 4, dashed: true }, defaultDrawingTemplate()),
    { color: "#4f8cff", width: 2 });
});

test("Visibility on intervals: the four shortcuts over the same allow-list", () => {
  assert.equal(visibleOnFor("all", "1h"), undefined);
  assert.deepEqual(visibleOnFor("only", "1h"), ["1h"]);
  assert.deepEqual(visibleOnFor("above", "4h"), ["4h", "6h", "8h", "12h", "1d"]);
  assert.deepEqual(visibleOnFor("below", "3m"), ["1s", "1m", "3m"]);
  // The shortest and the longest: "and above" / "and below" is everywhere.
  assert.equal(visibleOnFor("above", NATIVE_RESOLUTIONS[0]!), undefined);
  assert.equal(visibleOnFor("below", "1d"), undefined);
  // A custom interval is kept in its own list even though no native one is it.
  assert.deepEqual(visibleOnFor("above", "45m"), ["1h", "2h", "4h", "6h", "8h", "12h", "1d", "45m"]);
});

test("the menu can say which shortcut a drawing is on, and none for a hand-made list", () => {
  assert.equal(intervalVisibilityOf(undefined, "1h"), "all");
  assert.equal(intervalVisibilityOf(["1h"], "1h"), "only");
  assert.equal(intervalVisibilityOf(visibleOnFor("above", "1h"), "1h"), "above");
  assert.equal(intervalVisibilityOf(visibleOnFor("below", "1h"), "1h"), "below");
  assert.equal(intervalVisibilityOf(["1m", "1d"], "1h"), null);
});
