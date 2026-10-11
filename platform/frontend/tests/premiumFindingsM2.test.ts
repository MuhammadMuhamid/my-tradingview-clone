/**
 * M2: the pure halves of the reviewer's findings against live Premium
 * (2026-10-11). Each block names its finding; the rendered halves are in
 * `tests/dom/premiumFindingsM2.test.tsx` and `qa/premiumLock.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crosshairTimeFormatter, fmtDatePattern } from "../lib/chartClock";
import { chartMenu, paneMenu, PANE_MENU_IDS, type PaneMenuContext } from "../lib/menuPayloads";
import { isSeparator, type MenuItem } from "../lib/contextMenu";
import {
  applyPaneSymbol, compareIsBase, createWorkspace, setPaneCompare,
} from "../lib/workspace";
import { DEFAULT_SYNC } from "../lib/paneSync";

const sec = (ms: number): number => ms / 1000;
const HOUR = 3_600_000;

/* ── F-03: the crosshair's time label ─────────────────────────────────────── */

test("F-03 — intraday: weekday, date and time, as Premium's `Sun 04 Oct '26 20:00`", () => {
  const at = sec(Date.UTC(2026, 9, 4, 20, 0));
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true, intervalMs: HOUR })(at),
    "Sun 04 Oct '26 20:00");
  assert.equal(crosshairTimeFormatter({ twentyFourHour: false, intervalMs: 15 * 60_000 })(at),
    "Sun 04 Oct '26 8:00 pm", "the 12-hour row still moves the label");
});

test("F-03 — 1D and up: the date alone", () => {
  const at = sec(Date.UTC(2026, 9, 4));
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true, intervalMs: 24 * HOUR })(at),
    "Sun 04 Oct '26");
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true, intervalMs: 7 * 24 * HOUR })(at),
    "Sun 04 Oct '26");
});

test("F-03 — the chart's zone, date format and day-of-week row all reach the label", () => {
  const at = sec(Date.UTC(2026, 9, 4, 20, 0));
  // 20:00 UTC is 05:00 the next day in Tokyo.
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true, timeZone: "Asia/Tokyo", intervalMs: HOUR })(at),
    "Mon 05 Oct '26 05:00");
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true, dateFormat: "yyyy-MM-dd", intervalMs: HOUR })(at),
    "Sun 2026-10-04 20:00");
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true, dayOfWeek: false, intervalMs: HOUR })(at),
    "04 Oct '26 20:00");
  // A sub-minute resolution says the second too.
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true, intervalMs: 1000 })(at + 7),
    "Sun 04 Oct '26 20:00:07");
  assert.equal(crosshairTimeFormatter({ twentyFourHour: true })("not a time"), "");
});

test("F-03 — the date patterns are the dialog's own five", () => {
  const ms = Date.UTC(1997, 8, 29);
  assert.equal(fmtDatePattern(ms, "dd MMM yy"), "29 Sep '97");
  assert.equal(fmtDatePattern(ms, "MMM dd, yyyy"), "Sep 29, 1997");
  assert.equal(fmtDatePattern(ms, "yyyy-MM-dd"), "1997-09-29");
  assert.equal(fmtDatePattern(ms, "dd/MM/yyyy"), "29/09/1997");
  assert.equal(fmtDatePattern(ms, "MM/dd/yyyy"), "09/29/1997");
});

/* ── F-04: the `Manage panes` menu ────────────────────────────────────────── */

const PANE: PaneMenuContext = {
  mac: true, maximized: false, collapsed: false,
  canMaximize: true, canCollapse: true, canMove: true,
  canMoveUp: true, canMoveDown: true, canRemove: true,
};

function rows(ctx: PaneMenuContext): MenuItem[] {
  return paneMenu(ctx).filter((e): e is MenuItem => !isSeparator(e) && !("swatches" in e));
}

test("F-04 — Premium's five rows, in Premium's order, each with its glyph", () => {
  const items = rows(PANE);
  assert.deepEqual(items.map((i) => i.label),
    ["Maximize pane", "Collapse pane", "Move pane up", "Move pane down", "Delete pane"]);
  assert.deepEqual(items.map((i) => i.id), [...PANE_MENU_IDS]);
  assert.ok(items.every((i) => i.glyph), "every row carries a mark");
  assert.equal(items[0]!.hint, "Double click");
  assert.equal(items[1]!.hint, "⌘ Double click");
  assert.equal(rows({ ...PANE, mac: false })[1]!.hint, "Ctrl Double click");
});

test("F-04 — the ends of the stack disable a move, never drop it", () => {
  const top = rows({ ...PANE, canMoveUp: false });
  const up = top.find((i) => i.id === "pane:move-up")!;
  assert.equal(up.disabled, true);
  assert.ok(up.disabledReason);
  const bottom = rows({ ...PANE, canMoveDown: false });
  assert.equal(bottom.find((i) => i.id === "pane:move-down")!.disabled, true);
  assert.equal(bottom.find((i) => i.id === "pane:move-up")!.disabled, false);
});

test("F-04 — the toggles name the way back, and absent handlers are absent rows", () => {
  const on = rows({ ...PANE, maximized: true, collapsed: true });
  assert.equal(on[0]!.label, "Restore pane");
  assert.equal(on[1]!.label, "Expand pane");
  assert.deepEqual(rows({ ...PANE, canMove: false, canRemove: false }).map((i) => i.id),
    ["pane:maximize", "pane:collapse"]);
});

/* ── F-08: `Remove N drawings` on the chart menu ─────────────────────────── */

const CHART = {
  ticker: "BTCUSDT", mac: true, canPaste: false, lists: [], price: 100, priceLabel: "100.00",
  replayActive: false, autoScale: true, logScale: false, hasDrawings: true,
  drawingsHidden: false, drawingsLocked: false, tradingEnabled: false, candlePatterns: false,
};

test("F-08 — the chart menu counts the pane's drawings beside its indicators", () => {
  const items = chartMenu({ ...CHART, drawingCount: 3, indicatorCount: 2 })
    .filter((e): e is MenuItem => !isSeparator(e) && !("swatches" in e));
  const labels = items.map((i) => i.label);
  const drawings = labels.indexOf("Remove 3 drawings");
  assert.ok(drawings >= 0, JSON.stringify(labels));
  assert.equal(labels[drawings + 1], "Remove 2 indicators", "beside it, as on Premium");
  assert.equal(items[drawings]!.destructive, undefined, "no confirmation-grade styling");
  const one = chartMenu({ ...CHART, drawingCount: 1 })
    .find((e) => e.id === "chart:remove-drawings") as MenuItem;
  assert.equal(one.label, "Remove 1 drawing");
  const none = chartMenu({ ...CHART, drawingCount: 0 })
    .find((e) => e.id === "chart:remove-drawings") as MenuItem;
  assert.equal(none.disabled, true);
  assert.ok(!chartMenu({ ...CHART }).some((e) => !isSeparator(e) && "label" in e
    && /Lock vertical cursor/.test(e.label)), "that row stays absent");
});

/* ── F-09: a comparison that IS the chart is dropped ─────────────────────── */

test("F-09 — switching the chart to its comparison symbol removes the comparison", () => {
  const base = createWorkspace({ symbol: "SOLUSDT", interval: "1h" });
  const id = base.panes[0]!.id;
  const compared = setPaneCompare(base, id, { symbol: "BTCUSDT", mode: "percent", length: 60 });
  const switched = applyPaneSymbol(compared, id, "BTCUSDT", DEFAULT_SYNC);
  assert.equal(switched.panes[0]!.symbol, "BTCUSDT");
  assert.equal(switched.panes[0]!.compare, undefined, "BTCUSDT vs BTCUSDT compares nothing");
  // A canonical id names the same instrument.
  const canonical = applyPaneSymbol(compared, id, "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot", DEFAULT_SYNC);
  assert.equal(canonical.panes[0]!.compare, undefined);
  // Any other symbol keeps it.
  const eth = applyPaneSymbol(compared, id, "ETHUSDT", DEFAULT_SYNC);
  assert.deepEqual(eth.panes[0]!.compare, { symbol: "BTCUSDT", mode: "percent", length: 60 });
});

test("F-09 — compareIsBase reads tickers, not spellings", () => {
  assert.equal(compareIsBase("BTCUSDT", "btcusdt"), true);
  assert.equal(compareIsBase("instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot", "BTCUSDT"), true);
  assert.equal(compareIsBase("SOLUSDT", "BTCUSDT"), false);
  assert.equal(compareIsBase("", ""), false);
});
