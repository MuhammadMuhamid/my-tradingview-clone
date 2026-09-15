/**
 * A closed bottom panel takes no room, and can still be reopened.
 *
 * ── FG-04, and the constraint that had to be lifted first ─────────────────
 *
 * The product carried TWO stacked grey bars under every chart: a 31px range
 * row and a 34px tab row, 65px together. Read directly off a signed-in
 * TradingView at 1440×900 with its bottom panel closed, `.layout__area--bottom`
 * measures 0 and not one panel tab is on screen. One strip, 38px.
 *
 * The tab strip could not simply be hidden, because it was the ONLY way back
 * to the panel: no keyboard shortcut, no command-palette row, no toolbar
 * control — grepped for, and absent. Hiding it would have traded 27 pixels of
 * chrome for stranding anyone who closed it, which is a worse defect than the
 * one being fixed.
 *
 * So the two halves are tested together, because neither is correct alone.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, resetBrowser, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { BINDINGS } from "@/lib/shortcuts";

beforeEach(() => { resetBrowser(); });
after(closeBrowser);

const tabStrip = (c: HTMLElement): HTMLElement | null =>
  c.querySelector<HTMLElement>('[role="tablist"][aria-label="Bottom workstation"]');

/**
 * Open the panel, since the workstation starts with it collapsed.
 *
 * Worth stating because the first draft of this file assumed the opposite and
 * one of its tests passed for it: "`p` did not close an open panel" asserted
 * the strip was absent after one press, which was already true before the
 * press. It asserts the panel is open first now.
 */
async function open(container: HTMLElement): Promise<void> {
  fireEvent.keyDown(document, { key: "p", altKey: true, shiftKey: true });
  await settle();
  assert.ok(tabStrip(container), "setup: the panel would not open");
}

/** Collapse the panel the way a user does. */
async function collapse(container: HTMLElement): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.getAttribute("aria-label") === "Minimize panel");
  assert.ok(button, "no control minimises the panel");
  fireEvent.click(button);
  await settle();
}

test("FG-04 — a collapsed panel leaves nothing behind", async () => {
  const chart = await mountChart();
  await settle();
  await open(chart.container);

  await collapse(chart.container);

  assert.equal(tabStrip(chart.container), null,
    "the tab strip is still there, so the chart still carries two stacked bars "
    + "where the reference carries one");
  for (const label of ["Positions & Orders", "Strategy Tester", "Pine Editor"]) {
    const still = [...chart.container.querySelectorAll("button")]
      .some((b) => (b.textContent ?? "").trim() === label);
    assert.ok(!still, `"${label}" is still on screen with the panel closed`);
  }
});

test("FG-04 — and the keyboard brings it back", async () => {
  const chart = await mountChart();
  await settle();
  await open(chart.container);
  await collapse(chart.container);
  assert.equal(tabStrip(chart.container), null, "setup: the panel is not closed");

  fireEvent.keyDown(document, { key: "p", altKey: true, shiftKey: true });
  await settle();

  assert.ok(tabStrip(chart.container),
    "the panel cannot be reopened — closing it strands the user, which is "
    + "worse than the chrome this repair removed");
});

test("FG-04 — the same key closes it again", async () => {
  const chart = await mountChart();
  await settle();
  await open(chart.container);

  fireEvent.keyDown(document, { key: "p", altKey: true, shiftKey: true });
  await settle();
  assert.equal(tabStrip(chart.container), null, "`p` did not close an open panel");

  fireEvent.keyDown(document, { key: "p", altKey: true, shiftKey: true });
  await settle();
  assert.ok(tabStrip(chart.container), "`p` did not reopen it");
});

test("FG-04 — the reopen path is advertised, not just implemented", async () => {
  /*
   * A shortcut nobody can discover is not a way back. `BINDINGS` is the single
   * table the keyboard handler, the command palette and the shortcuts sheet
   * all read, so one entry here is three places a user can find it — and this
   * asserts the entry carries what those two surfaces need to show it.
   */
  const binding = BINDINGS.find((b) => b.action === "bottom-panel");
  assert.ok(binding, "there is no binding, so there is no palette row either");
  assert.ok(!binding.chordless,
    "a chordless binding is hidden from the palette, which is where a user looks");
  assert.ok((binding.label ?? "").length > 0, "the palette row would have no name");
  assert.equal(binding.group, "Navigation");

  const collisions = BINDINGS.filter((b) =>
    b.key === binding.key && b.mod === binding.mod && b.shift === binding.shift);
  assert.deepEqual(collisions.map((b) => b.action), ["bottom-panel"],
    "the key is already bound to something else");
});
