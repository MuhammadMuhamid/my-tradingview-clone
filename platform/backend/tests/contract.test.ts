/**
 * The shared cross-repository webhook contract.
 *
 * Two jobs:
 *
 *   1. DRIFT — assert this repository's vendored copy still hashes to
 *      `CONTRACT_FINGERPRINT`. The bot repository runs the identical assertion
 *      against its own copy, so the two cannot diverge without a red build on
 *      both sides.
 *   2. ROUND TRIP — feed every payload the sender can emit through the
 *      validator the receiver uses. A boundary the sender reaches and the
 *      receiver rejects is exactly what X-01 was, and it now fails the build.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalizeContractSource,
  CONTRACT_FINGERPRINT,
  CONTRACT_VERSION,
  dedupeKey,
  emittablePayloads,
  EXIT_LEGS,
  httpStatusFor,
  isReceiverOutcome,
  legacyDedupeKey,
  LIMITS,
  mayAdvanceLocalState,
  orderPlaced,
  parseDedupeKey,
  RECEIVER_OUTCOMES,
  validateCustomBotPayload,
} from "../src/contract/webhookContract";

const CONTRACT_PATH = path.join(__dirname, "..", "src", "contract", "webhookContract.ts");
const SECRET = "s".repeat(40);

// ── Drift ───────────────────────────────────────────────────────────────────

test("the vendored contract still matches its recorded fingerprint", () => {
  const source = fs.readFileSync(CONTRACT_PATH, "utf8");
  const canonical = canonicalizeContractSource(source);
  const actual = `sha256:v${CONTRACT_VERSION}:${crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex")}`;
  assert.equal(
    actual,
    CONTRACT_FINGERPRINT,
    "The contract changed. Update BOTH repositories' copies and paste this hash " +
      `into CONTRACT_FINGERPRINT in both:\n  ${actual}\n`
  );
});

test("canonicalisation ignores line endings and trailing whitespace, but not content", () => {
  const source = fs.readFileSync(CONTRACT_PATH, "utf8");
  const base = canonicalizeContractSource(source);
  assert.equal(canonicalizeContractSource(source.replace(/\n/g, "\r\n")), base);
  assert.equal(canonicalizeContractSource(source.replace(/\n/g, "   \n")), base);
  assert.notEqual(canonicalizeContractSource(source.replace("CONTRACT_VERSION = 4", "CONTRACT_VERSION = 5")), base);
});

test("the fingerprint does not depend on its own value", () => {
  const source = fs.readFileSync(CONTRACT_PATH, "utf8");
  const withOtherHash = source.replace(CONTRACT_FINGERPRINT, "sha256:v2:" + "0".repeat(64));
  assert.equal(canonicalizeContractSource(withOtherHash), canonicalizeContractSource(source));
});

// ── Round trip ──────────────────────────────────────────────────────────────

test("EVERY payload the sender can emit is accepted by the receiver's validator", () => {
  const payloads = emittablePayloads(SECRET);
  assert.ok(payloads.length > 50, `expected a broad set, got ${payloads.length}`);
  for (const payload of payloads) {
    const result = validateCustomBotPayload(payload);
    assert.equal(
      result.ok,
      true,
      `rejected: ${JSON.stringify({ ...payload, secret: "[REDACTED]" })} -> ${
        result.ok ? "" : result.code
      }`
    );
  }
});

test("X-01: sell_percent of exactly 100 is accepted", () => {
  // The evaluator clamps to 100 whenever rrTp1Size + rrTp2Size >= 100 — a
  // 50/50 take-profit split makes the TP2 leg exactly 100.
  const rrTp1Size = 50;
  const rrTp2Size = 50;
  const already = rrTp1Size;
  const currentPct = Math.min(100, (rrTp2Size / Math.max(0.000001, 100 - already)) * 100);
  assert.equal(currentPct, 100);

  const result = validateCustomBotPayload({
    secret: SECRET,
    action: "sell",
    symbol: "APTUSDT",
    sell_percent: currentPct,
    exit_leg: "tp2",
    dedupe_key: dedupeKey("sell", 1_700_000_000_000, "tp2"),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.code);
});

test("sell_percent boundaries: 0 and anything above 100 are still refused", () => {
  const base = { secret: SECRET, action: "sell", symbol: "APTUSDT" };
  for (const pct of [0, -1, 100.0001, 101, Infinity, NaN]) {
    const r = validateCustomBotPayload({ ...base, sell_percent: pct });
    assert.equal(r.ok, false, `${pct} must be refused`);
    assert.equal(r.ok ? "" : r.code, "sell_percent");
  }
  assert.equal(validateCustomBotPayload({ ...base, sell_percent: LIMITS.sellPercentMax }).ok, true);
});

test("sell_percent is refused on an entry, and cannot be combined with quantity", () => {
  const buy = validateCustomBotPayload({
    secret: SECRET, action: "buy", symbol: "APTUSDT", sell_percent: 50,
  });
  assert.equal(buy.ok, false);
  assert.equal(buy.ok ? "" : buy.code, "sell_percent_on_buy");

  const both = validateCustomBotPayload({
    secret: SECRET, action: "sell", symbol: "APTUSDT", sell_percent: 50, quantity: 1,
  });
  assert.equal(both.ok, false);
  assert.equal(both.ok ? "" : both.code, "quantity_and_sell_percent");
});

test("the schema is strict — an unexpected field is refused with a machine-readable code", () => {
  const r = validateCustomBotPayload({
    secret: SECRET, action: "buy", symbol: "APTUSDT", price: 12.34,
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.code, "unknown_field");
});

test("secret, symbol, quantity and dedupe-key bounds are enforced", () => {
  const ok = { secret: SECRET, action: "buy", symbol: "APTUSDT" };
  assert.equal(validateCustomBotPayload({ ...ok, secret: "s".repeat(31) }).ok, false);
  assert.equal(validateCustomBotPayload({ ...ok, secret: "s".repeat(32) }).ok, true);
  assert.equal(validateCustomBotPayload({ ...ok, secret: "s".repeat(257) }).ok, false);
  assert.equal(validateCustomBotPayload({ ...ok, symbol: "AP" }).ok, false);
  assert.equal(validateCustomBotPayload({ ...ok, quote_order_qty: LIMITS.quoteOrderQtyMax + 1 }).ok, false);
  assert.equal(validateCustomBotPayload({ ...ok, quantity: 0 }).ok, false);
  assert.equal(validateCustomBotPayload({ ...ok, dedupe_key: "" }).ok, false);
  assert.equal(validateCustomBotPayload({ ...ok, dedupe_key: "x".repeat(257) }).ok, false);
  assert.equal(validateCustomBotPayload({ ...ok, exit_leg: "moon" }).ok, false);
});

test("either symbol or tv_instrument is required", () => {
  assert.equal(validateCustomBotPayload({ secret: SECRET, action: "buy" }).ok, false);
  assert.equal(
    validateCustomBotPayload({ secret: SECRET, action: "buy", tv_instrument: "BINANCE:APTUSDT" }).ok,
    true
  );
});

test("a non-object payload is refused rather than coerced", () => {
  for (const bad of [null, undefined, 42, "buy", [], true]) {
    const r = validateCustomBotPayload(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.ok ? "" : r.code, "not_an_object");
  }
});

// ── Dedupe key ──────────────────────────────────────────────────────────────

test("X-02: the dedupe key is derived from bar open time alone", () => {
  const barTime = 1_700_000_000_000;
  assert.equal(dedupeKey("buy", barTime), `L-${barTime}`);
  assert.equal(dedupeKey("sell", barTime), `X-${barTime}`);
  assert.equal(dedupeKey("sell", barTime, "tp1"), `X-${barTime}-tp1`);

  // The key no longer embeds a bar index, so the two senders — which compute
  // that quantity differently — now produce the SAME key for the same bar.
  const platformBarIndex = Math.floor(barTime / 900_000);
  const pineBarIndex = 4321;
  assert.notEqual(platformBarIndex, pineBarIndex);
  assert.equal(dedupeKey("buy", barTime), dedupeKey("buy", barTime));
  assert.notEqual(legacyDedupeKey("buy", platformBarIndex, barTime), legacyDedupeKey("buy", pineBarIndex, barTime));
});

test("keys are stable per (action, bar, leg) and distinct across each of them", () => {
  const t = 1_700_000_000_000;
  assert.equal(dedupeKey("sell", t, "tp1"), dedupeKey("sell", t, "tp1"));
  const keys = new Set([
    dedupeKey("buy", t),
    dedupeKey("sell", t),
    ...EXIT_LEGS.map((leg) => dedupeKey("sell", t, leg)),
    dedupeKey("buy", t + 900_000),
  ]);
  assert.equal(keys.size, 2 + EXIT_LEGS.length + 1);
});

test("a canonical key round-trips, and a legacy key is recognised as not canonical", () => {
  const t = 1_700_000_000_000;
  assert.deepEqual(parseDedupeKey(dedupeKey("buy", t)), { action: "buy", barOpenTimeMs: t });
  assert.deepEqual(parseDedupeKey(dedupeKey("sell", t, "stop")), {
    action: "sell", barOpenTimeMs: t, exitLeg: "stop",
  });
  assert.equal(parseDedupeKey(legacyDedupeKey("buy", 4321, t)), null);
  assert.equal(parseDedupeKey("garbage"), null);
  assert.equal(parseDedupeKey(""), null);
});

// ── Receiver outcomes ───────────────────────────────────────────────────────

test("X-12: only `ok` means an order reached the exchange", () => {
  assert.equal(orderPlaced("ok"), true);
  for (const outcome of ["ignored_duplicate", "ignored_stale_sell", "halted", "risk_blocked"] as const) {
    assert.equal(orderPlaced(outcome), false, outcome);
  }
});

test("X-12: a skipped sell must NOT advance local state", () => {
  // This is the whole finding: `ignored_stale_sell` fires precisely when the
  // receiver holds a NEWER position it wants to protect, so no sell reaches
  // Binance and the receiver stays long. Advancing to flat here is how the
  // platform ends up buying into a position it does not know it holds.
  assert.equal(mayAdvanceLocalState("ignored_stale_sell"), false);
  assert.equal(mayAdvanceLocalState("halted"), false);
  assert.equal(mayAdvanceLocalState("risk_blocked"), false);
  // A duplicate implies the original order landed, so the states already agree.
  assert.equal(mayAdvanceLocalState("ignored_duplicate"), true);
  assert.equal(mayAdvanceLocalState("ok"), true);
});

test("outcomes that placed no order answer 409, so a body-ignoring sender fails safe", () => {
  assert.equal(httpStatusFor("ok"), 200);
  assert.equal(httpStatusFor("ignored_duplicate"), 200);
  assert.equal(httpStatusFor("ignored_stale_sell"), 409);
  assert.equal(httpStatusFor("halted"), 409);
  assert.equal(httpStatusFor("risk_blocked"), 409);
});

test("every outcome answers each of the three questions, with no gaps", () => {
  for (const outcome of RECEIVER_OUTCOMES) {
    assert.equal(typeof orderPlaced(outcome), "boolean", outcome);
    assert.equal(typeof mayAdvanceLocalState(outcome), "boolean", outcome);
    assert.ok(httpStatusFor(outcome) >= 200, outcome);
    // An order that was placed must always license a state advance.
    if (orderPlaced(outcome)) assert.equal(mayAdvanceLocalState(outcome), true, outcome);
    // A 2xx must never be an outcome the sender may not act on.
    if (httpStatusFor(outcome) < 300) assert.equal(mayAdvanceLocalState(outcome), true, outcome);
  }
  assert.equal(isReceiverOutcome("ok"), true);
  assert.equal(isReceiverOutcome("nonsense"), false);
  assert.equal(isReceiverOutcome(undefined), false);
});
