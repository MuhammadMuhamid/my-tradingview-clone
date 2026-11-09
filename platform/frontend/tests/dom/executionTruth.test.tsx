/*
 * Three surfaces that asserted more than they had been told.
 *
 * Each is the same class of defect and the most dangerous one this product can
 * have: a confident statement whose source of truth is a value the Platform
 * wrote for itself, or a failure rendered as a negative answer. The chart's
 * execution badge, the Screener's provenance line and its unresolved rows, and
 * the watchlist's reaction to a read it never completed.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { executionMode, TradingStateStrip } from "@/components/tv/TradingStateStrip";
import { unresolvedSymbolReason } from "@/lib/errorCopy";
import type { ManualTradingState } from "@/lib/api";
import { EXECUTION_ENVIRONMENT_TONE } from "@/lib/executionEnvironment";

beforeEach(resetBrowser);
after(closeBrowser);

function state(over: Partial<ManualTradingState> = {}): ManualTradingState {
  return {
    enabled: true, mainnetEnabled: false, dryRun: true, mixed: false,
    accounts: [], orders: [], positions: [],
    protection: { type: "bot-managed", exchangeResting: false, note: "" },
    ...over,
  };
}

// ── The execution badge ─────────────────────────────────────────────────────

test("a bot that was never contacted is not reported as being in dry-run", async () => {
  /*
   * When manual trading is disabled the Platform answers its own state route,
   * hard-coded `dryRun: true`, with a comment saying no Bot is contacted. The
   * badge read that one boolean and rendered PAPER with the tooltip "the
   * execution bot is in dry-run: orders are simulated" — a positive claim about
   * a bot nothing had spoken to. The asserted value was the safe one; the
   * source of truth was a constant the Platform wrote for itself.
   */
  const disconnected = executionMode(state({ enabled: false }));
  assert.equal(disconnected.mode, "disconnected");
  assert.equal(disconnected.label, "NOT CONNECTED");
  assert.doesNotMatch(disconnected.title, /the execution bot (is|reports)/i,
    "nothing may be asserted about a bot that was never contacted");
  assert.match(disconnected.title, /no execution bot was contacted/i);

  render(<TradingStateStrip state={state({ enabled: false })} symbol="BTCUSDT"
    readAt={Date.now()} onOpenTicket={() => {}} />);
  await settle();
  assert.ok(screen.getByText("NOT CONNECTED"));
  // And the positions empty state is a claim about accounts there are none of.
  assert.ok(screen.getByText(/no accounts to report positions for/i));
});

test("the states a connected bot can actually be in are distinguished", () => {
  const testnet = { id: "t", name: "T", exchange: "binance", marketType: "spot", testnet: true, mode: "testnet" as const };
  const mainnet = { id: "m", name: "M", exchange: "binance", marketType: "spot", testnet: false, mode: "mainnet" as const };
  assert.equal(executionMode(state({ dryRun: true })).mode, "dry_run");
  assert.equal(executionMode(state({ dryRun: false, accounts: [testnet] })).mode, "testnet");
  assert.equal(executionMode(state({ dryRun: false, accounts: [mainnet] })).mode, "real");
  // No account to say where orders go: not "real", not "live" — unknown.
  assert.equal(executionMode(state({ dryRun: false, accounts: [] })).mode, "unknown");
  // `mixed` was on the wire and read nowhere: a set of accounts that disagree
  // has no single answer, and a global chip is a lie whichever way it points.
  assert.equal(executionMode(state({ dryRun: true, mixed: true })).mode, "mixed");
  assert.equal(executionMode(state({ dryRun: false, mixed: true })).mode, "mixed");
  assert.match(executionMode(state({ mixed: true })).title, /do not agree/i);

  for (const over of [{ dryRun: true }, { dryRun: false, accounts: [testnet] },
    { dryRun: false, accounts: [mainnet] }, { dryRun: false }, { mixed: true }]) {
    const badge = executionMode(state(over));
    assert.match(badge.title, /the execution bot reports/i,
      `${badge.mode} is a report FROM the bot and should be worded as one`);
  }
});

test("D3: the strip never says LIVE, and says REAL only when every account is mainnet", async () => {
  /*
   * The chip read LIVE — "orders are real Spot orders on the exchange" —
   * whenever dry-run was off and the accounts agreed, including when every
   * account was testnet: exactly the testnet validation an operator is asked
   * to do, labelled as real money. It now uses the Journal's and the chart
   * overlay's own words.
   */
  const account = (id: string, isTestnet: boolean) => ({ id, name: id, exchange: "binance",
    marketType: "spot", testnet: isTestnet, mode: isTestnet ? "testnet" as const : "mainnet" as const });
  const cases: Array<[Partial<ManualTradingState>, string]> = [
    [{ dryRun: true, accounts: [account("a", true)] }, "DRY RUN"],
    [{ dryRun: false, accounts: [account("a", true), account("b", true)] }, "TESTNET"],
    [{ dryRun: false, accounts: [account("a", false)] }, "REAL"],
    [{ dryRun: false, accounts: [] }, "UNKNOWN"],
  ];
  for (const [over, label] of cases) {
    const badge = executionMode(state(over));
    assert.equal(badge.label, label, JSON.stringify(over));
    assert.notEqual(badge.label, "LIVE");
    assert.notEqual(badge.label, "PAPER", "PAPER is the Platform's paper engine, not the bot's dry run");
    if (label !== "REAL") assert.doesNotMatch(badge.title, /real Spot orders/i, label);
  }

  const { unmount } = render(<TradingStateStrip state={state({ dryRun: false, accounts: [account("a", true)] })}
    symbol="BTCUSDT" readAt={Date.now()} onOpenTicket={() => {}} />);
  await settle();
  const chip = screen.getByText("TESTNET");
  assert.equal(chip.getAttribute("data-execution-mode"), "testnet");
  // The Journal badge's colour for the same word.
  assert.ok(chip.className.includes(EXECUTION_ENVIRONMENT_TONE.TESTNET), "the TESTNET chip colour");
  assert.equal(document.body.textContent?.includes("LIVE"), false, "LIVE is on the page");
  unmount();
});

// ── The Screener's unresolved rows ──────────────────────────────────────────

test("a provider's own words are never the sentence a reader meets first", () => {
  /*
   * Live, this install's scanner returns 36 of 36 rows unresolved, each
   * carrying an HTTP status, a vendor URL and a clause of Binance's terms of
   * service — and the table rendered that string as the row body. The whole
   * Screener was one error message repeated 36 times.
   */
  const geo = "exchange unreachable: binance GET https://api.binance.com/api/v3/exchangeInfo 451 "
    + '{"code":0,"msg":"Service unavailable from a restricted location according to '
    + "'b. Eligibility' in https://www.binance.com/en/terms\"}";
  const sentence = unresolvedSymbolReason(geo);
  for (const leak of ["https://", "451", "binance.com", "exchangeInfo", "{", "Eligibility"]) {
    assert.ok(!sentence.includes(leak),
      `the reader's sentence still carries ${JSON.stringify(leak)}`);
  }
  // Geo-restriction gets its own wording: it is not a fault an operator can
  // retry their way out of, and "try again shortly" would send them in a loop.
  assert.match(sentence, /refuses requests from this location/i);
  assert.match(sentence, /not a fault with the symbol/i);

  assert.match(unresolvedSymbolReason("fetch failed"), /could not be reached/i);
  assert.match(unresolvedSymbolReason("404 unknown symbol"), /does not list this symbol/i);
  assert.match(unresolvedSymbolReason(null), /could not be resolved/i);
  // Whatever the cause, the reader is never handed a status code.
  for (const note of [geo, "fetch failed", "500 boom", "403 forbidden", null]) {
    assert.doesNotMatch(unresolvedSymbolReason(note), /\b\d{3}\b/,
      "a status code reached the page copy");
  }
});
