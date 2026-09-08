/**
 * The trader-state strip under the chart, in each of its states.
 *
 * The defect this pins: after one successful read of positions and orders, a
 * later read failing (Bot unreachable, manual trading switched off) left the
 * last good tables on screen with nothing to say they were no longer current.
 * The strip now distinguishes loading, unavailable, current, empty and stale,
 * stamps a current read with its time, and puts an unmistakable warning —
 * the failure reason and the read time — over retained state. The bottom
 * drawer, for its part, must not open on a tab that can only show a notice.
 *
 * Rendered with react-dom/server: real markup, no browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clockLabel, TradingStateStrip, tradingStateFreshness,
} from "../components/tv/TradingStateStrip";
import type { ManualOrder, ManualPosition, ManualTradingState } from "../lib/api";
import {
  manualTradingPollingAllowed, noteManualTradingFailure,
  resetManualTradingPollingCapability,
} from "../lib/manualTradingPolling";

const ROOT = path.join(__dirname, "..");
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8");

const position: ManualPosition = {
  id: "pos-1", exchangeAccountId: "acct-1", pair: "BTCUSDT", status: "active",
  entryPrice: 60000, currentPrice: 60600, quantity: 0.01, quoteSpent: 600,
  pnlUsdt: 6, pnlPct: 1, manualTpPrice: 62000, manualSlPrice: 59000,
  protectionType: null, protectionState: null, createdAt: "2026-09-05T10:00:00Z", closedAt: null, closedReason: null,
};
const order: ManualOrder = {
  id: "ord-1", requestId: "r".repeat(16), exchangeAccountId: "acct-1", linkedPositionId: null,
  symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote",
  requestedBaseQty: null, requestedQuoteQty: 100, limitPrice: 59500,
  takeProfitPrice: null, stopLossPrice: null, protectionType: null, protectionState: null, status: "open",
  exchangeOrderId: null, clientOrderId: null, filledBaseQty: 0, filledQuoteQty: 0,
  averageFillPrice: null, error: null, submittedAt: null, completedAt: null,
  createdAt: "2026-09-05T10:01:00Z", updatedAt: "2026-09-05T10:01:00Z",
};
const state: ManualTradingState = {
  enabled: true, mainnetEnabled: false, dryRun: true, mixed: false,
  accounts: [{ id: "acct-1", name: "Paper", exchange: "binance", marketType: "spot", testnet: true, mode: "testnet" }],
  orders: [order], positions: [position],
  protection: { type: "bot-managed", exchangeResting: false, note: "" },
};
const empty: ManualTradingState = { ...state, orders: [], positions: [] };

/** A fixed local wall-clock moment, so the stamp is deterministic in any zone. */
const READ_AT = new Date(2026, 8, 5, 14, 3, 9).getTime();

function render(props: Partial<Parameters<typeof TradingStateStrip>[0]>): string {
  return renderToStaticMarkup(createElement(TradingStateStrip, {
    state: null, symbol: "BTCUSDT", onOpenTicket: () => {}, ...props,
  }));
}

test("the five states are told apart, from the same two inputs the page holds", () => {
  assert.equal(tradingStateFreshness(null, null), "loading");
  assert.equal(tradingStateFreshness(null, undefined), "loading");
  assert.equal(tradingStateFreshness(null, "manual trading is disabled"), "unavailable");
  assert.equal(tradingStateFreshness(state, null), "current");
  assert.equal(tradingStateFreshness(empty, null), "current");
  assert.equal(tradingStateFreshness(state, "the execution bot could not be reached"), "stale");
  assert.equal(clockLabel(READ_AT), "14:03:09");
});

test("loading and unavailable are different sentences, and neither shows a table", () => {
  const loading = render({});
  assert.match(loading, /Reading positions and orders from the execution bot/);
  assert.doesNotMatch(loading, /<table/);

  const unavailable = render({ unavailable: "manual trading is disabled" });
  assert.match(unavailable, /manual trading is disabled/);
  assert.doesNotMatch(unavailable, /Reading positions/);
  assert.doesNotMatch(unavailable, /<table/);
});

test("a current read is stamped with its time and carries no warning", () => {
  const html = render({ state, readAt: READ_AT });
  assert.match(html, /read 14:03:09/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /Could not refresh/);
  assert.match(html, /BTCUSDT/);
  assert.match(html, /\+6\.00 USDT/);
  assert.match(html, /text-up/, "a current P&amp;L keeps its colour");

  const nothingOpen = render({ state: empty, readAt: READ_AT });
  assert.match(nothingOpen, /No open position on any account/);
  assert.match(nothingOpen, /read 14:03:09/);
  assert.doesNotMatch(nothingOpen, /role="alert"/);
});

test("A FAILED REFRESH OVER RETAINED STATE IS SAID OUT LOUD: THE REASON, THE READ TIME, NO P&L COLOUR", () => {
  const html = render({ state, readAt: READ_AT, unavailable: "the execution bot could not be reached" });
  // The retained figures are still there — the Bot's own numbers, unchanged…
  assert.match(html, /BTCUSDT/);
  assert.match(html, /\+6\.00 USDT/);
  // …under a warning that names the failure and when the figures were read.
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not refresh positions and orders: the execution bot could not be reached\./);
  assert.match(html, /Showing the state read at 14:03:09; it may have changed since\./);
  // The header's "read HH:MM:SS" would read as current; the warning replaces it.
  assert.doesNotMatch(html, /read 14:03:09<\/span>/);
  // A P&amp;L colour asserts a live figure; retained state has none.
  assert.doesNotMatch(html, /text-up/);
  assert.doesNotMatch(html, /text-down">\+6/);
  assert.match(html, /text-ink-muted">\s*\+6\.00 USDT/);

  // Nothing is invented: the same rows, no more, as the current render.
  const current = render({ state, readAt: READ_AT });
  assert.equal((html.match(/<tr/g) ?? []).length, (current.match(/<tr/g) ?? []).length);

  // A stale read with no time known still warns, without inventing one.
  assert.match(render({ state, unavailable: "x" }), /Showing the last state read; it may have changed since\./);
});

test("the chart page records each successful read, and the panel passes the time through", () => {
  const page = read("app/chart/page.tsx");
  assert.match(page, /const \[manualReadAt, setManualReadAt\] = useState<number \| null>\(null\);/);
  const record = /const recordManualState = useCallback\(\(next: ManualTradingState \| null\) => \{([\s\S]*?)\}, \[\]\);/.exec(page);
  assert.ok(record, "recordManualState could not be located");
  for (const call of ["setManualState(next);", "setManualReadAt(Date.now());", "setManualUnavailable(null);"]) {
    assert.ok(record[1]!.includes(call), `a successful read must ${call}`);
  }
  // Both readers — the page's poll and the ticket — go through it, and a
  // failure records only the reason: the last good state is kept.
  assert.match(page, /if \(live\) recordManualState\(next\);/);
  assert.match(page, /onManualState=\{recordManualState\}/);
  assert.match(page, /noteManualTradingFailure\(message\);/);
  assert.match(page, /if \(live\) setManualUnavailable\(message\);/);
  assert.doesNotMatch(page, /catch[^}]*setManualState\(null\)/, "a failed refresh must not discard retained state");
  assert.match(read("components/tv/ChartBottomPanel.tsx"), /readAt=\{props\.manualReadAt\}/);
});

test("a disabled capability is learned once and suppresses every later poll", () => {
  resetManualTradingPollingCapability();
  assert.equal(manualTradingPollingAllowed(), true);
  assert.equal(noteManualTradingFailure("temporary network error"), false);
  assert.equal(manualTradingPollingAllowed(), true, "transient failures remain retryable");
  assert.equal(noteManualTradingFailure("manual trading is disabled"), true);
  assert.equal(manualTradingPollingAllowed(), false);
  assert.equal(noteManualTradingFailure("anything later"), true,
    "the installation capability remains terminal for this browser session");
  resetManualTradingPollingCapability();
});

test("the bottom drawer does not open on a tab that can only show a notice", () => {
  const panel = read("components/tv/ChartBottomPanel.tsx");
  // The one rule: unavailable (no state, only a reason) moves trading → tester,
  // once, and never when the user has chosen a tab.
  assert.match(panel, /if \(userChoseTab\.current \|\| tradingStateFreshness\(manualState, manualUnavailable\) !== "unavailable"\) return;/);
  assert.match(panel, /setTab\(\(current\) => \(current === "trading" \? "tester" : current\)\);/);
  assert.match(panel, /userChoseTab\.current = true;/);
  // A read that once succeeded keeps the tab usable, so stale state is shown
  // under its warning rather than hidden behind a tab switch.
  assert.equal(tradingStateFreshness(state, "the execution bot could not be reached") !== "unavailable", true);
  // Capability detection is untouched: the panel still learns of manual
  // trading only through the same two props the strip reads.
  assert.doesNotMatch(panel, /manualTradingEnabled|api\.manualState/);
});
