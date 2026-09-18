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

test("the three states a connected bot can actually be in are distinguished", () => {
  assert.equal(executionMode(state({ dryRun: true })).mode, "paper");
  assert.equal(executionMode(state({ dryRun: false })).mode, "live");
  // `mixed` was on the wire and read nowhere: a set of accounts that disagree
  // has no single answer, and a global chip is a lie whichever way it points.
  assert.equal(executionMode(state({ dryRun: true, mixed: true })).mode, "mixed");
  assert.equal(executionMode(state({ dryRun: false, mixed: true })).mode, "mixed");
  assert.match(executionMode(state({ mixed: true })).title, /do not agree/i);

  for (const mode of ["paper", "live", "mixed"] as const) {
    const badge = executionMode(state({
      dryRun: mode !== "live", mixed: mode === "mixed",
    }));
    assert.match(badge.title, /the execution bot reports/i,
      `${mode} is a report FROM the bot and should be worded as one`);
  }
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
