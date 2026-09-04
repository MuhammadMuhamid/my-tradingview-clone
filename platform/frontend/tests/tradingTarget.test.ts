/**
 * Where the manual order ticket points, in a workspace showing many charts.
 *
 * ── The defect class this file exists to prevent ───────────────────────────
 *
 * `lib/manualTicket` already makes a SYMBOL change safe: everything staged is
 * discarded, because an amount, a limit price and a real-funds attestation are
 * statements about one instrument. A multi-pane workspace introduces a second,
 * much quieter way for the ticket's instrument to move — clicking another
 * chart. Nothing is typed, no dialog opens, and under a naive "the ticket
 * follows the focused pane" rule a staged order would silently be aimed
 * somewhere else.
 *
 * So: focus follows the pointer, and the trading target does not — while
 * anything is staged. These tests are the proof.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveTradingTarget, tradingTargetNotice, type TradingTarget } from "../lib/tradingTarget";
import { EMPTY_TICKET, isTicketStaged, ticketSubmitBlocker } from "../lib/manualTicket";
import {
  applyPaneSymbol, createWorkspace, removePane, setActivePane, setPaneCount, updatePane,
  type ChartWorkspace,
} from "../lib/workspace";
import { DEFAULT_SYNC } from "../lib/paneSync";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Four panes on four instruments, focused on the first. */
function board(): ChartWorkspace {
  let ws = setPaneCount(createWorkspace({ symbol: "SOLUSDT", interval: "15m" }), 4);
  ws = updatePane(ws, "p2", { symbol: "BTCUSDT" });
  ws = updatePane(ws, "p3", { symbol: "ETHUSDT" });
  ws = updatePane(ws, "p4", { symbol: "XRPUSDT" });
  return ws;
}

const resolve = (
  workspace: ChartWorkspace, previous: TradingTarget | null, ticketStaged: boolean
): TradingTarget => resolveTradingTarget({ workspace, previous, ticketStaged });

test("with nothing staged the ticket follows the focused pane", () => {
  const ws = board();
  const first = resolve(ws, null, false);
  assert.deepEqual(first, { paneId: "p1", symbol: "SOLUSDT", pinned: false });

  const moved = resolve(setActivePane(ws, "p3"), first, false);
  assert.deepEqual(moved, { paneId: "p3", symbol: "ETHUSDT", pinned: false });
  assert.equal(tradingTargetNotice(moved, setActivePane(ws, "p3")), null,
    "an unpinned ticket has nothing to explain");
});

test("AN ARMED TICKET DOES NOT FOLLOW A CHANGE OF FOCUS", () => {
  const ws = board();
  const armed = resolve(ws, null, false);
  assert.equal(armed.symbol, "SOLUSDT");

  // The operator types an amount, then clicks the Bitcoin pane.
  const focusedElsewhere = setActivePane(ws, "p2");
  const held = resolve(focusedElsewhere, armed, true);

  assert.equal(held.symbol, "SOLUSDT", "the staged order was silently retargeted");
  assert.equal(held.paneId, "p1");
  assert.equal(held.pinned, true);
  // And the workspace itself did move focus — the two facts are independent.
  assert.equal(focusedElsewhere.activePaneId, "p2");

  const notice = tradingTargetNotice(held, focusedElsewhere);
  assert.ok(notice && notice.includes("SOLUSDT") && notice.includes("BTCUSDT"),
    "the operator is not told which instrument the ticket is still on");
});

test("focus can wander across every pane without moving an armed ticket", () => {
  const ws = board();
  let target = resolve(ws, null, false);
  let current = ws;
  for (const paneId of ["p2", "p3", "p4", "p2", "p1", "p4"]) {
    current = setActivePane(current, paneId);
    target = resolve(current, target, true);
    assert.equal(target.symbol, "SOLUSDT", `focus on ${paneId} moved the ticket`);
    assert.equal(target.paneId, "p1");
  }
});

test("clearing the ticket hands the target back to the focused pane", () => {
  const ws = board();
  const armed = resolve(ws, null, false);
  const focused = setActivePane(ws, "p3");
  const held = resolve(focused, armed, true);
  assert.equal(held.symbol, "SOLUSDT");

  // The operator submits or clears; nothing is staged any more.
  const released = resolve(focused, held, false);
  assert.deepEqual(released, { paneId: "p3", symbol: "ETHUSDT", pinned: false });
});

test("changing the pinned pane's OWN symbol is the supported way to retarget", () => {
  /*
   * This is a deliberate act on the chart the ticket is attached to, and it is
   * the case `lib/manualTicket` was written for: the panel's own disarm runs on
   * the symbol prop changing, so the staged fields, the chosen position and the
   * real-funds attestation are all discarded before anything can be submitted.
   */
  const ws = board();
  const armed = resolve(ws, null, false);
  const retargeted = applyPaneSymbol(ws, "p1", "DOGEUSDT", { ...DEFAULT_SYNC, symbol: false });
  const followed = resolve(retargeted, armed, true);
  assert.equal(followed.symbol, "DOGEUSDT");
  assert.equal(followed.paneId, "p1");

  // The panel's own guard is what makes that safe, and it still refuses a
  // ticket armed for the old instrument.
  assert.equal(
    ticketSubmitBlocker({
      armedSymbol: "SOLUSDT", currentSymbol: "DOGEUSDT",
      armedAccountId: "acct", currentAccountId: "acct",
      positionId: "", side: "BUY", selectablePositions: [],
    }),
    "This ticket was prepared for SOLUSDT. Re-enter it for DOGEUSDT before submitting."
  );
});

test("closing the pinned pane keeps the ticket's instrument rather than moving it", () => {
  const ws = board();
  const armed = resolve(ws, null, false);
  const closed = setActivePane(removePane(ws, "p1"), "p3");
  const orphaned = resolve(closed, armed, true);

  assert.equal(orphaned.symbol, "SOLUSDT", "losing a view retargeted a live order");
  assert.equal(orphaned.paneId, null);
  assert.equal(orphaned.pinned, true);
  const notice = tradingTargetNotice(orphaned, closed);
  assert.ok(notice && notice.includes("SOLUSDT") && /closed/.test(notice));
});

test("a symbol-synced workspace moves every pane, and the ticket with them", () => {
  // Symbol sync is the operator saying "show me this instrument everywhere".
  // The ticket's own pane moved, so the ticket follows it — through the same
  // supported path, with the same disarm.
  const ws = board();
  const armed = resolve(ws, null, false);
  const synced = applyPaneSymbol(ws, "p3", "BTCUSDT", { ...DEFAULT_SYNC, symbol: true });
  const followed = resolve(synced, armed, true);
  assert.equal(followed.symbol, "BTCUSDT");
  assert.equal(followed.paneId, "p1");
});

test("the workspace's idea of 'staged' is the panel's, not a second definition", () => {
  assert.equal(isTicketStaged(EMPTY_TICKET), false);
  for (const staged of [
    { ...EMPTY_TICKET, amount: "5" },
    { ...EMPTY_TICKET, limitPrice: "100" },
    { ...EMPTY_TICKET, tp: "120" },
    { ...EMPTY_TICKET, sl: "90" },
    { ...EMPTY_TICKET, positionId: "pos-1" },
    { ...EMPTY_TICKET, mainnetConfirmed: true },
    { ...EMPTY_TICKET, orderRequestId: "req-1" },
    { ...EMPTY_TICKET, confirming: true },
  ]) {
    assert.equal(isTicketStaged(staged), true, `${JSON.stringify(staged)} should count as staged`);
  }
  // The panel reports exactly this predicate upward, so the pin cannot be
  // decided from a stricter or looser notion of "staged" than the disarm uses.
  const panel = read("components/tv/ManualTradingPanel.tsx");
  assert.match(panel, /const ticketStaged = isTicketStaged\(\{/);
  assert.match(panel, /onStagedChange\?\.\(ticketStaged\)/);
  // Unmounting must report "nothing staged", or closing the panel would leave
  // the workspace pinned forever.
  assert.match(panel, /onStagedChange\?\.\(false\)/);
});

test("THE PAGE BINDS THE TICKET TO THE RESOLVED TARGET, NOT TO THE FOCUSED PANE", () => {
  const page = read("app/chart/page.tsx");
  assert.match(page, /resolveTradingTarget\(\{ workspace, previous, ticketStaged \}\)/);
  // The page resolves the target; the side panel hands it to the ticket. Both
  // links are checked, because a break in either one silently retargets.
  assert.match(page, /tradingSymbol=\{tradingSymbol\}/);
  assert.match(page, /onTicketStagedChange=\{setTicketStaged\}/);
  assert.match(page, /tradingNotice=\{tradingNotice\}/);
  const side = read("components/tv/ChartSidePanel.tsx");
  assert.match(side, /<ManualTradingPanel symbol=\{props\.tradingSymbol\}/);
  assert.match(side, /onStagedChange=\{props\.onTicketStagedChange\}/);
  assert.match(side, /targetNotice=\{props\.tradingNotice\}/);
  // Server-authoritative manual state is read for the TICKET's instrument, so
  // the positions and balances shown belong to the order being staged.
  assert.match(page, /api\.manualState\(tradingSymbol\)/);
  assert.match(page, /p\.pair === tradingSymbol/);

  // And Shariah gating stays bound to the same symbol the ticket trades: the
  // panel asks the backend for its own `symbol` prop, which is that target.
  const panel = read("components/tv/ManualTradingPanel.tsx");
  assert.match(panel, /shariahApi\.status\(symbol\)/);
  assert.match(panel, /positionsForSymbol\(state\?\.positions, \{ symbol, accountId \}\)/);
  assert.match(panel, /currentSymbol: symbol/);
});
