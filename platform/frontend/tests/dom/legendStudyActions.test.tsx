/**
 * Every row on the price legend acts, including the moving-average set's.
 *
 * A1: the `Moving averages` row — the MA panel's lines, grouped — showed no
 * hover controls, did nothing when clicked and was absent from the Object
 * tree, while every study row beside it could be hidden, tuned and removed.
 * Premium offers Hide / Settings / Remove / More on every study row.
 *
 * A5 / A16: a study's `⋯` menu now leads with `Add alert on …` where the
 * alert engine evaluates that study's family, and a right-click on the row is
 * that menu rather than the chart's.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { menuItems, menuLabel, mountChart, press } from "./harness/chart";
import { WORKSPACE_STORAGE_KEY } from "@/lib/workspace";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

/** The first pane's MA lines that are on, as the workspace stored them. */
function storedMaOn(): string[] {
  const ws = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "{}");
  return (ws.panes?.[0]?.maLines ?? [])
    .filter((l: { visible: boolean }) => l.visible)
    .map((l: { type: string; length: number }) => `${l.type}${l.length}`);
}

const button = (name: string | RegExp) => screen.queryAllByRole("button", { name })[0] ?? null;

test("A1 — the MA set's row offers the four study verbs, and its eye is reversible", async () => {
  await mountChart();
  await settle();
  const before = storedMaOn();
  assert.ok(before.length > 0, "a fresh chart draws its default moving average");

  for (const name of ["Hide Moving averages", "Moving averages settings",
    "Remove Moving averages", "More for Moving averages"]) {
    assert.ok(button(name), `the MA row offers no ${JSON.stringify(name)}`);
  }

  fireEvent.click(button("Hide Moving averages")!);
  await settle();
  assert.deepEqual(storedMaOn(), [], "Hide left the lines on the chart");
  // The row stays, dimmed, with its eye closed — the eye is not a one-way door.
  const show = button("Show Moving averages");
  assert.ok(show, "hiding the set removed every way back from the legend");

  fireEvent.click(show!);
  await settle();
  assert.deepEqual(storedMaOn(), before, "Show must put back exactly the lines that were on");
});

test("A1 — Settings opens the MA panel; Remove takes the set off and leaves no ghost row", async () => {
  await mountChart();
  await settle();
  fireEvent.click(button("Moving averages settings")!);
  await settle();
  assert.ok(button(/^(Hide|Show) all$/), "the gear did not open the moving-average panel");

  fireEvent.click(button("Remove Moving averages")!);
  await settle();
  assert.deepEqual(storedMaOn(), []);
  assert.equal(button("Show Moving averages"), null,
    "a removed set must not leave a dimmed row offering to bring it back");
  assert.equal(button("More for Moving averages"), null, "the row outlived its lines");
});

test("A1 — the MA set is in the Object tree, and its ⋯ menu is the study menu", async () => {
  await mountChart();
  await settle();
  fireEvent.click(button("More for Moving averages")!);
  await settle();
  assert.equal(menuLabel(), "Moving averages");
  assert.deepEqual(menuItems().map((i) => i.label),
    ["Add alert on Moving averages…", "Settings…", "Hide", "Object tree", "Remove"],
    "W2A-04: the MA set has alerts, so its menu leads with one as RSI's does");
  fireEvent.click(screen.getByRole("menuitem", { name: /Object tree/ }));
  await settle();
  // The legend row's eye and the tree's eye: two controls, one set.
  assert.ok(screen.getAllByRole("button", { name: "Hide Moving averages" }).length >= 2,
    "the Object tree does not list the moving averages");
});

test("W2A-04 — the MA set's alert row arms its line, and a door to each line when there are several", async () => {
  await mountChart();
  await settle();
  const [only] = storedMaOn();
  assert.ok(only, "a fresh chart draws one moving average");

  // One line on: the row arms it directly, in the MA panel's own dialog.
  fireEvent.click(button("More for Moving averages")!);
  await settle();
  fireEvent.click(screen.getByRole("menuitem", { name: "Add alert on Moving averages…" }));
  await settle();
  const label = only.replace(/^(sma|ema)/, (t) => `${t.toUpperCase()} `);
  assert.match(screen.getByRole("dialog").textContent ?? "", new RegExp(`Alert on ${label}`),
    "the row did not open the moving-average alert dialog for the line on the chart");
  await press("Escape");

  // Two lines on: the row is a door to each, and each child arms ITS line.
  fireEvent.click(button("Moving averages settings")!);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show EMA 50" }));
  await settle();
  assert.equal(storedMaOn().length, 2);
  fireEvent.click(button("More for Moving averages")!);
  await settle();
  const parent = screen.getByRole("menuitem", { name: "Add alert on Moving averages" });
  assert.equal(parent.getAttribute("aria-haspopup"), "menu", "several lines make the row a submenu");
  fireEvent.click(parent);
  await settle();
  fireEvent.click(screen.getByRole("menuitem", { name: "EMA 50…" }));
  await settle();
  assert.match(screen.getByRole("dialog").textContent ?? "", /Alert on EMA 50/,
    "the child armed some other line than the one it named");
  await press("Escape");
});

function seedRsi(): void {
  window.localStorage.setItem("tv.nativeStudies.v1", JSON.stringify([{
    key: "rsi-1", defId: "rsi", params: { length: 14, source: "close" }, visible: true, styles: {},
  }]));
}

/** The RSI legend row's hover box, which owns the row's right-click. */
function rsiRow(): HTMLElement {
  const title = [...document.querySelectorAll<HTMLElement>("[title]")]
    .find((el) => /^Relative Strength Index\b/.test(el.getAttribute("title") ?? ""));
  assert.ok(title, "no RSI legend row");
  return title!;
}

test("A5/A16 — a right-click on a study row is that study's menu, led by its alert", async () => {
  seedRsi();
  await mountChart();
  await settle();
  const event = new window.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 60, clientY: 40, button: 2,
  });
  fireEvent(rsiRow(), event);
  await settle();
  assert.equal(event.defaultPrevented, true, "the browser's own menu would open over the chart");
  assert.equal(menuLabel(), "Relative Strength Index",
    "the right-click opened some other menu — the chart's is about the candles, not the study");
  const rows = menuItems().map((i) => i.label);
  assert.equal(rows[0], "Add alert on Relative Strength Index…");
  assert.equal(rows[rows.length - 1], "Remove", "Remove stays last");

  fireEvent.click(screen.getByRole("menuitem", { name: /^Add alert on Relative Strength Index/ }));
  await settle();
  assert.match(screen.getByRole("dialog").textContent ?? "", /RSI/,
    "the alert row did not open the RSI alert dialog");
  await press("Escape");
});

test("C-04 — the study's alert opens on the study's own inputs, not the family defaults", async () => {
  window.localStorage.setItem("tv.nativeStudies.v1", JSON.stringify([{
    key: "rsi-1", defId: "rsi", params: { length: 21, source: "close" }, visible: true, styles: {},
  }]));
  await mountChart();
  await settle();
  fireEvent.click(button(/^More for Relative Strength Index/)!);
  await settle();
  fireEvent.click(screen.getByRole("menuitem", { name: /^Add alert on Relative Strength Index/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  assert.match(dialog.textContent ?? "", /RSI 21 crosses/,
    "the alert must watch RSI(21) — the line that was clicked — not RSI_DEFAULTS' 50");
  await press("Escape");
});

test("C-04 — a MACD's alert carries its fast, slow and signal lengths", async () => {
  window.localStorage.setItem("tv.nativeStudies.v1", JSON.stringify([{
    key: "macd-1", defId: "macd", params: { fast: 8, slow: 21, signal: 5, source: "close" },
    visible: true, styles: {},
  }]));
  await mountChart();
  await settle();
  fireEvent.click(button(/^More for MACD/)!);
  await settle();
  fireEvent.click(screen.getByRole("menuitem", { name: /^Add alert on MACD/ }));
  await settle();
  const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
  assert.deepEqual([value("Fast length"), value("Slow length"), value("Signal length")], ["8", "21", "5"]);
  await press("Escape");
});

test("A5 — a study the alert engine does not evaluate offers no alert row", async () => {
  window.localStorage.setItem("tv.nativeStudies.v1", JSON.stringify([{
    key: "atr-1", defId: "atr", params: { length: 14 }, visible: true, styles: {},
  }]));
  await mountChart();
  await settle();
  fireEvent.click(button(/^More for Average True Range/)!);
  await settle();
  assert.ok(!menuItems().some((i) => /^Add alert/.test(i.label)),
    "an alert row for a study no alert can watch opens a dialog about something else");
});
