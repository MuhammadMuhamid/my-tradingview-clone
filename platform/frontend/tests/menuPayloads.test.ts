/**
 * The watchlist's three menus, row by row.
 *
 * ── Why the ROWS and not just the ids ──────────────────────────────────────
 *
 * TVP8 R7b-08 and R8-22 are both inventory findings: the right actions were on
 * the wrong buttons, and two of the reference's shared rows were missing
 * entirely. An id-only assertion cannot see either — a menu can hold the right
 * set of ids in an order nobody can scan, with `Delete list` above `Rename`
 * and the list of lists at the top. So the labels are asserted IN ORDER, which
 * is the property a reader actually has.
 *
 * ── What is deliberately not here ──────────────────────────────────────────
 *
 * The reference's row menu opens with `Flag/Unflag ETHUSD ⌥↵`, a seven-swatch
 * colour row and `Unflag all symbols`, and carries `Add … to compare`, `Add
 * note for …` and `Add section`. R7b classes all five as
 * GENUINELY_DIFFERENT_PRODUCT_FUNCTION: this product has no flags, no notes,
 * no compare list and no user sections (its sections are a VIEW of the asset
 * class, see `Watchlist.tsx`), and a menu row that opens nothing is the defect
 * `lib/menuPayloads.ts`'s own header is written against.
 *
 * The hotkey caps are absent for the same reason. TV prints `⌥↵` on Flag and
 * nothing on the rows this product shares; printing a cap for a chord the
 * product does not bind would be the menu lying about its own keyboard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGEND_ALERT_TARGET_PREFIX, legendStudyMenu,
  TIME_ZONE_MENU_PREFIX, WATCHLIST_VIEW_DEFAULTS, priceAxisMenu, timeAxisMenu,
  watchlistAddToListMenu, watchlistListsMenu, watchlistMenu, watchlistSettingsMenu,
} from "../lib/menuPayloads";
import { FLAG_COLOURS } from "../lib/watchlistFlags";
import { isSeparator, isSwatches, type MenuEntry } from "../lib/contextMenu";

const ONE_LIST = [{ id: "a", name: "Main Watchlist" }];
const TWO_LISTS = [...ONE_LIST, { id: "b", name: "Scalps" }];

/** Row labels in order, with `—` standing in for a separator. */
function rows(entries: readonly MenuEntry[]): string[] {
  return entries.map((entry) => (isSeparator(entry) ? "—" : entry.label));
}

/** The queue's F-05 context, with the parts a test is not about held still. */
function rowMenu(over: Partial<Parameters<typeof watchlistMenu>[0]> = {}) {
  return watchlistMenu({
    symbol: "ETHUSDT", replayActive: false, canOpenNewPane: true, lists: TWO_LISTS,
    activeListId: "a", flag: null, anyFlagged: false, flagColours: FLAG_COLOURS,
    canCompare: true, ...over,
  });
}

test("F-05 — the row menu is the reference's, in the reference's order", () => {
  /*
   * `08c_tv_watchlist_row_menu.png`: flagging, then the three things you do
   * WITH the symbol, then the two that act on the LIST. The two Trading Scene
   * rows that have no reference equivalent are kept, last, in a group of their
   * own — the queue asks for them to be retained rather than dropped.
   */
  assert.deepEqual(rows(rowMenu()), [
    "Flag ETHUSDT",
    "Flag colour for ETHUSDT",
    "Unflag all symbols",
    "—",
    "Add ETHUSDT to watchlist",
    "Add ETHUSDT to compare",
    "Add note for ETHUSDT",
    "—",
    "Add section",
    "Add symbol…",
    "—",
    "Open in the focused chart",
    "Open in a new pane",
    "Add alert on ETHUSDT",
  ]);
});

test("F-05 — `Remove from this list` is gone, and nothing in the menu is destructive", () => {
  /*
   * The reference has no remove row and no red text here; removing is the
   * hover trash and the Delete key, both of which the row already has. A red
   * row in a menu a user opens to flag a symbol is a mis-set expectation.
   */
  const entries = rowMenu();
  assert.equal(entries.some((e) => e.id === "watchlist:remove"), false);
  for (const entry of entries) {
    if (isSeparator(entry) || isSwatches(entry)) continue;
    assert.notEqual(entry.destructive, true, entry.label);
  }
});

test("F-05 — the palette is one row of seven, with radio semantics", () => {
  const palette = rowMenu({ flag: "green" }).find(isSwatches);
  assert.ok(palette, "the menu carries a swatch row");
  assert.equal(palette.swatches.length, 7);
  assert.deepEqual(palette.swatches.map((c) => c.id),
    ["red", "blue", "green", "orange", "purple", "cyan", "pink"]);
  assert.equal(palette.selected, "green",
    "the flag already on is the one the palette announces as checked");
});

test("F-05 — the first row's verb follows the symbol's own state", () => {
  assert.equal(rows(rowMenu({ flag: null }))[0], "Flag ETHUSDT");
  assert.equal(rows(rowMenu({ flag: "red" }))[0], "Unflag ETHUSDT");
});

test("F-05 — `Unflag all symbols` is greyed, with a reason, when nothing is flagged", () => {
  const off = rowMenu({ anyFlagged: false }).find((e) => e.id === "watchlist:unflag-all");
  assert.ok(off && !isSeparator(off) && !isSwatches(off));
  assert.equal(off.disabled, true);
  assert.match(String(off.disabledReason), /flagged/);
  const on = rowMenu({ anyFlagged: true }).find((e) => e.id === "watchlist:unflag-all");
  assert.ok(on && !isSeparator(on) && !isSwatches(on));
  assert.notEqual(on.disabled, true);
});

test("F-05 — `Add to watchlist` is a submenu of the OTHER lists", () => {
  const entry = rowMenu().find((e) => e.id === "watchlist:add-to-list");
  assert.ok(entry && !isSeparator(entry) && !isSwatches(entry));
  assert.deepEqual(entry.children?.map((c) => c.id), ["watchlist:add-to-list:b"],
    "the list the row is already on is not somewhere to add it to");
});

test("R7b-18 — with one list there is nowhere to add the row TO, so the row is absent", () => {
  /*
   * Not "disabled with a reason": that rule is for an action that is
   * temporarily unavailable. `Add X to watchlist` has no meaning at all until
   * a second list exists, and a permanently greyed row teaches nothing.
   */
  const ids = rowMenu({ lists: ONE_LIST }).map((e) => e.id);
  assert.equal(ids.includes("watchlist:add-to-list"), false);
  assert.equal(ids.includes("watchlist:add-symbol"), true,
    "`Add symbol` is unconditional — a list of one can still be added to");
});

test("R7b-18 — the second level offers the OTHER lists and never the current one", () => {
  const submenu = watchlistAddToListMenu(TWO_LISTS, "a");
  assert.deepEqual(rows(submenu), ["Scalps"]);
  assert.deepEqual(submenu.map((e) => e.id), ["watchlist:add-to-list:b"]);
  assert.deepEqual(watchlistAddToListMenu(ONE_LIST, "a"), [],
    "adding a row to the list it is already on is not an action");
});

test("R7b-10 — a canonical row's menu is written in tickers, never in storage keys", () => {
  const canonical = "instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot";
  for (const label of rows(rowMenu({ symbol: canonical }))) {
    assert.doesNotMatch(label, /instrument:v1/, label);
  }
});

// ── the two header dropdowns (R7b-08) ──────────────────────────────────────

/** Entry ids in order, with `—` for a separator and `##` before a heading. */
function panel(entries: readonly { kind: string; id: string }[]): string[] {
  return entries.map((entry) => entry.kind === "separator" ? "—"
    : entry.kind === "heading" ? `##${entry.id}` : entry.id);
}

test("R7b-08 — the list NAME holds list editing, with the lists under a heading", () => {
  /*
   * This menu used to be a bare list of lists, and New / Rename / Delete lived
   * on the `⋯` beside it — so the control that says which list you are looking
   * at could not act on it.
   */
  assert.deepEqual(panel(watchlistListsMenu({ lists: TWO_LISTS, activeId: "a" })), [
    "list:copy", "list:rename", "list:clear",
    "—",
    "list:new",
    "—",
    "##head-lists",
    "list:select:a", "list:select:b",
    "—",
    "list:delete",
  ]);
  const entries = watchlistListsMenu({ lists: TWO_LISTS, activeId: "a" });
  const current = entries.find((e) => e.id === "list:select:a");
  assert.equal(current?.kind === "item" && current.checked, true,
    "the current list is the checked radio, which is what the reference marks");
  assert.equal(current?.kind === "item" && current.radio, true,
    "one of N is a radio, not N independent checkboxes");
});

test("R7b-08 — a workspace keeps at least one list, and says so on the row", () => {
  const only = watchlistListsMenu({ lists: ONE_LIST, activeId: "a" })
    .find((e) => e.id === "list:delete");
  assert.equal(only?.kind === "item" && only.disabled, true);
  assert.match(only?.kind === "item" ? only.disabledReason ?? "" : "", /at least one list/);
});

test("R7b-08 — `⋯` is view settings: which columns, and how a symbol is written", () => {
  assert.deepEqual(panel(watchlistSettingsMenu(WATCHLIST_VIEW_DEFAULTS)), [
    "view:compact",
    "—",
    "##head-columns",
    "view:column:last", "view:column:change", "view:column:changePct", "view:column:volume",
    "—",
    "##head-display",
    "view:mark", "view:display:symbol", "view:display:name",
  ]);
});

test("R7b-08 — the settings menu reports the state it is looking at", () => {
  const checked = (entries: readonly { kind: string; id: string; checked?: boolean }[], id: string) =>
    entries.find((e) => e.id === id)?.checked;
  const off = watchlistSettingsMenu(WATCHLIST_VIEW_DEFAULTS);
  assert.equal(checked(off, "view:column:volume"), false,
    "Volume is the reference's own unchecked column");
  assert.equal(checked(off, "view:display:symbol"), true);
  assert.equal(checked(off, "view:display:name"), false);

  const on = watchlistSettingsMenu({
    ...WATCHLIST_VIEW_DEFAULTS, compact: true, display: "name",
    columns: { ...WATCHLIST_VIEW_DEFAULTS.columns, volume: true },
  });
  assert.equal(checked(on, "view:compact"), true);
  assert.equal(checked(on, "view:column:volume"), true);
  assert.equal(checked(on, "view:display:name"), true);
  assert.equal(checked(on, "view:display:symbol"), false,
    "Symbol and Name are one choice, not two switches");
});

/* ── A6: the axes' menus offer the rows this product can honour ──────────── */

const AXIS = {
  autoScale: true, logScale: false, percentScale: false, indexedScale: false, inverted: false,
  mac: true, onLeft: false,
  labels: { lastValue: true, indicatorValue: true, dayOfWeek: true },
  lines: { lastValue: true, bidAsk: null },
};

function flat(entries: readonly MenuEntry[]): MenuEntry[] {
  return entries.flatMap((entry) => [entry, ...flat((entry as { children?: MenuEntry[] }).children ?? [])]);
}
const labelled = (entries: readonly MenuEntry[]): string[] =>
  flat(entries).map((entry) => (entry as { label?: string }).label ?? "").filter(Boolean);

test("A6 — the price axis offers `Plus button`, checked as the setting is", () => {
  const on = flat(priceAxisMenu({ ...AXIS, plusButton: true }));
  const off = flat(priceAxisMenu({ ...AXIS, plusButton: false }));
  const row = (menu: MenuEntry[]) => menu.find((e) => e.id === "axis:toggle-plus-button") as
    { label?: string; checked?: boolean } | undefined;
  assert.equal(row(on)?.label, "Plus button");
  assert.equal(row(on)?.checked, true);
  assert.equal(row(off)?.checked, false);
});

test("A6 — no row for what the engine cannot do: bar-ratio lock, price-only scaling, session breaks", () => {
  const rows = [
    ...labelled(priceAxisMenu(AXIS)),
    ...labelled(timeAxisMenu({ mac: true, timeZone: "UTC" })),
  ];
  for (const absent of [/lock price to bar ratio/i, /scale price chart only/i, /session breaks/i]) {
    assert.ok(!rows.some((label) => absent.test(label)), `${absent} is a switch that would do nothing`);
  }
});

test("A6 — the time axis offers `Time zone ›`, one radio row per zone, the pane's checked", () => {
  const menu = timeAxisMenu({ mac: true, timeZone: "Asia/Tokyo" });
  const parent = menu.find((e) => e.id === "time:time-zone") as
    { label?: string; children?: { id: string; label: string; radio?: boolean; checked?: boolean }[] };
  assert.equal(parent?.label, "Time zone");
  const zones = parent.children ?? [];
  assert.equal(zones.length, 5);
  assert.ok(zones.every((zone) => zone.radio === true && zone.id.startsWith(TIME_ZONE_MENU_PREFIX)));
  assert.deepEqual(zones.filter((zone) => zone.checked).map((zone) => zone.id),
    [`${TIME_ZONE_MENU_PREFIX}Asia/Tokyo`]);
  // A caller that does not say reads as the setting's default.
  const utc = (timeAxisMenu({ mac: true }).find((e) => e.id === "time:time-zone") as
    { children?: { id: string; checked?: boolean }[] }).children!;
  assert.deepEqual(utc.filter((zone) => zone.checked).map((zone) => zone.id), [`${TIME_ZONE_MENU_PREFIX}UTC`]);
});

test("W2A-04 — a grouped legend row's alert arms one line: directly for one, a door for several", () => {
  const one = legendStudyMenu({
    title: "Moving averages",
    alert: { replayActive: false, targets: [{ id: "ma-sma-200", label: "SMA 200" }] },
  });
  const row = one[0] as { id: string; label: string; children?: unknown };
  assert.equal(row.id, `${LEGEND_ALERT_TARGET_PREFIX}ma-sma-200`);
  assert.equal(row.label, "Add alert on Moving averages…");
  assert.equal(row.children, undefined);

  const two = legendStudyMenu({
    title: "Moving averages",
    alert: { replayActive: true, targets: [
      { id: "ma-sma-200", label: "SMA 200" }, { id: "ma-ema-50", label: "EMA 50" }] },
  });
  const door = two[0] as unknown as { label: string; disabled?: boolean; children: { id: string; label: string }[] };
  assert.equal(door.label, "Add alert on Moving averages", "a door is not an ellipsis row");
  assert.equal(door.disabled, true, "a Replay disables it, as every alert row");
  assert.deepEqual(door.children.map((c) => [c.id, c.label]), [
    [`${LEGEND_ALERT_TARGET_PREFIX}ma-sma-200`, "SMA 200…"],
    [`${LEGEND_ALERT_TARGET_PREFIX}ma-ema-50`, "EMA 50…"],
  ]);

  // A study with no targets keeps its own row.
  const rsi = legendStudyMenu({ title: "RSI", alert: { replayActive: false } });
  assert.equal((rsi[0] as { id: string }).id, "study-legend:add-alert");
});
