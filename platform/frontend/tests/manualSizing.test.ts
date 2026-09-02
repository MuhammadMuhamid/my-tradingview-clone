/**
 * Sizing, quoting and refusal evidence at the trading ticket.
 *
 * The through-line of every assertion here is the same: these numbers help a
 * human choose, and none of them may ever widen what executes. The execution
 * bot re-reads the balance, re-applies Binance's filters and re-runs its risk
 * and Shariah checks at submission; a figure shown in the ticket that is stale
 * or wrong must cost a rejection, never an oversized order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decimalsForStep, floorToStep, maximumOrder, preSubmitProblem, quickFillAmount,
  QUICK_FILL_PERCENTS, relativePriceHint, spreadOf, type ManualAccountState,
} from "../lib/manualSizing";
import { classifyRefusal, isRefused, toTradeEvent } from "../lib/tradeEvents";
import type { ManualOrder } from "../lib/api";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const state = (over: Partial<ManualAccountState> = {}): ManualAccountState => ({
  symbol: "SOLUSDT",
  base: { asset: "SOL", free: 12.3456789, locked: 2 },
  quote: { asset: "USDT", free: 60.86, locked: 10 },
  rules: { lotStep: 0.001, minQty: 0.001, priceTick: 0.01, minNotional: 5 },
  simulated: false, ...over,
});

// ── C2: what is actually available ─────────────────────────────────────────

test("the maximum BUY is free quote; the maximum SELL is free base, on the lot step", () => {
  assert.deepEqual(maximumOrder(state(), "BUY"), { amount: 60.86, asset: "USDT" });
  assert.deepEqual(maximumOrder(state(), "SELL"), { amount: 12.345, asset: "SOL" });
});

test("locked funds are never counted as available", () => {
  const s = state({ quote: { asset: "USDT", free: 0, locked: 500 } });
  assert.equal(maximumOrder(s, "BUY")!.amount, 0);
});

test("with no account reading there is no maximum, and nothing is claimed", () => {
  assert.equal(maximumOrder(null, "BUY"), null);
  assert.equal(preSubmitProblem({ state: null, side: "BUY", amount: "1e9", referencePrice: 1 }), null);
});

// ── C2: pre-submit validation names the ACTUAL maximum ─────────────────────

test("an oversized order is refused and the message states the real maximum", () => {
  const problem = preSubmitProblem({ state: state(), side: "BUY", amount: "100",
    referencePrice: 180 });
  assert.ok(problem);
  assert.match(problem!, /60\.86 USDT/);
  assert.match(problem!, /Maximum order at current state/);
});

test("validation can never authorise MORE than is displayed as available", () => {
  const s = state();
  const max = maximumOrder(s, "BUY")!.amount;
  // Anything at or below the stated maximum passes the size check; anything
  // above it does not. There is no third outcome.
  assert.equal(preSubmitProblem({ state: s, side: "BUY", amount: String(max),
    referencePrice: 180 }), null);
  for (const over of [max + 1e-6, max + 0.01, max * 2]) {
    assert.ok(preSubmitProblem({ state: s, side: "BUY", amount: String(over), referencePrice: 180 }),
      `${over} was allowed above the displayed maximum of ${max}`);
  }
});

test("exchange minimums and lot steps are stated before submitting, not after", () => {
  const s = state();
  assert.match(preSubmitProblem({ state: s, side: "BUY", amount: "1", referencePrice: 180 })!,
    /Minimum order value/);
  assert.match(preSubmitProblem({ state: s, side: "SELL", amount: "0.0005",
    referencePrice: 180 })!, /Minimum order size/);
  assert.match(preSubmitProblem({ state: s, side: "SELL", amount: "1.00042",
    referencePrice: 180 })!, /multiple of/);
  assert.match(preSubmitProblem({ state: s, side: "SELL", amount: "0.001",
    referencePrice: 1 })!, /below the 5 USDT minimum/);
});

// ── C3: quick fill ─────────────────────────────────────────────────────────

test("quick fill derives from available quote for BUY and available base for SELL", () => {
  assert.equal(quickFillAmount(state(), "BUY", 100), "60.86");
  assert.equal(quickFillAmount(state(), "BUY", 50), "30.43");
  assert.equal(quickFillAmount(state(), "SELL", 100), "12.345");
  assert.equal(quickFillAmount(state(), "SELL", 50), "6.172");
});

test("every quick-fill percentage produces an amount the validation then accepts", () => {
  const s = state();
  for (const pct of QUICK_FILL_PERCENTS) {
    for (const side of ["BUY", "SELL"] as const) {
      const amount = quickFillAmount(s, side, pct);
      if (amount === "") continue;
      const max = maximumOrder(s, side)!.amount;
      assert.ok(Number(amount) <= max,
        `${side} ${pct}% produced ${amount}, above the maximum ${max}`);
      // Only a minimum-size complaint is acceptable for the small percentages;
      // an "insufficient balance" from our own quick fill would be a bug.
      const problem = preSubmitProblem({ state: s, side, amount, referencePrice: 180 });
      assert.doesNotMatch(problem ?? "", /is available/,
        `${side} ${pct}% asked for more than is available`);
    }
  }
});

test("quick fill floors onto the lot step, so 100% can never exceed the balance", () => {
  const s = state({ base: { asset: "SOL", free: 0.9999999, locked: 0 } });
  const amount = quickFillAmount(s, "SELL", 100);
  assert.equal(amount, "0.999");
  assert.ok(Number(amount) <= 0.9999999);
});

test("an empty balance quick-fills to nothing rather than to zero", () => {
  const s = state({ quote: { asset: "USDT", free: 0, locked: 0 } });
  assert.equal(quickFillAmount(s, "BUY", 100), "");
  assert.equal(quickFillAmount(null, "BUY", 100), "");
});

test("step arithmetic never rounds up", () => {
  assert.equal(floorToStep(1.9999, 1), 1);
  assert.equal(floorToStep(0.30000000000000004, 0.1), 0.3);
  assert.equal(floorToStep(5, 0), 5);
  assert.equal(floorToStep(-1, 0.1), 0);
  assert.equal(decimalsForStep(0.001), 3);
  assert.equal(decimalsForStep(1), 0);
});

// ── C1: the quote is real or it is absent ──────────────────────────────────

test("a spread is computed from a real two-sided quote, and only from one", () => {
  assert.deepEqual(spreadOf({ bid: 99.9, ask: 100.1 }),
    { absolute: 100.1 - 99.9, bps: ((100.1 - 99.9) / 100) * 10_000 });
  assert.equal(spreadOf(null), null);
  assert.equal(spreadOf({ bid: 0, ask: 100 }), null);
  assert.equal(spreadOf({ bid: 100, ask: 0 }), null);
  // A crossed book is not a spread; it is bad data.
  assert.equal(spreadOf({ bid: 101, ask: 100 }), null);
});

test("the quote comes from the live book stream, never from candle OHLC", () => {
  const hook = read("lib/useBookQuote.ts");
  assert.match(hook, /@bookTicker/);
  // Comments may discuss candles; the stream it opens must not be one.
  const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /@kline|klines|ohlc/i);
  // A symbol change must clear the previous instrument's quote immediately.
  assert.match(hook, /setQuote\(null\);/);
  const panel = read("components/tv/ManualTradingPanel.tsx");
  assert.match(panel, /useBookQuote\(symbol\)/);
  // When there is no quote the panel says so rather than showing a last trade
  // labelled as a bid or an ask.
  assert.match(panel, /that is a last\s+trade, not a bid or an ask/);
});

// ── C4: the relative price hint is explanatory only ────────────────────────

test("the price hint counts real ticks against the live book", () => {
  const quote = { bid: 100, ask: 100.1 };
  assert.equal(relativePriceHint({ limitPrice: "100.15", quote, tickSize: 0.01 }),
    "Ask + 5 ticks");
  assert.equal(relativePriceHint({ limitPrice: "99.95", quote, tickSize: 0.01 }),
    "Bid − 5 ticks");
  assert.equal(relativePriceHint({ limitPrice: "100.1", quote, tickSize: 0.01 }), "At ask");
  assert.equal(relativePriceHint({ limitPrice: "100", quote, tickSize: 0.01 }), "At bid");
  assert.equal(relativePriceHint({ limitPrice: "100.11", quote, tickSize: 0.01 }),
    "Ask + 1 tick");
});

test("the hint is absent rather than guessed when anything it needs is missing", () => {
  const quote = { bid: 100, ask: 100.1 };
  assert.equal(relativePriceHint({ limitPrice: "", quote, tickSize: 0.01 }), null);
  assert.equal(relativePriceHint({ limitPrice: "100", quote: null, tickSize: 0.01 }), null);
  assert.equal(relativePriceHint({ limitPrice: "100", quote, tickSize: 0 }), null);
});

test("the hint never writes back into the submitted price", () => {
  const panel = read("components/tv/ManualTradingPanel.tsx");
  const hint = panel.slice(panel.indexOf('data-testid="manual-price-hint"'));
  assert.doesNotMatch(hint.slice(0, 200), /setLimitPrice|arm\(/,
    "the hint must be read-only; it explains a value, it does not set one");
});

// ── C5: refusals are distinguishable ───────────────────────────────────────

const order = (over: Partial<ManualOrder> = {}): ManualOrder => ({
  id: "o1", requestId: "r1", exchangeAccountId: "a1", symbol: "SOLUSDT", side: "BUY",
  orderType: "MARKET", quantityType: "quote", requestedBaseQty: null, requestedQuoteQty: 10,
  limitPrice: null, takeProfitPrice: null, stopLossPrice: null, protectionType: null,
  protectionState: null, status: "rejected", exchangeOrderId: null, clientOrderId: "c1",
  filledBaseQty: 0, filledQuoteQty: 0, averageFillPrice: null, error: null,
  submittedAt: null, completedAt: null, createdAt: "2026-09-02T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z", ...over,
} as ManualOrder);

test("a Shariah refusal is never mistaken for an exchange failure", () => {
  for (const detail of [
    "SHARIAH_REVIEW_BLOCKED: SOLUSDT: new spot exposure is not permitted",
    "SHARIAH_EXCLUDED_BLOCKED: ...",
    "SHARIAH_CONTEXT_REQUIRED: ...",
    "SHARIAH_EVIDENCE_UNVERIFIED: ...",
    "SHARIAH_ASSET_MISMATCH: ...",
    "SHARIAH_POLICY_MISMATCH: ...",
  ]) {
    assert.equal(classifyRefusal(detail), "shariah", detail);
  }
});

test("auth, risk, halt and exchange refusals are each their own class", () => {
  assert.equal(classifyRefusal("manual signature invalid (401)"), "auth");
  assert.equal(classifyRefusal("nonce already used"), "auth");
  assert.equal(classifyRefusal("trading is halted"), "halt");
  assert.equal(classifyRefusal("Max entry orders reached"), "risk");
  assert.equal(classifyRefusal("Binance: -2010 Insufficient balance"), "exchange");
  assert.equal(classifyRefusal("LOT_SIZE filter failure"), "exchange");
});

test("an unrecognised refusal stays unknown rather than being guessed at", () => {
  assert.equal(classifyRefusal("something nobody has seen before"), "unknown");
  assert.equal(classifyRefusal(null), "unknown");
  assert.equal(classifyRefusal(""), "unknown");
});

test("a blocked trade appears truthfully, with its own reason and no invention", () => {
  const blocked = toTradeEvent(order({ status: "rejected",
    error: "SHARIAH_EXCLUDED_BLOCKED: SOLUSDT: not permitted" }));
  assert.equal(blocked.refusal!.class, "shariah");
  assert.equal(blocked.refusal!.label, "Shariah policy");
  assert.equal(blocked.refusal!.detail, "SHARIAH_EXCLUDED_BLOCKED: SOLUSDT: not permitted");
  assert.equal(blocked.symbol, "SOLUSDT");
  assert.equal(blocked.status, "rejected");
});

test("an order that succeeded is never dressed up as a refusal", () => {
  const filled = toTradeEvent(order({ status: "filled", error: null }));
  assert.equal(filled.refusal, null);
  assert.equal(isRefused(order({ status: "filled", error: null })), false);
  assert.equal(isRefused(order({ status: "canceled", error: null })), false,
    "an operator cancelling their own order is not a refusal");
  assert.equal(isRefused(order({ status: "canceled", error: "Binance rejected the cancel" })), true);
});

test("the order log is account-wide, so a rejection is findable without guessing the chart", () => {
  const panel = read("components/tv/ManualTradingPanel.tsx");
  assert.match(panel, /await api\.manualState\(\)/,
    "the panel must not scope the order log to the current symbol");
  assert.match(panel, /id: "blocked"/, "policy refusals need their own bucket");
  assert.match(panel, /data-testid="manual-refusal-class"/);
});

test("the account reading is bound to the symbol AND account it was asked for", () => {
  const panel = read("components/tv/ManualTradingPanel.tsx");
  const effect = panel.slice(panel.indexOf("setAccountState(null);"));
  const body = effect.slice(0, effect.indexOf("}, [symbol, accountId]);"));
  assert.match(body, /next\.symbol === symbol/,
    "a reading for another symbol must never be accepted as this one's");
  assert.ok(body.indexOf("setAccountState(null)") < body.indexOf("api.manualAccountState"),
    "the previous pair's balance must be cleared before the new one is requested");
});

test("no Binance credential is required by the Platform for any of this", () => {
  // The balance comes from the execution bot over the existing authenticated
  // boundary; the Platform holds no exchange key and must not start to.
  const client = read("lib/api.ts");
  assert.match(client, /manualAccountState:/);
  assert.match(client, /\/api\/manual-trading\/account-state/);
  assert.doesNotMatch(read("lib/manualSizing.ts"), /apiKey|secret|binance\.com/i);
});
