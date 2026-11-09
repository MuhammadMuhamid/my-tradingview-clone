/**
 * F7 on screen: a late-fill position is unmistakably UNPROTECTED in the chart
 * strip and in the Trade panel, an unrecognised protection state reads
 * "Protection unknown", and neither implies a TP/SL that nothing enforces.
 * Also: the panel calls the bot's dry run "DRY RUN (simulated)", never PAPER.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertPresent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { TradingStateStrip } from "@/components/tv/TradingStateStrip";
import { loadSession, resetSessionForTests } from "@/lib/session";
import type { ManualPosition, ManualTradingState } from "@/lib/api";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const position = (id: string, over: Partial<ManualPosition>): ManualPosition => ({
  id, exchangeAccountId: "acct-test", pair: "BTCUSDT", status: "active", entryPrice: 70000,
  currentPrice: 70100, quantity: 0.001, quoteSpent: 70, pnlUsdt: 0.1, pnlPct: 0.14,
  manualTpPrice: null, manualSlPrice: null, protectionType: null, protectionState: null,
  createdAt: "2026-11-09T10:00:00.000Z", closedAt: null, closedReason: null, ...over,
});

const POSITIONS: ManualPosition[] = [
  position("late", { protectionState: "late_fill_unprotected" }),
  position("odd", { pair: "ETHUSDT", protectionState: "pending_entry", manualTpPrice: 4000, manualSlPrice: 3000 }),
  position("watched", { pair: "SOLUSDT", protectionType: "bot-managed", protectionState: "active",
    manualTpPrice: 250, manualSlPrice: 150 }),
  position("mainnet", { pair: "BNBUSDT", exchangeAccountId: "acct-main", protectionType: "bot-managed",
    protectionState: "active", manualTpPrice: 700, manualSlPrice: 500 }),
];

const STATE: ManualTradingState = {
  enabled: true, mainnetEnabled: false, dryRun: true, mixed: true, tradingHalted: false,
  accounts: [{ id: "acct-test", name: "Testnet", exchange: "binance", marketType: "spot", testnet: true, mode: "testnet" },
    { id: "acct-main", name: "Mainnet", exchange: "binance", marketType: "spot", testnet: false, mode: "mainnet" }],
  orders: [], positions: POSITIONS,
  protection: { type: "bot-managed", exchangeResting: false, note: "Checked by the bot poller about every 30 s",
    polling: true, haltedBy: null, mainnetPositionsChecked: false },
};
const HALTED: ManualTradingState = { ...STATE, tradingHalted: true,
  protection: { ...STATE.protection, polling: false, haltedBy: "operator",
    note: "TP/SL is NOT being checked: the Bot is halted." } };
/** A bot from before `polling` existed: it says nothing about its poller. */
const OLD_BOT: ManualTradingState = { ...STATE,
  protection: { type: "bot-managed", exchangeResting: false, note: "Checked by the bot poller" } };
delete (OLD_BOT as Partial<ManualTradingState>).tradingHalted;

async function strip(state: ManualTradingState, unavailable: string | null = null) {
  const view = render(<TradingStateStrip state={state} symbol="BTCUSDT" readAt={Date.now()} onOpenTicket={() => {}}
    unavailable={unavailable} />);
  await settle();
  const row = (pair: string) => assertPresent(
    [...document.querySelectorAll("tbody tr")].find((tr) => tr.firstElementChild?.textContent === pair) ?? null, pair);
  return { row, unmount: view.unmount };
}

test("the chart strip shows the late fill as UNPROTECTED and implies no TP/SL", async () => {
  const { row } = await strip(STATE);
  const late = row("BTCUSDT");
  const badge = assertPresent(late.querySelector('[data-protection="late_fill_unprotected"]'), "late-fill badge");
  assert.equal(badge.textContent, "UNPROTECTED · late fill");
  assert.match(badge.className, /text-down/);
  assert.equal(late.textContent?.includes(" / "), false, "a TP / SL pair is implied for an unwatched position");
  const odd = row("ETHUSDT");
  assert.equal(assertPresent(odd.querySelector("[data-protection]"), "unknown badge").textContent, "Protection unknown");
  assert.equal(odd.textContent?.includes("4,000") || odd.textContent?.includes("4000"), false,
    "levels the bot is not confirmed to watch are shown as if enforced");
  assert.match(row("SOLUSDT").textContent ?? "", /250.*\/.*150/);
  // A mainnet position while the bot does not check mainnet positions.
  const mainnet = row("BNBUSDT");
  assert.equal(assertPresent(mainnet.querySelector("[data-protection]"), "mainnet badge").textContent,
    "TP/SL NOT BEING CHECKED · mainnet manual off");
  assert.equal(mainnet.textContent?.includes("700"), false, "unchecked levels shown as if enforced");
});

test("a halted bot: no position reads as protected, and no level is shown as enforced", async () => {
  const { row } = await strip(HALTED);
  const watched = row("SOLUSDT");
  const badge = assertPresent(watched.querySelector("[data-protection]"), "halted badge");
  assert.equal(badge.textContent, "TP/SL NOT BEING CHECKED · Bot halted");
  assert.match(badge.className, /text-down/);
  assert.equal(watched.textContent?.includes("250"), false);
});

test("RR3: after a failed read the strip keeps the rows but claims no protection", async () => {
  // STATE says the testnet position is checked — but that was the LAST read;
  // the latest one failed (the Bot is down).
  const { row } = await strip(STATE, "The execution bot could not be reached");
  assert.ok(document.querySelector('[role="alert"]'), "setup: the stale-read notice is shown");
  const watched = row("SOLUSDT");
  assert.equal(assertPresent(watched.querySelector("[data-protection]"), "stale badge").textContent,
    "TP/SL NOT BEING CHECKED · status unknown");
  assert.equal(watched.textContent?.includes("250"), false, "a level shown as enforced from a stale read");
});

test("an older bot that does not report its poller: status unknown, never protected", async () => {
  const { row } = await strip(OLD_BOT);
  assert.equal(assertPresent(row("SOLUSDT").querySelector("[data-protection]"), "old-bot badge").textContent,
    "TP/SL NOT BEING CHECKED · status unknown");
});

test("the Trade panel badges the late fill and calls the bot's dry run DRY RUN (simulated)", async () => {
  await loadSession();
  // The panel lists only positions the chart's symbol can exit; the harness
  // chart opens on SOLUSDT (asserted below).
  server.routes.set("GET /api/manual-trading/state", () => ({ ...STATE, positions: [
    position("late", { pair: "SOLUSDT", protectionState: "late_fill_unprotected" }),
    position("odd", { pair: "SOLUSDT", protectionState: "pending_entry", manualTpPrice: 250, manualSlPrice: 150 }),
  ] }));
  const chart = await mountChart();
  await settle(6);
  const trade = assertPresent(chart.container.querySelector<HTMLElement>('[data-toolbar-control="trade"]'), "Trade control");
  fireEvent.click(trade);
  await settle(6);
  assert.ok(server.callsTo("/api/manual-trading/account-state?symbol=SOLUSDT").length > 0,
    "setup: the harness chart is expected to open on SOLUSDT");
  assert.ok(screen.getByText("DRY RUN (simulated)"), "the panel's dry-run label");
  assert.equal(document.body.textContent?.includes("PAPER SIMULATION"), false);
  fireEvent.click(screen.getByRole("tab", { name: /^Orders/ }));
  await settle(4);
  const late = assertPresent(document.querySelector('[data-position-id="late"]'), "late-fill position in the panel");
  const badge = assertPresent(late.querySelector('[data-protection="late_fill_unprotected"]'), "panel late-fill badge");
  assert.equal(badge.textContent, "UNPROTECTED · late fill");
  assert.equal(late.textContent?.includes("late_fill_unprotected"), false, "the raw bot state is the copy");
  const odd = assertPresent(document.querySelector('[data-position-id="odd"]'), "unknown-state position");
  assert.equal(assertPresent(odd.querySelector("[data-protection]"), "panel unknown badge").textContent, "Protection unknown");
});

test("the Trade panel says the bot is NOT checking TP/SL while it is halted", async () => {
  await loadSession();
  server.routes.set("GET /api/manual-trading/state", () => ({ ...HALTED, positions: [
    position("watched", { pair: "SOLUSDT", protectionType: "bot-managed", protectionState: "active",
      manualTpPrice: 250, manualSlPrice: 150 }),
  ] }));
  const chart = await mountChart();
  await settle(6);
  fireEvent.click(assertPresent(chart.container.querySelector<HTMLElement>('[data-toolbar-control="trade"]'), "Trade control"));
  await settle(6);
  const notice = assertPresent(document.querySelector('[data-protection-notice="true"]'), "protection notice");
  assert.match(notice.textContent ?? "", /NOT checking take-profit \/ stop-loss/);
  assert.match(notice.textContent ?? "", /halted/);
  assert.equal(document.body.textContent?.includes("still available"), false);
  fireEvent.click(screen.getByRole("tab", { name: /^Orders/ }));
  await settle(4);
  const watched = assertPresent(document.querySelector('[data-position-id="watched"]'), "watched position");
  assert.equal(assertPresent(watched.querySelector("[data-protection]"), "panel halted badge").textContent,
    "TP/SL NOT BEING CHECKED · Bot halted");
});
