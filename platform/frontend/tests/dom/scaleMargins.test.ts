/**
 * What the chart library ACTUALLY refuses, measured rather than believed.
 *
 * ── IO-A8, which was reported as a defect and is not one ──────────────────
 *
 * The finding: the two margin controls each accept 0–50, fifty and fifty is
 * 1.0, lightweight-charts "requires the two to sum to less than one", the
 * throw is swallowed by the call site's `try`/`catch`, and both controls are
 * therefore inert with nothing said. It is a clean argument and it reads
 * straight off the library's own error message.
 *
 * Driven against the real `IPriceScaleApi` at the version this product ships:
 *
 *     0.5 / 0.5  → accepted, stored as 0.5 / 0.5
 *     0.6 / 0.6  → Invalid margins - sum of margins must be less than 1, given=1.2
 *
 * The test is `sum > 1`. The dialog's maximum lands exactly ON the limit, which
 * is accepted. **The controls were never inert**, and the finding is recorded
 * as INVALID_FINDING rather than repaired.
 *
 * What this file is for now is the part that is true: the dialog's maximum sits
 * one step from the far side of a line the call site's `catch` would hide, so
 * the boundary is worth pinning where a change to either cap will meet it. If
 * the library's rule ever tightens, this fails and the pure test does not.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createChart, type IChartApi } from "lightweight-charts";
import { resetBrowser } from "./harness/env";
import { MAX_SCALE_MARGIN_SUM, scaleMarginsFor } from "@/lib/chartSettings";

let chart: IChartApi;

beforeEach(() => {
  resetBrowser();
  const host = document.createElement("div");
  document.body.appendChild(host);
  chart = createChart(host, { width: 600, height: 400 });
});

/** Every pair of whole percentages the two dialog controls can produce. */
function* dialogPairs(): Generator<[number, number]> {
  for (let top = 0; top <= 50; top += 5) {
    for (let bottom = 0; bottom <= 50; bottom += 5) yield [top, bottom];
  }
}

test("IO-A8 — the library accepts every margin pair the dialog allows", () => {
  const scale = chart.priceScale("right");
  const refused: string[] = [];

  for (const [top, bottom] of dialogPairs()) {
    try {
      scale.applyOptions({ scaleMargins: scaleMarginsFor(top, bottom) });
    } catch (cause) {
      refused.push(`${top}/${bottom}: ${(cause as Error).message}`);
    }
  }

  assert.deepEqual(refused, [],
    "a value the dialog offers is one the chart refuses, which is how both "
    + "margin controls went inert with nothing said");
});

test("IO-A8 — the dialog's own maximum is accepted, so the controls do reach the chart", () => {
  /*
   * The assertion the finding would have failed. 50/50 is the most the two
   * boxes can ask for; if the library refused it, both controls really would
   * be inert and the `catch` really would be hiding it.
   */
  const scale = chart.priceScale("right");
  scale.applyOptions({ scaleMargins: { top: 0.5, bottom: 0.5 } });
  const applied = scale.options().scaleMargins;
  assert.equal(applied.top, 0.5, "the dialog's maximum did not reach the scale");
  assert.equal(applied.bottom, 0.5);
});

test("IO-A8 — and one step past it is refused, which is what the clamp is for", () => {
  /*
   * The line is real and it is close. Widening either cap from 50, or adding
   * any third contribution to the margins, crosses it — and on the far side
   * the call site's `catch` turns a refusal into two silently dead controls.
   */
  const scale = chart.priceScale("right");
  assert.throws(
    () => scale.applyOptions({ scaleMargins: { top: 0.6, bottom: 0.6 } }),
    /sum of margins must be less than 1/,
    "the library takes a sum above 1 — then the clamp guards nothing");

  // And the clamp turns that same request into one it takes.
  scale.applyOptions({ scaleMargins: scaleMarginsFor(60, 60) });
  const applied = scale.options().scaleMargins;
  assert.ok(applied.top + applied.bottom <= MAX_SCALE_MARGIN_SUM + 1e-9);
});
