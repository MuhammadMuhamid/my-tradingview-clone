/**
 * A Pine plot's look, set in the Style tab, survives the script's next run.
 *
 * The look is stored beside the run output and laid over it by
 * `applyPlotStyles`, so these feed it fresh output — as each run produces —
 * and check what the chart is handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlotStyles, plotKey, validPlotStyles } from "../lib/indicators";
import type { ChartOverlay } from "../lib/chartSeries";

const run = (): ChartOverlay[] => ([
  {
    id: "s1", title: "Basis", color: "#2962ff", width: 1,
    data: [{ time: 1, value: 1, color: "#ff0000" }, { time: 2, value: 2, color: null }, { time: 3, value: 3 }],
  },
  { id: "s2", title: "", color: "#f23645", width: 2, data: [] },
] as unknown as ChartOverlay[]);

test("a plot is keyed by its title, and an untitled one by its position", () => {
  const [a, b] = run();
  assert.equal(plotKey(a!, 0), "Basis");
  assert.equal(plotKey(b!, 1), "plot 2");
});

test("no styles: the run's own output, untouched", () => {
  const out = run();
  assert.equal(applyPlotStyles(out, undefined), out);
});

test("colour, width and dash override the script's; a hidden plot is dropped", () => {
  const out = applyPlotStyles(run(), {
    Basis: { color: "#00ff00", width: 3, lineStyle: "dotted" },
    "plot 2": { hidden: true },
  });
  assert.equal(out.length, 1);
  const [basis] = out;
  assert.equal(basis!.color, "#00ff00");
  assert.equal(basis!.width, 3);
  assert.equal(basis!.lineStyle, "dotted");
  assert.equal(basis!.dashed, false);
  // The script's per-bar tint gives way to the chosen colour; its `na` (null) stays hidden.
  const pts = basis!.data as { color?: string | null }[];
  assert.equal("color" in pts[0]!, false);
  assert.equal(pts[1]!.color, null);
  assert.equal("color" in pts[2]!, false);
});

test("a stored look keeps its well-formed parts and drops the rest", () => {
  assert.equal(validPlotStyles(null), undefined);
  assert.equal(validPlotStyles({ A: { color: "red", width: 9 } }), undefined);
  assert.deepEqual(
    validPlotStyles({ A: { color: "#AbCdEf", width: 2, lineStyle: "wavy", hidden: "yes" }, B: { hidden: true } }),
    { A: { color: "#AbCdEf", width: 2 }, B: { hidden: true } },
  );
});
