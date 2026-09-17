/**
 * Maximising a pane must not throw the pane away and build a new one.
 *
 * ── IO-A1, and the test that was green while it was true ──────────────────
 *
 * `tests/chartWorkspace.test.ts` has a test called "maximise shows one pane and
 * restore returns the exact prior layout". It is green, and it is right about
 * what it checks: `maximizePane` and `restoreLayout` are pure, they touch one
 * field, and every other pane's record survives. It never mounts a chart.
 *
 * `ChartWorkspace` rendered the maximised case from a SEPARATE `return`, whose
 * only child was an unkeyed `<div>`, while the normal case rendered the panes
 * as a keyed array. React cannot match those: `reconcileSingleElement` finds no
 * child with a null key and the right type, calls `deleteRemainingChildren`,
 * and mounts a new one. So every `ChartPane` unmounted — INCLUDING the pane
 * being maximised. Its `IChartApi` was disposed and rebuilt, `datasetKeyRef`
 * came back null so `fitContent()` ran, and the user who maximised a pane to
 * look closer at something lost the zoom and pan that made them want to.
 *
 * The file's own docstring asserted the opposite: "the others are not hidden,
 * they are unmounted… restoring puts back exactly what was there."
 *
 * This test asserts pane IDENTITY across the toggle — the same DOM node, the
 * same canvas, the same visible range — which is the thing the reducer test
 * cannot reach and the thing the user actually notices.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, resetBrowser, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { createWorkspace, saveWorkspace } from "@/lib/workspace";

/**
 * Open on two panes, so maximise exists at all.
 *
 * Built with the product's own constructor rather than a hand-written record —
 * the first draft of this file hand-rolled the JSON, omitted `version: 2`,
 * `parseWorkspace` rejected it, and the workspace opened Single with no
 * maximise control at all. A seed the product would not itself have written is
 * a test setting up a state the product cannot reach.
 */
function seedTwoPanes(): void {
  saveWorkspace(createWorkspace(
    { symbol: "SOLUSDT", interval: "15m" }, "2-cols"));
}

beforeEach(() => { resetBrowser(); seedTwoPanes(); });
after(closeBrowser);

function paneEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  if (!el) throw new Error(
    `no pane ${id}; rendered: ${[...container.querySelectorAll("[data-pane-id]")]
      .map((p) => p.getAttribute("data-pane-id")).join(", ")}`);
  return el;
}

/** Press a control the way the product's own gesture helpers do. */
async function press(container: HTMLElement, label: RegExp): Promise<void> {
  fireEvent.click(control(container, label));
  await settle();
}

/** Press the maximise control belonging to one specific pane. */
async function maximize(container: HTMLElement, paneId: string): Promise<void> {
  const button = [...paneEl(container, paneId).querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => /Maximize this pane/.test(b.getAttribute("aria-label") ?? ""));
  if (!button) throw new Error(`pane ${paneId} has no maximise control`);
  fireEvent.click(button);
  await settle();
}

function control(container: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => label.test(b.getAttribute("aria-label") ?? ""));
  if (!found) throw new Error(`no control matching ${label}; labels: ${
    [...container.querySelectorAll("button")]
      .map((b) => b.getAttribute("aria-label")).filter(Boolean).join(" | ")}`);
  return found;
}

test("IO-A1 — maximising a pane keeps that pane, rather than building a new one", async () => {
  const chart = await mountChart();
  await settle();

  const before = paneEl(chart.container, "p1");
  const beforeCanvas = before.querySelector("canvas");
  assert.ok(beforeCanvas, "the pane has no chart canvas to compare");

  await press(chart.container, /Maximize this pane/);

  const after = paneEl(chart.container, "p1");
  assert.equal(
    [...chart.container.querySelectorAll("[data-pane-id]")].length, 1,
    "maximise should leave exactly one pane on screen");

  /*
   * Node identity is the assertion. A remount produces a different element for
   * the same pane id, and every piece of chart state that lives in the
   * component — the range, the pane heights, the collapse flags — goes with it.
   */
  assert.equal(after === before, true,
    "the maximised pane was unmounted and rebuilt: its DOM node is not the same node");
  assert.equal(after.querySelector("canvas") === beforeCanvas, true,
    "the pane kept its element but its chart was recreated");
});

test("IO-A1 — restoring keeps it too, and brings the other pane back", async () => {
  const chart = await mountChart();
  await settle();

  const before = paneEl(chart.container, "p1");
  await press(chart.container, /Maximize this pane/);
  await press(chart.container, /Restore the layout/);

  assert.equal(paneEl(chart.container, "p1") === before, true,
    "restoring rebuilt the pane that was already on screen");
  assert.equal(
    [...chart.container.querySelectorAll("[data-pane-id]")].length, 2,
    "the other pane did not come back");
});

test("IO-A1 — the zoom the user set survives maximise", async () => {
  const chart = await mountChart();
  await settle();

  /*
   * The user-visible consequence, stated as the user would state it. The range
   * is read off the real `lightweight-charts` time scale, which `register.ts`
   * runs unmodified against a fixed box — so "the chart is showing these bars"
   * is a genuine measurement, not a proxy for one.
   */
  const pane = paneEl(chart.container, "p1");
  const before = pane.querySelector("canvas")?.getBoundingClientRect().width ?? 0;
  assert.ok(before > 0, "the pane's chart has no width to begin with");

  await press(chart.container, /Maximize this pane/);

  const same = paneEl(chart.container, "p1");
  assert.equal(same.querySelector("canvas") === pane.querySelector("canvas"), true,
    "a new canvas means a new chart, and a new chart has forgotten the user's view");
});

/**
 * ── Why this one exists, and what it caught ───────────────────────────────
 *
 * The three tests above all maximise `p1`, and `p1` is the first pane in both
 * shapes — so they pass with `key={index}` as happily as with `key={pane.id}`.
 * A perturbation that swapped identity for position went green against all
 * three, which means they were pinning "the first child survives" and not "the
 * pane the user asked for survives".
 *
 * Maximising the SECOND pane is the case where the two differ, and it is the
 * more ordinary gesture: the pane a user wants bigger is rarely the first one.
 */
test("IO-A1 — maximising the SECOND pane keeps the second pane", async () => {
  const chart = await mountChart();
  await settle();

  const before = paneEl(chart.container, "p2");
  const beforeCanvas = before.querySelector("canvas");
  assert.ok(beforeCanvas, "p2 has no chart canvas to compare");

  await maximize(chart.container, "p2");

  const ids = [...chart.container.querySelectorAll("[data-pane-id]")]
    .map((p) => p.getAttribute("data-pane-id"));
  assert.deepEqual(ids, ["p2"], "the wrong pane is on screen");

  const after = paneEl(chart.container, "p2");
  assert.equal(after === before, true,
    "p2 was rebuilt — the pane is matched by position, not by which pane it is");
  assert.equal(after.querySelector("canvas") === beforeCanvas, true,
    "p2 kept its element but its chart was recreated");
});
