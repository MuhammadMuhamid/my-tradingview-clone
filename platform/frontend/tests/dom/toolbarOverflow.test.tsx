/*
 * The toolbar's ⋯, driven as a person drives it (A13 / B-05 / B-23).
 *
 * ⋯ opened a second 38px row — HISTORY 2K 10K 50K All · Overlays · Automate ·
 * Strategy · Best config — at every width, including 1440 where nothing had
 * overflowed; below 1280 the whole right-hand cluster vanished into that row at
 * once; and at 768 the left side still ran off the edge, taking ⋯ with it.
 *
 * jsdom applies no CSS, so WHICH copy of a control is displayed at a width is
 * the class arithmetic pinned in `tests/chartToolbar.test.ts`. What is asserted
 * here is the behaviour: ⋯ opens a dropdown, not the strip; the dropdown holds
 * a copy of every control that can leave the row, each a labelled row that
 * works; the strip is reached by name; and Escape takes one layer at a time.
 *
 * The bar is mounted on its own, with the page's callbacks recorded, so this
 * file runs in seconds rather than mounting a chart.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useState } from "react";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { ChartToolbar, type ChartToolbarProps } from "@/components/tv/ChartToolbar";
import { TOOLBAR_OVERFLOW_FROM, type OverflowControlId } from "@/lib/toolbarLayout";
import { DEFAULT_OVERLAY_PREFERENCES } from "@/lib/tradingOverlays";
import { DEFAULT_SYNC } from "@/lib/paneSync";

beforeEach(resetBrowser);
after(closeBrowser);

const calls: string[] = [];
const note = (name: string) => () => { calls.push(name); };

function Harness(over: Partial<ChartToolbarProps>) {
  const [moreOpen, setMoreOpen] = useState(false);
  const props: ChartToolbarProps = {
    symbol: "BTCUSDT", interval: "1h",
    onOpenSearch: note("search"), onOpenCompare: note("compare"), onInterval: () => {},
    resolutions: {
      favourites: ["1m", "1h"], recents: [], custom: [],
      toggleFavourite: () => {}, addCustom: () => {}, removeCustom: () => {}, noteUsed: () => {},
    },
    chartType: "candles", onChartType: () => {},
    presetId: "1", onPreset: () => {},
    sync: DEFAULT_SYNC, onSync: () => {}, syncDisabled: false,
    bars: 2000, onBars: () => {}, loadedBars: 1500,
    indicatorCount: 0, onOpenIndicators: note("indicators"), onAddFavoriteIndicator: () => {},
    indicatorTemplateStudies: { indicators: [], native: [] },
    onApplyIndicatorTemplate: () => ({ applied: 0, skipped: [] }) as unknown as ReturnType<ChartToolbarProps["onApplyIndicatorTemplate"]>,
    canUndo: true, canRedo: true, onUndo: note("undo"), onRedo: note("redo"),
    replayActive: false, replayPickerOpen: false, onToggleReplayPicker: note("replay"),
    replayBlocksLiveActions: false,
    fullscreen: false, fullscreenSupported: true, onToggleFullscreen: note("fullscreen"),
    onOpenChartSettings: note("settings"), onOpenCommandPalette: note("palette"),
    onSnapshot: (mode) => calls.push(`snapshot:${mode}`),
    overlayMenuOpen: false, onOverlayMenuOpen: () => {},
    overlayPrefs: DEFAULT_OVERLAY_PREFERENCES, onOverlayPrefs: () => {},
    overlayData: null, overlaysLoading: false, overlayError: null, overlayItems: [], onSelectOverlay: () => {},
    onOpenPriceAlert: note("alert"), onOpenAutomation: note("automate"), onOpenManual: note("trade"),
    onOpenStrategy: note("strategy"), onApplyBest: () => {}, loadingBest: false,
    layouts: [], currentLayoutId: null, autosave: false, layoutDirty: false, autosaveError: null,
    layoutHandlers: {
      onSelect: () => {}, onSaveNow: () => {}, onToggleAutosave: () => {}, onCreate: () => {},
      onCopy: () => {}, onRename: () => {}, onDelete: () => {}, onDownload: () => {},
    },
    moreOpen, onMoreOpen: setMoreOpen,
    ...over,
  };
  return <div className="tv-workstation"><ChartToolbar {...props} /></div>;
}

const more = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-label="More controls"]')!;
const panel = (c: HTMLElement) => c.querySelector<HTMLElement>("#chart-toolbar-overflow");
const strip = (c: HTMLElement) => c.querySelector<HTMLElement>("#chart-toolbar-more");

test("⋯ opens a dropdown of the overflowable controls — not the secondary row", async () => {
  calls.length = 0;
  const { container } = render(<Harness />);
  assert.equal(more(container).getAttribute("aria-expanded"), "false");
  fireEvent.click(more(container));
  await settle();

  const dropdown = panel(container);
  assert.ok(dropdown, "⋯ opened nothing");
  assert.equal(more(container).getAttribute("aria-expanded"), "true");
  assert.equal(strip(container), null,
    "⋯ must not open the HISTORY / overlays / automation row by surprise");

  // A copy of every control that can leave the row, inside the dropdown.
  const inside = new Set([...dropdown.querySelectorAll<HTMLElement>("[data-toolbar-control]")]
    .map((el) => el.getAttribute("data-toolbar-control")));
  // (Indicator templates is a component of its own with no registry marker;
  // its row is checked by name below.)
  for (const id of Object.keys(TOOLBAR_OVERFLOW_FROM) as OverflowControlId[]) {
    if (id === "templates") continue;
    assert.ok(inside.has(id), `${id} has no copy in the ⋯ dropdown`);
  }
  // Exactly ONE copy of each overflowed control exists while ⋯ is open: a
  // display:none twin on the row shares its popover's exclusive id, and its
  // outside-click handler would close the menu being used in the dropdown.
  for (const id of ["snapshot", "layout", "savedLayouts", "sync", "undo"]) {
    assert.equal(container.querySelectorAll(`[data-toolbar-control="${id}"]`).length, 1,
      `${id} is mounted twice while ⋯ is open`);
  }
  // Each is a labelled row, and the labels are words a person reads.
  const rows = [...dropdown.querySelectorAll<HTMLElement>("[data-overflow-row]")]
    .map((r) => r.textContent?.trim() ?? "");
  for (const word of ["Compare symbol", "Indicators", "Undo", "Redo", "Chart layout", "Chart settings",
    "Fullscreen", "Chart image", "Search tool or function", "Create alert", "Bar replay",
    "Indicator templates", "Saved layouts", "Sync panes"]) {
    assert.ok(rows.some((r) => r.endsWith(word)), `no "${word}" row in ${JSON.stringify(rows)}`);
  }
  // And the strip is reachable from it, by name.
  assert.ok([...dropdown.querySelectorAll("button")].some((b) => b.textContent === "History, overlays & automation"));
});

test("a dropdown row works from its label, and an action closes the dropdown", async () => {
  calls.length = 0;
  const { container } = render(<Harness />);
  fireEvent.click(more(container));
  await settle();
  const row = [...panel(container)!.querySelectorAll<HTMLElement>("[data-overflow-row]")]
    .find((r) => r.textContent?.trim().endsWith("Chart settings"))!;
  fireEvent.click(row.querySelector("span[aria-hidden='true']:last-child")!);
  await settle();
  assert.deepEqual(calls, ["settings"], "clicking the row's NAME presses its control");
  assert.equal(panel(container), null, "an action closes the dropdown once it has run");
});

test("a row that opens a menu keeps the dropdown open, and Escape closes the menu first", async () => {
  calls.length = 0;
  const { container } = render(<Harness />);
  fireEvent.click(more(container));
  await settle();
  const camera = panel(container)!.querySelector<HTMLButtonElement>('button[aria-label="Chart image"]')!;
  fireEvent.click(camera);
  await settle();
  assert.ok(panel(container), "opening the camera's menu must not close the dropdown it lives in");
  assert.ok(panel(container)!.querySelector('[role="menu"][aria-label="Chart image"]'), "the camera menu opened");

  fireEvent.keyDown(window, { key: "Escape" });
  await settle();
  assert.ok(panel(container), "the first Escape takes the camera's menu, not the dropdown behind it");

  fireEvent.keyDown(window, { key: "Escape" });
  await settle();
  assert.equal(panel(container), null, "the second Escape closes the dropdown");
  assert.equal(document.activeElement, more(container), "and hands focus back to ⋯");
});

test("the secondary row is opened by name, and closes from itself", async () => {
  const { container } = render(<Harness />);
  fireEvent.click(more(container));
  await settle();
  const toggle = [...panel(container)!.querySelectorAll("button")]
    .find((b) => b.textContent === "History, overlays & automation")!;
  assert.equal(toggle.getAttribute("aria-controls"), "chart-toolbar-more");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);
  await settle();
  assert.ok(strip(container), "the named row opens the strip");
  assert.equal(panel(container), null, "and, being an action, closes the dropdown");
  assert.match(strip(container)!.textContent ?? "", /History.*2K.*Automate.*Strategy.*Best config/s);

  fireEvent.click(container.querySelector('button[aria-label="Hide history, overlays and automation"]')!);
  await settle();
  assert.equal(strip(container), null, "the strip closes from its own row");
});

test("Escape is answered by the top layer only (B-23)", async () => {
  /*
   * On a phone the bottom More sheet sits ABOVE the toolbar's ⋯ dropdown, and
   * takes Escape in the capture phase (`ChartSidePanel`). The toolbar must
   * then leave its own dropdown alone instead of closing the layer behind the
   * one in front — and must still close it when nothing above has answered,
   * even though the shortcut layer marks every Escape `defaultPrevented`.
   */
  const { container } = render(<Harness />);
  fireEvent.click(more(container));
  await settle();
  const sheet = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); } };
  window.addEventListener("keydown", sheet, true);
  try {
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    assert.ok(panel(container), "an Escape the sheet above answered closed the dropdown behind it");
  } finally {
    window.removeEventListener("keydown", sheet, true);
  }
  const shortcuts = (e: KeyboardEvent) => { if (e.key === "Escape") e.preventDefault(); };
  window.addEventListener("keydown", shortcuts);
  try {
    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    assert.equal(panel(container), null, "with no layer above, Escape closes the dropdown");
  } finally {
    window.removeEventListener("keydown", shortcuts);
  }
});

test("the phone's More sheet takes Escape first, in the capture phase (B-23)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "components", "tv", "ChartSidePanel.tsx"), "utf8");
  assert.match(src, /if \(!moreOpen \|\| !isMobile\) return;[\s\S]{0,260}e\.stopPropagation\(\);[\s\S]{0,80}setMoreOpen\(false\)/);
  assert.match(src, /window\.addEventListener\("keydown", onEsc, true\)/);
});
