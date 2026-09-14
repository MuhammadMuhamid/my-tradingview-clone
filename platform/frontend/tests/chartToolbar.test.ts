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
  TOOLBAR_ACCOUNT_CELL_WIDTH, TOOLBAR_CLUSTER_WIDTH, TOOLBAR_CONTROLS,
  controlsInGroup, isPrimaryControl, primaryControls, secondaryControls,
  toolbarControl, toolbarDensity, toolbarGroup, type ToolbarControlId,
} from "../lib/toolbarLayout";
import { toolbarDensityClasses } from "../components/tv/toolbarDensity";
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
/* The breakpoint literals moved here so a test can import the function that
   returns them; tailwind still scans it, being under components/. */
const DENSITY = "components/tv/toolbarDensity.ts";

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
    "<ContextActions", 'ctl("undo")', 'ctl("redo")', "<WorkspaceActions", 'ctl("more")', "<TradeButton",
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
  const workspaceCluster = source.slice(source.indexOf("function WorkspaceActions"), source.indexOf("function SnapshotMenu"));
  const utilities = ['ctl("layout")', "<SavedLayoutIdentity", 'ctl("sync")', 'ctl("commandPalette")', 'ctl("chartSettings")', 'ctl("fullscreen")', "<SnapshotMenu"];
  at = -1;
  for (const marker of utilities) {
    const next = workspaceCluster.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} is out of order in the workspace cluster (or missing)`);
    at = next;
  }
});

test("nothing on the primary row is a word except the ticker, the chips, the layout name and Trade", () => {
  /*
   * The owner's screenshot: `Last close 77,799 · 9,999 bars · Unnamed` in
   * prime toolbar space, plus `Indicators`, `Replay`, `Alert`, `Trade`, `Sync`
   * as labels at wide widths. The reference's controls are icon-only; the only
   * words on its bar are the ticker, the interval chips, the layout name and
   * the two pills. So: no readout prop, no label class, no count badge.
   */
  const source = readCode(TOOLBAR);
  assert.doesNotMatch(source, /readout/, "the price/bar-count readout must not exist on the bar");
  assert.doesNotMatch(source, /labelClass|density\.label|TOOL_LABEL/, "there are no text labels beside icons");
  assert.doesNotMatch(source, /bg-accent px-1\.5 text-\[10px\]/, "no count badge on Indicators");
  assert.doesNotMatch(read("app/chart/page.tsx"), /readout=\{/, "the page no longer supplies a readout");
  assert.match(source, /<TradeButton/, "Trade is a pill, rendered from one component");
  assert.match(source, /TOOL_PILL_OUTLINE/);
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

test("the More strip is opened deliberately, not by the viewport", () => {
  const source = read(TOOLBAR);
  // The regression this guards: the strip used to appear on its own at `xl`,
  // so a wide screen got several wrapped rows of chrome nobody asked for.
  const stripStart = source.indexOf('data-toolbar-row="secondary"');
  const stripHeader = source.slice(source.lastIndexOf("{moreOpen && (", stripStart), stripStart);
  assert.ok(stripHeader.includes("moreOpen"), "the More strip must be gated on the toggle");
  assert.doesNotMatch(
    source.slice(stripStart, stripStart + 400),
    /\bxl:flex\b|\bxl:order-none\b/,
    "the More strip must not re-appear on its own at a breakpoint"
  );
  assert.match(source, /aria-expanded=\{moreOpen\}/, "the toggle must announce its state");
  assert.match(source, /aria-controls="chart-toolbar-more"/);
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
  assert.match(picker, /title="All timeframes"/);
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
test("the toolbar's one collapse decision is the phone breakpoint, and the CSS carries the same number", () => {
  assert.equal(TOOLBAR_CLUSTER_WIDTH, 768, "Tailwind's md, which is what the class literal says");
  assert.equal(TOOLBAR_ACCOUNT_CELL_WIDTH, 52, "the rail's width: the account cell sits above the rail");
  for (const viewport of [320, 640, 767, 768, 1024, 1280, 1440, 1920]) {
    assert.deepEqual(toolbarDensity(viewport), { clusterOnPrimaryRow: viewport >= 768 });
  }
  const classes = toolbarDensityClasses();
  assert.equal(classes.cluster, "hidden md:flex");
  assert.equal(classes.clusterInMore, "flex md:hidden");
  assert.equal(classes.separator, "hidden md:inline-block");
  assert.equal(classes.separatorInMore, "md:hidden");
  // No shifted breakpoint survives anywhere in the density module.
  assert.doesNotMatch(read(DENSITY), /min-\[\d+px\]/, "a shifted breakpoint is the boxed toolbar coming back");
  // And the page no longer tells the bar about the ticket or the panel,
  // because neither takes width from a full-width row.
  assert.doesNotMatch(read(TOOLBAR), /ticketOpen|panelOpen/);
  assert.doesNotMatch(read("app/chart/page.tsx"), /ticketOpen=|panelOpen=/);
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

test("every control that leaves the primary row on a phone has a second home in the More strip", () => {
  const source = read(TOOLBAR);
  assert.equal((source.match(/<WorkspaceActions /g) ?? []).length, 2);
  assert.equal((source.match(/<ContextActions /g) ?? []).length, 2);
  assert.equal((source.match(/<CompareButton /g) ?? []).length, 2);
  assert.equal((source.match(/<TradeButton /g) ?? []).length, 2);
  assert.match(source, /<WorkspaceActions \{\.\.\.props\} className=\{density\.cluster\} \/>/);
  assert.match(source, /<WorkspaceActions \{\.\.\.props\} className=\{density\.clusterInMore\} \/>/);
  assert.match(source, /<TradeButton \{\.\.\.props\} className=\{density\.clusterInMore\} \/>/);
  assert.doesNotMatch(source, /className="hidden md:flex"/,
    "a hard-coded viewport placement is the defect coming back");
  assert.doesNotMatch(source, /className="flex md:hidden"/);
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

test("a chip prints a day uppercase and everything shorter lowercase", () => {
  // `1M` is a month and `1m` is a minute; on a 29px chip the case of one
  // letter is the whole of the difference, so the reference's casing is
  // copied rather than approximated.
  assert.equal(chipLabel("1d"), "1D");
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

test("one to four charts are immediately accessible and five to sixteen are not hidden", () => {
  const source = read("components/tv/LayoutSelector.tsx");
  assert.match(source, /COMMON_COUNTS = \[1, 2, 3, 4\]/);
  // Everything else is still in the same menu, one click away.
  assert.match(source, /More charts/);
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

  // The menu rows keep the washed thumbnails: there the fill is what separates
  // one arrangement from the next.
  assert.match(source, /<PresetThumbnail preset=\{preset\} \/>/);
});

test("asymmetric arrangements are exposed, not only grids", () => {
  const asymmetric = LAYOUT_PRESETS.filter((p) => p.cells.some((c) => c.colSpan > 1 || c.rowSpan > 1));
  assert.ok(asymmetric.length >= 4, "the one-big-several-small shapes must remain selectable");
  const source = read("components/tv/LayoutSelector.tsx");
  assert.match(source, /presetsForCount\(count\)/,
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
  assert.match(toolbar, /props\.fullscreenSupported && \(/);
  assert.match(toolbar, /aria-pressed=\{props\.fullscreen\}/);
  assert.doesNotMatch(toolbar, /position:\s*fixed.*fullscreen/i);
});

test("fullscreen uses the standard API rather than a fixed-position clone", () => {
  const source = read("lib/fullscreen.ts");
  assert.match(source, /requestFullscreen/);
  assert.match(source, /exitFullscreen/);
  assert.match(source, /fullscreenchange/);
});

