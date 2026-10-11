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
   * menu carries `Move to`, `Pin to scale`, `Visual order` and `Copy` as
   * well (and `Add alert on …`, which appears only when the owner says the
   * alert engine evaluates the study — `legendStudyActions.test.tsx` — and
   * this render passes no `alertFor`), and none of them is written here as a greyed
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

test("F-04 — the pane's controls are ONE bordered `⋯` in ink, opening Manage panes", async () => {
  /*
   * R3b-21 drew four bordered 24×24 boxes here. Live Premium draws ONE
   * 24×24 `Manage panes` button in ink rgb(219), still a box over the
   * chart's own ground, and the four actions are rows of its menu.
   */
  const acted: string[] = [];
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
      onAction={(_id, action) => acted.push(action)}
      onToggleCollapsed={() => acted.push("collapse")}
      onToggleMaximized={() => acted.push("maximize")}
      onMove={(_id, d) => acted.push(`move:${d}`)}
      canMoveDown
      canMaximize
    />);
  await settle();

  const cluster = view.container.querySelector<HTMLElement>("[data-pane-buttons]");
  assert.ok(cluster, "the pane cluster is gone");
  // W2D-11: 4px from the PLOT's edge (`tests/dom/paneButtonsAxis.test.tsx`).
  assert.match(cluster.style.right, /^\d+px$/);
  const buttons = [...cluster.querySelectorAll("button")];
  assert.equal(buttons.length, 1, "one Manage panes button, not four icons");
  const manage = buttons[0]!;
  assert.equal(manage.getAttribute("aria-label"), "Manage panes — Relative Strength Index");
  assert.equal(manage.getAttribute("aria-haspopup"), "menu");
  assert.match(manage.className, /\bh-6\b/);
  assert.match(manage.className, /\bw-6\b/);
  assert.match(manage.className, /border-border-strong/, "a box, as R3b-21 measured");
  assert.match(manage.className, /\btext-ink\b/, "in ink, not the muted rgb(140)");
  assert.doesNotMatch(manage.className, /text-ink-faint|text-ink-muted/);

  fireEvent.click(manage);
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Manage panes"]');
  assert.ok(menu, "the button opened nothing");
  assert.equal(manage.getAttribute("aria-expanded"), "true");
  const rows = [...menu.querySelectorAll<HTMLButtonElement>("button.tvc-menu-row")];
  assert.deepEqual(rows.map((r) => r.querySelector("span.shrink-0.whitespace-nowrap")?.textContent),
    ["Maximize pane", "Collapse pane", "Move pane up", "Move pane down", "Delete pane"]);
  // The shared 32px rows: an 18px glyph in a 28px box on every row.
  for (const row of rows) {
    const mark = row.querySelector<HTMLElement>("[data-menu-mark]");
    assert.match(mark?.className ?? "", /\bh-7 w-7\b/);
    assert.equal(mark?.querySelector("svg[data-menu-glyph]")?.getAttribute("width"), "18");
  }
  assert.match(rows[0]!.textContent ?? "", /Double click/);
  // The top pane cannot move up: disabled, not dropped.
  assert.equal(rows[2]!.disabled, true);
  assert.equal(rows[3]!.disabled, false);
  fireEvent.click(rows[3]!);
  await settle();
  assert.deepEqual(acted, ["move:1"], "a row reaches the handler the old icon called");
  assert.equal(document.querySelector('[role="menu"][aria-label="Manage panes"]'), null);

  for (const [index, expected] of [[0, "maximize"], [1, "collapse"], [4, "remove"]] as const) {
    fireEvent.click(manage);
    await settle();
    const again = [...document.querySelectorAll<HTMLButtonElement>(
      '[role="menu"][aria-label="Manage panes"] button.tvc-menu-row')];
    fireEvent.click(again[index]!);
    await settle();
    assert.equal(acted[acted.length - 1], expected);
  }
});

test("F-04 — double-click maximises the pane; ⌘/Ctrl double-click collapses it", async () => {
  const acted: string[] = [];
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
      onToggleCollapsed={() => acted.push("collapse")}
      onToggleMaximized={() => acted.push("maximize")}
      canMaximize
    />);
  await settle(4);
  const plot = view.container.querySelector<HTMLElement>("section > div.absolute.inset-0");
  assert.ok(plot, "no plot host");
  fireEvent.doubleClick(plot, { clientX: 100, clientY: 40 });
  fireEvent.doubleClick(plot, { clientX: 100, clientY: 40, metaKey: true });
  fireEvent.doubleClick(plot, { clientX: 100, clientY: 40, ctrlKey: true });
  assert.deepEqual(acted, ["maximize", "collapse", "collapse"]);
  // The Manage panes button keeps its own double-click.
  fireEvent.doubleClick(view.container.querySelector<HTMLElement>("[data-pane-buttons] button")!);
  assert.equal(acted.length, 3);
});
