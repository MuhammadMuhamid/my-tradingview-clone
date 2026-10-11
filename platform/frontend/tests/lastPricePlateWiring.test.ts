/**
 * How `CandleChart` wires the last-price plate and the axis around it (A8,
 * B-13). The primitive's own behaviour is `barCountdown.test.ts`; these are the
 * three decisions that live in the component, read from its source with the
 * comments stripped so a comment cannot satisfy them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const chart = readFileSync(path.join(__dirname, "..", "components", "CandleChart.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("A8 — the series' own chip is off in every state, not only while the countdown runs", () => {
  /*
   * With the countdown off the library's chip came back: on the last VISIBLE
   * bar, in the price line's slate — a different label from the plate, so
   * the price tag moved and recoloured with a countdown switch.
   */
  assert.match(chart, /priceLineVisible: settings\.lastValueLine,[\s\S]{0,400}lastValueVisible: false,/);
  assert.doesNotMatch(chart, /countdownOwnsChip/);
});

test("A8 — the plate is given the series' colours, not the price line's", () => {
  assert.match(chart, /palette: \{ up: upColor, down: downColor, line: CHART_ACCENT \}/);
  assert.doesNotMatch(chart, /chipBackColor/,
    "`priceLineColor || lastBarColor` is what painted every plate slate");
});

test("A8 — the tick clearance is attached AFTER the plate, in one effect", () => {
  /*
   * Both draw from the axis's top pass, in attach order. The clearance has to
   * see the plate on the main canvas to clear a tick half under it.
   */
  const effect = /const primitive = new BarCountdownPrimitive\(\);[\s\S]*?series\.attachPrimitive\(primitive\)[\s\S]*?new AxisTickClearancePrimitive\(\);[\s\S]*?series\.attachPrimitive\(clearance\)/;
  assert.match(chart, effect);
  assert.equal(chart.match(/new AxisTickClearancePrimitive\(\)/g)?.length, 1,
    "a second, independently ordered clearance would race the plate again");
});

test("B-13 — the axis's auto / log / % strip carries an opaque backdrop", () => {
  // It was transparent, so on hover its words were drawn across the ticks.
  assert.match(chart, /data-axis-buttons=\{settings\.scaleButtons\}\s*className=\{`[^`]*\bbg-surface\b/);
});
