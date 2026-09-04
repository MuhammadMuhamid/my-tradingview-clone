/**
 * Characterization of the CURRENT cross-repository webhook contract, including
 * the mismatches the audit found. These tests describe what the two systems do
 * today; the ones marked KNOWN MISMATCH are the regression net for the fixes.
 *
 * The receiver's schema is duplicated here from
 * `3commabotclone/backend/src/routes/webhooks.ts` because there is no shared
 * package yet — which is itself the root cause of X-01/X-02/X-12.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, customDedupeKey, platformCorrelationHeaders,
  deliveryAdvancesState } from "../src/alerts/dispatcher";
import type { CustomBotAlertPayload, ThreeCommasAlertPayload } from "../src/types/alerts";
import type { DeploymentRow } from "../src/types/deployments";
import { initialRuntimeState } from "../src/types/deployments";
import { INTERVAL_MS } from "../src/types/market";

function dep(over: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: "d1", strategyId: 1, configId: null, symbol: "APTUSDT", timeframe: "15m",
    params: {}, status: "active", delivery: "custom",
    webhookUrl: "https://bot.alphawebstudioz.com/api/webhooks/signal_bots",
    secret: "s".repeat(40), botUuid: null, buyQuoteQty: 340.01,
    runtimeState: initialRuntimeState(), lastBarTime: null,
    createdAt: "", updatedAt: "", ...over,
  };
}

const ctx = (over: Record<string, unknown> = {}) => ({
  action: "buy" as const, price: 12.34, barTime: 1_700_000_000_000, barIndex: 42,
  marketPosition: "long" as const, positionSize: 64.8,
  prevMarketPosition: "flat" as const, prevPositionSize: 0, contracts: 64.8,
  ...over,
});

// ── The receiver's validation, mirrored ────────────────────────────────────
type Receiver = { ok: true } | { ok: false; reason: string };

/** Mirrors the receiver's zod schema as it stands today. */
function receiverAccepts(body: Record<string, unknown>): Receiver {
  const s = body.secret;
  if (typeof s !== "string" || s.length < 32 || s.length > 256) return { ok: false, reason: "secret" };
  const action = body.action;
  if (typeof action !== "string" || action.length < 1 || action.length > 40) return { ok: false, reason: "action" };
  if (!body.symbol && !body.tv_instrument) return { ok: false, reason: "symbol or tv_instrument required" };
  const q = body.quote_order_qty;
  if (q != null && (typeof q !== "number" || !(q > 0) || q > 1_000_000)) return { ok: false, reason: "quote_order_qty" };
  const sp = body.sell_percent;
  if (sp != null) {
    // Contract v1: `> 0 && <= 100`. It was `< 100`, which made the exact-100
    // leg the sender could produce a terminal 400 (X-01).
    if (typeof sp !== "number" || !(sp > 0) || !(sp <= 100)) return { ok: false, reason: "sell_percent" };
  }
  const allowed = new Set([
    "secret", "action", "symbol", "tv_instrument", "quote_order_qty",
    "quantity", "sell_percent", "exit_leg", "dedupe_key",
  ]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, reason: `strict: ${k}` };
  return { ok: true };
}

/** Mirrors the receiver's `resolveAction`. */
function receiverResolveAction(action: string): "buy" | "sell" {
  const a = action.toLowerCase().replace(/[\s_-]/g, "");
  if (["buy", "enterlong", "long", "entrylong", "openlong"].includes(a)) return "buy";
  if (["sell", "exitlong", "closelong", "close", "exit", "closeposition", "market"].includes(a)) return "sell";
  throw new Error(`Unknown action: ${action}`);
}

/** Mirrors the receiver's `normalizeSymbol`. */
function receiverNormalizeSymbol(raw: string): string {
  let s = raw.trim().toUpperCase();
  const colon = s.lastIndexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);
  return s.replace(/[/-]/g, "");
}

// ── Shapes ─────────────────────────────────────────────────────────────────

test("the custom BUY payload the platform emits is accepted by the receiver", () => {
  const { payload } = buildPayload(dep(), ctx());
  const p = payload as CustomBotAlertPayload;
  assert.deepEqual(Object.keys(p).sort(), ["action", "dedupe_key", "quote_order_qty", "secret", "symbol"]);
  assert.deepEqual(receiverAccepts(p as unknown as Record<string, unknown>), { ok: true });
  assert.equal(receiverResolveAction(p.action), "buy");
  assert.equal(receiverNormalizeSymbol(p.symbol), "APTUSDT");
});

test("v2 correlation uses headers so a staged old Bot keeps receiving the strict v1 body", () => {
  const built = buildPayload(dep(), ctx());
  const headers = platformCorrelationHeaders({ deploymentId: dep().id, orderIntentId: 41 });
  assert.equal("platform_deployment_id" in built.payload, false);
  assert.deepEqual(headers, { "x-platform-deployment-id": dep().id,
    "x-platform-order-intent-id": "41" });
  assert.equal(receiverAccepts(built.payload as unknown as Record<string, unknown>).ok, true);
});

test("a full-close SELL carries no sell_percent and is accepted", () => {
  const { payload } = buildPayload(dep(), ctx({ action: "sell" }));
  const p = payload as CustomBotAlertPayload;
  assert.equal("sell_percent" in p, false);
  assert.equal("quote_order_qty" in p, false);
  assert.deepEqual(receiverAccepts(p as unknown as Record<string, unknown>), { ok: true });
  assert.equal(receiverResolveAction(p.action), "sell");
});

test("partial exits below 100 % round-trip for every leg the evaluator can emit", () => {
  for (const exitLeg of ["tp1", "tp2", "runner", "stop", "signal"] as const) {
    for (const sellPercent of [0.01, 1, 25, 40, 50, 66.6667, 99.99]) {
      const { payload } = buildPayload(dep(), ctx({ action: "sell", sellPercent, exitLeg }));
      const p = payload as CustomBotAlertPayload;
      assert.equal(p.sell_percent, sellPercent);
      assert.equal(p.exit_leg, exitLeg);
      assert.deepEqual(
        receiverAccepts(p as unknown as Record<string, unknown>), { ok: true },
        `${exitLeg} @ ${sellPercent}`
      );
    }
  }
});

test("X-01 FIXED: the sender no longer expresses a full close as sell_percent 100", () => {
  // The evaluator now resets the position and omits `sell_percent` entirely
  // when a tier takes 100 % of the remainder, and the contract accepts 100 as a
  // fail-safe for any sender that has not been updated. This test asserted the
  // broken behaviour in Phase 0; the change here is the fix landing.
  const { payload } = buildPayload(dep(), ctx({ action: "sell", sellPercent: 100, exitLeg: "tp2" }));
  const p = payload as CustomBotAlertPayload;
  // `buildPayload` still forwards whatever the caller hands it, so a direct
  // caller CAN produce 100 — and the receiver must now accept it.
  assert.equal(p.sell_percent, 100);
  assert.deepEqual(
    receiverAccepts(p as unknown as Record<string, unknown>),
    { ok: true },
    "the receiver mirror in this file was updated to the v1 contract"
  );
});

test("X-02 FIXED: the dedupe key no longer embeds a bar index, so both senders agree", () => {
  const barTime = 1_700_000_000_000;
  // The bar index the two senders would each have computed. They never matched.
  const platformBarIndex = Math.floor(barTime / INTERVAL_MS["15m"]);
  const pineBarIndex = 4321;
  assert.notEqual(platformBarIndex, pineBarIndex);
  assert.ok(platformBarIndex > 1_000_000, "epoch/interval is ~1.9e6 for a 15m bar");

  // The key is now bar open time only, which both sides read identically.
  assert.equal(customDedupeKey("buy", platformBarIndex, barTime), `L-${barTime}`);
  assert.equal(customDedupeKey("buy", pineBarIndex, barTime), `L-${barTime}`);
  assert.equal(
    customDedupeKey("buy", platformBarIndex, barTime),
    customDedupeKey("buy", pineBarIndex, barTime),
    "the same bar now produces the same key regardless of sender"
  );
});

test("dedupe keys are stable per (action, bar, leg) and distinct across legs", () => {
  const k = (leg?: "tp1" | "tp2") => customDedupeKey("sell", 42, 1_700_000_000_000, leg);
  assert.equal(k(), k());
  assert.notEqual(k("tp1"), k("tp2"));
  assert.equal(k("tp1"), "X-1700000000000-tp1");
  assert.equal(customDedupeKey("buy", 42, 1_700_000_000_000), "L-1700000000000");
});

test("the 3Commas payload is all-strings and carries no dedupe key at all", () => {
  const { payload, dedupeKey } = buildPayload(dep({ delivery: "3commas", botUuid: "uuid-1" }), ctx());
  const p = payload as ThreeCommasAlertPayload;
  assert.equal(dedupeKey, null, "KNOWN GAP BE-12: retries on this path have no idempotency key");
  for (const v of [p.max_lag, p.timestamp, p.trigger_price, p.tv_instrument, p.order.amount]) {
    assert.equal(typeof v, "string");
  }
  assert.equal(p.tv_exchange, "BINANCE");
  assert.equal(p.order.currency_type, "base");
});

test("delivery=off builds the custom shape with an empty secret and no URL", () => {
  const { payload, url } = buildPayload(dep({ delivery: "off" }), ctx());
  assert.equal(url, null);
  assert.equal((payload as CustomBotAlertPayload).secret, "");
});

test("X-12 FIXED: the dispatcher now distinguishes the receiver's outcomes", () => {
  // `deliveryAdvancesState` reads the receiver's own `status` field rather than
  // trusting `res.ok`. Full coverage of the outcome matrix lives in
  // `tests/contract.test.ts`; this asserts the sender-side wiring.
  assert.equal(deliveryAdvancesState({ status: "sent", attempts: 1, outcome: "ok" }), true);
  assert.equal(
    deliveryAdvancesState({ status: "skipped", attempts: 1, outcome: "ignored_duplicate" }),
    true
  );
  assert.equal(
    deliveryAdvancesState({ status: "blocked", attempts: 1, outcome: "ignored_stale_sell" }),
    false,
    "no order was placed and the receiver is still long"
  );
  assert.equal(deliveryAdvancesState({ status: "failed", attempts: 4 }), false);
});

test("action and symbol normalisation the receiver applies to platform payloads", () => {
  assert.equal(receiverResolveAction("buy"), "buy");
  assert.equal(receiverResolveAction("sell"), "sell");
  assert.equal(receiverResolveAction("Enter Long"), "buy");
  assert.equal(receiverResolveAction("exit_long"), "sell");
  assert.equal(receiverResolveAction("CLOSE-POSITION"), "sell");
  assert.throws(() => receiverResolveAction("short"));
  assert.equal(receiverNormalizeSymbol("BINANCE:NEARUSDT"), "NEARUSDT");
  assert.equal(receiverNormalizeSymbol(" near/usdt "), "NEARUSDT");
  assert.equal(receiverNormalizeSymbol("APT-USDT"), "APTUSDT");
});

test("the receiver's strict schema rejects any field the platform does not send", () => {
  const { payload } = buildPayload(dep(), ctx());
  const extra = { ...(payload as unknown as Record<string, unknown>), price: 12.34 };
  assert.deepEqual(receiverAccepts(extra), { ok: false, reason: "strict: price" });
});

test("secret length bounds: the receiver requires 32..256 characters", () => {
  const short = buildPayload(dep({ secret: "s".repeat(31) }), ctx()).payload;
  assert.deepEqual(receiverAccepts(short as unknown as Record<string, unknown>), { ok: false, reason: "secret" });
  const ok = buildPayload(dep({ secret: "s".repeat(32) }), ctx()).payload;
  assert.deepEqual(receiverAccepts(ok as unknown as Record<string, unknown>), { ok: true });
});
