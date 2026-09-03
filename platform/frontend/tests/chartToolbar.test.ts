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
import {
  MORE_INTERVALS, QUICK_INTERVALS, isQuickInterval, timeframeStrip,
} from "../lib/timeframes";
import {
  MANUAL_TICKET_ROW_WIDTH, TOOLBAR_CLUSTER_WIDTH, TOOLBAR_CLUSTER_WIDTH_WITH_TICKET,
  TOOLBAR_CONTROLS, TOOLBAR_LABEL_WIDTH, TOOLBAR_LABEL_WIDTH_WITH_TICKET,
  controlsInGroup, isPrimaryControl, primaryControls, secondaryControls,
  toolbarControl, toolbarDensity, toolbarGroup, toolbarRowWidth, type ToolbarControlId,
} from "../lib/toolbarLayout";
import {
  enterFullscreen, exitFullscreen, fullscreenSupported, isFullscreen, toggleFullscreen,
  watchFullscreen, type FullscreenDocument, type FullscreenTarget,
} from "../lib/fullscreen";
import { INTERVAL_VALUES, type Interval } from "../lib/types";
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
  assert.deepEqual(
    controlsInGroup("context").map((c) => c.id),
    ["symbol", "timeframe", "chartType", "indicators", "replay"],
    "the chart-context group is what tells you what you are looking at"
  );
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
  // The scroller is what lets it stay one row without pushing controls off.
  assert.match(source, /overflow-x-auto/);
});

// ── the collapse breakpoints measure the row, not the screen ───────────────

/**
 * The seven widths Phase 02E measured live with the ticket open. 1024 and 1280
 * overprinted the saved-layout label onto the ticket's instrument header;
 * 1152, 1366, 1440, 1512 and 1680 were clean. The behaviour was non-monotonic,
 * which is what identified a breakpoint compared against the wrong number
 * rather than a separate defect at each width.
 */
const MEASURED_VIEWPORTS = [1024, 1152, 1280, 1366, 1440, 1512, 1680];

test("the toolbar's row is the viewport minus the ticket, and only when the ticket is static", () => {
  assert.equal(MANUAL_TICKET_ROW_WIDTH, 341, "340px panel plus its own left border");
  for (const viewport of MEASURED_VIEWPORTS) {
    assert.equal(toolbarRowWidth(viewport, false), viewport,
      "a closed ticket takes no width from the row");
    assert.equal(toolbarRowWidth(viewport, true), viewport - MANUAL_TICKET_ROW_WIDTH);
  }
  // Below md the ticket is a fixed overlay (ChartSidePanel's `fixed … md:static`),
  // so it is not a flex sibling and subtracts nothing.
  assert.equal(toolbarRowWidth(600, true), 600);
});

test("no measured viewport asks for labels the row cannot hold", () => {
  // The defect, stated as an invariant: the label decision must never be true
  // while the row is narrower than the width labels need.
  for (const viewport of MEASURED_VIEWPORTS) {
    for (const ticketOpen of [false, true]) {
      const density = toolbarDensity(viewport, ticketOpen);
      const row = toolbarRowWidth(viewport, ticketOpen);
      assert.equal(density.labels, row >= TOOLBAR_LABEL_WIDTH,
        `labels at ${viewport}px with ticket ${ticketOpen} disagree with a ${row}px row`);
      assert.equal(density.clusterOnPrimaryRow, row >= TOOLBAR_CLUSTER_WIDTH);
    }
  }

  // The two widths that overprinted. 1280 kept its labels because xl had fired
  // on a 939px row; 1024 kept the saved-layout identity on a 683px row.
  assert.deepEqual(toolbarDensity(1280, true), { labels: false, clusterOnPrimaryRow: true });
  assert.deepEqual(toolbarDensity(1024, true), { labels: false, clusterOnPrimaryRow: false });
  // The clean ones stay exactly as they were measured.
  assert.deepEqual(toolbarDensity(1152, true), { labels: false, clusterOnPrimaryRow: true });
  assert.deepEqual(toolbarDensity(1680, true), { labels: true, clusterOnPrimaryRow: true });
});

test("closing the ticket restores the plain viewport breakpoints exactly", () => {
  // Nothing about the bar changes on a screen with no ticket open: this repair
  // may not move a breakpoint anyone has already lived with.
  for (const viewport of [320, 640, 767, 768, 1023, 1024, 1279, 1280, 1536, 1920]) {
    assert.deepEqual(toolbarDensity(viewport, false), {
      labels: viewport >= 1280,
      clusterOnPrimaryRow: viewport >= 768,
    }, `${viewport}px with the ticket closed must behave as md/xl always did`);
  }
});

test("the classes the bar actually ships are the shifted breakpoints, not a second opinion", () => {
  // tailwind.config.ts scans only app/ and components/, so the class names have
  // to live in the component. This is what keeps them and toolbarLayout's
  // arithmetic from drifting apart.
  const source = read(TOOLBAR);
  assert.equal(TOOLBAR_CLUSTER_WIDTH_WITH_TICKET, 1109);
  assert.equal(TOOLBAR_LABEL_WIDTH_WITH_TICKET, 1621);
  for (const variant of [
    `min-[${TOOLBAR_LABEL_WIDTH_WITH_TICKET}px]:inline`,
    `min-[${TOOLBAR_CLUSTER_WIDTH_WITH_TICKET}px]:flex`,
    `min-[${TOOLBAR_CLUSTER_WIDTH_WITH_TICKET}px]:hidden`,
    `min-[${TOOLBAR_CLUSTER_WIDTH_WITH_TICKET}px]:inline-block`,
  ]) {
    assert.ok(source.includes(variant), `${variant} is not what the bar renders`);
  }
  // And the ticket-closed set is untouched Tailwind.
  assert.match(source, /label: "hidden xl:inline"/);
  assert.match(source, /cluster: "hidden md:flex"/);

  // The bar can only make this decision if it is told; the page is the only
  // place that knows the ticket is open.
  assert.match(source, /ticketOpen: boolean;/);
  assert.match(read("app/chart/page.tsx"),
    /ticketOpen=\{panel === "manual" && !replayActive\}/,
    "the flag must be exactly the condition under which the ticket takes row width");
});

test("the saved-layout identity and the workspace cluster share one placement decision", () => {
  // These are the two elements that overprinted, so the fix has to reach both
  // placements of each — the primary row and the More strip — from one source.
  const source = read(TOOLBAR);
  assert.equal((source.match(/<SavedLayoutIdentity /g) ?? []).length, 2);
  assert.equal((source.match(/<WorkspaceActions /g) ?? []).length, 2);
  assert.match(source, /className=\{`ml-auto \$\{density\.cluster\} 2xl:ml-0`\}/);
  assert.match(source, /<SavedLayoutIdentity \{\.\.\.props\} className=\{density\.clusterInMore\} \/>/);
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
  assert.match(toolbar, /onInterval: \(interval: Interval\) => void;/);
});

test("the toolbar keeps the chart-type control as a slot it does not implement", () => {
  const source = read(TOOLBAR);
  assert.match(source, /<ChartTypeMenu value=\{props\.chartType\} onChange=\{props\.onChartType\} \/>/);
  assert.doesNotMatch(source, /heikin|renko|kagi/i,
    "presentation types belong to the chart-type system, not to this bar");
});

// ── timeframes ─────────────────────────────────────────────────────────────

test("the quick strip and the overflow together are exactly what the backend serves", () => {
  const union = [...QUICK_INTERVALS, ...MORE_INTERVALS];
  assert.equal(new Set(union).size, union.length, "an interval is in both lists");
  assert.deepEqual([...union].sort(), [...INTERVAL_VALUES].sort(),
    "the two lists must partition INTERVAL_VALUES — no invented interval, none hidden");
});

test("no unsupported interval can reach the strip", () => {
  for (const i of [...QUICK_INTERVALS, ...MORE_INTERVALS]) {
    assert.ok((INTERVAL_VALUES as readonly string[]).includes(i), `${i} is not served`);
  }
  // The five that used to be unreachable from the UI despite being supported.
  assert.deepEqual([...MORE_INTERVALS], ["3m", "30m", "2h", "6h", "12h"]);
});

test("the overflow button names the current interval when it lives there", () => {
  const common = timeframeStrip("15m");
  assert.equal(common.moreActive, false);
  assert.equal(common.moreLabel, "More");
  assert.ok(isQuickInterval("15m"));

  // Otherwise the strip would show nothing pressed and a button saying "More",
  // which reads as "no timeframe selected".
  const uncommon = timeframeStrip("30m");
  assert.equal(uncommon.moreActive, true);
  assert.equal(uncommon.moreLabel, "30m");
  assert.equal(isQuickInterval("30m"), false);
});

test("every served interval is reachable from the strip", () => {
  for (const i of INTERVAL_VALUES) {
    const strip = timeframeStrip(i);
    const reachable = [...strip.quick, ...strip.more];
    assert.ok(reachable.includes(i as Interval), `${i} cannot be selected`);
  }
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
  assert.match(source, /SYNC_LABELS\.map/);
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
  // The ref sits on the page's own root — drawing rail, charts, side panels —
  // which excludes the site navigation bar rendered by app/layout.tsx.
  assert.match(page, /<div ref=\{fullscreen\.ref\} className="flex h-full/);
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
