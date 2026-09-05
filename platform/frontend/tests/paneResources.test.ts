/**
 * What each pane owns, and what belongs to the instrument instead.
 *
 * Three things were tangled in the two-pane design and are separated here:
 *
 *   DRAWINGS   are canonically per SYMBOL. Two panes on one instrument see the
 *              same drawings; closing a pane removes a view, not the work.
 *   STUDIES    are per PANE. The old second pane had none of its own — it
 *              re-ran the first pane's list under a `mirror_` key prefix, so a
 *              study could not be added to it at all.
 *   REPLAY     is one clock for the workspace, so no pane can be showing live
 *              data while another is at a historical horizon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  clearStored, copyStoredForScope, indicatorStorageKey, loadStored,
  PRIMARY_INDICATOR_SCOPE, saveStored, type AppliedIndicator,
} from "../lib/indicators";
import {
  clearStoredNative, copyStoredNativeForScope, loadStoredNative, nativeStorageKey,
  saveStoredNative,
} from "../lib/useNativeStudies";
import type { AppliedNativeStudy } from "../lib/native/compute";
import { loadDrawings, saveDrawings, type Drawing } from "../lib/drawings";
import {
  drawingsAtReplayHorizon, lastBarIndexAtOrBefore, liveActionsDisabled, replayCandles,
  startReplay, stepReplay, type ReplaySession,
} from "../lib/replay";
import {
  createWorkspace, maximizePane, removePane, restoreLayout, setPaneCount, updatePane,
} from "../lib/workspace";
import type { Candle, Interval } from "../lib/types";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const nativeStudy = (key: string, defId: string): AppliedNativeStudy =>
  ({ key, defId, params: {}, visible: true, styles: {} });

/** A `localStorage` good enough for the modules under test. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  (globalThis as { window?: unknown }).window = { localStorage };
  (globalThis as { localStorage?: unknown }).localStorage = localStorage;
  return store;
}

function uninstallStorage(): void {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

const study = (key: string, name: string, params: Record<string, number> = {}): AppliedIndicator => ({
  key, scriptId: null, name, kind: "indicator", shortTitle: "", overlay: true,
  precision: null, source: `//@version=5\nindicator("${name}")`, inputs: [], params,
  visible: true, loading: false, error: null, warnings: [],
  overlays: [], decorations: [], barColors: [], markers: [],
  drawings: { lines: [], boxes: [], labels: [], tables: [] }, trades: [],
});

const drawing = (id: string, price: number): Drawing => ({
  id, tool: "trend", points: [{ time: 1000, price }, { time: 2000, price: price + 1 }],
  style: { color: "#fff", width: 1 },
});

const candles = (count: number, interval: Interval = "15m"): Candle[] =>
  Array.from({ length: count }, (_, i) => ({
    symbol: "SOLUSDT", interval, openTime: i * 900_000,
    closeTime: i * 900_000 + 899_999,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1,
  }));

// ── studies are per pane ───────────────────────────────────────────────────

test("THE FIRST PANE KEEPS THE EXISTING STORAGE ENTRY", () => {
  /*
   * An existing user's applied studies are under `tv.indicators.v1`. Their
   * chart becomes pane `p1`, so p1 must read that exact key or the move to a
   * multi-pane workspace would silently empty everyone's chart.
   */
  assert.equal(PRIMARY_INDICATOR_SCOPE, "p1");
  assert.equal(indicatorStorageKey("p1"), "tv.indicators.v1");
  assert.equal(indicatorStorageKey("p2"), "tv.indicators.v1.p2");
  assert.equal(indicatorStorageKey("p16"), "tv.indicators.v1.p16");

  const store = installStorage();
  try {
    // Written by a build that predates panes.
    store.set("tv.indicators.v1", JSON.stringify([
      { key: "ind_a", scriptId: null, name: "RSI", source: "src", params: { len: 14 }, visible: true },
    ]));
    const restored = loadStored("p1");
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.name, "RSI");
    // And a second pane starts empty rather than inheriting them.
    assert.deepEqual(loadStored("p2"), []);
  } finally { uninstallStorage(); }
});

test("every pane owns its studies; one pane's list never reaches another", () => {
  const store = installStorage();
  try {
    saveStored([study("a", "RSI", { len: 14 })], "p1");
    saveStored([study("b", "MACD"), study("c", "ATR")], "p4");
    assert.deepEqual(loadStored("p1").map((s) => s.name), ["RSI"]);
    assert.deepEqual(loadStored("p4").map((s) => s.name), ["MACD", "ATR"]);
    assert.deepEqual(loadStored("p9"), []);

    // Removing everything from one pane leaves the others alone.
    saveStored([], "p1");
    assert.deepEqual(loadStored("p1"), []);
    assert.equal(loadStored("p4").length, 2);
    assert.ok(store.has("tv.indicators.v1.p4"));
  } finally { uninstallStorage(); }
});

test("a cloned pane gets a COPY of the studies, not a shared configuration", () => {
  const store = installStorage();
  try {
    saveStored([study("a", "RSI", { len: 14 })], "p1");
    copyStoredForScope("p1", "p3");
    const source = loadStored("p1");
    const copy = loadStored("p3");
    assert.deepEqual(copy.map((s) => s.name), ["RSI"]);
    assert.deepEqual(copy[0]!.params, source[0]!.params);
    // Separate storage entries, so retuning one chart cannot retune the other.
    assert.notEqual(store.get("tv.indicators.v1"), undefined);
    assert.notEqual(store.get("tv.indicators.v1.p3"), undefined);
    saveStored([study("a", "RSI", { len: 50 })], "p3");
    assert.equal(loadStored("p1")[0]!.params.len, 14);
    assert.equal(loadStored("p3")[0]!.params.len, 50);
    // Copying to itself is a no-op rather than a self-overwrite.
    copyStoredForScope("p1", "p1");
    assert.equal(loadStored("p1")[0]!.params.len, 14);
  } finally { uninstallStorage(); }
});

test("closing a pane releases its studies so a reused id inherits nothing", () => {
  const store = installStorage();
  try {
    saveStored([study("a", "RSI")], "p1");
    saveStored([study("b", "MACD")], "p2");
    clearStored("p2");
    assert.deepEqual(loadStored("p2"), []);
    assert.equal(store.has("tv.indicators.v1.p2"), false);
    assert.equal(loadStored("p1").length, 1, "closing one pane emptied another");
  } finally { uninstallStorage(); }
});

test("the page copies on growth and releases on close, for BOTH study engines", () => {
  const page = read("app/chart/page.tsx");
  assert.match(page, /copyStoredForScope\(workspace\.activePaneId, pane\.id\)/);
  assert.match(page, /copyStoredNativeForScope\(workspace\.activePaneId, pane\.id\)/,
    "a cloned pane must inherit its source pane's built-in studies too");
  assert.match(page, /if \(next !== ws\) \{ clearStored\(paneId\); clearStoredNative\(paneId\); \}/,
    "closing a pane must release both scopes, or a reused pane id inherits " +
    "built-in studies from the pane that used to hold it");
});

test("a pane's built-in studies are scoped and released exactly like its Pine ones", () => {
  const store = installStorage();
  try {
    saveStoredNative([nativeStudy("n1", "rsi")], "p1");
    saveStoredNative([nativeStudy("n2", "macd")], "p2");
    assert.equal(loadStoredNative("p1")[0]!.defId, "rsi");
    assert.equal(loadStoredNative("p2")[0]!.defId, "macd");

    // The first pane keeps the unsuffixed key, so an existing user's chart
    // reads exactly the entry it wrote before panes had scopes.
    assert.equal(nativeStorageKey("p1"), "tv.nativeStudies.v1");
    assert.equal(nativeStorageKey("p2"), "tv.nativeStudies.v1.p2");

    copyStoredNativeForScope("p1", "p3");
    assert.equal(loadStoredNative("p3")[0]!.defId, "rsi");
    assert.notEqual(loadStoredNative("p3")[0]!.key, loadStoredNative("p1")[0]!.key,
      "a clone gets its own instance keys, or the two panes would share a legend row");

    clearStoredNative("p2");
    assert.deepEqual(loadStoredNative("p2"), []);
    assert.equal(store.has("tv.nativeStudies.v1.p2"), false);
    assert.equal(loadStoredNative("p1").length, 1, "closing one pane emptied another");
  } finally { uninstallStorage(); }
});

test("a stored built-in study that this build does not have is dropped, not fatal", () => {
  const store = installStorage();
  try {
    store.set("tv.nativeStudies.v1", JSON.stringify([
      { key: "a", defId: "rsi", params: { length: 21 }, visible: true, styles: {} },
      { key: "b", defId: "from_a_later_build", params: {}, visible: true, styles: {} },
      { key: "c", defId: "macd", params: {}, visible: false, styles: { macd: { color: "#fff" } } },
    ]));
    const restored = loadStoredNative("p1");
    assert.deepEqual(restored.map((s) => s.defId), ["rsi", "macd"],
      "losing two good studies because a third named something unknown is the " +
      "worst possible response to a forward-compatible file");
    assert.equal(restored[0]!.params.length, 21, "a stored tuning survives");
    assert.equal(restored[1]!.visible, false, "and so does a hidden study");
    assert.equal(restored[1]!.styles.macd!.color, "#fff", "and so does a style override");
  } finally { uninstallStorage(); }
});

test("a hostile or corrupt stored entry cannot reach a study's arithmetic", () => {
  const store = installStorage();
  try {
    store.set("tv.nativeStudies.v1", JSON.stringify([
      { key: "a", defId: "rsi", params: { length: -5, source: "javascript:" }, visible: true,
        styles: { rsi: { width: 9999 }, notAPlot: { color: "#f00" } } },
    ]));
    const restored = loadStoredNative("p1");
    assert.equal(restored.length, 1);
    assert.ok((restored[0]!.params.length as number) >= 1, "a negative length is clamped");
    assert.equal(restored[0]!.params.source, "close", "an unknown source falls back");
    assert.equal(restored[0]!.styles.rsi!.width, 8, "an absurd width is clamped");
    assert.ok(!("notAPlot" in restored[0]!.styles),
      "an override for a plot this study does not declare is dropped");

    store.set("tv.nativeStudies.v1", "not json at all");
    assert.deepEqual(loadStoredNative("p1"), []);
    store.set("tv.nativeStudies.v1", JSON.stringify({ not: "an array" }));
    assert.deepEqual(loadStoredNative("p1"), []);
  } finally { uninstallStorage(); }
});

// ── drawings belong to the instrument ──────────────────────────────────────

test("DRAWINGS SURVIVE LAYOUT, MAXIMISE AND PANE REMOVAL", () => {
  installStorage();
  try {
    saveDrawings("SOLUSDT", [drawing("d1", 100), drawing("d2", 200)]);
    saveDrawings("BTCUSDT", [drawing("d3", 60_000)]);

    // Nothing in the workspace model can reach the drawing store: these are
    // separate authorities, keyed on different things.
    let ws = setPaneCount(createWorkspace({ symbol: "SOLUSDT", interval: "15m" }), 4);
    ws = updatePane(ws, "p2", { symbol: "BTCUSDT" });
    ws = maximizePane(ws, "p2");
    ws = restoreLayout(ws);
    ws = setPaneCount(ws, 2);
    ws = removePane(ws, "p2");
    assert.equal(ws.panes.length, 1);

    assert.equal(loadDrawings("SOLUSDT").length, 2, "a layout change deleted drawings");
    assert.equal(loadDrawings("BTCUSDT").length, 1,
      "closing the only pane on an instrument deleted its drawings");
  } finally { uninstallStorage(); }
});

test("two panes on one instrument read one drawing list", () => {
  installStorage();
  try {
    saveDrawings("SOLUSDT", [drawing("d1", 100)]);
    // Both panes ask the same authority with the same key, so there is no
    // second copy that could be written last and win.
    assert.deepEqual(loadDrawings("SOLUSDT"), loadDrawings("SOLUSDT"));
    saveDrawings("SOLUSDT", [drawing("d1", 100), drawing("d2", 150)]);
    assert.equal(loadDrawings("SOLUSDT").length, 2);
    // Synchronisation cannot duplicate them: a synced symbol change just puts
    // two panes on one key.
    assert.equal(loadDrawings("SOLUSDT").filter((d) => d.id === "d1").length, 1);
  } finally { uninstallStorage(); }
});

test("the drawing store is one authority that panes subscribe to", () => {
  const store = read("lib/drawingStore.ts");
  const pane = read("components/tv/ChartPane.tsx");
  assert.match(pane, /drawingStore\.subscribe\(pane\.symbol, setDrawings\)/);
  assert.match(pane, /drawingStore\.set\(pane\.symbol, next, gesture \?\? null\)/,
    "the pane forwards the canvas's gesture id, so one drag is one undo step " +
    "rather than sixty");
  // Memory is updated synchronously for the canvas; the disk write is
  // coalesced, because the old path wrote every symbol's drawings to
  // localStorage on every mousemove of a drag.
  assert.match(store, /schedulePersist\(\)/);
  assert.match(store, /"pagehide"/);
  // Comments stripped: the digest's own docstring quotes the call it replaced.
  const canvas = read("components/tv/DrawingCanvas.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(!/JSON\.stringify\(drawings/.test(canvas),
    "the render loop is serialising every anchor again");
  assert.match(canvas, /geometryDigest\(drawings\)/);
});

// ── replay is one clock ────────────────────────────────────────────────────

test("REPLAY IS ONE WORKSPACE CLOCK, AND NO PANE OUTRUNS IT", () => {
  const bars = candles(50);
  const session = startReplay(bars, bars[20]!.closeTime, bars[49]!.closeTime + 1);
  assert.ok(session, "replay could not start on a completed bar");

  // Every pane clips the same series with the same session, so two panes can
  // never be at different moments — the V1 invariant.
  const shown = replayCandles(bars, session);
  assert.equal(shown.length, 21);
  assert.equal(shown[shown.length - 1]!.openTime, bars[20]!.openTime);
  assert.deepEqual(replayCandles(bars, session), shown);

  // Stepping forward moves the one horizon; nothing beyond it is reachable.
  const stepped = stepReplay(session, bars, 1);
  assert.equal(replayCandles(bars, stepped).length, 22);
  assert.equal(lastBarIndexAtOrBefore(bars, stepped.horizonCloseTime), 21);

  // The frozen ceiling is what stops replay rolling into live data.
  let advanced: ReplaySession = stepped;
  for (let i = 0; i < 200; i++) advanced = stepReplay(advanced, bars, 1);
  assert.ok(advanced.horizonCloseTime <= advanced.availableThroughCloseTime);
  assert.ok(replayCandles(bars, advanced).length <= bars.length);

  // Live-only actions stay disabled for the whole workspace, not per pane.
  assert.equal(liveActionsDisabled(session), true);
  assert.equal(liveActionsDisabled(null), false);
});

test("replay drawings are a session overlay, never written over the real ones", () => {
  const persisted = [drawing("d1", 100)];
  const inSession = [drawing("d2", 200)];
  const session = startReplay(candles(10), candles(10)[5]!.closeTime, Date.now());
  assert.ok(session);
  assert.deepEqual(drawingsAtReplayHorizon(null, persisted, inSession), persisted);
  assert.deepEqual(drawingsAtReplayHorizon(session, persisted, inSession), inSession);
});

test("every pane is handed the same replay session and goes offline with it", () => {
  const page = read("app/chart/page.tsx");
  const pane = read("components/tv/ChartPane.tsx");
  // One session object, passed to every pane by the same render callback.
  assert.match(page, /replay=\{replay\}/);
  assert.equal((page.match(/const \[replay, setReplay\]/g) ?? []).length, 1,
    "there is more than one replay clock in the workspace");
  // A pane clips to it and disconnects its live feed while it is set.
  assert.match(pane, /replayCandles\(history\.candles, replay\)/);
  assert.match(pane, /live=\{!replayActive\}/);
  assert.match(pane, /onLiveBarBoundary=\{replayActive \? undefined : liveBarBoundary\}/);
});
