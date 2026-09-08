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
  CHART_MENU_IDS, DRAWING_MENU_IDS, STUDY_MENU_IDS, AXIS_MENU_IDS, WATCHLIST_MENU_IDS,
} from "../lib/menuPayloads";
import {
  cloneDrawing, DrawingHistory, historyScope, MAX_HISTORY, MAX_SCOPES, sameDrawings,
} from "../lib/drawingHistory";
import {
  closeAllPopovers, closePopover, currentPopover, openPopover, resetPopovers,
  subscribePopovers,
} from "../lib/popoverGroup";
import { INTERVAL_VALUES } from "../lib/types";
import type { Drawing } from "../lib/drawings";

// ── placement ───────────────────────────────────────────────────────────────

const VIEWPORT = { viewportWidth: 1000, viewportHeight: 800 };

test("a menu with room opens down and right of the pointer", () => {
  const placed = placeMenu({ x: 100, y: 100, width: 200, height: 300, ...VIEWPORT });
  assert.deepEqual(placed, {
    left: 100, top: 100, flippedX: false, flippedY: false, maxHeight: 692,
  });
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

/**
 * A menu taller than the viewport must be SCROLLABLE, not silently cut off.
 *
 * Clamping alone put the panel's top at the margin and left the rest below the
 * fold, with `overflow-hidden` and no bound — so the chart menu's last items
 * were unreachable in a short window, and arrowing moved the cursor onto items
 * that were not on screen. The placement now reports the height it could give,
 * and the panel scrolls inside it.
 */
test("a menu taller than the viewport is bounded and scrollable", () => {
  const tall = placeMenu({ x: 20, y: 400, width: 200, height: 900, ...VIEWPORT });
  assert.equal(tall.top, 8, "clamped to the top margin, because nothing fits");
  assert.equal(tall.maxHeight, 800 - 8 - 8, "and bounded by what is left below it");
  assert.ok(tall.maxHeight <= 784);

  // A menu that fits is never given less room than it needs.
  const short = placeMenu({ x: 20, y: 100, width: 200, height: 200, ...VIEWPORT });
  assert.ok(short.maxHeight >= 200);

  // The panel applies it, with a scroll rather than a clip.
  const component = read("components/tv/ContextMenu.tsx");
  assert.match(component, /maxHeight: placement \? placement\.maxHeight : undefined/);
  assert.match(component, /overflow-y-auto/);
  assert.doesNotMatch(component, /overflow-hidden/,
    "a fixed panel cannot be scrolled by the page, so a clip loses the items");
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
    price: 100, priceLabel: "100.00", replayActive: true, autoScale: true, logScale: false,
    hasDrawings: true, drawingsHidden: false, drawingsLocked: false, tradingEnabled: true, candlePatterns: false,
  });
  for (const id of ["chart:add-alert", "chart:trade-at-price"]) {
    const item = byId(replay, id)!;
    assert.ok(item, `${id} must be present even when it cannot be used`);
    assert.equal((item as { disabled?: boolean }).disabled, true);
    assert.match((item as { disabledReason?: string }).disabledReason ?? "", /Replay/,
      "a greyed item with no explanation is a mystery");
  }
  // Copying a price is not an action on the market, so Replay does not block it.
  assert.notEqual((byId(replay, "chart:copy-price") as { disabled?: boolean }).disabled, true);
});

test("the chart menu prepares an order and never submits one", () => {
  const menu = chartMenu({
    price: 100, priceLabel: "100.00", replayActive: false, autoScale: true, logScale: false,
    hasDrawings: false, drawingsHidden: false, drawingsLocked: false, tradingEnabled: true, candlePatterns: false,
  });
  const trade = byId(menu, "chart:trade-at-price")!;
  assert.match((trade as { label: string }).label, /Prepare/,
    "a one-click order from a context menu would cross the alerts-never-trade line");
  assert.match((trade as { hint?: string }).hint ?? "", /ticket/);
  for (const item of menu) {
    if (isSeparator(item)) continue;
    assert.doesNotMatch(item.label, /\b(buy|sell|submit|place order)\b/i,
      `"${item.label}" reads as an order, not a preparation`);
  }
});

test("an item that acts on a price names the price", () => {
  /*
   * Confirmed against live TradingView Premium, which writes "Add alert on
   * ETHUSDT at 2,500.26…" and "Copy price 2,500.26". The value is already in
   * hand when the payload is built, and "at this price" leaves the user to
   * work out which price the menu opened at — on the one item whose entire
   * purpose is a specific number.
   */
  const menu = chartMenu({
    price: 64_123.5, priceLabel: "64,123.50", replayActive: false,
    autoScale: true, logScale: false, hasDrawings: false,
    drawingsHidden: false, drawingsLocked: false, tradingEnabled: true,
    candlePatterns: false,
  });
  assert.equal((byId(menu, "chart:copy-price") as { label: string }).label,
    "Copy price 64,123.50");
  assert.equal((byId(menu, "chart:add-alert") as { label: string }).label,
    "Add alert at 64,123.50");
  assert.equal((byId(menu, "chart:trade-at-price") as { label: string }).label,
    "Prepare an order at 64,123.50");

  // With no price under the pointer there is no number to name, and the items
  // fall back to their bare form rather than saying "at ".
  const noPrice = chartMenu({
    price: null, priceLabel: "", replayActive: false,
    autoScale: true, logScale: false, hasDrawings: false,
    drawingsHidden: false, drawingsLocked: false, tradingEnabled: true,
    candlePatterns: false,
  });
  assert.equal((byId(noPrice, "chart:copy-price") as { label: string }).label, "Copy price");
  assert.equal((byId(noPrice, "chart:add-alert") as { label: string }).label, "Add alert");
  for (const entry of noPrice) {
    if (isSeparator(entry)) continue;
    assert.doesNotMatch(entry.label, /\bat\s*$/, `"${entry.label}" trails an empty price`);
  }
});

test("the chart menu offers no control it cannot justify", () => {
  const menu = chartMenu({
    price: null, priceLabel: "", replayActive: false, autoScale: false, logScale: true,
    hasDrawings: false, drawingsHidden: false, drawingsLocked: false, tradingEnabled: false, candlePatterns: false,
  });
  const labels = menu.filter((e) => !isSeparator(e)).map((e) => (e as { label: string }).label);
  assert.ok(!labels.some((l) => /invert/i.test(l)),
    "a chart control whose only justification is that another product has one");
  // With no price under the pointer the price actions say why they are off.
  assert.match((byId(menu, "chart:copy-price") as { disabledReason?: string }).disabledReason ?? "",
    /Right-click on the chart/);
  // Toggles reflect the CURRENT state rather than what they would do.
  assert.equal((byId(menu, "chart:toggle-log") as { checked?: boolean }).checked, true);
  assert.equal((byId(menu, "chart:toggle-auto") as { checked?: boolean }).checked, false);
  // And with nothing drawn, the drawing toggles say so rather than doing nothing.
  assert.equal((byId(menu, "chart:toggle-drawings-hidden") as { disabled?: boolean }).disabled, true);
});

test("a locked drawing refuses the edits that would change it", () => {
  const locked = drawingMenu({
    locked: true, hidden: false, alertable: true, replayActive: false, canReorder: true, mac: true,
  });
  for (const id of ["drawing:clone", "drawing:remove"]) {
    assert.equal((byId(locked, id) as { disabled?: boolean }).disabled, true, id);
  }
  // Unlocking is exactly what a locked drawing's menu must still offer.
  assert.notEqual((byId(locked, "drawing:toggle-lock") as { disabled?: boolean }).disabled, true);
  assert.equal((byId(locked, "drawing:toggle-lock") as { checked?: boolean }).checked, true);
});

test("only a level can carry a price alert, and not during Replay", () => {
  const notLevel = drawingMenu({
    locked: false, hidden: false, alertable: false, replayActive: false, canReorder: true, mac: true,
  });
  assert.match((byId(notLevel, "drawing:add-alert") as { disabledReason?: string }).disabledReason ?? "",
    /horizontal level/);
  const inReplay = drawingMenu({
    locked: false, hidden: false, alertable: true, replayActive: true, canReorder: true, mac: true,
  });
  assert.match((byId(inReplay, "drawing:add-alert") as { disabledReason?: string }).disabledReason ?? "",
    /Replay/);
});

test("a built-in study has no source to open, and says so", () => {
  const builtin = studyMenu({ visible: true, first: true, last: false, hasSource: false });
  const open = byId(builtin, "study:open-source")!;
  assert.equal((open as { disabled?: boolean }).disabled, true);
  assert.match((open as { disabledReason?: string }).disabledReason ?? "", /built-in/i);
  assert.equal((byId(builtin, "study:move-up") as { disabled?: boolean }).disabled, true,
    "the first study has nothing above it");
  assert.notEqual((byId(builtin, "study:move-down") as { disabled?: boolean }).disabled, true);

  const pine = studyMenu({ visible: false, first: false, last: true, hasSource: true });
  assert.notEqual((byId(pine, "study:open-source") as { disabled?: boolean }).disabled, true);
  assert.equal((byId(pine, "study:toggle-visible") as { checked?: boolean }).checked, false);
});

test("the price axis and watchlist menus state their own preconditions", () => {
  const axis = priceAxisMenu({
    autoScale: true, logScale: false, percentScale: true, indexedScale: false,
    inverted: false,
  });
  assert.equal((byId(axis, "axis:toggle-auto") as { checked?: boolean }).checked, true);
  assert.ok(byId(axis, "axis:reset"));
  /*
   * The axis reads in one of four ways, and the menu must show which. A
   * percent axis whose menu still ticked "Logarithmic scale" would describe a
   * chart nobody is looking at.
   */
  assert.equal((byId(axis, "axis:toggle-percent") as { checked?: boolean }).checked, true);
  assert.equal((byId(axis, "axis:toggle-log") as { checked?: boolean }).checked, false);
  assert.equal((byId(axis, "axis:toggle-indexed") as { checked?: boolean }).checked, false);
  assert.equal((byId(axis, "axis:toggle-invert") as { checked?: boolean }).checked, false);

  const full = watchlistMenu({ symbol: "SOLUSDT", replayActive: false, canOpenNewPane: false });
  assert.match((byId(full, "watchlist:open-new-pane") as { disabledReason?: string }).disabledReason ?? "",
    /maximum number of panes/);
  assert.match((byId(full, "watchlist:add-alert") as { label: string }).label, /SOLUSDT/,
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
    /*
     * The event a keyboard would actually emit.
     *
     * The old version passed `shiftKey: binding.shift === true`, which for the
     * `?` binding synthesised `{ key: "?", shiftKey: false }` — an event no US
     * or UK keyboard produces. The binding was unreachable in the browser and
     * the test said it was fine. A punctuation key is now checked BOTH ways,
     * because which one a layout emits is not ours to assume.
     */
    const shifts = /^[a-z0-9]$/i.test(binding.key) || binding.key.length > 1
      ? [binding.shift === true]
      : [true, false];
    for (const shiftKey of shifts) {
      const resolved = resolveShortcut(
        key({ key: binding.key, metaKey: binding.mod === true, shiftKey }),
        { mac: true, replayActive: true });
      assert.ok(resolved !== null,
        `${binding.label} (${binding.key}${shiftKey ? " with shift" : ""}) resolves to nothing`);
    }
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

  /*
   * The canvas keeps one listener for Escape and Delete, which the workspace
   * deliberately delegates to it — but `DrawingCanvas` mounts once per PANE,
   * so a four-pane layout had four of them and one Delete removed a drawing in
   * every pane that had one selected. Two properties matter now: the inactive
   * panes decline the key, and the guard is the shared one rather than a
   * narrower copy that omitted `<select>` and the editor surface.
   */
  const canvas = read("components/tv/DrawingCanvas.tsx");
  assert.match(canvas, /if \(!activeRef\.current\) return;/,
    "an unfocused pane must not act on Delete");
  assert.match(canvas, /isTypingTarget\(/,
    "the canvas must use the shared typing guard, not a copy of part of it");
  assert.doesNotMatch(canvas, /el\.tagName === "INPUT"/,
    "a second, narrower guard is how the two drift apart");
});

test("the shortcuts sheet is generated from the table that implements the keys", () => {
  const sheet = read("components/tv/ShortcutsSheet.tsx");
  assert.match(sheet, /import \{ BINDINGS/,
    "a hand-written list advertises keys that do nothing within two changes");
  assert.match(sheet, /mac \? "⌘" : "Ctrl"/,
    "a sheet that says Ctrl+Z on a Mac names a combination that does nothing");
});

// ── one popover at a time ──────────────────────────────────────────────────

/**
 * Five menus hang off buttons a few pixels apart in the toolbar, and each used
 * to own its own `open` boolean. Nothing coordinated them, so clicking one
 * while another was open left both on screen, overlapping, with two sets of
 * controls competing for the same clicks.
 */
test("opening one popover closes whichever other one was open", () => {
  resetPopovers();
  assert.equal(currentPopover(), null);
  openPopover("layout-preset");
  assert.equal(currentPopover(), "layout-preset");
  openPopover("pane-sync");
  assert.equal(currentPopover(), "pane-sync", "the previous one is no longer open");

  // Closing one that is not open is a no-op, not a way to close the other.
  closePopover("layout-preset");
  assert.equal(currentPopover(), "pane-sync");
  closePopover("pane-sync");
  assert.equal(currentPopover(), null);

  openPopover("chart-type");
  closeAllPopovers();
  assert.equal(currentPopover(), null);
});

test("subscribers are told which popover is open, so each renders its own state", () => {
  resetPopovers();
  const seen: (string | null)[] = [];
  const stop = subscribePopovers((id) => seen.push(id));
  openPopover("a");
  openPopover("b");
  closePopover("b");
  stop();
  openPopover("c");
  assert.deepEqual(seen, ["a", "b", null], "and nothing after unsubscribing");
});

/**
 * Derived, not listed.
 *
 * The old version iterated a hardcoded list of the four files that HAD been
 * migrated, so the four that had not — the timeframe menu, the drawing
 * flyout, the trading-overlay menu and the nav system menu — could not fail
 * it. The timeframe and chart-type menus sit about forty pixels apart in the
 * same toolbar row and could both be open at once, which is the exact defect
 * the registry was written to remove.
 *
 * Now every popover the registry knows about must be claimed by some source
 * file, and no file may keep a private `open` boolean beside it.
 */
test("every toolbar popover goes through the registry rather than its own state", () => {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (/\.tsx?$/.test(entry.name)) sources.set(rel, read(rel));
    }
  };
  walk("components");
  walk("lib");

  const registered = [...sources.values()]
    .flatMap((source) => [...source.matchAll(/useExclusivePopover\("([^"]+)"\)/g)])
    .map((m) => m[1]!);
  // Every popover this product has, by name. A new one that keeps its own
  // boolean will not appear here — and the check below is what catches it.
  assert.deepEqual([...registered].sort(), [
    "chart-type", "drawing-flyout", "layout-preset", "nav-system", "pane-sync",
    "saved-layouts", "timeframe", "trading-overlays",
  ]);
  assert.equal(new Set(registered).size, registered.length, "two popovers share an id");

  /*
   * And no file may keep a PRIVATE open flag beside a popover menu, which is
   * the shape the defect actually took: `const [open, setOpen] = useState(false)`
   * in a component that renders `role="menu"`. The state may live in the
   * component or in a hook it is given — what it may not do is escape the
   * registry.
   */
  for (const [file, source] of sources) {
    if (!/role="menu"|role="listbox"/.test(source)) continue;
    assert.doesNotMatch(source, /const \[(open|menuOpen|flyout)[^\]]*\] = useState\(false\)/,
      `${file} keeps a private open flag beside a popover menu`);
  }
});

// ── the menus reach something ──────────────────────────────────────────────

/**
 * A menu item that does nothing is worse than one that is not there.
 *
 * Five were: "Reset view", "Auto scale", "Logarithmic scale", the drawing's
 * "Style…" and its "Hide". Each was rendered, enabled, and fell through to a
 * `default:` — precisely what `lib/menuPayloads.ts`'s own header forbids ("an
 * action that cannot be taken is DISABLED with a reason, never hidden").
 *
 * A source assertion because there is no DOM here, and because the failure it
 * catches is structural: an id added to a payload and never answered.
 */
const CHART_PAGE = read("app/chart/page.tsx");

const ALL_MENU_IDS = [
  ...CHART_MENU_IDS, ...DRAWING_MENU_IDS, ...STUDY_MENU_IDS,
  ...AXIS_MENU_IDS, ...WATCHLIST_MENU_IDS,
];

test("every id a menu can emit is answered by a handler", () => {
  // The study and watchlist menus are opened by their own components, so their
  // handlers are there rather than on the chart page.
  const sources = [
    CHART_PAGE,
    read("components/tv/IndicatorsPanel.tsx"),
    read("components/tv/Watchlist.tsx"),
  ].join("\n");
  for (const id of ALL_MENU_IDS) {
    assert.ok(sources.includes(`case "${id}"`),
      `${id} is offered by a menu and reaches no handler — the menu closes and nothing happens`);
  }
});

test("two menus cannot collide on an id", () => {
  // `add-alert` belonged to the chart menu, the drawing menu AND the watchlist
  // menu, and one shared switch ran first: a drawing's "Add alert on this
  // level" armed at the POINTER's price, and the branch that read the
  // drawing's own level was unreachable. Prefixes make the collision
  // impossible rather than fixing the one instance.
  assert.equal(new Set(ALL_MENU_IDS).size, ALL_MENU_IDS.length,
    "two menus share an id, so one handler will answer for both");
  for (const [prefix, ids] of [
    ["chart", CHART_MENU_IDS], ["drawing", DRAWING_MENU_IDS], ["study", STUDY_MENU_IDS],
    ["axis", AXIS_MENU_IDS], ["watchlist", WATCHLIST_MENU_IDS],
  ] as const) {
    for (const id of ids) {
      assert.ok(id.startsWith(`${prefix}:`), `${id} does not name its own menu`);
    }
  }
});

/*
 * "a drawing's add-alert reads the drawing's level, not the pointer's price"
 * used to be here, as two `indexOf` calls over the chart page checking that
 * one `case` label came after another. It could not see whether either branch
 * ran, and it would have passed on a build where the drawing branch was
 * unreachable for a different reason.
 *
 * It is now `tests/dom/contextMenu.test.tsx`, which places a horizontal line,
 * right-clicks four pixels off it, and reads the level the alert dialog was
 * actually pre-filled with.
 */

// ── typed intervals ───────────────────────────────────────────
//
// Three tests used to live here that reproduced `useShortcuts`' decision order
// by hand — a buffer, a table, and the rule that the buffer wins while it is
// open — because the hook could not run without a DOM. That mirror was a test
// of the mirror: it would have kept passing on a build where the hook stopped
// consulting the buffer first, which is the exact defect it existed to catch.
// (`4h` and `15m` became untypable, and typing them silently armed a tool.)
//
// The hook is now pressed for real, at the real page, in
// `tests/dom/keyboard.test.tsx`. The pure table it consults is still tested
// above.

// ── the shortcuts sheet is reachable ───────────────────────────────────────

test("? opens the shortcuts sheet on a layout where ? is shifted", () => {
  // The binding declares no `shift`, and on a US or UK layout `?` IS Shift+`/`
  // — so the real event carries `shiftKey: true` and the binding was
  // unreachable. The discovery surface for the entire keyboard layer could not
  // be opened from the keyboard.
  assert.equal(resolveShortcut(key({ key: "?", shiftKey: true }), CONTEXT), "shortcuts-sheet");
  // And on a layout where it is not shifted.
  assert.equal(resolveShortcut(key({ key: "?", shiftKey: false }), CONTEXT), "shortcuts-sheet");
  // Shift remains a real modifier where it distinguishes two bindings.
  assert.equal(resolveShortcut(key({ key: "f", shiftKey: true }), CONTEXT), "fullscreen");
  assert.equal(resolveShortcut(key({ key: "f", shiftKey: false }), CONTEXT), "tool:fib");
});

test("the modifier that is not this platform's is left to the browser", () => {
  // On macOS, Ctrl+T is not the trend tool — it is a chord this app never
  // claimed, and taking it would preventDefault something the OS or the
  // browser owns.
  assert.equal(resolveShortcut(key({ key: "t", ctrlKey: true }), { mac: true, replayActive: false }),
    null);
  assert.equal(resolveShortcut(key({ key: "t", metaKey: true }), { mac: false, replayActive: false }),
    null);
  // And the platform's own modifier still resolves what the table declares.
  assert.equal(resolveShortcut(key({ key: "z", metaKey: true }), { mac: true, replayActive: false }),
    "undo");
});

// ── Replay's own undo stack ────────────────────────────────────────────────

/**
 * `historyScope` was exported, documented as the isolation mechanism, tested —
 * and imported by nothing. Replay drawings lived in component state and never
 * reached the store, so the isolation claim was satisfied by accident: they
 * could not contaminate live history because they had no history at all, and
 * Cmd+Z during a Replay did nothing while the shortcuts sheet listed Undo.
 */
test("a Replay session has its own undo stack, isolated from the chart's", () => {
  const store = read("lib/drawingStore.ts");
  assert.match(store, /import \{ DrawingHistory, historyScope/,
    "the scope function must actually be used, not merely exported");
  for (const method of ["resetReplay", "setReplay", "undoReplay", "redoReplay"]) {
    assert.ok(store.includes(`${method}(`), `the store offers no ${method}`);
  }
  // Nothing may write a Replay scope to the cache or to disk: a Replay drawing
  // that reached `saveDrawings` would appear on the live chart after the
  // session ended.
  const replaySection = store.slice(
    store.indexOf("resetReplay"), store.indexOf("replayHistoryState"));
  assert.doesNotMatch(replaySection, /this\.write\(/,
    "a Replay edit must never be persisted or broadcast as the instrument's");

  const page = read("app/chart/page.tsx");
  assert.match(page, /drawingStore\.undoReplay\(symbol\)/);
  assert.match(page, /drawingStore\.redoReplay\(symbol\)/);
  assert.match(page, /drawingStore\.resetReplay\(symbol, \[\]\)/,
    "a new session must not inherit the previous one's undo steps");
});

test("the two scopes cannot collide", () => {
  // A symbol cannot contain "|", so no instrument's key can ever be a Replay
  // key — which is what keeps one undo from reaching the other's list.
  assert.equal(historyScope("BTCUSDT", false), "BTCUSDT");
  assert.equal(historyScope("btcusdt", true), "replay|BTCUSDT");
  assert.notEqual(historyScope("BTCUSDT", true), historyScope("BTCUSDT", false));

  const history = new DrawingHistory();
  const live = historyScope("BTCUSDT", false);
  const replay = historyScope("BTCUSDT", true);
  const one = [line("a", 10)];
  history.reset(live, []);
  history.reset(replay, []);
  history.record(live, one, null);
  assert.equal(history.undo(replay), null, "an undo in Replay cannot reach the live list");
  assert.deepEqual(history.undo(live), []);
});
