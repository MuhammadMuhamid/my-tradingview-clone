/**
 * The chart workspace: panes, layouts, focus, maximise, synchronisation and
 * the migration off the old two-pane split.
 *
 * These are state-and-output tests over `lib/workspace`, `lib/layoutPresets`
 * and `lib/paneSync`, because that is where the rules now live. The old design
 * put them inline in a page component, which is exactly why four of the five
 * sync toggles could be dead for as long as they were: there was nothing a
 * test could hold.
 *
 * A short static section at the end pins the structural facts a state test
 * cannot see — that there is one pane component and no second-class one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  availablePaneCounts, cellGridStyle, defaultPresetFor, LAYOUT_PRESETS, MAX_PANES,
  paneDensity, presetGridStyle, presetOrDefault, presetsForCount,
} from "../lib/layoutPresets";
import {
  activePane, applyPaneInterval, applyPaneSymbol, clonePane, createWorkspace, feedKeys,
  maximizePane, paneById, parseWorkspace, removePane, restoreLayout, restoreWorkspace,
  setActivePane, setPaneCount, setPaneMaVisibility, setPreset, setWorkspaceBars,
  togglePaneMa, toggleMaximize, updatePane, visiblePanes,
  type ChartWorkspace, type PaneSeed,
} from "../lib/workspace";
import {
  crosshairForPane, DEFAULT_SYNC, followEdgeForPane, SYNC_LABELS, visibleRangeForPane,
  type SyncOptions,
} from "../lib/paneSync";
import { chartTypeLabel } from "../lib/chartType";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SEED: PaneSeed = { symbol: "SOLUSDT", interval: "15m" };
const seeded = (presetId?: string): ChartWorkspace => createWorkspace(SEED, presetId);
const sync = (overrides: Partial<SyncOptions> = {}): SyncOptions => ({ ...DEFAULT_SYNC, ...overrides });
const ids = (ws: ChartWorkspace): string[] => ws.panes.map((p) => p.id);

// ── layout presets ─────────────────────────────────────────────────────────

test("every pane count from one to sixteen has an exact preset", () => {
  for (let n = 1; n <= MAX_PANES; n++) {
    const preset = defaultPresetFor(n);
    assert.equal(preset.panes, n, `no preset holds exactly ${n} panes`);
  }
  assert.deepEqual(
    availablePaneCounts(),
    Array.from({ length: MAX_PANES }, (_, i) => i + 1)
  );
});

test("every preset's cells fit its grid and never overlap", () => {
  for (const preset of LAYOUT_PRESETS) {
    assert.equal(preset.cells.length, preset.panes, `${preset.id} miscounts its panes`);
    const occupied = new Set<string>();
    for (const cell of preset.cells) {
      assert.ok(cell.col >= 1 && cell.col + cell.colSpan - 1 <= preset.cols,
        `${preset.id} has a cell outside its columns`);
      assert.ok(cell.row >= 1 && cell.row + cell.rowSpan - 1 <= preset.rows,
        `${preset.id} has a cell outside its rows`);
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
        for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
          const key = `${c}:${r}`;
          assert.ok(!occupied.has(key), `${preset.id} stacks two panes on ${key}`);
          occupied.add(key);
        }
      }
    }
    // Every square of the grid is used, or the layout has a visible hole.
    assert.equal(occupied.size, preset.cols * preset.rows,
      `${preset.id} leaves part of its grid empty`);
  }
});

test("preset ids are unique and unknown ids fall back to a single pane", () => {
  const seen = new Set(LAYOUT_PRESETS.map((p) => p.id));
  assert.equal(seen.size, LAYOUT_PRESETS.length, "two presets share an id");
  assert.equal(presetOrDefault("not-a-preset").panes, 1);
  assert.equal(presetOrDefault("").id, "1");
});

test("the useful shapes for one to four charts all exist", () => {
  assert.deepEqual(presetsForCount(1).map((p) => p.id), ["1"]);
  assert.deepEqual(presetsForCount(2).map((p) => p.id), ["2-cols", "2-rows"]);
  // Rows, columns, and the two dominant-pane arrangements.
  assert.deepEqual(presetsForCount(3).map((p) => p.id),
    ["3-cols", "3-rows", "3-left", "3-top"]);
  assert.ok(presetsForCount(4).map((p) => p.id).includes("4-grid"));
  assert.ok(presetsForCount(9).map((p) => p.id).includes("9-grid"));
  assert.ok(presetsForCount(16).map((p) => p.id).includes("16-grid"));
});

test("grid styles place a pane in the cell the preset gave it", () => {
  const grid = presetOrDefault("3-left");
  assert.deepEqual(presetGridStyle(grid), {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gridTemplateRows: "repeat(2, minmax(0, 1fr))",
  });
  // The dominant pane spans both rows of the left column.
  assert.deepEqual(cellGridStyle(grid.cells[0]!),
    { gridColumn: "1 / span 1", gridRow: "1 / span 2" });
  assert.deepEqual(cellGridStyle(grid.cells[2]!),
    { gridColumn: "2 / span 1", gridRow: "2 / span 1" });
});

test("density steps down from the smallest usable chart, never below it", () => {
  assert.equal(paneDensity(1400, 800), "large");
  assert.equal(paneDensity(500, 300), "medium");
  assert.equal(paneDensity(300, 180), "small");
  // The audit's practical floor: below it, only the identity is drawn.
  assert.equal(paneDensity(279, 159), "tiny");
  assert.equal(paneDensity(280, 160), "small");
});

// ── pane counts ────────────────────────────────────────────────────────────

for (const count of [1, 2, 3, 4, 8, 16]) {
  test(`a ${count}-pane workspace has ${count} first-class panes with distinct state`, () => {
    const ws = setPaneCount(seeded(), count);
    assert.equal(ws.panes.length, count);
    assert.equal(presetOrDefault(ws.presetId).panes, count);
    assert.equal(new Set(ids(ws)).size, count, "pane ids collided");
    // No two panes share a mutable moving-average array.
    for (let i = 0; i < ws.panes.length; i++) {
      for (let j = i + 1; j < ws.panes.length; j++) {
        assert.notEqual(ws.panes[i]!.maLines, ws.panes[j]!.maLines,
          "two panes share one maLines array");
      }
    }
    // Changing one pane's view changes exactly one pane.
    const target = ws.panes[count - 1]!;
    const changed = updatePane(ws, target.id, { symbol: "BTCUSDT", chartType: "line" });
    assert.equal(paneById(changed, target.id)!.symbol, "BTCUSDT");
    assert.equal(paneById(changed, target.id)!.chartType, "line");
    for (const other of changed.panes.filter((p) => p.id !== target.id)) {
      assert.equal(other.symbol, "SOLUSDT");
      assert.equal(other.chartType, "candles");
    }
    assert.equal(visiblePanes(changed).length, count);
  });
}

test("a one-pane workspace keeps the full primary-chart state model", () => {
  const ws = seeded();
  const pane = ws.panes[0]!;
  assert.equal(pane.id, "p1");
  assert.equal(pane.symbol, "SOLUSDT");
  assert.equal(pane.interval, "15m");
  assert.equal(pane.chartType, "candles");
  assert.ok(pane.bars > 0);
  assert.ok(pane.maLines.length > 0, "a pane with no moving averages is not the primary chart");
  assert.equal(ws.activePaneId, "p1");
  assert.equal(ws.maximizedPaneId, null);
});

test("layout changes preserve the ids and state of surviving panes", () => {
  let ws = setPaneCount(seeded(), 4);
  ws = updatePane(ws, "p2", { symbol: "BTCUSDT", interval: "1h" });
  ws = updatePane(ws, "p3", { symbol: "ETHUSDT" });
  ws = setActivePane(ws, "p2");

  const shrunk = setPaneCount(ws, 2);
  assert.deepEqual(ids(shrunk), ["p1", "p2"]);
  assert.equal(paneById(shrunk, "p2")!.symbol, "BTCUSDT");
  assert.equal(paneById(shrunk, "p2")!.interval, "1h");
  assert.equal(shrunk.activePaneId, "p2", "focus moved for no reason");

  // Growing clones the focused pane, and reuses the lowest free ids.
  const grown = setPaneCount(shrunk, 4);
  assert.deepEqual(ids(grown), ["p1", "p2", "p3", "p4"]);
  assert.equal(paneById(grown, "p3")!.symbol, "BTCUSDT");
  assert.notEqual(paneById(grown, "p3")!.maLines, paneById(grown, "p2")!.maLines);
});

test("shrinking past the focused pane moves focus rather than losing it", () => {
  let ws = setPaneCount(seeded(), 4);
  ws = setActivePane(ws, "p4");
  const shrunk = setPaneCount(ws, 2);
  assert.equal(shrunk.activePaneId, "p1");
  assert.equal(activePane(shrunk).id, "p1");
});

test("closing a pane shrinks the layout and never closes the last one", () => {
  let ws = setPaneCount(seeded(), 3);
  ws = updatePane(ws, "p3", { symbol: "ETHUSDT" });
  const closed = removePane(ws, "p2");
  assert.deepEqual(ids(closed), ["p1", "p3"]);
  assert.equal(closed.panes.length, presetOrDefault(closed.presetId).panes);
  assert.equal(paneById(closed, "p3")!.symbol, "ETHUSDT", "a surviving pane lost its state");

  const single = removePane(closed, "p3");
  assert.deepEqual(ids(single), ["p1"]);
  assert.equal(removePane(single, "p1"), single, "the last pane must not be closable");
});

test("a preset change never leaves the pane count and the geometry disagreeing", () => {
  let ws = seeded();
  for (const preset of LAYOUT_PRESETS) {
    ws = setPreset(ws, preset.id);
    assert.equal(ws.panes.length, preset.panes, `${preset.id} produced the wrong pane count`);
    assert.ok(ws.panes.some((p) => p.id === ws.activePaneId), `${preset.id} lost its focus`);
  }
});

// ── focus ──────────────────────────────────────────────────────────────────

test("the active pane is explicit and changing it changes nothing else", () => {
  const ws = setPaneCount(seeded(), 4);
  const focused = setActivePane(ws, "p3");
  assert.equal(focused.activePaneId, "p3");
  assert.equal(activePane(focused).id, "p3");
  // Focus is focus. No symbol, interval or layout moved with it.
  assert.deepEqual(focused.panes, ws.panes);
  assert.equal(focused.presetId, ws.presetId);
  // An unknown pane is not focusable, and re-focusing is a no-op by identity.
  assert.equal(setActivePane(focused, "nope"), focused);
  assert.equal(setActivePane(focused, "p3"), focused);
});

// ── maximise / restore ─────────────────────────────────────────────────────

test("maximise shows one pane and restore returns the exact prior layout", () => {
  let ws = setPaneCount(seeded(), 4);
  ws = updatePane(ws, "p2", { symbol: "BTCUSDT", interval: "4h", chartType: "line" });
  ws = setActivePane(ws, "p1");
  const before = ws;

  const big = maximizePane(ws, "p2");
  assert.equal(big.maximizedPaneId, "p2");
  assert.deepEqual(visiblePanes(big).map((p) => p.id), ["p2"]);
  // Every other pane is still in the workspace, untouched.
  assert.deepEqual(big.panes, before.panes);
  assert.equal(big.presetId, before.presetId);
  assert.equal(paneById(big, "p4")!.symbol, "SOLUSDT");

  const restored = restoreLayout(big);
  assert.equal(restored.maximizedPaneId, null);
  assert.deepEqual(restored.panes, before.panes);
  assert.equal(restored.presetId, before.presetId);
  assert.deepEqual(visiblePanes(restored).map((p) => p.id), ["p1", "p2", "p3", "p4"]);
});

test("maximising focuses the pane on screen, and toggling restores", () => {
  const ws = setPaneCount(seeded(), 4);
  const big = toggleMaximize(ws, "p3");
  assert.equal(big.activePaneId, "p3", "the only pane on screen must be the focused one");
  assert.equal(toggleMaximize(big, "p3").maximizedPaneId, null);
});

test("a layout change while maximised drops the maximise rather than stranding it", () => {
  const ws = maximizePane(setPaneCount(seeded(), 4), "p4");
  const shrunk = setPaneCount(ws, 2);
  assert.equal(shrunk.maximizedPaneId, null);
  assert.equal(visiblePanes(shrunk).length, 2);
});

// ── synchronisation ────────────────────────────────────────────────────────

test("a synchronised symbol change reaches every pane exactly once", () => {
  const ws = setPaneCount(seeded(), 8);
  const next = applyPaneSymbol(ws, "p5", "BTCUSDT", sync({ symbol: true }));
  assert.deepEqual(next.panes.map((p) => p.symbol), new Array(8).fill("BTCUSDT"));
  // Idempotent: a second identical application is a no-op, so a broadcast that
  // somehow arrived twice could not compound.
  const again = applyPaneSymbol(next, "p5", "BTCUSDT", sync({ symbol: true }));
  assert.deepEqual(again.panes.map((p) => p.symbol), next.panes.map((p) => p.symbol));
  // The layout and focus are untouched by a data change.
  assert.equal(next.presetId, ws.presetId);
  assert.equal(next.activePaneId, ws.activePaneId);
});

test("an unsynchronised symbol change stays in its own pane", () => {
  const ws = setPaneCount(seeded(), 4);
  const next = applyPaneSymbol(ws, "p2", "BTCUSDT", sync({ symbol: false }));
  assert.equal(paneById(next, "p2")!.symbol, "BTCUSDT");
  for (const id of ["p1", "p3", "p4"]) {
    assert.equal(paneById(next, id)!.symbol, "SOLUSDT", `${id} followed a pane it should not`);
  }
});

test("interval sync propagates, and is independent of symbol sync", () => {
  const ws = setPaneCount(seeded(), 3);
  const synced = applyPaneInterval(ws, "p1", "4h", sync({ interval: true, symbol: false }));
  assert.deepEqual(synced.panes.map((p) => p.interval), ["4h", "4h", "4h"]);
  assert.deepEqual(synced.panes.map((p) => p.symbol), ["SOLUSDT", "SOLUSDT", "SOLUSDT"]);

  const alone = applyPaneInterval(ws, "p2", "1h", sync({ interval: false }));
  assert.deepEqual(alone.panes.map((p) => p.interval), ["15m", "1h", "15m"]);
});

test("a change from a pane that is not in the workspace changes nothing", () => {
  const ws = setPaneCount(seeded(), 2);
  assert.equal(applyPaneSymbol(ws, "ghost", "BTCUSDT", sync({ symbol: true })), ws);
  assert.equal(applyPaneInterval(ws, "ghost", "1h", sync({ interval: true })), ws);
});

test("crosshair mirroring works for arbitrary pane ids and never echoes", () => {
  const on = sync({ crosshair: true });
  const signal = { paneId: "p9", time: 1_700_000_000 };
  // Any other pane draws it…
  assert.equal(crosshairForPane(signal, "p1", on), 1_700_000_000);
  assert.equal(crosshairForPane(signal, "p16", on), 1_700_000_000);
  // …and the pane that produced it does not, which is what prevents a loop.
  assert.equal(crosshairForPane(signal, "p9", on), null);
  // Off means off, and no signal means nothing to draw.
  assert.equal(crosshairForPane(signal, "p1", sync({ crosshair: false })), null);
  assert.equal(crosshairForPane(null, "p1", on), null);
  // A pointer that left the plot clears the mirrored crosshair.
  assert.equal(crosshairForPane({ paneId: "p2", time: null }, "p1", on), null);
});

test("range mirroring distinguishes the same span from the same right edge", () => {
  const signal = { paneId: "p3", from: 100, to: 200 };
  const exact = sync({ dateRange: true, time: false });
  assert.deepEqual(visibleRangeForPane(signal, "p1", exact), { from: 100, to: 200 });
  assert.equal(followEdgeForPane(signal, "p1", exact), null,
    "date-range sync already fixes the edge; following it too would fight the zoom");

  const edge = sync({ time: true, dateRange: false });
  assert.equal(visibleRangeForPane(signal, "p1", edge), null);
  assert.equal(followEdgeForPane(signal, "p1", edge), 200);

  // Neither ever returns to the pane that produced the range.
  assert.equal(visibleRangeForPane(signal, "p3", exact), null);
  assert.equal(followEdgeForPane(signal, "p3", edge), null);
  // Both off: nothing is applied.
  assert.equal(visibleRangeForPane(signal, "p1", sync()), null);
  assert.equal(followEdgeForPane(signal, "p1", sync()), null);
});

test("NO SYNC CONTROL IS DECORATIVE", () => {
  /*
   * The regression this pins: the menu shipped five switches, and only
   * `interval` did anything. `symbol` was never read; `crosshair`, `time` and
   * `dateRange` were written into state tagged `pane: 2` that only a
   * `pane === 1` reader consumed, and pane 1 was never wired to emit.
   *
   * Every id below must now be consumed by a real mechanism, and the two
   * mechanisms are the only ones there are: field propagation in the workspace
   * reducer, and view mirroring in the pane-sync helpers.
   */
  const workspace = read("lib/workspace.ts");
  const paneSync = read("lib/paneSync.ts");
  const page = read("app/chart/page.tsx");
  const mechanisms: Record<string, { source: string; pattern: RegExp }> = {
    // Field propagation, in the workspace reducer.
    symbol: { source: workspace, pattern: /syncTargets\(ws, originId, sync, "symbol"\)/ },
    interval: { source: workspace, pattern: /syncTargets\(ws, originId, sync, "interval"\)/ },
    // View mirroring, in the pane-sync resolvers.
    crosshair: { source: paneSync, pattern: /!sync\.crosshair/ },
    time: { source: paneSync, pattern: /!sync\.time/ },
    dateRange: { source: paneSync, pattern: /sync\.dateRange/ },
  };
  for (const option of SYNC_LABELS) {
    const mechanism = mechanisms[option.id];
    assert.ok(mechanism, `${option.id} has no declared mechanism`);
    assert.match(mechanism.source, mechanism.pattern,
      `the ${option.id} toggle is displayed but nothing reads it`);
  }
  // And the page must actually hand the mirroring props to the panes, which is
  // the wiring that was missing before.
  assert.match(page, /crosshairTime=\{crosshairForPane\(cross, pane\.id, sync\)\}/);
  assert.match(page, /visibleRange=\{visibleRangeForPane\(range, pane\.id, sync\)\}/);
  assert.match(page, /followEdgeTime=\{followEdgeForPane\(range, pane\.id, sync\)\}/);
  assert.match(page, /onCrosshairMove=\{publishCrosshair\}/);
  assert.match(page, /onVisibleRangeChange=\{publishRange\}/);
});

// ── moving averages are per pane ───────────────────────────────────────────

test("toggling a moving average affects one pane only", () => {
  // Started from every line shown, because what is being asserted is that a
  // toggle reaches exactly one pane — not what a fresh chart draws, which is
  // `tests/movingAverages.test.ts`.
  const all = setPaneCount(seeded(), 3);
  const ws = {
    ...all,
    panes: all.panes.map((p) => ({ ...p, maLines: p.maLines.map((l) => ({ ...l, visible: true })) })),
  };
  const next = togglePaneMa(ws, "p2", "sma", 200);
  const line = (id: string) =>
    paneById(next, id)!.maLines.find((l) => l.type === "sma" && l.length === 200)!;
  assert.equal(line("p2").visible, false);
  assert.equal(line("p1").visible, true);
  assert.equal(line("p3").visible, true);

  const hidden = setPaneMaVisibility(next, "p3", false);
  assert.ok(paneById(hidden, "p3")!.maLines.every((l) => !l.visible));
  assert.ok(paneById(hidden, "p1")!.maLines.every((l) => l.visible));
});

test("a cloned pane copies its source's moving averages instead of sharing them", () => {
  const ws = togglePaneMa(seeded(), "p1", "ema", 50);
  const copy = clonePane(ws.panes[0]!, "p2");
  assert.deepEqual(copy.maLines, ws.panes[0]!.maLines);
  assert.notEqual(copy.maLines, ws.panes[0]!.maLines);
  copy.maLines[0]!.visible = !copy.maLines[0]!.visible;
  assert.notEqual(copy.maLines[0]!.visible, ws.panes[0]!.maLines[0]!.visible);
});

// ── shared feed identity ───────────────────────────────────────────────────

test("the workspace's upstream cost tracks distinct feeds, not pane count", () => {
  const sixteen = setPaneCount(seeded(), 16);
  assert.equal(sixteen.panes.length, 16);
  assert.deepEqual(feedKeys(sixteen), ["SOLUSDT|15m"],
    "sixteen identical panes must want exactly one upstream feed");

  let mixed = sixteen;
  mixed = updatePane(mixed, "p2", { symbol: "BTCUSDT" });
  mixed = updatePane(mixed, "p3", { interval: "1h" });
  mixed = updatePane(mixed, "p4", { symbol: "BTCUSDT" });
  assert.deepEqual(feedKeys(mixed).sort(),
    ["BTCUSDT|15m", "SOLUSDT|15m", "SOLUSDT|1h"]);
});

test("history depth is a workspace-wide reading choice", () => {
  const ws = setWorkspaceBars(setPaneCount(seeded(), 4), 2000);
  assert.deepEqual(ws.panes.map((p) => p.bars), [2000, 2000, 2000, 2000]);
});

// ── persistence and migration ──────────────────────────────────────────────

test("a workspace round-trips through storage with its identity intact", () => {
  let ws = setPaneCount(seeded(), 4);
  ws = updatePane(ws, "p2", { symbol: "BTCUSDT", interval: "4h", chartType: "area", bars: 2000 });
  ws = setActivePane(ws, "p3");
  ws = maximizePane(ws, "p3");
  const restored = parseWorkspace(JSON.parse(JSON.stringify(ws)) as unknown);
  assert.deepEqual(restored, ws);
});

test("legacy split state migrates to the equivalent workspace", () => {
  const closed = restoreWorkspace({ stored: null, legacySplit: { open: false }, seed: SEED });
  assert.equal(closed.source, "legacy-split");
  assert.equal(closed.workspace.panes.length, 1);
  assert.equal(closed.workspace.presetId, "1");
  assert.equal(closed.workspace.panes[0]!.symbol, "SOLUSDT");

  const split = restoreWorkspace({
    stored: null, legacySplit: { open: true, interval: "1h" }, seed: SEED,
  });
  assert.equal(split.source, "legacy-split");
  assert.equal(split.workspace.panes.length, 2);
  assert.equal(split.workspace.presetId, "2-cols");
  // The old split shared pane 1's symbol and kept its own timeframe.
  assert.deepEqual(split.workspace.panes.map((p) => p.symbol), ["SOLUSDT", "SOLUSDT"]);
  assert.deepEqual(split.workspace.panes.map((p) => p.interval), ["15m", "1h"]);
  assert.equal(split.workspace.activePaneId, "p1");

  // A split with no recorded timeframe still opens two panes.
  const bare = restoreWorkspace({ stored: null, legacySplit: { open: true }, seed: SEED });
  assert.equal(bare.workspace.panes.length, 2);
  assert.equal(bare.workspace.panes[1]!.interval, "15m");
});

test("no persisted state at all opens one pane on the seed", () => {
  const fresh = restoreWorkspace({ stored: null, legacySplit: null, seed: SEED });
  assert.equal(fresh.source, "default");
  assert.equal(fresh.workspace.panes.length, 1);
  assert.equal(fresh.workspace.panes[0]!.interval, "15m");
});

test("A MALFORMED WORKSPACE FAILS SAFE TO ONE PANE", () => {
  /*
   * All-or-nothing on purpose. A workspace half-restored from a damaged record
   * is worse than a clean single chart: the operator cannot tell which of what
   * they are looking at is theirs, and one of these panes is where an order
   * ticket points.
   */
  const good = setPaneCount(seeded(), 2);
  const damaged: unknown[] = [
    null, undefined, 42, "{}", [],
    { ...good, version: 1 },
    { ...good, presetId: "not-a-preset" },
    // pane count disagreeing with the preset
    { ...good, panes: good.panes.slice(0, 1) },
    // duplicate ids
    { ...good, panes: [good.panes[0], { ...good.panes[1], id: "p1" }] },
    { ...good, activePaneId: "p9" },
    { ...good, maximizedPaneId: "p9" },
    // `7m` is a REAL resolution now — seven whole one-minute bars — so the
    // rejected example has to be one that genuinely cannot be built: a week is
    // a calendar object rather than a multiple of anything the venue publishes.
    { ...good, panes: [good.panes[0], { ...good.panes[1], interval: "1w" }] },
    { ...good, panes: [good.panes[0], { ...good.panes[1], interval: "0m" }] },
    { ...good, panes: [good.panes[0], { ...good.panes[1], interval: "7" }] },
    { ...good, panes: [good.panes[0], { ...good.panes[1], chartType: "kagi" }] },
    { ...good, panes: [good.panes[0], { ...good.panes[1], bars: -5 }] },
    { ...good, panes: [good.panes[0], { ...good.panes[1], symbol: "" }] },
    { ...good, panes: [good.panes[0], { ...good.panes[1], maLines: "all" }] },
    { ...good, panes: [good.panes[0], { ...good.panes[1], maLines: [{ type: "wma", length: 9, visible: true }] }] },
  ];
  for (const record of damaged) {
    assert.equal(parseWorkspace(record), null, `accepted a damaged record: ${JSON.stringify(record)}`);
  }
  // And a damaged record must not fall through to the legacy split key, which
  // the stored workspace had already replaced.
  const recovered = restoreWorkspace({
    stored: "{not json", legacySplit: { open: true, interval: "1h" }, seed: SEED,
  });
  assert.equal(recovered.source, "default");
  assert.equal(recovered.workspace.panes.length, 1);
});

test("a valid stored workspace wins over the legacy split key", () => {
  const stored = JSON.parse(JSON.stringify(setPaneCount(seeded(), 3))) as unknown;
  const restored = restoreWorkspace({
    stored, legacySplit: { open: true, interval: "1h" }, seed: SEED,
  });
  assert.equal(restored.source, "stored");
  assert.equal(restored.workspace.panes.length, 3);
});

// ── structure ──────────────────────────────────────────────────────────────

test("THE SECOND-CLASS SPLIT PANE IS GONE, NOT MERELY UNUSED", () => {
  for (const file of ["components/tv/SplitPane.tsx", "lib/useMirroredIndicators.ts"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, file)),
      `${file} still exists — the legacy two-pane runtime is shipping alongside the new one`);
  }
  const tree = [
    ...fs.readdirSync(path.join(ROOT, "app", "chart")).map((f) => `app/chart/${f}`),
    ...fs.readdirSync(path.join(ROOT, "components", "tv")).map((f) => `components/tv/${f}`),
    "components/CandleChart.tsx",
  ].filter((f) => f.endsWith(".tsx"));
  for (const file of tree) {
    // Comments are stripped: this file's own history explains what `mirror_`
    // was, and prose about a retired mechanism is not a use of it.
    const source = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!/\bSplitPane\b/.test(source), `${file} still references SplitPane`);
    assert.ok(!/useMirroredIndicators|mirror_/.test(source),
      `${file} still mirrors another pane's studies instead of owning its own`);
  }
});

test("EVERY CHART ON SCREEN IS THE SAME FIRST-CLASS PANE COMPONENT", () => {
  const page = read("app/chart/page.tsx");
  const host = read("components/tv/ChartWorkspace.tsx");
  const pane = read("components/tv/ChartPane.tsx");

  // The page renders panes only through the workspace host's render callback.
  assert.match(page, /<ChartWorkspace workspace=\{workspace\} renderPane=\{renderPane\}/);
  assert.match(page, /<ChartPane/);
  assert.equal((page.match(/<CandleChart/g) ?? []).length, 0,
    "the page mounts a chart directly, which is how a privileged main chart returns");
  assert.match(host, /renderPane\(pane, \{ maximized: false \}\)/);

  // And a pane has the capabilities the old secondary pane lacked entirely.
  for (const capability of [
    /useIndicators\(/, /scope: pane\.id/, /chartType=\{pane\.chartType\}/,
    /drawings=\{drawingsAtReplayHorizon\(/, /onDrawingsChange=/, /priceLines=\{props\.priceLines\}/,
    /onIndicatorPaneAction=\{paneAction\}/, /buildMaOverlays\(visibleCandles, pane\.maLines\)/,
  ]) {
    assert.match(pane, capability, `every pane must support ${capability}`);
  }
});

test("a pane keeps its instrument legible at every size", () => {
  const pane = read("components/tv/ChartPane.tsx");
  const legend = read("components/tv/PaneLegend.tsx");

  /*
   * The pane's identity moved out of a bordered header row and onto the chart.
   *
   * What is being asserted is unchanged: a pane always says what instrument and
   * what resolution it is, at every size. What changed is that it no longer
   * says it in a second toolbar under the first one — see `PaneLegend`.
   */
  assert.match(pane, /<PaneLegend/);
  assert.match(pane, /symbol=\{pane\.symbol\}/);
  assert.match(pane, /interval=\{pane\.interval\}/);
  assert.doesNotMatch(pane, /border-b border-border px-1\.5/,
    "the pane must not grow a header row again");

  // Neither the symbol nor the timeframe is behind a density flag; only the
  // price and the loading note are.
  assert.match(legend, /onOpenSymbolSearch\(paneId\)/);
  assert.match(legend, /<LegendTimeframe/);
  assert.match(legend, /!dense && props\.lastClose/);
  assert.ok(!/dense[\s\S]{0,120}\{symbol\}/.test(legend),
    "the instrument must never be hidden by the density policy");
});

test("the pane legend does not swallow the drawing layer's pointer events", () => {
  const legend = read("components/tv/PaneLegend.tsx");
  // The container is transparent to the pointer and each control opts back in.
  // A legend that ate a drag would break every trend line started near the
  // top-left corner, which is where most of them start.
  assert.match(legend, /pointer-events-none absolute left-2/);
  assert.match(legend, /const HIT = "pointer-events-auto"/);
});

test("one pane means one symbol control and one timeframe control", () => {
  /*
   * The owner-reported defect, as an assertion.
   *
   * The toolbar carries the focused pane's symbol and timeframe; the pane
   * carries its own. In a one-pane workspace those are the same pane, so the
   * pane's copies must not be a second BAR — and they are not: they are a
   * legend over the plot with no strip in it. The strip lives once, on the
   * toolbar, and `tests/dom/chartShell.test.tsx` counts the rendered controls.
   */
  const pane = read("components/tv/ChartPane.tsx");
  assert.doesNotMatch(pane, /PANE_INTERVALS/,
    "the pane must not carry its own list of intervals again");
  const legend = read("components/tv/PaneLegend.tsx");
  assert.doesNotMatch(legend, /\.map\(\(i\) =>/,
    "the legend states one timeframe; it does not render a strip of them");
});

// ── chart-only transforms in the workspace ─────────────────────────────────

/**
 * Heikin Ashi and Renko are per-pane display state and nothing more. The tests
 * below hold the three facts that keeps true: one pane's lens does not reach
 * another's, the lens is not part of the upstream feed's identity, and a lens
 * survives a reload without ever being able to survive as garbage.
 */

test("CANONICAL, HEIKIN ASHI AND RENKO COEXIST ON ONE INSTRUMENT", () => {
  let ws = setPaneCount(createWorkspace({ symbol: "BTCUSDT", interval: "15m" }), 3);
  ws = updatePane(ws, "p2", { chartType: "heikinAshi" });
  ws = updatePane(ws, "p3", { chartType: "renko" });

  assert.deepEqual(ws.panes.map((p) => p.chartType), ["candles", "heikinAshi", "renko"]);
  assert.deepEqual(ws.panes.map((p) => `${p.symbol}|${p.interval}`),
    ["BTCUSDT|15m", "BTCUSDT|15m", "BTCUSDT|15m"]);

  // Three lenses on one instrument is still ONE upstream feed. Presentation is
  // not part of feed identity, and if it ever became part of it this is the
  // assertion that would say so.
  assert.deepEqual(feedKeys(ws), ["BTCUSDT|15m"],
    "a chart-only transform opened a second upstream feed");
});

test("CHANGING A PANE'S TRANSFORM CHANGES NOTHING ELSE", () => {
  const start = setPaneCount(createWorkspace({ symbol: "BTCUSDT", interval: "15m" }), 4);
  let ws = start;

  // Candles → Heikin Ashi → Renko → Candles, on one pane only.
  for (const type of ["heikinAshi", "renko", "candles"] as const) {
    ws = updatePane(ws, "p2", { chartType: type });
    assert.equal(paneById(ws, "p2")!.chartType, type);
    for (const other of ["p1", "p3", "p4"]) {
      assert.deepEqual(paneById(ws, other), paneById(start, other),
        `changing p2's chart type disturbed ${other}`);
    }
    assert.deepEqual(feedKeys(ws), ["BTCUSDT|15m"],
      "switching presentation changed which feeds the workspace needs");
  }

  // And a full round trip lands exactly where it started.
  assert.deepEqual(ws, start);
});

test("A TRANSFORM IS NOT PROPAGATED BY SYNCHRONISATION", () => {
  // Symbol and interval are the only field-propagating sync toggles; a chart
  // lens is a per-pane reading choice and must not travel with them.
  let ws = setPaneCount(createWorkspace(SEED), 3);
  ws = updatePane(ws, "p1", { chartType: "renko" });
  ws = applyPaneSymbol(ws, "p1", "ETHUSDT", sync({ symbol: true }));
  ws = applyPaneInterval(ws, "p1", "1h", sync({ interval: true }));

  assert.deepEqual(ws.panes.map((p) => p.chartType), ["renko", "candles", "candles"]);
  assert.deepEqual(ws.panes.map((p) => p.symbol), ["ETHUSDT", "ETHUSDT", "ETHUSDT"]);
});

test("A SYNTHETIC PANE SURVIVES A RELOAD, AND A DAMAGED ONE DOES NOT COME BACK WRONG", () => {
  let ws = setPaneCount(createWorkspace({ symbol: "BTCUSDT", interval: "15m" }), 3);
  ws = updatePane(ws, "p2", { chartType: "heikinAshi" });
  ws = updatePane(ws, "p3", { chartType: "renko" });

  // Round-trip through the storage format, not through the objects.
  const stored = JSON.parse(JSON.stringify(ws)) as unknown;
  const restored = restoreWorkspace({ stored, legacySplit: null, seed: SEED });
  assert.equal(restored.source, "stored");
  assert.deepEqual(restored.workspace, ws);
  assert.deepEqual(restored.workspace.panes.map((p) => p.chartType),
    ["candles", "heikinAshi", "renko"]);

  // Renko's only parameter is fixed at ATR(14) and is carried by the type, so
  // restoring the type restores the parameters — there is nothing else to lose.
  assert.equal(chartTypeLabel(restored.workspace.panes[2]!.chartType), "Renko · ATR(14)");

  // A record naming a transform this build does not have is a damaged record,
  // and a damaged record lands on a clean canonical pane rather than on a
  // half-restored workspace.
  const bogus = JSON.parse(JSON.stringify(ws)) as { panes: { chartType: string }[] };
  bogus.panes[1]!.chartType = "kagi";
  assert.equal(parseWorkspace(bogus), null);
  const fallback = restoreWorkspace({ stored: bogus, legacySplit: null, seed: SEED });
  assert.equal(fallback.source, "default");
  assert.deepEqual(fallback.workspace.panes.map((p) => p.chartType), ["candles"]);
});

test("A TRANSFORM CANNOT REACH TRADING, ALERTS, STRATEGIES OR STORED CANDLES", () => {
  // Manual execution targets a pane's SYMBOL. It has never known about
  // presentation and must not learn: this is the assertion that fails if a
  // chart lens is ever threaded into the trading target.
  const target = read("lib/tradingTarget.ts");
  assert.ok(!/chartType|heikinAshi|renko|chartTransforms/i.test(target),
    "the manual trading target grew an opinion about how the chart is drawn");

  // The pane hands the chart its CANONICAL candles; the transform happens
  // inside the renderer, downstream of everything else the pane computes.
  const pane = read("components/tv/ChartPane.tsx");
  assert.match(pane, /candles=\{visibleCandles\}/);
  assert.match(pane, /buildMaOverlays\(visibleCandles, pane\.maLines\)/);
  assert.ok(!/chartTransforms|heikinAshi|renkoBricks/.test(pane),
    "a pane started transforming candles before handing them on");

  // And nothing outside the chart imports the transforms at all.
  for (const file of [
    "lib/workspace.ts", "lib/marketFeed.ts", "lib/candleHistory.ts", "lib/replay.ts",
    "lib/alerts.ts", "lib/manualTicket.ts", "lib/tradingOverlays.ts", "lib/drawings.ts",
  ]) {
    assert.ok(!/chartTransforms/.test(read(file)),
      `${file} reads the synthetic transforms; only the renderer may`);
  }
});
