/**
 * The study legend's own row: its cluster, its hover box and its absences.
 *
 * ── Why these are DOM tests and not source greps ───────────────────────────
 *
 * Every one of the round-two findings against this row (R3b-19, -20, -22) was
 * a property of the RENDERED row — how many controls the hover reveals, what
 * the outline encloses, what colour a missing reading is drawn in — and the
 * round-one tests for the same row were greps over `IndicatorLegend.tsx`. A
 * grep cannot see that the cluster fell outside the outline it appears with,
 * and it cannot see that `∅` inherited the plot's colour through an inline
 * style. These render the component and read the DOM back.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { IndicatorLegend } from "@/components/tv/IndicatorLegend";
import { IndicatorPane } from "@/components/tv/IndicatorPane";

beforeEach(resetBrowser);
after(closeBrowser);

/** One study on the legend, with a reading and with none. */
const overlay = (value: number | null) => ({
  id: "rsi:0", title: "RSI", color: "#9b7cf5",
  instanceId: "nat_rsi", instanceTitle: "Relative Strength Index",
  instanceParams: "Length 14 · Source close",
  data: [{ time: 1_700_000_000, value, color: "#9b7cf5" }],
});

test("R3b-19 — the hover cluster is the reference's, at a 28px pitch with no gap", async () => {
  const view = render(
    <IndicatorLegend
      overlays={[overlay(61.18)]}
      time={1_700_000_000}
      collapsible={false}
      onAction={() => {}}
      canAction={() => true}
    />);
  await settle();

  const buttons = [...view.container.querySelectorAll("button")]
    .map((b) => b.getAttribute("aria-label") ?? "");
  assert.deepEqual(buttons, [
    "Hide Relative Strength Index",
    "Relative Strength Index settings",
    "Remove Relative Strength Index",
    "More for Relative Strength Index",
  ], "eye, gear, trash and the reference's More — in the reference's order");

  /*
   * The pitch is the BUTTON, not the button plus a gap: the reference's row is
   * 28px per control with nothing between them, and ours ran at 30 because a
   * `gap-0.5` sat on top of a 28×24 button.
   */
  const cluster = view.container.querySelector<HTMLElement>("span.flex.shrink-0.items-center");
  assert.ok(cluster, "the cluster is gone");
  assert.doesNotMatch(cluster.className, /\bgap-/,
    "a gap on top of a 28px button is a 30px pitch");
  /*
   * 28x22 with an 18px glyph, re-measured against live Premium on 2026-09-18.
   * The earlier 28x24/16 was recorded here and in the component as "measured",
   * and was not: the pitch was right, the cell was 2px too tall and the glyph a
   * ninth too small, which is why this cluster read lighter than the
   * reference's at the same zoom.
   */
  for (const button of view.container.querySelectorAll("button")) {
    assert.match(button.className, /h-\[22px\] w-7/, "28×22, the reference's legend-action size");
    const glyph = button.querySelector("svg");
    assert.equal(glyph?.getAttribute("width"), "18", "an 18px glyph, as the reference draws it");
  }
});

test("R3b-20 — the hover outline encloses the title, the params AND the cluster", async () => {
  const view = render(
    <IndicatorLegend
      overlays={[overlay(61.18)]}
      time={1_700_000_000}
      collapsible={false}
      onAction={() => {}}
      canAction={() => true}
    />);
  await settle();

  /*
   * The box is the element that grows a border on hover. What this test is
   * about is what is INSIDE it: the cluster used to be a sibling, so the row
   * drew an outline around half of what the hover had revealed.
   */
  const box = [...view.container.querySelectorAll<HTMLElement>("span")]
    .find((el) => /group-hover\/study:border-/.test(el.className));
  assert.ok(box, "no element takes the hover outline any more");
  assert.match(box.className, /h-6/, "the reference's box is 24px tall");
  assert.match(box.className, /group-hover\/study:bg-surface/,
    "with a fill of the chart's own ground, so the candles under it are knocked back");
  assert.match(box.textContent ?? "", /Relative Strength Index/);
  assert.match(box.textContent ?? "", /Length 14/);
  assert.ok(
    within(box).getByRole("button", { name: "More for Relative Strength Index" }),
    "the cluster must be inside the outline, not beside it");

  // And the VALUE stays outside it, because it is about the crosshair.
  assert.doesNotMatch(box.textContent ?? "", /61\.18/);
  assert.match(view.container.textContent ?? "", /61\.18/);
});

test("R3b-22 — an absent reading is neutral, not the plot's colour", async () => {
  const view = render(
    <IndicatorLegend overlays={[overlay(null)]} time={1_700_000_000} collapsible={false} />);
  await settle();

  const empty = [...view.container.querySelectorAll<HTMLElement>("span")]
    .find((el) => el.textContent?.startsWith("∅"));
  assert.ok(empty, "the legend no longer marks an absent reading");
  assert.equal(empty.style.color, "",
    "`∅` in the plot's colour reads as a value in that colour, and there is no value");
  assert.match(empty.className, /text-ink-muted/, "the reference draws its empty marker neutral");

  // The plot is still identifiable: the name is on the tooltip and in the
  // screen-reader text, which is what the colour was standing in for.
  assert.equal(empty.getAttribute("title"), "RSI");
});

test("R3b-19 — `⋯` opens the product's own menu, and every row in it acts", async () => {
  const acted: string[] = [];
  const view = render(
    <IndicatorLegend
      overlays={[overlay(61.18)]}
      time={1_700_000_000}
      collapsible={false}
      onAction={(id, action) => acted.push(`${id}:${action}`)}
      canAction={() => true}
    />);
  await settle();

  fireEvent.click(
    view.getByRole("button", { name: "More for Relative Strength Index" }));
  await settle();

  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu, "the More button opened nothing");
  const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  assert.deepEqual(rows.map((r) => (r.textContent ?? "").trim()),
    ["Settings…", "Hide", "Object tree", "Remove"]);

  /*
   * `Remove`, not `Remove Relative Strength Index`. The drawing menu three
   * functions away already says `Remove` with a bin, so the long form made this
   * menu the odd one out in its own product as well as against the reference —
   * and the study's name is already the menu's heading.
   */

  /* Every row carries the icon its gutter reserves. The gutter was reserved
     and left empty, which is the most "unfinished" thing a menu can do. */
  for (const row of rows) {
    assert.ok(row.querySelector("svg"), `${row.textContent} reserves an icon slot and draws nothing`);
  }

  /*
   * Not one row is disabled, and that is the point: the reference's indicator
   * menu carries `Move to`, `Pin to scale`, `Visual order`, `Copy` and
   * `Add alert on …` as well, and none of them is written here as a greyed
   * row, because a legend cannot reach a resolver for them yet. A menu of
   * mostly-dead rows teaches nothing — see `lib/menuPayloads`. `Object tree`
   * joined because it is the one of them this product CAN hand somewhere: the
   * chart menu's own row already resolves to the objects panel.
   */
  for (const row of rows) {
    assert.notEqual(row.getAttribute("aria-disabled"), "true", `${row.textContent} cannot act`);
  }

  fireEvent.click(rows[0]!);
  await settle();
  assert.deepEqual(acted, ["nat_rsi:settings"],
    "the menu routes through the same resolver the glyphs do");
});

test("R3b-21 — a revealed pane control is a bordered box, and collapse is two chevrons", async () => {
  /*
   * The pane cluster was four transparent glyphs until each was itself
   * hovered, so a pane whose cluster had appeared showed no targets; the
   * reference draws four bordered 24×24 boxes over the chart's ground the
   * moment the cluster is revealed. And its collapse glyph is the ⤡ pair —
   * two chevrons pointing inward — not the single chevron every dropdown in
   * the product opens with.
   */
  const view = render(
    <IndicatorPane
      id="indicator:nat_rsi"
      title="Relative Strength Index"
      params="Length 14"
      overlays={[overlay(61.18)]}
      decorations={[]}
      hoverTime={null}
      onHover={() => {}}
      onReady={() => {}}
      onRangeChange={() => {}}
      onAction={() => {}}
      onToggleCollapsed={() => {}}
      onToggleMaximized={() => {}}
      canMaximize
    />);
  await settle();

  const cluster = [...view.container.querySelectorAll<HTMLElement>("span")]
    .find((el) => /group-hover\/studypane:opacity-100/.test(el.className));
  assert.ok(cluster, "the pane cluster is gone");
  assert.match(cluster.className, /right-1/, "4px from the pane's content edge");
  assert.match(cluster.className, /gap-1/, "4px between the boxes");

  const buttons = [...cluster.querySelectorAll("button")];
  assert.ok(buttons.length >= 2, `expected the pane's own controls, saw ${buttons.length}`);
  for (const button of buttons) {
    assert.match(button.className, /border-border-strong/,
      "revealed means drawn as a box — rgb(74,74,74) in dark, as the reference measures");
    assert.match(button.className, /bg-surface/, "over the chart's own ground");
    assert.doesNotMatch(button.className, /border-transparent/);
  }

  const collapse = buttons
    .find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Collapse"));
  assert.ok(collapse, "the pane cannot be collapsed");
  assert.equal(collapse.querySelectorAll("path").length, 2,
    "⤡ is two chevrons; one chevron is the glyph every dropdown opens with");
});
