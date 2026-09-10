/**
 * Manual ticket safety — the three P0 defects, and the rules that close them.
 *
 * The defects, all reverified as present against this component before the fix:
 *
 *   D1  changing the chart symbol left an already-staged order ticket armed for
 *       the newly selected instrument. The panel is not remounted on a symbol
 *       change — it is the same instance with a new prop — so an amount, limit
 *       price, TP, SL and chosen position all carried over.
 *   D2  the real-mainnet-funds attestation survived an instrument change, and
 *       so did an OPEN confirmation dialog: it re-rendered naming the new
 *       symbol with the old tick still on and its confirm button live.
 *   D3  the SELL position picker was scoped to the account but NOT to the
 *       symbol. Choosing another instrument's position filled the amount box
 *       with that instrument's quantity while the submitted order still carried
 *       the current chart's symbol.
 *
 * The behavioural rules are unit-tested here; the wiring is pinned against the
 * component source, because this repository's frontend suite has no DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EMPTY_TICKET, baseAssetOf, isTicketStaged, positionsForSymbol, resetForAccountChange,
  resetForSymbolChange, sameSymbol, ticketSubmitBlocker, type StagedTicket,
} from "../lib/manualTicket";
import type { ManualPosition } from "../lib/api";

const PANEL = path.join(__dirname, "..", "components", "tv", "ManualTradingPanel.tsx");
const panel = (): string => fs.readFileSync(PANEL, "utf8");

const staged: StagedTicket = {
  amount: "0.5", limitPrice: "180.25", tp: "200", sl: "150",
  positionId: "pos-1", mainnetConfirmed: true, orderRequestId: "req-1", confirming: true,
};

const position = (over: Partial<ManualPosition> = {}): ManualPosition => ({
  id: "pos-1", exchangeAccountId: "acct-1", pair: "SOLUSDT", status: "active",
  entryPrice: 180, currentPrice: 190, quantity: 0.5, quoteSpent: 90,
  pnlUsdt: 5, pnlPct: 5, manualTpPrice: null, manualSlPrice: null,
  protectionType: null, protectionState: null,
  createdAt: "", closedAt: null, closedReason: null, ...over,
});

// ── D1: a symbol change disarms the ticket ─────────────────────────────────

test("a staged ticket is recognised as staged, by any one of its fields", () => {
  assert.equal(isTicketStaged(EMPTY_TICKET), false);
  for (const field of Object.keys(staged) as Array<keyof StagedTicket>) {
    const one = { ...EMPTY_TICKET, [field]: staged[field] } as StagedTicket;
    assert.equal(isTicketStaged(one), true, `${field} did not count as staged`);
  }
});

test("a symbol change clears EVERY instrument-specific field", () => {
  const after = resetForSymbolChange();
  assert.deepEqual(after, EMPTY_TICKET);
  // Stated field by field, so adding a new staged field without clearing it
  // fails here rather than in production.
  assert.equal(after.amount, "");
  assert.equal(after.limitPrice, "");
  assert.equal(after.tp, "");
  assert.equal(after.sl, "");
  assert.equal(after.positionId, "");
  assert.equal(after.mainnetConfirmed, false, "D2: the attestation must not survive");
  assert.equal(after.confirming, false, "D2: an open confirmation must not survive");
  assert.equal(after.orderRequestId, null,
    "an idempotency key for one order must not be reused for another instrument");
});

test("the component resets the ticket on a symbol change, keyed on the symbol alone", () => {
  const src = panel();
  const effect = src.slice(src.indexOf("useEffect(() => {\n    setDisarmedFrom("));
  const body = effect.slice(0, effect.indexOf("}, [symbol]);"));
  assert.ok(body.length > 0, "no symbol-change reset effect is present");
  for (const setter of ["setAmount(", "setLimitPrice(", "setTp(", "setSl(", "setPositionId(",
    "setMainnetConfirmed(", "setOrderRequestId(", "setConfirming("]) {
    assert.ok(body.includes(setter), `the symbol-change reset does not clear ${setter}`);
  }
  assert.match(body, /resetForSymbolChange\(\)/,
    "the component must use the tested rule, not a second private copy of it");
});

test("the panel is not remounted per symbol, which is why the effect has to exist", () => {
  // If a future change adds `key={symbol}` this reset becomes redundant rather
  // than wrong — but its absence today is exactly what made D1 reachable.
  const chart = fs.readFileSync(path.join(__dirname, "..", "app", "chart", "page.tsx"), "utf8");
  const usage = chart.slice(chart.indexOf("<ManualTradingPanel"));
  assert.doesNotMatch(usage.slice(0, 200), /key=\{symbol\}/);
});

// ── D2: the attestation ────────────────────────────────────────────────────

test("an account change drops the attestation and the chosen position, and keeps the numbers", () => {
  const after = resetForAccountChange(staged);
  assert.equal(after.mainnetConfirmed, false);
  assert.equal(after.positionId, "");
  assert.equal(after.confirming, false);
  // The instrument did not move, so what was typed is still meaningful.
  assert.equal(after.amount, "0.5");
  assert.equal(after.limitPrice, "180.25");
  assert.equal(after.tp, "200");
  assert.equal(after.sl, "150");
});

test("the component resets the attestation on an account change", () => {
  const src = panel();
  const handler = src.slice(src.indexOf('<select id="manual-account"'));
  assert.match(handler.slice(0, 1200), /resetForAccountChange\(/);
});

test("X3A exposes no production activation or real-funds order control", () => {
  const src = panel();
  assert.doesNotMatch(src, /arm\(setMainnetConfirmed\)/);
  assert.doesNotMatch(src, /I confirm this order uses real funds/);
  assert.match(src, /PAPER \/ TESTNET ONLY/);
  assert.match(src, /Production activation is unavailable/);
  assert.match(src, /safeAccountIds\.has\(order\.exchangeAccountId\)/,
    "production-account history must not appear under a paper/testnet heading");
});

// ── D3: the SELL position picker ───────────────────────────────────────────

test("the picker shows only positions on the current symbol and account", () => {
  const positions = [
    position({ id: "same", pair: "SOLUSDT" }),
    position({ id: "other-symbol", pair: "ETHUSDT" }),
    position({ id: "other-account", pair: "SOLUSDT", exchangeAccountId: "acct-2" }),
    position({ id: "closed", pair: "SOLUSDT", status: "closed" }),
  ];
  const shown = positionsForSymbol(positions, { symbol: "SOLUSDT", accountId: "acct-1" });
  assert.deepEqual(shown.map((p) => p.id), ["same"]);
});

test("scoping never hides a position that DOES belong to this instrument", () => {
  const positions = [
    position({ id: "a", pair: "SOLUSDT" }),
    position({ id: "b", pair: "sol/usdt" }),
    position({ id: "c", pair: "SOLUSDT" }),
  ];
  const shown = positionsForSymbol(positions, { symbol: "SOLUSDT", accountId: "acct-1" });
  assert.deepEqual(shown.map((p) => p.id), ["a", "b", "c"],
    "an exit must never be made harder to reach");
});

test("symbol comparison is normalised, and an empty symbol matches nothing", () => {
  assert.equal(sameSymbol("SOLUSDT", "sol/usdt"), true);
  assert.equal(sameSymbol("SOLUSDT", "ETHUSDT"), false);
  assert.equal(sameSymbol("", ""), false);
  assert.equal(sameSymbol("", "SOLUSDT"), false);
  assert.equal(baseAssetOf("SOLUSDT"), "SOL");
  assert.equal(baseAssetOf("sol/usdt"), "SOL");
});

test("the component uses the scoped list, not a bare account filter", () => {
  const src = panel();
  assert.match(src, /positionsForSymbol\(state\?\.positions, \{ symbol, accountId \}\)/);
  assert.doesNotMatch(src,
    /state\?\.positions\.filter\(\(p\) =>\s*\n?\s*p\.status === "active" && p\.exchangeAccountId === accountId\)/,
    "the unscoped filter must be gone, not merely shadowed");
});

// ── The submit guard ───────────────────────────────────────────────────────

const guard = (over: Partial<Parameters<typeof ticketSubmitBlocker>[0]> = {}) =>
  ticketSubmitBlocker({
    armedSymbol: "SOLUSDT", currentSymbol: "SOLUSDT",
    armedAccountId: "acct-1", currentAccountId: "acct-1",
    positionId: "", side: "BUY", selectablePositions: [], ...over,
  });

test("a ticket armed for the current symbol and account submits", () => {
  assert.equal(guard(), null);
});

test("a ticket armed for another symbol cannot be submitted, and the message names both", () => {
  const blocked = guard({ armedSymbol: "ETHUSDT" });
  assert.ok(blocked);
  assert.match(blocked!, /ETHUSDT/);
  assert.match(blocked!, /SOLUSDT/);
});

test("a ticket armed for another account cannot be submitted", () => {
  assert.ok(guard({ armedAccountId: "acct-2" }));
});

test("an unarmed ticket is not blocked — nothing has been staged to be stale", () => {
  assert.equal(guard({ armedSymbol: null, armedAccountId: null }), null);
});

test("a SELL naming a position that is not selectable here is refused", () => {
  const blocked = guard({ side: "SELL", positionId: "pos-9", selectablePositions: [] });
  assert.ok(blocked);
  assert.match(blocked!, /SOLUSDT/);
  // And the same SELL is fine once the position really is on this symbol.
  assert.equal(guard({ side: "SELL", positionId: "pos-1",
    selectablePositions: [position()] }), null);
});

test("an unassociated wallet SELL is never blocked by the guard", () => {
  assert.equal(guard({ side: "SELL", positionId: "", selectablePositions: [] }), null,
    "selling without naming a position must stay available");
});

test("submit refuses a stale ticket even if the disabled state were wrong", () => {
  const src = panel();
  const submit = src.slice(src.indexOf("const submit = async () => {"));
  const body = submit.slice(0, submit.indexOf("\n  };"));
  assert.match(body, /if \(staleTicket\)/,
    "submit must re-check staleness itself, not trust the button");
  assert.ok(body.indexOf("if (staleTicket)") < body.indexOf("api.submitManualOrder"),
    "the check must precede the request");
});

test("the ticket's target instrument is stated in the panel itself", () => {
  const src = panel();
  assert.match(src, /data-testid="manual-ticket-target"/);
  assert.match(src, /Ticket cleared: it was prepared for \{disarmedFrom\}/);
});

test("nothing in these rules can disable selling", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "manualTicket.ts"), "utf8");
  // The module must never gate a side; it scopes a list and compares identity.
  assert.doesNotMatch(src, /side === "SELL"[^\n]*return (false|null);\s*\n\s*.*block/i);
  assert.match(src, /must not make an exit harder/,
    "the invariant is stated in the module, so a later edit has to confront it");
});
