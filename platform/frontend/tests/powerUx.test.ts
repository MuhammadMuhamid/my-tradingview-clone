/**
 * The power-user layer: menus, shortcuts, and drawing history.
 *
 * ── What is worth asserting ────────────────────────────────────────────────
 *
 * Every rule here is one that is invisible until it is wrong, and wrong in a
 * way that costs the user something:
 *
 *   a menu that opens off-screen, or that scrolls the chart to fit;
 *   a keyboard cursor that lands on a disabled item, or on a separator;
 *   a menu that opens with "Remove" under the cursor, where a reflexive Enter
 *     deletes the thing that was just right-clicked;
 *   a shortcut that fires while the user is typing a strategy name;
 *   Cmd+Z undoing a drawing while the Pine editor has focus;
 *   an undo that rewinds three pixels of a drag instead of the drag;
 *   an undo on one instrument that restores a drawing deleted on another.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  focusableIndices, initialMenuCursor, isSeparator, moveMenuCursor, placeMenu,
  tidyEntries, type MenuEntry,
} from "../lib/contextMenu";
import {
  appendIntervalKey, BINDINGS, EMPTY_INTERVAL_BUFFER, isTypingTarget,
  resolveShortcut, resolveTypedInterval,
} from "../lib/shortcuts";
import {
  chartMenu, drawingMenu, priceAxisMenu, studyMenu, watchlistMenu,
} from "../lib/menuPayloads";
import {
  cloneDrawing, DrawingHistory, historyScope, MAX_HISTORY, MAX_SCOPES, sameDrawings,
} from "../lib/drawingHistory";
import { INTERVAL_VALUES } from "../lib/types";
import type { Drawing } from "../lib/drawings";

// ── placement ───────────────────────────────────────────────────────────────

const VIEWPORT = { viewportWidth: 1000, viewportHeight: 800 };

test("a menu with room opens down and right of the pointer", () => {
  const placed = placeMenu({ x: 100, y: 100, width: 200, height: 300, ...VIEWPORT });
  assert.deepEqual(placed, { left: 100, top: 100, flippedX: false, flippedY: false });
});

test("a menu without room FLIPS back across the pointer rather than sliding", () => {
  // Near the bottom-right corner: both axes have to flip.
  const placed = placeMenu({ x: 950, y: 760, width: 200, height: 300, ...VIEWPORT });
  assert.equal(placed.flippedX, true);
  assert.equal(placed.flippedY, true);
  assert.equal(placed.left, 750, "opens leftwards from the pointer");
  assert.equal(placed.top, 460, "and upwards");
  // Sliding instead of flipping would put the pointer in the MIDDLE of the
  // menu, so the item under the cursor on release is one nobody aimed at.
  assert.ok(placed.left + 200 <= 1000 && placed.top + 300 <= 800);
});

test("a menu too large to fit either way is clamped inside the viewport", () => {
  // Taller than the space above the pointer AND below it, so flipping cannot
  // help and the only correct answer is to clamp.
  const placed = placeMenu({ x: 20, y: 780, width: 200, height: 790, ...VIEWPORT });
  assert.equal(placed.flippedY, false, "there was no room to flip into either");
  assert.ok(placed.top >= 8, "never above the top edge");
  assert.ok(placed.left >= 8);

  // And when there IS room above, flipping is preferred to clamping — the
  // pointer stays at the menu's edge rather than in its middle.
  const flipped = placeMenu({ x: 20, y: 780, width: 200, height: 700, ...VIEWPORT });
  assert.equal(flipped.flippedY, true);
  assert.equal(flipped.top, 80);
});

test("a menu is never placed so that the page has to scroll to show it", () => {
  for (const [x, y] of [[0, 0], [999, 799], [500, 799], [999, 400]]) {
    const placed = placeMenu({ x: x!, y: y!, width: 260, height: 400, ...VIEWPORT });
    assert.ok(placed.left >= 0 && placed.top >= 0);
    assert.ok(placed.left + 260 <= 1000 + 8, `x=${x} y=${y} overflowed right`);
    assert.ok(placed.top + 400 <= 800 + 8, `x=${x} y=${y} overflowed bottom`);
  }
});

// ── keyboard navigation inside a menu ──────────────────────────────────────

const MENU: MenuEntry[] = [
  { id: "a", label: "A" },
  { id: "b", label: "B", disabled: true },
  { id: "sep", separator: true },
  { id: "c", label: "C" },
  { id: "d", label: "D", destructive: true },
];

test("the cursor moves through enabled items only, skipping separators", () => {
  assert.deepEqual(focusableIndices(MENU), [0, 3, 4]);
  assert.equal(moveMenuCursor(MENU, 0, "ArrowDown"), 3, "B is disabled and sep is not an item");
  assert.equal(moveMenuCursor(MENU, 3, "ArrowDown"), 4);
  assert.equal(moveMenuCursor(MENU, 4, "ArrowDown"), 0, "wraps, like every native menu");
  assert.equal(moveMenuCursor(MENU, 0, "ArrowUp"), 4);
  assert.equal(moveMenuCursor(MENU, 3, "Home"), 0);
  assert.equal(moveMenuCursor(MENU, 0, "End"), 4);
});

test("a menu with nothing selectable reports -1 rather than a phantom row", () => {
  const dead: MenuEntry[] = [{ id: "x", label: "X", disabled: true }, { id: "s", separator: true }];
  assert.equal(moveMenuCursor(dead, 0, "ArrowDown"), -1);
  assert.equal(initialMenuCursor(dead), -1);
});

test("a menu never opens with a destructive item under the cursor", () => {
  const dangerFirst: MenuEntry[] = [
    { id: "remove", label: "Remove", destructive: true },
    { id: "settings", label: "Settings…" },
  ];
  assert.equal(initialMenuCursor(dangerFirst), 1,
    "a reflexive Enter must not delete the thing that was just right-clicked");
  assert.equal(initialMenuCursor(MENU), 0);
});

test("leading, trailing and doubled separators are dropped as meaningless", () => {
  const messy: MenuEntry[] = [
    { id: "s1", separator: true },
    { id: "a", label: "A" },
    { id: "s2", separator: true },
    { id: "s3", separator: true },
    { id: "b", label: "B" },
    { id: "s4", separator: true },
  ];
  const tidy = tidyEntries(messy);
  assert.deepEqual(tidy.map((e) => e.id), ["a", "s2", "b"]);
  assert.ok(!isSeparator(tidy[0]!) && !isSeparator(tidy[tidy.length - 1]!));
});

// ── what each menu offers, and refuses ─────────────────────────────────────

const byId = (entries: MenuEntry[], id: string): MenuEntry | undefined =>
  entries.find((e) => e.id === id);

test("an action that cannot be taken is disabled with a reason, never hidden", () => {
  const replay = chartMenu({
    price: 100, replayActive: true, autoScale: true, logScale: false,
    hasDrawings: true, drawingsHidden: false, drawingsLocked: false, tradingEnabled: true,
  });
  for (const id of ["add-alert", "trade-at-price"]) {
    const item = byId(replay, id)!;
    assert.ok(item, `${id} must be present even when it cannot be used`);
    assert.equal((item as { disabled?: boolean }).disabled, true);
    assert.match((item as { disabledReason?: string }).disabledReason ?? "", /Replay/,
      "a greyed item with no explanation is a mystery");
  }
  // Copying a price is not an action on the market, so Replay does not block it.
  assert.notEqual((byId(replay, "copy-price") as { disabled?: boolean }).disabled, true);
});

test("the chart menu prepares an order and never submits one", () => {
  const menu = chartMenu({
    price: 100, replayActive: false, autoScale: true, logScale: false,
    hasDrawings: false, drawingsHidden: false, drawingsLocked: false, tradingEnabled: true,
  });
  const trade = byId(menu, "trade-at-price")!;
  assert.match((trade as { label: string }).label, /Prepare/,
    "a one-click order from a context menu would cross the alerts-never-trade line");
  assert.match((trade as { hint?: string }).hint ?? "", /ticket/);
  for (const item of menu) {
    if (isSeparator(item)) continue;
    assert.doesNotMatch(item.label, /\b(buy|sell|submit|place order)\b/i,
      `"${item.label}" reads as an order, not a preparation`);
  }
});

test("the chart menu offers no control it cannot justify", () => {
  const menu = chartMenu({
    price: null, replayActive: false, autoScale: false, logScale: true,
    hasDrawings: false, drawingsHidden: false, drawingsLocked: false, tradingEnabled: false,
  });
  const labels = menu.filter((e) => !isSeparator(e)).map((e) => (e as { label: string }).label);
  assert.ok(!labels.some((l) => /invert/i.test(l)),
    "a chart control whose only justification is that another product has one");
  // With no price under the pointer the price actions say why they are off.
  assert.match((byId(menu, "copy-price") as { disabledReason?: string }).disabledReason ?? "",
    /Right-click on the chart/);
  // Toggles reflect the CURRENT state rather than what they would do.
  assert.equal((byId(menu, "toggle-log") as { checked?: boolean }).checked, true);
  assert.equal((byId(menu, "toggle-auto") as { checked?: boolean }).checked, false);
  // And with nothing drawn, the drawing toggles say so rather than doing nothing.
  assert.equal((byId(menu, "toggle-drawings-hidden") as { disabled?: boolean }).disabled, true);
});

test("a locked drawing refuses the edits that would change it", () => {
  const locked = drawingMenu({
    locked: true, hidden: false, alertable: true, replayActive: false, canReorder: true,
  });
  for (const id of ["clone", "remove"]) {
    assert.equal((byId(locked, id) as { disabled?: boolean }).disabled, true, id);
  }
  // Unlocking is exactly what a locked drawing's menu must still offer.
  assert.notEqual((byId(locked, "toggle-lock") as { disabled?: boolean }).disabled, true);
  assert.equal((byId(locked, "toggle-lock") as { checked?: boolean }).checked, true);
});

test("only a level can carry a price alert, and not during Replay", () => {
  const notLevel = drawingMenu({
    locked: false, hidden: false, alertable: false, replayActive: false, canReorder: true,
  });
  assert.match((byId(notLevel, "add-alert") as { disabledReason?: string }).disabledReason ?? "",
    /horizontal level/);
  const inReplay = drawingMenu({
    locked: false, hidden: false, alertable: true, replayActive: true, canReorder: true,
  });
  assert.match((byId(inReplay, "add-alert") as { disabledReason?: string }).disabledReason ?? "",
    /Replay/);
});

test("a built-in study has no source to open, and says so", () => {
  const builtin = studyMenu({ visible: true, first: true, last: false, hasSource: false });
  const open = byId(builtin, "open-source")!;
  assert.equal((open as { disabled?: boolean }).disabled, true);
  assert.match((open as { disabledReason?: string }).disabledReason ?? "", /built-in/i);
  assert.equal((byId(builtin, "move-up") as { disabled?: boolean }).disabled, true,
    "the first study has nothing above it");
  assert.notEqual((byId(builtin, "move-down") as { disabled?: boolean }).disabled, true);

  const pine = studyMenu({ visible: false, first: false, last: true, hasSource: true });
  assert.notEqual((byId(pine, "open-source") as { disabled?: boolean }).disabled, true);
  assert.equal((byId(pine, "toggle-visible") as { checked?: boolean }).checked, false);
});

test("the price axis and watchlist menus state their own preconditions", () => {
  const axis = priceAxisMenu({ autoScale: true, logScale: false });
  assert.equal((byId(axis, "toggle-auto") as { checked?: boolean }).checked, true);
  assert.ok(byId(axis, "reset"));

  const full = watchlistMenu({ symbol: "SOLUSDT", replayActive: false, canOpenNewPane: false });
  assert.match((byId(full, "open-new-pane") as { disabledReason?: string }).disabledReason ?? "",
    /maximum number of panes/);
  assert.match((byId(full, "add-alert") as { label: string }).label, /SOLUSDT/,
    "the row's own symbol, so the action is not ambiguous in a long list");
});

// ── the typing guard ───────────────────────────────────────────────────────

const CONTEXT = { mac: true, replayActive: false };
const key = (over: Partial<Parameters<typeof resolveShortcut>[0]> = {}) => ({
  key: "t", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over,
});

test("no shortcut fires while the user is typing, in any kind of field", () => {
  for (const target of [
    { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "DIV", closestEditor: true },
  ]) {
    assert.equal(isTypingTarget(target), true, JSON.stringify(target));
    assert.equal(resolveShortcut(key({ target }), CONTEXT), null,
      "a `t` taken from the middle of a strategy name is a keystroke the user " +
      "has to notice is missing");
    assert.equal(resolveShortcut(key({ key: "z", metaKey: true, target }), CONTEXT), null,
      "Cmd+Z in the editor must undo the EDITOR, not a chart the user is not looking at");
  }
});

test("an unknown or missing target counts as not typing, so the layer keeps working", () => {
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(undefined), false);
  assert.equal(isTypingTarget({ tagName: "CANVAS" }), false);
  assert.equal(resolveShortcut(key({ target: { tagName: "CANVAS" } }), CONTEXT), "tool:trend");
});

test("the platform modifier is honoured, and a foreign one is left to the browser", () => {
  assert.equal(resolveShortcut(key({ key: "z", metaKey: true }), { mac: true, replayActive: false }),
    "undo");
  assert.equal(resolveShortcut(key({ key: "z", ctrlKey: true }), { mac: true, replayActive: false }),
    null, "Ctrl+Z on a Mac is not this app's undo");
  assert.equal(resolveShortcut(key({ key: "z", ctrlKey: true }), { mac: false, replayActive: false }),
    "undo");
  // Alt combinations belong to the browser and the OS: Alt+← is Back.
  assert.equal(resolveShortcut(key({ key: "ArrowLeft", altKey: true }),
    { mac: true, replayActive: true }), null);
  // A bare tool letter arriving with the modifier held is a browser command.
  assert.equal(resolveShortcut(key({ key: "t", metaKey: true }), CONTEXT), null,
    "Cmd+T opens a browser tab; taking it would be hostile");
});

test("Replay keys are inert outside Replay, so Space still scrolls the page", () => {
  for (const k of ["ArrowLeft", "ArrowRight", " "]) {
    assert.equal(resolveShortcut(key({ key: k }), { mac: true, replayActive: false }), null);
  }
  assert.equal(resolveShortcut(key({ key: " " }), { mac: true, replayActive: true }),
    "replay-play-pause");
  assert.equal(resolveShortcut(key({ key: "ArrowLeft" }), { mac: true, replayActive: true }),
    "replay-step-back");
});

test("both redo bindings resolve, and every binding is reachable", () => {
  assert.equal(resolveShortcut(key({ key: "z", metaKey: true, shiftKey: true }), CONTEXT), "redo");
  assert.equal(resolveShortcut(key({ key: "y", metaKey: true }), CONTEXT), "redo");
  for (const binding of BINDINGS) {
    const resolved = resolveShortcut(
      key({
        key: binding.key, metaKey: binding.mod === true, shiftKey: binding.shift === true,
      }),
      { mac: true, replayActive: true });
    assert.ok(resolved !== null, `${binding.label} (${binding.key}) resolves to nothing`);
  }
});

// ── typed intervals ────────────────────────────────────────────────────────

test("typing a number and pressing Enter resolves only a served timeframe", () => {
  const now = 1_000_000;
  let buffer = EMPTY_INTERVAL_BUFFER;
  for (const k of ["1", "5"]) buffer = appendIntervalKey(buffer, k, now);
  assert.equal(buffer.text, "15");
  assert.equal(resolveTypedInterval(buffer, INTERVAL_VALUES, now), "15m");

  // 60 minutes is an hour; 240 is four hours. That shorthand is the point of
  // allowing a bare number at all.
  assert.equal(resolveTypedInterval({ text: "60", at: now }, INTERVAL_VALUES, now), "1h");
  assert.equal(resolveTypedInterval({ text: "240", at: now }, INTERVAL_VALUES, now), "4h");
  assert.equal(resolveTypedInterval({ text: "1d", at: now }, INTERVAL_VALUES, now), "1d");
  assert.equal(resolveTypedInterval({ text: "4h", at: now }, INTERVAL_VALUES, now), "4h");

  // An interval this installation does not serve resolves to nothing rather
  // than to the nearest one — picking a timeframe nobody asked for is worse
  // than doing nothing.
  assert.equal(resolveTypedInterval({ text: "7", at: now }, INTERVAL_VALUES, now), null);
  assert.equal(resolveTypedInterval({ text: "7m", at: now }, INTERVAL_VALUES, now), null);
  assert.equal(resolveTypedInterval({ text: "99h", at: now }, INTERVAL_VALUES, now), null);
});

test("the buffer times out, so a number typed a minute ago is not still waiting", () => {
  const now = 1_000_000;
  const stale = { text: "15", at: now - 5_000 };
  assert.equal(resolveTypedInterval(stale, INTERVAL_VALUES, now), null);
  // And a keystroke after the timeout starts a new entry rather than appending.
  assert.equal(appendIntervalKey(stale, "3", now).text, "3");
  assert.equal(appendIntervalKey({ text: "1", at: now }, "5", now + 100).text, "15");
  // Keys that cannot be part of an interval are refused outright.
  assert.equal(appendIntervalKey(EMPTY_INTERVAL_BUFFER, "q", now), EMPTY_INTERVAL_BUFFER);
});

// ── drawing history ────────────────────────────────────────────────────────

const line = (id: string, price: number): Drawing => ({
  id, tool: "trend",
  points: [{ time: 1000, price }, { time: 2000, price: price + 1 }],
  style: { color: "#fff", width: 2 },
});

test("undo and redo walk one instrument's edits, and stop at the ends", () => {
  const history = new DrawingHistory();
  history.reset("BTCUSDT", []);
  history.record("BTCUSDT", [line("a", 1)]);
  history.record("BTCUSDT", [line("a", 1), line("b", 2)]);
  assert.equal(history.state("BTCUSDT").canUndo, true);

  assert.deepEqual(history.undo("BTCUSDT")!.map((d) => d.id), ["a"]);
  assert.deepEqual(history.undo("BTCUSDT")!.map((d) => d.id), []);
  assert.equal(history.undo("BTCUSDT"), null, "nothing before the start");
  assert.deepEqual(history.redo("BTCUSDT")!.map((d) => d.id), ["a"]);
  assert.deepEqual(history.redo("BTCUSDT")!.map((d) => d.id), ["a", "b"]);
  assert.equal(history.redo("BTCUSDT"), null);
});

test("a drag is one undo step rather than sixty", () => {
  const history = new DrawingHistory();
  history.reset("BTCUSDT", [line("a", 1)]);
  // Sixty pointer samples, all tagged with the same gesture.
  for (let i = 1; i <= 60; i++) history.record("BTCUSDT", [line("a", 1 + i)], "drag:a:1");
  assert.equal(history.state("BTCUSDT").depth, 1,
    "undo must rewind the drag, not three pixels of it");
  assert.deepEqual(history.undo("BTCUSDT")!.map((d) => d.points[0]!.price), [1]);

  // Letting go and dragging again is a second step.
  history.record("BTCUSDT", [line("a", 5)], "drag:a:1");
  history.record("BTCUSDT", [line("a", 9)], "drag:a:2");
  assert.equal(history.undo("BTCUSDT")!.map((d) => d.points[0]!.price)[0], 5);
});

test("undo is per instrument, so it cannot reach a chart the user is not looking at", () => {
  const history = new DrawingHistory();
  history.reset("BTCUSDT", [line("btc", 1)]);
  history.reset("ETHUSDT", [line("eth", 2)]);
  history.record("BTCUSDT", []);
  history.record("ETHUSDT", []);
  assert.deepEqual(history.undo("ETHUSDT")!.map((d) => d.id), ["eth"]);
  assert.deepEqual(history.undo("BTCUSDT")!.map((d) => d.id), ["btc"],
    "each instrument's stack is its own");
  // Replay drawings are session-scoped and get their own stack entirely.
  assert.notEqual(historyScope("BTCUSDT", true), historyScope("BTCUSDT", false));
});

test("a new edit invalidates the redo branch, because there is no tree here", () => {
  const history = new DrawingHistory();
  history.reset("S", []);
  history.record("S", [line("a", 1)]);
  history.record("S", [line("a", 1), line("b", 2)]);
  history.undo("S");
  assert.equal(history.state("S").canRedo, true);
  history.record("S", [line("a", 1), line("c", 3)]);
  assert.equal(history.state("S").canRedo, false,
    "a redo that jumped to a state the current one did not come from would be " +
    "a different document");
});

test("recording an identical list is not an edit", () => {
  const history = new DrawingHistory();
  history.reset("S", [line("a", 1)]);
  history.record("S", [line("a", 1)]);
  assert.equal(history.state("S").canUndo, false,
    "a pointer sample that moved an anchor by zero pixels is not an edit");
  assert.equal(sameDrawings([line("a", 1)], [line("a", 1)]), true);
  assert.equal(sameDrawings([line("a", 1)], [line("a", 2)]), false);
  assert.equal(sameDrawings([line("a", 1)], []), false);
});

test("loading a symbol's drawings is not undoable", () => {
  const history = new DrawingHistory();
  history.record("S", [line("a", 1)]);
  history.reset("S", [line("a", 1), line("b", 2)]);
  assert.equal(history.state("S").canUndo, false,
    "the first Cmd+Z after opening a chart must not undo the arrival of the " +
    "user's own saved drawings");
});

test("history is bounded in depth and in breadth", () => {
  const history = new DrawingHistory();
  history.reset("S", []);
  for (let i = 0; i < MAX_HISTORY * 3; i++) history.record("S", [line(`d${i}`, i)]);
  assert.equal(history.state("S").depth, MAX_HISTORY);

  for (let i = 0; i < MAX_SCOPES * 2; i++) history.record(`SYM${i}`, [line("x", i)]);
  assert.ok(history.scopeCount <= MAX_SCOPES,
    "a session that visits forty symbols must not hold forty stacks");
});

test("a clone is offset in chart units, so it is visibly a copy at any zoom", () => {
  const original = line("a", 100);
  let n = 0;
  const copy = cloneDrawing(original, () => `new${++n}`, 60, 2);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.locked, false, "a clone of a locked drawing is editable");
  assert.deepEqual(copy.points.map((p) => p.time), [1000 + 120, 2000 + 120],
    "offset in BARS, because a pixel offset means a different distance at " +
    "every zoom level");
  assert.deepEqual(copy.points.map((p) => p.price), original.points.map((p) => p.price));
  assert.notEqual(copy.style, original.style, "the style is copied, not shared");
});

// ── the wiring ──────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("there is exactly one keyboard listener and one menu, wired at the workspace", () => {
  const page = read("app/chart/page.tsx");
  assert.match(page, /useShortcuts\(/, "the workspace owns the keyboard");
  assert.match(page, /<ContextMenu/, "and the one menu");
  assert.match(page, /chartMenu\(\{/);
  assert.match(page, /drawingMenu\(\{/);

  // No component may grow its own global key listener beside the layer.
  const canvas = read("components/tv/DrawingCanvas.tsx");
  assert.match(canvas, /el\.tagName === "INPUT"/,
    "the canvas's own Escape/Delete handler keeps its typing guard");
});

test("the shortcuts sheet is generated from the table that implements the keys", () => {
  const sheet = read("components/tv/ShortcutsSheet.tsx");
  assert.match(sheet, /import \{ BINDINGS/,
    "a hand-written list advertises keys that do nothing within two changes");
  assert.match(sheet, /mac \? "⌘" : "Ctrl"/,
    "a sheet that says Ctrl+Z on a Mac names a combination that does nothing");
});
