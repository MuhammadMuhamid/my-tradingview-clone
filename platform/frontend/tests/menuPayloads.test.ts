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
  WATCHLIST_VIEW_DEFAULTS, watchlistAddToListMenu, watchlistListsMenu, watchlistMenu,
  watchlistSettingsMenu,
} from "../lib/menuPayloads";
import { isSeparator, type MenuEntry } from "../lib/contextMenu";

const ONE_LIST = [{ id: "a", name: "Main Watchlist" }];
const TWO_LISTS = [...ONE_LIST, { id: "b", name: "Scalps" }];

/** Row labels in order, with `—` standing in for a separator. */
function rows(entries: readonly MenuEntry[]): string[] {
  return entries.map((entry) => (isSeparator(entry) ? "—" : entry.label));
}

test("R8-22 / R7b-18 — the row menu's rows, in order", () => {
  assert.deepEqual(rows(watchlistMenu({
    symbol: "ETHUSDT", replayActive: false, canOpenNewPane: true, lists: TWO_LISTS,
  })), [
    "Open in the focused chart",
    "Open in a new pane",
    // The reference's own `Add ETHUSD to watchlist ›`, which this product can
    // honour because it has more than one list.
    "Add ETHUSDT to watchlist…",
    "—",
    "Add alert on ETHUSDT",
    "—",
    // The reference's last row. It opens the same field the header's `+` does.
    "Add symbol…",
    "—",
    "Remove from this list",
  ]);
});

test("R7b-18 — with one list there is nowhere to add the row TO, so the row is absent", () => {
  /*
   * Not "disabled with a reason": that rule is for an action that is
   * temporarily unavailable. `Add X to watchlist` has no meaning at all until
   * a second list exists, and a permanently greyed row teaches nothing.
   */
  const ids = watchlistMenu({
    symbol: "ETHUSDT", replayActive: false, canOpenNewPane: true, lists: ONE_LIST,
  }).map((e) => e.id);
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
  for (const label of rows(watchlistMenu({
    symbol: canonical, replayActive: false, canOpenNewPane: true, lists: TWO_LISTS,
  }))) {
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
