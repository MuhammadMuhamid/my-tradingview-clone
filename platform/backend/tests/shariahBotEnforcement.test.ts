/**
 * Making Shariah Mode reach the side that executes.
 *
 * ── The defect this suite exists for ────────────────────────────────────────
 *
 * Every Platform-originated BUY was gated correctly. But the Bot also accepts
 * signals the Platform never sees — a direct TradingView webhook authenticated
 * by a per-bot secret — and the Bot only refuses those if it has been TOLD this
 * installation enforces. Nothing told it: the Bot remembers enforcement per
 * SENDER SCOPE, and a Platform manual order arms `manual-account:<id>`, never
 * `bot:<id>`. So an operator could switch Shariah Mode ON, be shown
 * "enforcing", and still have every direct webhook BUY admitted ungated.
 *
 * Two things close it, and both are asserted here:
 *
 *   1. changing the mode PUSHES it to the Bot over the HMAC control channel,
 *      and turning it on fails loudly rather than silently half-applying;
 *   2. an automated BUY carries its decision WITH a detached signature, because
 *      that path's only authentication is a secret inside the body — which
 *      authorises placing an order and proves nothing about who screened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { shariahRoutes } from "../src/api/routes/shariah";
import { buildPayload, withShariahEvidence } from "../src/alerts/dispatcher";
import { pushShariahModeToBot, ShariahBotSyncError } from "../src/shariah/botEnforcement";
import { shariahEvidenceCanonical, SHARIAH_POLICY_VERSION } from "../src/contract/webhookContract";
import type { ShariahRequestContext } from "../src/shariah/gate";
import type { DeploymentRow } from "../src/types/deployments";
import { initialRuntimeState } from "../src/types/deployments";
import type { CustomBotAlertPayload } from "../src/types/alerts";

const SRC = path.join(__dirname, "..", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const SECRET = "test-only-shariah-signing-secret-0000000000";

const eligible = (over: Partial<ShariahRequestContext> = {}): ShariahRequestContext => ({
  mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION, assetId: "reg_apt_0001",
  baseAsset: "APT", effectiveStatus: "ELIGIBLE", publicationId: "pub_2026_09_02", ...over,
});

function dep(over: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: "d1", strategyId: 1, configId: null, symbol: "APTUSDT", timeframe: "15m",
    params: {}, status: "active", delivery: "custom",
    webhookUrl: "https://bot.alphawebstudioz.com/api/webhooks/signal_bots",
    secret: "s".repeat(40), botUuid: null, buyQuoteQty: 100,
    runtimeState: initialRuntimeState(), lastBarTime: null,
    createdAt: "", updatedAt: "", ...over,
  };
}

const ctx = (action: "buy" | "sell" = "buy") => ({
  action, price: 12.34, barTime: 1_700_000_000_000, barIndex: 42,
  marketPosition: action === "buy" ? ("long" as const) : ("flat" as const),
  positionSize: 8, prevMarketPosition: "flat" as const, prevPositionSize: 0, contracts: 8,
});

// ── The control channel ─────────────────────────────────────────────────────

test("the mode push carries the mode and the policy identity, and nothing else", async () => {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  await pushShariahModeToBot("enforce", {
    manualTradingEnabled: true,
    request: (async (input: { method: string; path: string; body?: unknown }) => {
      sent.push({ method: input.method, path: input.path, body: input.body });
      return {};
    }) as never,
  });
  assert.deepEqual(sent, [{
    method: "PUT",
    path: "/api/manual-trading/shariah-enforcement",
    body: { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION },
  }]);
  // No asset, no symbol, no classification: the Bot holds no registry, and the
  // per-asset decision travels with each individual order instead.
  assert.deepEqual(Object.keys(sent[0]!.body as object).sort(), ["mode", "policyVersion"]);
});

test("turning enforcement off sends a null policy version", async () => {
  const bodies: unknown[] = [];
  await pushShariahModeToBot("off", {
    manualTradingEnabled: true,
    request: (async (input: { body?: unknown }) => { bodies.push(input.body); return {}; }) as never,
  });
  assert.deepEqual(bodies, [{ mode: "off", policyVersion: null }]);
});

test("an installation with no execution bot has no webhook path to protect, so the push is a no-op", async () => {
  let called = false;
  const result = await pushShariahModeToBot("enforce", {
    manualTradingEnabled: false,
    request: (async () => { called = true; return {}; }) as never,
  });
  assert.deepEqual(result, { pushed: false });
  assert.equal(called, false);
});

test("a bot that cannot be reached makes the push an error, not a shrug", async () => {
  await assert.rejects(
    () => pushShariahModeToBot("enforce", {
      manualTradingEnabled: true,
      request: (async () => { throw new Error("connect ECONNREFUSED"); }) as never,
    }),
    (error: unknown) => error instanceof ShariahBotSyncError && error.status === 502);
});

// ── The route, which is where the ordering guarantee lives ──────────────────

async function modeApp(over: {
  push?: (mode: string) => Promise<unknown>;
  stored?: "off" | "enforce";
  onStore?: (mode: string) => void;
} = {}) {
  let stored: "off" | "enforce" = over.stored ?? "off";
  const app = Fastify();
  await app.register(shariahRoutes, {
    mode: {
      get: async () => stored,
      set: async (mode: "off" | "enforce") => {
        over.onStore?.(mode); stored = mode; return mode; },
    },
    botEnforcement: {
      manualTradingEnabled: true,
      request: (async (input: { body?: { mode?: string } }) => {
        if (over.push) return over.push(String(input.body?.mode));
        return {};
      }) as never,
    },
  });
  return { app, read: () => stored };
}

test("turning enforcement ON arms the bot BEFORE the mode is stored", async (t) => {
  const order: string[] = [];
  const { app } = await modeApp({
    push: async (m) => { order.push(`bot:${m}`); return {}; },
    onStore: (m) => order.push(`store:${m}`),
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "PUT", url: "/api/shariah/mode",
    payload: { mode: "enforce" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(order, ["bot:enforce", "store:enforce"],
    "the executing side must be armed before the operator is told they are protected");
});

test("turning enforcement OFF stores first, so every intermediate state is the stricter one",
  async (t) => {
    const order: string[] = [];
    const { app } = await modeApp({
      stored: "enforce",
      push: async (m) => { order.push(`bot:${m}`); return {}; },
      onStore: (m) => order.push(`store:${m}`),
    });
    t.after(() => app.close());
    const response = await app.inject({ method: "PUT", url: "/api/shariah/mode",
      payload: { mode: "off" } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(order, ["store:off", "bot:off"]);
  });

test("if the bot refuses the arming, the mode is NOT stored and the operator is told", async (t) => {
  const stores: string[] = [];
  const { app, read } = await modeApp({
    push: async () => { throw new Error("bot down"); },
    onStore: (m) => stores.push(m),
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "PUT", url: "/api/shariah/mode",
    payload: { mode: "enforce" } });
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).mode, "off");
  assert.deepEqual(stores, [], "a half-applied enforce is worse than a refused one");
  assert.equal(read(), "off");
});

test("the route still refuses a mode that is not off or enforce", async (t) => {
  const { app } = await modeApp();
  t.after(() => app.close());
  for (const mode of ["ENFORCE", "on", "", null, 1, { mode: "enforce" }]) {
    const response = await app.inject({ method: "PUT", url: "/api/shariah/mode", payload: { mode } });
    assert.equal(response.statusCode, 400, JSON.stringify(mode));
  }
});

// ── The detached signature on the automated path ────────────────────────────

test("a custom-bot BUY carries the decision and a signature that verifies", () => {
  const context = eligible();
  const built = withShariahEvidence(buildPayload(dep(), ctx("buy")),
    { symbol: "APTUSDT", side: "buy", context }, SECRET);
  const payload = built.payload as CustomBotAlertPayload;

  assert.deepEqual(payload.shariah, context);
  assert.match(String(payload.shariah_ts), /^[0-9]{10,17}$/);

  const expected = `v1=${createHmac("sha256", SECRET).update(shariahEvidenceCanonical({
    symbol: "APTUSDT", side: "buy", timestamp: String(payload.shariah_ts), context,
  })).digest("hex")}`;
  assert.equal(payload.shariah_sig, expected);
});

test("the signature covers every field of the decision, plus the symbol, side and time", () => {
  const context = eligible();
  const timestamp = "1700000000000";
  const base = shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy", timestamp, context });
  const variants: Array<[string, string]> = [
    ["symbol", shariahEvidenceCanonical({ symbol: "BTCUSDT", side: "buy", timestamp, context })],
    ["side", shariahEvidenceCanonical({ symbol: "APTUSDT", side: "sell", timestamp, context })],
    ["timestamp", shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy",
      timestamp: "1700000000001", context })],
  ];
  for (const field of
    ["mode", "policyVersion", "assetId", "baseAsset", "effectiveStatus", "publicationId"] as const) {
    variants.push([field, shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy", timestamp,
      context: { ...context, [field]: field === "mode" ? "off" : "TAMPERED" } })]);
  }
  for (const [name, canonical] of variants) {
    assert.notEqual(canonical, base, `${name} is not covered by the signed bytes`);
  }
});

test("key ORDER in the transmitted block cannot change what was signed", () => {
  const forward = eligible();
  const reversed = Object.fromEntries(
    Object.entries(forward).reverse()) as unknown as ShariahRequestContext;
  assert.notDeepEqual(Object.keys(forward), Object.keys(reversed));
  assert.equal(
    shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy", timestamp: "1", context: forward }),
    shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy", timestamp: "1", context: reversed }));
});

test("3Commas and the no-delivery modes never carry a Shariah block", () => {
  const three = withShariahEvidence(buildPayload(dep({ delivery: "3commas", botUuid: "u" }), ctx()),
    { symbol: "APTUSDT", side: "buy", context: eligible() }, SECRET);
  assert.equal("shariah" in (three.payload as unknown as Record<string, unknown>), false);

  for (const delivery of ["off", "paper"] as const) {
    const built = withShariahEvidence(buildPayload(dep({ delivery }), ctx()),
      { symbol: "APTUSDT", side: "buy", context: eligible() }, SECRET);
    // No outbound call is made at all, so there is nothing to authenticate.
    assert.equal(built.url, null);
    assert.equal("shariah" in (built.payload as unknown as Record<string, unknown>), false);
  }
});

test("an installation with no shared secret still ships the block, unsigned", () => {
  const built = withShariahEvidence(buildPayload(dep(), ctx()),
    { symbol: "APTUSDT", side: "buy", context: eligible() }, "");
  const payload = built.payload as CustomBotAlertPayload;
  assert.deepEqual(payload.shariah, eligible());
  assert.equal(payload.shariah_sig, undefined);
  // Unsigned, the receiver treats it as unproven — which can only ever be
  // stricter than omitting it, never more permissive.
});

test("a SELL still carries its evidence, and carrying it never gates the exit", () => {
  const built = withShariahEvidence(buildPayload(dep(), ctx("sell")),
    { symbol: "APTUSDT", side: "sell",
      context: eligible({ effectiveStatus: "EXCLUDED" }) }, SECRET);
  const payload = built.payload as CustomBotAlertPayload;
  assert.equal(payload.action, "sell");
  assert.equal(payload.shariah?.effectiveStatus, "EXCLUDED");
  assert.ok(payload.shariah_sig);
});

// ── Source pins: what must not come back ────────────────────────────────────

test("the paired-release flag is gone from config, code and tests", () => {
  for (const rel of ["config.ts", "api/routes/manualTrading.ts"]) {
    assert.doesNotMatch(read(rel), /config\.shariahBotContextEnabled/,
      `${rel} still gates delivery on the retired flag`);
  }
  assert.doesNotMatch(read("config.ts"), /shariahBotContextEnabled:/,
    "the flag must not be readable from config at all");
});

test("the manual order route attaches the block unconditionally", () => {
  const src = read("api/routes/manualTrading.ts");
  assert.match(src, /body: \{ \.\.\.command, shariah: context \}/,
    "the computed decision must ship on every manual order, with no second switch");
});

test("every automated delivery path signs its evidence at the point the gate allowed it", () => {
  for (const rel of ["engine/liveRunner.ts", "api/routes/deployments.ts"]) {
    assert.match(read(rel), /withShariahEvidence\(/,
      `${rel} sends an automated order without attaching the Platform's decision`);
  }
});

test("the mode route cannot store enforce without having pushed it", () => {
  const src = read("api/routes/shariah.ts");
  const put = src.slice(src.indexOf('app.put("/api/shariah/mode"'));
  const body = put.slice(0, put.indexOf("\n  });"));
  const push = body.indexOf('pushShariahModeToBot("enforce"');
  const store = body.indexOf("writeMode(mode)");
  assert.ok(push > -1 && store > -1);
  assert.ok(push < store, "the bot must be armed before the mode is stored");
});
