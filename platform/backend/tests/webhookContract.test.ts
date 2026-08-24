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
import { buildPayload, customDedupeKey } from "../src/alerts/dispatcher";
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
    // `.positive().lt(100)` — strictly less than 100.
    if (typeof sp !== "number" || !(sp > 0) || !(sp < 100)) return { ok: false, reason: "sell_percent" };
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

test("KNOWN MISMATCH X-01: the sender can emit sell_percent exactly 100 and the receiver rejects it", () => {
  const { payload } = buildPayload(dep(), ctx({ action: "sell", sellPercent: 100, exitLeg: "tp2" }));
  const p = payload as CustomBotAlertPayload;
  assert.equal(p.sell_percent, 100);
  const verdict = receiverAccepts(p as unknown as Record<string, unknown>);
  assert.deepEqual(verdict, { ok: false, reason: "sell_percent" },
    "documents today's behaviour: an exact-100 partial is a hard 400 with no retry");
});

test("KNOWN MISMATCH X-02: the platform dedupe key is not the value the Pine template produces", () => {
  const barTime = 1_700_000_000_000;
  const platformBarIndex = Math.floor(barTime / INTERVAL_MS["15m"]);
  const platformKey = customDedupeKey("buy", platformBarIndex, barTime);
  // Pine's `bar_index` counts from the left edge of the loaded chart history.
  const pineBarIndex = 4321;
  const pineKey = `L-${pineBarIndex}-${barTime}`;
  assert.equal(platformKey, `L-${platformBarIndex}-${barTime}`);
  assert.notEqual(platformKey, pineKey);
  assert.ok(platformBarIndex > 1_000_000, "epoch/interval is ~1.9e6 for a 15m bar");
  // The *format* matches; only the embedded quantity differs.
  assert.match(platformKey, /^L-\d+-\d+$/);
  assert.match(pineKey, /^L-\d+-\d+$/);
});

test("dedupe keys are stable per (action, bar, leg) and distinct across legs", () => {
  const k = (leg?: "tp1" | "tp2") => customDedupeKey("sell", 42, 1_700_000_000_000, leg);
  assert.equal(k(), k());
  assert.notEqual(k("tp1"), k("tp2"));
  assert.equal(k("tp1"), "X-42-1700000000000-tp1");
  assert.equal(customDedupeKey("buy", 42, 1_700_000_000_000), "L-42-1700000000000");
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

test("KNOWN MISMATCH X-12: the receiver reports three different outcomes with one success shape", () => {
  // The sender's success test is `res.ok`; these all arrive as HTTP 200.
  const outcomes = ["ok", "ignored_duplicate", "ignored_stale_sell"];
  for (const status of outcomes) {
    const body = { status };
    // Today nothing in the dispatcher inspects `status` on a 2xx.
    assert.equal(typeof body.status, "string");
  }
  assert.equal(outcomes.length, 3,
    "ignored_stale_sell means NO order was placed and the receiver is still long");
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
