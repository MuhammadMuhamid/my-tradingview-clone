/**
 * The chart toolbar's hierarchy, the timeframe split, the layout selector, the
 * sync menu and fullscreen.
 *
 * ── What is a state test and what is a source test, and why ────────────────
 *
 * There is no DOM in this environment, so the rules that CAN live in a module
 * do: the tier registry (`lib/toolbarLayout`), the interval split
 * (`lib/timeframes`) and the Fullscreen API wrapper (`lib/fullscreen`) are all
 * exercised directly, the last against a fake document that reproduces a
 * browser refusing the request and a user pressing Escape.
 *
 * What remains is structural — WHERE a control is rendered — and that is
 * checked against the source, because the alternative is checking nothing. The
 * component builds each control from the registry via a `ctl(...)` marker, so
 * these assertions are about the bar that actually ships rather than a
 * description of it kept alongside.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_FAVOURITES, chipLabel, timeframeStrip } from "../lib/timeframes";
import {
  TOOLBAR_ACCOUNT_CELL_WIDTH, TOOLBAR_CONTROLS, TOOLBAR_OVERFLOW_FROM,
  controlsInGroup, isPrimaryControl, primaryControls, secondaryControls,
  toolbarControl, toolbarGroup, toolbarPlacement, toolbarRowWidth,
  type OverflowControlId, type ToolbarControlId,
} from "../lib/toolbarLayout";
import { TOOLBAR_SEPARATOR_TIERS, TOOLBAR_TIERS } from "../components/tv/toolbarDensity";
import {
  enterFullscreen, exitFullscreen, fullscreenSupported, isFullscreen, toggleFullscreen,
  watchFullscreen, type FullscreenDocument, type FullscreenTarget,
} from "../lib/fullscreen";
import { type Interval } from "../lib/types";
import { SYNC_LABELS, DEFAULT_SYNC } from "../lib/paneSync";
import { LAYOUT_PRESETS, MAX_PANES, availablePaneCounts, defaultPresetFor } from "../lib/layoutPresets";
import {
  activePane, applyPaneInterval, createWorkspace, paneById, setPaneCount, workspacePreset,
  type PaneSeed,
} from "../lib/workspace";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The same source with its comments removed.
 *
 * A "this must not appear" assertion over a file that EXPLAINS why the thing
 * must not appear will always fail on the explanation. Absence checks read
 * this; presence checks read the raw source.
 */
const readCode = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TOOLBAR = "components/tv/ChartToolbar.tsx";

/** Everything the toolbar declares, in source order, as `ctl("id")` markers. */
function markersInOrder(source: string): { id: string; at: number }[] {
  const out: { id: string; at: number }[] = [];
  const re = /ctl\("([A-Za-z]+)"\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) out.push({ id: match[1]!, at: match.index });
  return out;
}

// ── the tier registry ───────────────────────────────────────────────────────

test("every toolbar control has exactly one tier, and the ids are unique", () => {
  const ids = TOOLBAR_CONTROLS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "an id is declared twice");
  for (const control of TOOLBAR_CONTROLS) {
    assert.equal(toolbarControl(control.id), control);
    assert.equal(toolbarGroup(control.id), control.group);
    assert.ok(control.label.length > 0, `${control.id} has no accessible name`);
  }
  assert.equal(
    primaryControls().length + secondaryControls().length,
    TOOLBAR_CONTROLS.length,
    "a control is in neither tier"
  );
});

test("the high-value chart controls are primary, not behind an overflow", () => {
  // These are what a trader touches constantly. If any of them moves into the
  // secondary tier, the bar has regressed to the state this wave fixed.
  const mustBePrimary: ToolbarControlId[] = [
    "symbol", "timeframe", "chartType", "indicators", "replay",
    "alert", "trade", "layout", "sync", "fullscreen",
  ];
  for (const id of mustBePrimary) {
    assert.ok(isPrimaryControl(id), `${id} must stay on the primary row`);
  }
  /*
   * TVP8 owner veto (OV-B): the registry is in RENDER order and the order is
   * the reference's, measured live — symbol, compare, interval, style,
   * indicators, alert, replay, undo, redo; then, right-aligned, layout, the
   * saved layout, sync, quick search, settings, fullscreen, snapshot, more,
   * Trade. A control that moves here moves on the bar.
   */
  assert.deepEqual(
    controlsInGroup("context").map((c) => c.id),
    ["symbol", "compare", "timeframe", "chartType", "indicators", "alert", "replay", "undo", "redo"],
    "the chart-context group is what tells you what you are looking at, in the reference's order"
  );
  assert.deepEqual(
    controlsInGroup("workspace").map((c) => c.id),
    ["layout", "savedLayouts", "sync", "commandPalette", "chartSettings", "fullscreen", "snapshot", "more", "trade"],
    "the right-hand group ends in the Trade pill, as the reference's bar does"
  );
});

test("the toolbar's markers appear in the registry's order", () => {
  // The registry IS the order. A control rendered out of sequence is the bar
  // drifting from the reference one refactor at a time.
  const source = read(TOOLBAR);
  const primaryRow = source.indexOf('data-toolbar-row="primary"');
  const secondaryRow = source.indexOf('data-toolbar-row="secondary"');
  // Markers rendered inside the reusable clusters (WorkspaceActions,
  // ContextActions, CompareButton, TradeButton, SavedLayoutIdentity) are
  // declared above the row; what is asserted is the sequence of the clusters
  // and the inline controls as the ROW composes them.
  const row = source.slice(primaryRow, secondaryRow);
  const sequence = [
    'ctl("symbol")', "<CompareButton", "<TimeframePicker", "<ChartTypeMenu",
    "<ContextActions", "<EditHistory", "<WorkspaceActions", 'ctl("more")', "<TradeButton",
  ];
  let at = -1;
  for (const marker of sequence) {
    const next = row.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} is out of order on the primary row (or missing)`);
    at = next;
  }
  const contextCluster = source.slice(source.indexOf("function ContextActions"), source.indexOf("function SavedLayoutIdentity"));
  for (const [a, b] of [['ctl("indicators")', 'ctl("alert")'], ['ctl("alert")', 'ctl("replay")']]) {
    assert.ok(contextCluster.indexOf(a) < contextCluster.indexOf(b), `${a} must precede ${b}`);
  }
  assert.ok(contextCluster.indexOf('ctl("undo")') < contextCluster.indexOf('ctl("redo")'),
    "undo precedes redo");
  const workspaceCluster = source.slice(source.indexOf("function WorkspaceActions"), source.indexOf("function SnapshotMenu"));
  const utilities = ['ctl("layout")', "<SavedLayoutIdentity", 'ctl("sync")', 'ctl("commandPalette")', 'ctl("chartSettings")', 'ctl("fullscreen")', "<SnapshotMenu"];
  at = -1;
  for (const marker of utilities) {
    const next = workspaceCluster.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} is out of order in the workspace cluster (or missing)`);
    at = next;
  }
});

test("nothing on the primary row is a word except the ticker, the chips, the layout name, Trade — and, at 2xl, TradingView's own three", () => {
  /*
   * The owner's screenshot: `Last close 77,799 · 9,999 bars · Unnamed` in
   * prime toolbar space, plus `Indicators`, `Replay`, `Alert`, `Trade`, `Sync`
   * as labels at wide widths. The reference's controls are icon-only at 1440
   * and the only words on its bar are the ticker, the interval chips, the
   * layout name and the two pills. So: no readout prop, no count badge, and no
   * per-control label class.
   *
   * ── TVP8 R1c-17: rewritten, because the blanket ban was wrong at 1920 ─────
   *
   * This test used to forbid the string `TOOL_LABEL` outright. Measured on
   * `tradingview/tv-shell-1920x1080-dark.png`, the reference grows a label on
   * exactly three cells above 1536 — `Indicators` (x 654–715), `Alert`
   * (811–840), `Replay` (889–930) — and on nothing else. A rule that says
   * "never a word" therefore forbids parity at the one width where the
   * reference has words, so the rule is now the reference's own: at most those
   * three, each hidden until `2xl`, and every other cell icon-only at every
   * width. The readout and the badge are still banned outright, because the
   * reference has neither at any width.
   */
  const source = readCode(TOOLBAR);
  assert.doesNotMatch(source, /readout/, "the price/bar-count readout must not exist on the bar");
  assert.doesNotMatch(source, /labelClass|density\.label/, "no per-control label class");
  assert.doesNotMatch(source, /bg-accent px-1\.5 text-\[10px\]/, "no count badge on Indicators");
  assert.doesNotMatch(read("app/chart/page.tsx"), /readout=\{/, "the page no longer supplies a readout");
  assert.match(source, /<TradeButton/, "Trade is a pill, rendered from one component");
  assert.match(source, /TOOL_PILL_OUTLINE/);

  // The three, and only the three.
  const labelled = [...source.matchAll(/<WideLabel>([^<]+)<\/WideLabel>/g)].map((m) => m[1]);
  assert.deepEqual(labelled, ["Indicators", "Alert", "Replay"],
    "the reference labels these three cells at 1920 and no others");
  // And they are invisible below the breakpoint the reference draws them at.
  assert.match(source, /function WideLabel[\s\S]{0,400}?2xl:inline/,
    "a label that is not gated on 2xl is a label at 1440, where the reference has none");
  assert.match(source, /TOOL_LABELLED_BUTTON = `\$\{TOOL_ICON_BUTTON\} 2xl:w-auto`/,
    "the cell has to give up its fixed 38px width at the same breakpoint");
});

test("the secondary tier is a deliberate set, not whatever did not fit", () => {
  assert.deepEqual(
    secondaryControls().map((c) => c.id).sort(),
    ["automate", "best", "history", "overlays", "strategy"],
    "the overflow must hold exactly the lower-frequency controls"
  );
});

// ── the toolbar renders from that registry ─────────────────────────────────

test("the toolbar renders every registered control and invents none", () => {
  const source = read(TOOLBAR);
  const rendered = new Set(markersInOrder(source).map((m) => m.id));
  const declared = new Set<string>(TOOLBAR_CONTROLS.map((c) => c.id));
  for (const id of declared) {
    assert.ok(rendered.has(id), `${id} is declared but never rendered`);
  }
  for (const id of rendered) {
    assert.ok(declared.has(id), `${id} is rendered but has no declared tier`);
  }
});

test("secondary controls are inside the More strip and primary ones are not", () => {
  const source = read(TOOLBAR);
  const secondaryRow = source.indexOf('data-toolbar-row="secondary"');
  const primaryRow = source.indexOf('data-toolbar-row="primary"');
  assert.ok(primaryRow > 0 && secondaryRow > primaryRow,
    "the toolbar must have a primary row and a More strip after it");

  for (const marker of markersInOrder(source)) {
    const group = toolbarGroup(marker.id as ToolbarControlId);
    if (group === "secondary") {
      assert.ok(marker.at > secondaryRow,
        `${marker.id} is a secondary control rendered outside the More strip`);
    } else {
      assert.ok(marker.at < secondaryRow,
        `${marker.id} is a primary control rendered inside the More strip`);
    }
  }
});

test("the secondary strip is opened deliberately, by name, not by the viewport or by ⋯", () => {
  const source = read(TOOLBAR);
  // The regression this guards: the strip used to appear on its own at `xl`,
  // so a wide screen got several wrapped rows of chrome nobody asked for.
  const stripStart = source.indexOf('data-toolbar-row="secondary"');
  const stripHeader = source.slice(source.lastIndexOf("{moreOpen && (", stripStart), stripStart);
  assert.ok(stripHeader.includes("moreOpen"), "the strip must be gated on its toggle");
  assert.doesNotMatch(
    source.slice(stripStart, stripStart + 400),
    /\bxl:flex\b|\bxl:order-none\b/,
    "the strip must not re-appear on its own at a breakpoint"
  );
  /*
   * A13: ⋯ itself opened the strip, so at 1440 — where nothing had overflowed
   * — it produced a second row of HISTORY 2K 10K 50K All · Overlays · Automate
   * · Strategy · Best config by surprise. ⋯ now opens the overflow DROPDOWN,
   * and the strip is a row of it that says what it opens.
   */
  const more = source.slice(source.indexOf('ctl("more")'), source.indexOf('id="chart-toolbar-overflow"'));
  assert.match(more, /onClick=\{\(\) => setOverflowOpen\(!overflowOpen\)\}/, "⋯ opens the dropdown");
  assert.doesNotMatch(more, /onMoreOpen/, "⋯ must not open the strip");
  assert.match(more, /aria-controls="chart-toolbar-overflow"/);
  assert.match(more, /aria-expanded=\{overflowOpen\}/);
  const toggle = source.slice(source.indexOf('id="chart-toolbar-overflow"'), stripStart);
  assert.match(toggle, /aria-controls="chart-toolbar-more"/, "the strip's toggle is a row of the dropdown");
  assert.match(toggle, /aria-expanded=\{moreOpen\}/, "and announces its state");
  assert.match(toggle, /"History, overlays & automation"/, "and names what it opens");
});

test("the primary row never wraps — the timeframe strip absorbs the pressure", () => {
  const source = read(TOOLBAR);
  const rowTag = source.slice(source.indexOf('data-toolbar-row="primary"'));
  const className = rowTag.slice(0, rowTag.indexOf(">"));
  assert.match(className, /flex-nowrap/, "the primary row must stay one row");
  assert.doesNotMatch(className, /flex-wrap/);
  /*
   * The strip is still the row's give — but only below `md`.
   *
   * R1-03: at 1440 the wrapper measured 150px around 194px of chips, so the
   * bar printed `1h 4 ⌄` — one favourite sliced mid-glyph, the next one hidden
   * under the caret. A scroller is the right answer on a small tablet and the
   * wrong one on the viewport this product is designed for, so the scroller
   * survives below `md` and the strip is `shrink-0` from `sm` up.
   *
   * jsdom performs no layout, so scrollWidth is 0 everywhere and the widths
   * R1-03 names (1280/1366/1440/1536/1920) cannot be measured here. What can
   * be pinned is the only thing that made them clip: permission to shrink.
   */
  const picker = read("components/tv/TimeframePicker.tsx");
  assert.match(picker, /overflow-x-auto/, "a narrow tablet still scrolls rather than overlaps");
  assert.match(picker, /md:overflow-x-visible/, "the scroller must stop at `md`");
  assert.match(picker, /shrink-0 items-center overflow-x-auto sm:flex/,
    "the favourites strip must not be shrinkable at `sm` and above");
  assert.doesNotMatch(picker, /sm:flex-initial|sm:min-w-0/,
    "nothing in the timeframe control may be given permission to shrink below "
    + "its content — that is what clipped `4h` and hid `1d` at 1440");
});

test("the interval trigger is a caret, not a word", () => {
  const picker = read("components/tv/TimeframePicker.tsx");
  /*
   * The reference draws a 24px caret-only menu button after the favourites and
   * no label at all. Ours printed "Timeframe" (90px at desktop, the armed
   * resolution below `sm`), which is both a word TradingView does not draw and
   * the 90px that the strip had to give up to fit beside it.
   */
  assert.match(picker, /className=\{TOOL_CARET_BUTTON\}/,
    "the trigger must use the bar's shared 24px caret chrome");
  assert.match(picker, /aria-label="Chart interval — all timeframes"/);
  // The chrome draws its own tooltip chip now; the OS never draws one.
  assert.match(picker, /data-tooltip="All timeframes"/);
  assert.doesNotMatch(picker, /menuLabel/,
    "the trigger no longer prints a label, so it no longer computes one");
  // `role="group" aria-label="Timeframe"` names the GROUP for assistive tech
  // and is not drawn; the only other "Timeframe" left is the pane legend's
  // accessible name. Neither is visible copy.
  assert.doesNotMatch(picker, /className[^\n]*>\s*Timeframe\s*</,
    "the word Timeframe must not be rendered as visible copy at any width");
});

// ── the collapse breakpoints measure the row, not the screen ───────────────

/**
 * TVP8: the row is the viewport minus the account cell at EVERY width.
 *
 * The four-branch arithmetic that used to live here — the row narrowed by the
 * manual ticket's 341px and the widget panel's 300px — described a toolbar
 * boxed inside the chart column. The toolbar is the workstation's first
 * full-width row now, above the rails, the chart and the panel, so nothing
 * narrows it and the one decision left is Tailwind's `md`.
 */
/** Tailwind's own `sm`, which Compare's literal uses instead of an arbitrary value. */
const breakpointOf = (cls: string): number => {
  if (/(^|\s)sm:/.test(cls)) return 640;
  const m = /min-\[(\d+)px\]:/.exec(cls);
  assert.ok(m, `no breakpoint in ${cls}`);
  return Number(m[1]);
};

test("every overflowable control is on the row OR in ⋯ — never both, never neither — and the CSS carries the same number", () => {
  /*
   * A13 / B-05. The one decision this replaced (`hidden xl:flex` on the whole
   * right-hand cluster) moved seven controls at once at 1280 and still let the
   * left side overrun at 768, where Undo, Redo and ⋯ were drawn off the edge
   * and Layout, Search, Settings, Fullscreen, Chart image and Trade were not
   * rendered anywhere at all.
   */
  assert.equal(TOOLBAR_ACCOUNT_CELL_WIDTH, 52, "the rail's width: the account cell sits above the rail");
  const ids = Object.keys(TOOLBAR_OVERFLOW_FROM) as OverflowControlId[];
  assert.deepEqual(Object.keys(TOOLBAR_TIERS).sort(), [...ids].sort(), "one tier per overflowable control");
  for (const id of ids) {
    const { row, menu } = TOOLBAR_TIERS[id];
    const at = TOOLBAR_OVERFLOW_FROM[id];
    assert.equal(breakpointOf(row), at, `${id}: the row class says ${row}, the arithmetic ${at}`);
    assert.equal(breakpointOf(menu), at, `${id}: the menu class says ${menu}, the arithmetic ${at}`);
    // Mirrored: hidden on the row exactly where the menu copy is displayed.
    assert.match(row, /^hidden \S+:flex$/, `${id}: the row copy is hidden below its width`);
    assert.match(menu, /^flex \S+:hidden$/, `${id}: the menu copy is displayed below it`);
    assert.equal(row.split(" ")[1]!.split(":")[0], menu.split(" ")[1]!.split(":")[0],
      `${id}: the two copies switch at the same breakpoint`);
  }
  // Every primary control that is not always on the row is overflowable.
  const always: ToolbarControlId[] = ["symbol", "timeframe", "chartType", "more"];
  for (const control of primaryControls()) {
    assert.ok(always.includes(control.id) || ids.includes(control.id as OverflowControlId),
      `${control.id} can neither stay nor leave — it would simply be clipped`);
  }
  // And the menu's set is the complement of the row's at every width.
  for (let viewport = 320; viewport <= 1920; viewport += 1) {
    const { row, menu } = toolbarPlacement(viewport);
    assert.equal(row.length + menu.length, ids.length);
    assert.equal(row.filter((id) => menu.includes(id)).length, 0);
  }
  // No shifted ticket/panel breakpoint: the page no longer tells the bar about
  // either, because neither takes width from a full-width row.
  assert.doesNotMatch(read(TOOLBAR), /ticketOpen|panelOpen/);
  assert.doesNotMatch(read("app/chart/page.tsx"), /ticketOpen=|panelOpen=/);
});

test("the row fits at EVERY width from 640 to 1440, so ⋯ is never clipped", () => {
  /*
   * ⋯ is the route to every overflowed control, and on a narrow screen it is
   * also how Correlation, the object tree, the data window and Maximize pane
   * stay reachable — this regressed twice when the row overran the viewport.
   * The row is `flex-nowrap` on a page that never scrolls sideways, so the
   * only safe statement is arithmetic: what the row draws is narrower than the
   * screen, one pixel at a time, with one pane and with two (Sync's cell).
   */
  for (let viewport = 640; viewport <= 1440; viewport += 1) {
    for (const panes of [1, 2]) {
      const width = toolbarRowWidth(viewport, { panes });
      assert.ok(width <= viewport,
        `at ${viewport}px with ${panes} pane(s) the row needs ${width}px — ⋯ would be cut off`);
    }
  }
  // Nothing has left the row at 1440, and the premium-measured 1200 keeps
  // Layout, the layout name, Settings, Snapshot and Trade on it.
  assert.deepEqual(toolbarPlacement(1440).menu, []);
  for (const id of ["layout", "savedLayouts", "chartSettings", "snapshot", "trade"] as const) {
    assert.ok(toolbarPlacement(1200).row.includes(id), `${id} must still be on the row at 1200`);
  }
  // At 768 (B-05) nothing is dropped: what is not on the row is in ⋯.
  const at768 = toolbarPlacement(768);
  for (const id of ["layout", "commandPalette", "chartSettings", "fullscreen", "snapshot"] as const) {
    assert.ok(at768.menu.includes(id) || at768.row.includes(id), `${id} is unreachable at 768`);
  }
  // Lowest priority leaves first: quick search before fullscreen before undo …
  const order = (Object.keys(TOOLBAR_OVERFLOW_FROM) as OverflowControlId[])
    .sort((a, b) => TOOLBAR_OVERFLOW_FROM[b] - TOOLBAR_OVERFLOW_FROM[a]);
  assert.deepEqual(order.slice(0, 2), ["commandPalette", "fullscreen"]);
  assert.ok(TOOLBAR_OVERFLOW_FROM.trade < TOOLBAR_OVERFLOW_FROM.chartSettings
    && TOOLBAR_OVERFLOW_FROM.chartSettings < TOOLBAR_OVERFLOW_FROM.snapshot
    && TOOLBAR_OVERFLOW_FROM.snapshot < TOOLBAR_OVERFLOW_FROM.layout
    && TOOLBAR_OVERFLOW_FROM.layout < TOOLBAR_OVERFLOW_FROM.savedLayouts,
  "Trade, Settings, Snapshot, Layout and the name are the last to go, in that order");
});

test("each row separator is drawn exactly while both of its neighbours are", () => {
  assert.equal(breakpointOf(TOOLBAR_SEPARATOR_TIERS.context), TOOLBAR_OVERFLOW_FROM.compare);
  assert.equal(breakpointOf(TOOLBAR_SEPARATOR_TIERS.beforeAlert), TOOLBAR_OVERFLOW_FROM.alert);
  assert.equal(breakpointOf(TOOLBAR_SEPARATOR_TIERS.beforeUndo), TOOLBAR_OVERFLOW_FROM.undo);
  // layout · name · sync │ search · settings · fullscreen · snapshot: the
  // later of `layout` and the first utility to appear (`chartSettings`).
  assert.equal(breakpointOf(TOOLBAR_SEPARATOR_TIERS.beforeUtilities),
    Math.max(TOOLBAR_OVERFLOW_FROM.layout, TOOLBAR_OVERFLOW_FROM.chartSettings));
  const source = read(TOOLBAR);
  for (const key of Object.keys(TOOLBAR_SEPARATOR_TIERS)) {
    assert.match(source, new RegExp(`TOOLBAR_SEPARATOR_TIERS\\.${key}`), `the ${key} separator is not used`);
  }
});

test("the toolbar is the first full-width row of the workstation, above the rails and the panel", () => {
  const page = read("app/chart/page.tsx");
  const container = page.indexOf('tv-workstation">');
  const toolbar = page.indexOf("<ChartToolbar", container);
  const rail = page.indexOf("<DrawingToolbar", container);
  const panel = page.indexOf("<ChartSidePanel", container);
  const account = page.indexOf('<ProductMenu variant="rail"', container);
  assert.ok(container > 0 && account > container, "the account cell is the first thing in the workstation");
  assert.ok(account < toolbar, "the account cell precedes the toolbar on the first row");
  assert.ok(toolbar < rail, "the toolbar is rendered before the rail — it is the row above it");
  assert.ok(rail < panel, "the rail, the chart column and the panel share the second row");
  assert.match(page.slice(Math.max(0, container - 160), container), /flex-col/, "the workstation stacks its two rows");
});

test("every control that can leave the row has a second home in the ⋯ dropdown", () => {
  const source = read(TOOLBAR);
  for (const cluster of ["WorkspaceActions", "ContextActions", "EditHistory"]) {
    assert.equal((source.match(new RegExp(`<${cluster} `, "g")) ?? []).length, 2, `${cluster} twice`);
    assert.match(source, new RegExp(`<${cluster} \\{\\.\\.\\.props\\} placement="row" overflowed=\\{overflowed\\} />`));
    assert.match(source, new RegExp(`<${cluster} \\{\\.\\.\\.props\\} placement="menu" overflowed=\\{overflowed\\} />`));
  }
  assert.equal((source.match(/<CompareButton /g) ?? []).length, 2);
  assert.equal((source.match(/<TradeButton /g) ?? []).length, 2);
  assert.match(source, /<CompareButton \{\.\.\.props\} className=\{tier\("compare", "row"\)\} \/>/);
  assert.match(source, /<TradeButton \{\.\.\.props\} className=\{`ml-1\.5 \$\{tier\("trade", "row"\)\}`\} \/>/);
  assert.match(source, /tier\("trade", "menu"\)/);
  // The menu copies live inside the dropdown, the row copies outside it.
  const panel = source.slice(source.indexOf('id="chart-toolbar-overflow"'), source.indexOf('data-toolbar-row="secondary"'));
  for (const cluster of ["WorkspaceActions", "ContextActions", "EditHistory"]) {
    assert.match(panel, new RegExp(`<${cluster} \\{\\.\\.\\.props\\} placement="menu" overflowed=\\{overflowed\\} />`));
  }
  // `placed` is the ONE place a control picks its copy's class.
  assert.match(source, /function placed\(\s*placement: Placement, id: OverflowControlId/);
  assert.doesNotMatch(source, /className="hidden md:flex"/,
    "a hard-coded viewport placement is the defect coming back");
  assert.doesNotMatch(source, /className="flex md:hidden"/);
  assert.doesNotMatch(source, /xl:hidden|hidden xl:flex/, "the all-at-once cluster breakpoint is gone");
});

test("the toolbar acts on the focused pane, never on a pane it resolves itself", () => {
  const page = read("app/chart/page.tsx");
  assert.match(page, /onOpenSearch=\{\(\) => setSearchPaneId\(active\.id\)\}/,
    "the symbol dialog must be opened FOR the focused pane and hold that id");
  assert.match(page, /onInterval=\{\(i\) => changePaneInterval\(active\.id, i\)\}/,
    "a timeframe change must target the focused pane");
  // The bar is handed the focused pane's symbol and interval and calls back; it
  // never reads the workspace, so it cannot act on a pane other than the one
  // the page resolved.
  const toolbar = readCode(TOOLBAR);
  assert.doesNotMatch(toolbar, /from "@\/lib\/workspace"/,
    "the toolbar must not reach into the workspace to decide what it acts on");
  assert.doesNotMatch(toolbar, /activePaneId/);
  assert.match(toolbar, /symbol: string;/);
  assert.match(toolbar, /onInterval: \(interval: Resolution\) => void;/);
});

test("the toolbar keeps the chart-type control as a slot it does not implement", () => {
  const source = read(TOOLBAR);
  // The slot also hands the control the FOCUSED pane's settings, so its
  // disclosure text can name the transform parameters actually in force
  // rather than the build's defaults. Still a slot: the bar passes state
  // through and implements none of it.
  assert.match(source,
    /<ChartTypeMenu value=\{props\.chartType\} onChange=\{props\.onChartType\}\s*\n?\s*settings=\{props\.chartSettings\} \/>/);
  assert.doesNotMatch(source, /heikin|renko|kagi/i,
    "presentation types belong to the chart-type system, not to this bar");
});

// ── timeframes ─────────────────────────────────────────────────────────────

/*
 * The strip stopped being a fixed list of six.
 *
 * It is now the browser's FAVOURITES, and the eleven-interval partition these
 * tests used to assert has been replaced by a catalogue that includes
 * resolutions the candle store does not hold at all. What that catalogue may
 * contain, and how favourites, recents and custom entries behave, is
 * `tests/timeframes.test.ts`. What is left here is the bar's own contract:
 * the strip is what the favourites say, and the picker button never leaves the
 * current resolution unnamed.
 */

test("the strip is the browser's favourites, and defaults to the historical six", () => {
  assert.deepEqual([...DEFAULT_FAVOURITES], ["1m", "5m", "15m", "1h", "4h", "1d"],
    "a new user's toolbar must not change shape");
  assert.deepEqual([...timeframeStrip("15m").quick], [...DEFAULT_FAVOURITES]);

  const starred = timeframeStrip("45m", ["1m", "45m"]);
  assert.deepEqual([...starred.quick], ["1m", "45m"],
    "the strip renders the favourites it was given, not a fixed list");
});

test("the armed resolution always has a chip, even when no favourite carries it", () => {
  const onStrip = timeframeStrip("15m");
  assert.equal(onStrip.currentInQuick, true);
  assert.equal(onStrip.armedChip, null,
    "a favourite already carries it; a second pressed chip beside it is noise");

  /*
   * Otherwise the strip would show nothing pressed at all, which reads as "no
   * timeframe selected". The extra chip is where the picker button's label
   * used to be — the reference appends the armed interval to the strip rather
   * than printing it inside the caret.
   */
  const offStrip = timeframeStrip("45m");
  assert.equal(offStrip.currentInQuick, false);
  assert.equal(offStrip.armedChip, "45m");
});

test("a chip prints a day as a bare letter and everything shorter with its count", () => {
  /*
   * TVP8 (BLIND clue 6). `1M` is a month and `1m` is a minute; on a 29px chip
   * the case of one letter is the whole of the difference, so the reference's
   * casing is copied rather than approximated — and so is its COUNT rule. The
   * shared grammar writes a single day as `D`, not `1D`: a blind reviewer
   * picked our toolbar out of a pair on that one character. Multiples keep
   * their count (`2D`), and sub-day is unchanged, because a bare `m` would
   * name the unit rather than the interval.
   */
  assert.equal(chipLabel("1d"), "D");
  assert.equal(chipLabel("4h"), "4h");
  assert.equal(chipLabel("30s"), "30s");
  assert.equal(chipLabel("15m"), "15m");
  // The label is presentation only — the id it is made from is untouched.
  assert.deepEqual([...DEFAULT_FAVOURITES], ["1m", "5m", "15m", "1h", "4h", "1d"]);
});

test("the bar mounts the shared picker rather than a second interval control", () => {
  const source = read(TOOLBAR);
  assert.match(source, /<TimeframePicker\n?\s+interval=\{interval\}/,
    "the toolbar delegates its timeframe control");
  assert.doesNotMatch(source, /QUICK_INTERVALS|MORE_INTERVALS/,
    "the bar must not carry its own interval list again");
  // The pane legend uses the same component, so the two cannot drift apart.
  const legend = read("components/tv/PaneLegend.tsx");
  assert.match(legend, /LegendTimeframe/);
});

// ── layout selector ────────────────────────────────────────────────────────

test("every count to sixteen is a row of its arrangements, one click each, as the reference draws it", () => {
  const source = read("components/tv/LayoutSelector.tsx");
  // C12: one row per count, every arrangement for that count shown as a
  // thumbnail — no count-first second trip, no bare numerals.
  assert.match(source, /counts\.map\(\(n, index\) => \(/);
  assert.match(source, /presetsForCount\(n\)\.map\(\(preset\) =>/);
  assert.match(source, /role="menuitemradio"/);
  assert.match(source, /availablePaneCounts\(\)/);
  const counts = availablePaneCounts();
  assert.deepEqual(counts, Array.from({ length: MAX_PANES }, (_, i) => i + 1));
  for (const n of counts) {
    assert.equal(defaultPresetFor(n).panes, n, `no default shape for ${n} charts`);
  }
});

test("the layout menu imposes no plan or tier restriction", () => {
  const source = readCode("components/tv/LayoutSelector.tsx");
  assert.doesNotMatch(source, /upgrade|premium|pro plan|subscription|locked/i,
    "this product has no subscription tiers and inventing one would be a lie");
  // Nor a quieter version of the same thing: no count is disabled.
  assert.doesNotMatch(source, /disabled=/,
    "every pane count from 1 to 16 must be selectable");
});

test("the active preset is marked by more than a colour", () => {
  const source = read("components/tv/LayoutSelector.tsx");
  assert.match(source, /aria-checked=\{isCurrent\}/, "the arrangement must announce its state");
  assert.match(source, /Current/, "and say it in words, not only in a tint");
  assert.match(source, /aria-label=\{`Chart layout — \$\{current\.label\}`\}/);
});

test("the layout-setup control is an icon cell, not a thumbnail with a digit", () => {
  /*
   * TVP8 R1-07. The trigger drew `PresetThumbnail`, whose panes are washed at
   * 0.18 so a row in the MENU can be told from the row above it. On the bar
   * that wash is a light-grey square sitting inside a chip that also fills on
   * hover — the one control on the row that read as permanently pressed rather
   * than as an icon. TradingView draws a plain outline square here.
   */
  const source = read("components/tv/LayoutSelector.tsx");
  assert.match(source, /TOOL_ICON_BUTTON/,
    "the layout trigger is a 38x38 cell like every other icon on the bar");
  assert.match(source, /<LayoutGlyph preset=\{current\} \/>/);

  const glyph = /function LayoutGlyph[\s\S]*?\n}/.exec(source);
  assert.ok(glyph, "the trigger's own glyph could not be located");
  assert.match(glyph[0], /fill="none"/, "line work, not a filled block");
  assert.doesNotMatch(glyph[0], /fillOpacity/);

  // The pane count is exactly what the glyph draws, and it was ALSO printed as
  // a digit — which made this the only control whose width changed with its
  // value, so the icons to its left moved when the layout changed.
  assert.doesNotMatch(source, /current\.panes > 1 &&/);

  // C12: the menu draws each arrangement with the SAME line glyph, as the
  // reference's layout menu does — rows of outline grids, no washed blocks.
  assert.match(source, /<LayoutGlyph preset=\{preset\} \/>/);
  assert.doesNotMatch(source, /PresetThumbnail/);
});

test("asymmetric arrangements are exposed, not only grids", () => {
  const asymmetric = LAYOUT_PRESETS.filter((p) => p.cells.some((c) => c.colSpan > 1 || c.rowSpan > 1));
  assert.ok(asymmetric.length >= 4, "the one-big-several-small shapes must remain selectable");
  const source = read("components/tv/LayoutSelector.tsx");
  assert.match(source, /presetsForCount\(n\)/,
    "variants must come from the preset data so a new shape appears without an edit");
});

// ── coherence across representative layouts ────────────────────────────────

test("the bar stays coherent at one, four and sixteen charts", () => {
  const seed: PaneSeed = { symbol: "SOLUSDT", interval: "15m" };
  for (const [presetId, count] of [["1", 1], ["4-grid", 4], ["16-grid", 16]] as const) {
    let ws = createWorkspace(seed, presetId);
    ws = setPaneCount(ws, count);
    assert.equal(ws.panes.length, count, `${presetId} did not produce ${count} panes`);
    assert.equal(workspacePreset(ws).panes, count,
      `${presetId} and its pane list disagree, so the layout button would lie`);

    // The bar's subject is always exactly one pane — the focused one — however
    // many are on screen, so every control has a well-defined target.
    const focused = activePane(ws);
    assert.ok(ws.panes.some((p) => p.id === focused.id));

    // Sync is offered only when there is something to synchronise with. The
    // toolbar takes this as `syncDisabled`, so a single-pane layout cannot show
    // five switches that provably do nothing.
    const syncDisabled = ws.panes.length < 2;
    assert.equal(syncDisabled, count === 1, `sync availability is wrong at ${count} charts`);

    // A timeframe change lands on the focused pane and, with sync off, nowhere
    // else — at sixteen panes as at one.
    const changed = applyPaneInterval(ws, focused.id, "4h", { ...DEFAULT_SYNC, interval: false });
    assert.equal(paneById(changed, focused.id)?.interval, "4h");
    assert.deepEqual(
      changed.panes.filter((p) => p.id !== focused.id).map((p) => p.interval),
      Array.from({ length: count - 1 }, () => "15m" as Interval)
    );
  }
});

test("the page hands the toolbar the focused pane's own state, at every layout size", () => {
  const page = read("app/chart/page.tsx");
  assert.match(page, /const active = focusedPane\(workspace\)/);
  assert.match(page, /symbol=\{symbol\}/);
  assert.match(page, /interval=\{interval\}/);
  assert.match(page, /syncDisabled=\{paneCount < 2\}/);
  assert.match(page, /presetId=\{workspace\.presetId\}/);
});

// ── sync menu ──────────────────────────────────────────────────────────────

test("the sync menu offers only synchronisation that is implemented", () => {
  const source = read("components/tv/SyncMenu.tsx");
  // The list is SYNC_LABELS and nothing else: a switch cannot be added to the
  // menu without a mechanism in lib/paneSync behind it.
  // Rendered as common switches plus an Advanced group, both derived from
  // SYNC_LABELS — never from a second list.
  assert.match(source, /SYNC_LABELS\.filter\(\(o\) => COMMON_SYNC\.includes\(o\.id\)\)/);
  assert.match(source, /SYNC_LABELS\.filter\(\(o\) => !COMMON_SYNC\.includes\(o\.id\)\)/);
  assert.match(source, /\[\.\.\.common, \.\.\.\(showAdvanced \? advanced : \[\]\)\]\.map/);
  assert.deepEqual(
    SYNC_LABELS.map((o) => o.id),
    ["symbol", "interval", "crosshair", "time", "dateRange"]
  );
  for (const option of SYNC_LABELS) {
    assert.ok(option.id in DEFAULT_SYNC, `${option.id} has no state behind it`);
  }
});

test("the sync menu adds no drawing sync and says why", () => {
  const source = read("components/tv/SyncMenu.tsx");
  assert.ok(
    !SYNC_LABELS.some((o) => /draw/i.test(o.label)),
    "drawings are per instrument, so a drawing-sync toggle could not work"
  );
  assert.match(source, /Drawings are stored per instrument/,
    "the absence should be explained rather than left as a conspicuous gap");
});

test("sync is presented as a workspace-level control, and its state is not colour-only", () => {
  const source = read("components/tv/SyncMenu.tsx");
  assert.match(source, /Sync across charts/);
  assert.match(source, /Applies to every chart in this layout/);
  assert.match(source, /role="switch"/);
  assert.match(source, /aria-checked=\{on\}/);
  assert.match(source, /\{on \? "On" : "Off"\}/, "the state must also be a word");
});

// ── fullscreen ─────────────────────────────────────────────────────────────

/** A document that behaves like a browser's, driven by the test. */
function fakeDocument(options: {
  enabled?: boolean; exit?: (() => Promise<void>) | undefined;
} = {}): FullscreenDocument & { listeners: (() => void)[]; element: Element | null } {
  const doc = {
    fullscreenElement: null as Element | null,
    fullscreenEnabled: options.enabled ?? true,
    exitFullscreen: "exit" in options
      ? options.exit
      : async function () { doc.fullscreenElement = null; doc.listeners.forEach((l) => l()); },
    listeners: [] as (() => void)[],
    get element() { return doc.fullscreenElement; },
    addEventListener(_type: string, listener: () => void) { doc.listeners.push(listener); },
    removeEventListener(_type: string, listener: () => void) {
      doc.listeners = doc.listeners.filter((l) => l !== listener);
    },
  };
  return doc as unknown as FullscreenDocument & { listeners: (() => void)[]; element: Element | null };
}

function fakeTarget(doc: FullscreenDocument, options: { refuse?: boolean } = {}): FullscreenTarget {
  const target: FullscreenTarget = {
    async requestFullscreen() {
      if (options.refuse) throw new Error("permissions policy");
      (doc as { fullscreenElement: Element | null }).fullscreenElement =
        target as unknown as Element;
    },
  };
  return target;
}

test("fullscreen is offered only when the browser actually permits it", () => {
  assert.equal(fullscreenSupported(fakeDocument()), true);
  assert.equal(fullscreenSupported(fakeDocument({ enabled: false })), false,
    "an iframe without the permission reports fullscreenEnabled: false");
  assert.equal(fullscreenSupported(fakeDocument({ exit: undefined })), false,
    "an engine with no exitFullscreen cannot be driven");
  assert.equal(fullscreenSupported(null), false, "there is no document on the server");
});

test("entering and exiting fullscreen tracks the document, not an assumption", async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc);
  assert.equal(isFullscreen(doc, target), false);

  assert.equal(await enterFullscreen(target, doc), true);
  assert.equal(isFullscreen(doc, target), true);
  assert.equal(isFullscreen(doc), true);

  assert.equal(await exitFullscreen(doc), true);
  assert.equal(isFullscreen(doc, target), false);
  // Exiting when not fullscreen is a no-op, not an error.
  assert.equal(await exitFullscreen(doc), false);
});

test("a refused request reports false rather than claiming fullscreen", async () => {
  const doc = fakeDocument();
  const refusing = fakeTarget(doc, { refuse: true });
  assert.equal(await enterFullscreen(refusing, doc), false);
  assert.equal(isFullscreen(doc, refusing), false);
  // The toggle must report the state actually reached, or the caller renders
  // an "exit fullscreen" affordance for a fullscreen it never entered.
  assert.equal(await toggleFullscreen(refusing, doc), false);
});

test("toggling out of fullscreen leaves the document clean", async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc);
  assert.equal(await toggleFullscreen(target, doc), true);
  assert.equal(await toggleFullscreen(target, doc), false);
  assert.equal(doc.fullscreenElement, null, "state must be cleaned up, not merely flagged");
});

test("a browser-driven exit — Escape — is observed rather than missed", async () => {
  const doc = fakeDocument();
  const target = fakeTarget(doc);
  let observed = 0;
  const stop = watchFullscreen(doc, () => { observed += 1; });

  await enterFullscreen(target, doc);
  // Escape: the browser leaves fullscreen and fires the event. A component
  // holding its own boolean would still be showing "Exit fullscreen" here.
  await exitFullscreen(doc);
  assert.ok(observed >= 1, "the fullscreenchange subscription never fired");
  assert.equal(isFullscreen(doc, target), false);

  stop();
  const before = doc.listeners.length;
  assert.equal(before, 0, "unsubscribing must remove the listener");
});

test("the fullscreen control targets the chart workspace, not the whole document", () => {
  const page = read("app/chart/page.tsx");
  // The ref sits on the page's own root — drawing rail, charts, side panels.
  // It used to be `h-full`; FC2R made it a flex item of `main` (a percentage
  // height cannot resolve against a `flex-1` parent, which was costing the
  // workspace its last 10px). What matters to this test is unchanged: the ref
  // is on the workspace root and not on the document.
  assert.match(page, /<div ref=\{fullscreen\.ref\} className="flex min-h-0 flex-1 flex-col bg-bg/);
  assert.match(page, /onToggleFullscreen=\{fullscreen\.toggle\}/);
  assert.match(page, /fullscreenSupported=\{fullscreen\.supported\}/);

  const toolbar = read(TOOLBAR);
  // Hidden rather than disabled: an inert control teaches the user it is broken.
  assert.match(toolbar, /props\.fullscreenSupported && place\("fullscreen"/);
  assert.match(toolbar, /aria-pressed=\{props\.fullscreen\}/);
  assert.doesNotMatch(toolbar, /position:\s*fixed.*fullscreen/i);
});

test("fullscreen uses the standard API rather than a fixed-position clone", () => {
  const source = read("lib/fullscreen.ts");
  assert.match(source, /requestFullscreen/);
  assert.match(source, /exitFullscreen/);
  assert.match(source, /fullscreenchange/);
});

