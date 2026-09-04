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
import {
  pushShariahModeToBot, readBotShariahMode, ShariahBotSyncError,
} from "../src/shariah/botEnforcement";
import {
  httpStatusFor, mayAdvanceLocalState, shariahEvidenceCanonical,
  SHARIAH_EVIDENCE_MAX_AGE_MS, SHARIAH_LIMITS, SHARIAH_POLICY_VERSION,
  validateCustomBotPayload,
} from "../src/contract/webhookContract";
import type { ShariahRequestContext } from "../src/shariah/gate";
import type { DeploymentRow } from "../src/types/deployments";
import { initialRuntimeState } from "../src/types/deployments";
import type { CustomBotAlertPayload } from "../src/types/alerts";
import { config } from "../src/config";
import {
  isManualControlChannelConfigured, ManualBotError, manualBotControlRequest,
} from "../src/manualTrading/client";

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
    controlChannelConfigured: true,
    request: (async (input: { method: string; path: string; body?: unknown }) => {
      sent.push({ method: input.method, path: input.path, body: input.body });
      return { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION };
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
    controlChannelConfigured: true,
    request: (async (input: { body?: unknown }) => {
      bodies.push(input.body); return { mode: "off", policyVersion: null };
    }) as never,
  });
  assert.deepEqual(bodies, [{ mode: "off", policyVersion: null }]);
});

test("an installation with no control channel has no bot to talk to, so the push is a no-op",
  async () => {
    let called = false;
    const result = await pushShariahModeToBot("enforce", {
      controlChannelConfigured: false,
      request: (async () => { called = true; return {}; }) as never,
    });
    assert.deepEqual(result, { pushed: false });
    assert.equal(called, false);
  });

/*
 * BOT-P1-4. MANUAL_TRADING_ENABLED governs manual ORDER submission. Reading it
 * here is what let an operator who had deliberately disabled manual trading —
 * the safe posture, and the one most likely to be running purely on direct
 * TradingView webhooks — switch Shariah Mode on, be told it worked, and leave
 * the Bot floor `off` with every webhook BUY still admitted ungated.
 *
 * The push now asks only whether a control channel exists. `isManualControlChannelConfigured`
 * reads the URL and the HMAC key and nothing else; this test pins that the flag
 * is not consulted, in either direction.
 */
test("manual trading being disabled does not disable the Shariah floor push", async () => {
  const priorEnabled = config.manualTradingEnabled;
  const priorSecret = config.manualTradingHmacSecret;
  const priorUrl = config.manualTradingBotUrl;
  try {
    config.manualTradingEnabled = false;
    config.manualTradingHmacSecret = "f".repeat(64);
    config.manualTradingBotUrl = "http://127.0.0.1:4001";
    assert.equal(isManualControlChannelConfigured(), true,
      "the channel is a URL and a key — never the manual-order feature flag");

    const sent: unknown[] = [];
    const result = await pushShariahModeToBot("enforce", {
      request: (async (input: { body?: unknown }) => {
        sent.push(input.body);
        return { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION };
      }) as never,
    });
    assert.deepEqual(result, { pushed: true });
    assert.deepEqual(sent, [{ mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION }]);

    // ...and an absent key is a refusal, never a silent unenforced fallback.
    config.manualTradingHmacSecret = "";
    assert.equal(isManualControlChannelConfigured(), false);
    await assert.rejects(() => manualBotControlRequest({ method: "GET", path: "/x" }),
      (error: unknown) => error instanceof ManualBotError && error.status === 503);
  } finally {
    config.manualTradingEnabled = priorEnabled;
    config.manualTradingHmacSecret = priorSecret;
    config.manualTradingBotUrl = priorUrl;
  }
});

test("a bot that cannot be reached makes the push an error, not a shrug", async () => {
  await assert.rejects(
    () => pushShariahModeToBot("enforce", {
      controlChannelConfigured: true,
      request: (async () => { throw new Error("connect ECONNREFUSED"); }) as never,
    }),
    (error: unknown) => error instanceof ShariahBotSyncError && error.status === 502);
});

/*
 * The failure this whole module exists to prevent, one layer up: a receiver
 * that accepts the request and does nothing. An old Bot that ignores the field,
 * a proxy that swallows it, a wrong route that happens to answer 200 — every
 * one of those used to be recorded as "armed" because only the status was read.
 */
test("a 200 that does not name the requested floor is a sync failure, not an arming", async () => {
  for (const reply of [{}, { mode: "off" }, { mode: null }, { mode: "enforce", policyVersion: "TS_SHARIAH_V0" }]) {
    await assert.rejects(
      () => pushShariahModeToBot("enforce", {
        controlChannelConfigured: true,
        request: (async () => reply) as never,
      }),
      (error: unknown) => error instanceof ShariahBotSyncError && error.status === 502,
      JSON.stringify(reply));
  }
  // The truthful answer, and the only one accepted.
  assert.deepEqual(
    await pushShariahModeToBot("enforce", {
      controlChannelConfigured: true,
      request: (async () => ({ mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION })) as never,
    }),
    { pushed: true });
});

// ── The route, which is where the ordering guarantee lives ──────────────────

async function modeApp(over: {
  push?: (mode: string) => Promise<unknown>;
  stored?: "off" | "enforce";
  onStore?: (mode: string) => void;
  storeThrows?: boolean;
  botReports?: "off" | "enforce" | "unreachable";
  /** What the bot CLAIMS it applied, when that differs from what was asked. */
  botApplies?: "off" | "enforce";
} = {}) {
  let stored: "off" | "enforce" = over.stored ?? "off";
  const app = Fastify();
  await app.register(shariahRoutes, {
    mode: {
      get: async () => stored,
      set: async (mode: "off" | "enforce") => {
        over.onStore?.(mode);
        if (over.storeThrows) throw new Error("connection terminated unexpectedly");
        stored = mode; return mode; },
    },
    botEnforcement: {
      controlChannelConfigured: true,
      request: (async (input: { method: string; body?: { mode?: string } }) => {
        if (input.method === "GET") {
          if (over.botReports === "unreachable") throw new Error("bot unreachable");
          return { mode: over.botReports ?? "off", policyVersion: null };
        }
        const asked = String(input.body?.mode);
        if (over.push) await over.push(asked);
        /*
         * A truthful receiver echoes the floor it actually applied. The harness
         * defaults to truthful so the ORDERING tests below test ordering; a
         * lying receiver is `botApplies`, covered above.
         */
        const applied = over.botApplies ?? asked;
        return { mode: applied,
          policyVersion: applied === "enforce" ? SHARIAH_POLICY_VERSION : null,
          supportedPolicyVersion: SHARIAH_POLICY_VERSION };
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

test("a mode change that arms the bot but cannot be stored is reported as drift, not as a 500",
  async (t) => {
    /*
     * The safe direction — the webhook path the push exists to protect is
     * closed, and every Platform path keeps the behaviour it had — but the
     * operator asked for something that only half happened, and a bare 500
     * would not tell them which half.
     */
    const { app, read } = await modeApp({ storeThrows: true, botReports: "enforce" });
    t.after(() => app.close());
    const response = await app.inject({ method: "PUT", url: "/api/shariah/mode",
      payload: { mode: "enforce" } });
    assert.equal(response.statusCode, 500);
    const body = JSON.parse(response.body);
    assert.equal(body.mode, "off", "it must report what this Platform actually stored");
    assert.equal(body.botMode, "enforce", "and what the bot was actually set to");
    assert.equal(body.inSync, false);
    assert.match(body.error, /Retry the mode change/);
    assert.equal(read(), "off");
  });

test("the mode reading reports the bot's own floor, so drift is visible", async (t) => {
  const agreed = await modeApp({ stored: "enforce", botReports: "enforce" });
  t.after(() => agreed.app.close());
  const inSync = JSON.parse(
    (await agreed.app.inject({ method: "GET", url: "/api/shariah/mode" })).body);
  assert.deepEqual(inSync,
    { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION, botMode: "enforce", inSync: true });

  const drifted = await modeApp({ stored: "enforce", botReports: "off" });
  t.after(() => drifted.app.close());
  const out = JSON.parse(
    (await drifted.app.inject({ method: "GET", url: "/api/shariah/mode" })).body);
  assert.equal(out.botMode, "off");
  assert.equal(out.inSync, false);
});

test("an unreachable bot reads as unknown, never as agreement and never as protection",
  async (t) => {
    const { app } = await modeApp({ stored: "enforce", botReports: "unreachable" });
    t.after(() => app.close());
    const body = JSON.parse((await app.inject({ method: "GET", url: "/api/shariah/mode" })).body);
    assert.equal(body.botMode, null);
    assert.equal(body.inSync, null, "unknown must not be reported as either true or false");

    assert.equal(await readBotShariahMode({
      controlChannelConfigured: true,
      request: (async () => { throw new Error("down"); }) as never,
    }), null);
  });

// ── The detached signature on the automated path ────────────────────────────

test("a custom-bot BUY carries the decision, a nonce and a signature that verifies", () => {
  const context = eligible();
  const built = withShariahEvidence(buildPayload(dep(), ctx("buy")),
    { symbol: "APTUSDT", side: "buy", context }, SECRET);
  const payload = built.payload as CustomBotAlertPayload;

  assert.deepEqual(payload.shariah, context);
  assert.match(String(payload.shariah_ts), /^[0-9]{10,17}$/);
  assert.match(String(payload.shariah_nonce), /^[A-Za-z0-9_-]{22,128}$/);

  const expected = `v1=${createHmac("sha256", SECRET).update(shariahEvidenceCanonical({
    symbol: "APTUSDT", side: "buy", timestamp: String(payload.shariah_ts),
    nonce: String(payload.shariah_nonce), context,
  })).digest("hex")}`;
  assert.equal(payload.shariah_sig, expected);
});

test("every authorisation gets its own nonce, and the nonce is unpredictable", () => {
  const context = eligible();
  const mint = () => String((withShariahEvidence(buildPayload(dep(), ctx("buy")),
    { symbol: "APTUSDT", side: "buy", context }, SECRET)
    .payload as CustomBotAlertPayload).shariah_nonce);

  /*
   * Two deliveries of the SAME decision for the SAME symbol on the SAME side
   * must not share an authorisation. This is the property the whole replay
   * defence rests on: if the nonce were derived from anything in the payload,
   * two legitimate entries would collide and the second would be refused as a
   * replay of the first.
   */
  const minted = new Set(Array.from({ length: 256 }, mint));
  assert.equal(minted.size, 256, "a nonce was reused across authorisations");

  // Entropy, crudely: 24 random bytes is 32 base64url characters, and the
  // contract's floor is 22. A generator that fell back to a counter, a
  // timestamp or a hash of the payload would not clear this.
  for (const nonce of minted) {
    assert.ok(nonce.length >= SHARIAH_LIMITS.nonceMin, "nonce is below the contract floor");
    assert.equal(nonce.length, 32);
  }
  // And nothing about the order is recoverable from it.
  for (const nonce of minted) {
    assert.equal(nonce.includes("APT"), false);
    assert.equal(/^[0-9]{10,17}$/.test(nonce), false);
  }
});

test("the signature covers every field of the decision, plus the symbol, side and time", () => {
  const context = eligible();
  const timestamp = "1700000000000";
  const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
  const base = shariahEvidenceCanonical({
    symbol: "APTUSDT", side: "buy", timestamp, nonce, context });
  const variants: Array<[string, string]> = [
    ["symbol", shariahEvidenceCanonical({
      symbol: "BTCUSDT", side: "buy", timestamp, nonce, context })],
    ["side", shariahEvidenceCanonical({
      symbol: "APTUSDT", side: "sell", timestamp, nonce, context })],
    ["timestamp", shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy",
      timestamp: "1700000000001", nonce, context })],
    // The v5 line. Without this the signature says nothing about WHICH entry it
    // authorises, which is exactly how a captured payload became replayable.
    ["nonce", shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy", timestamp,
      nonce: "BBBBBBBBBBBBBBBBBBBBBB", context })],
  ];
  for (const field of
    ["mode", "policyVersion", "assetId", "baseAsset", "effectiveStatus", "publicationId"] as const) {
    variants.push([field, shariahEvidenceCanonical({ symbol: "APTUSDT", side: "buy", timestamp,
      nonce, context: { ...context, [field]: field === "mode" ? "off" : "TAMPERED" } })]);
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
    shariahEvidenceCanonical({
      symbol: "APTUSDT", side: "buy", timestamp: "1", nonce: "n".repeat(22), context: forward }),
    shariahEvidenceCanonical({
      symbol: "APTUSDT", side: "buy", timestamp: "1", nonce: "n".repeat(22), context: reversed }));
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
  //
  // The rest of the detached set goes with it. There is no authorisation to
  // mint when there is nothing to certify, and a partial set is one the shared
  // validator calls invalid.
  assert.equal(payload.shariah_ts, undefined);
  assert.equal(payload.shariah_nonce, undefined);
  assert.equal(validateCustomBotPayload({ ...payload, secret: "s".repeat(40) }).ok, true);
});

test("a SELL still carries its evidence, and carrying it never gates the exit", () => {
  const built = withShariahEvidence(buildPayload(dep(), ctx("sell")),
    { symbol: "APTUSDT", side: "sell",
      context: eligible({ effectiveStatus: "EXCLUDED" }) }, SECRET);
  const payload = built.payload as CustomBotAlertPayload;
  assert.equal(payload.action, "sell");
  assert.equal(payload.shariah?.effectiveStatus, "EXCLUDED");
  assert.ok(payload.shariah_sig);
  // A SELL carries a nonce for protocol consistency — the sender signs every
  // delivery the same way — and the receiver never claims it. An exit cannot be
  // trapped by an authorisation having been spent.
  assert.ok(payload.shariah_nonce);
});

// ── The signature has to outlive delivery, and a refusal has to be terminal ─

test("delivery cannot outlive the signature's freshness window", () => {
  /*
   * The signature is stamped when the payload is built and verified when the
   * Bot receives it, so the sender's whole retry schedule has to fit inside the
   * receiver's freshness window. If it ever stopped fitting, a delivery that
   * succeeded on a late attempt would be refused as expired — and the operator
   * would see a Shariah refusal for an asset that is ELIGIBLE.
   */
  const src = read("alerts/dispatcher.ts");
  const attempts = Number(/opts\.maxAttempts \?\? (\d+)/.exec(src)?.[1]);
  const timeoutMs = Number(/opts\.timeoutMs \?\? (\d+)/.exec(src)?.[1]);
  const backoff = /await sleep\((\d+) \* 2 \*\* \(attempt - 1\)\)/.exec(src)?.[1];
  assert.ok(Number.isFinite(attempts) && Number.isFinite(timeoutMs) && backoff,
    "the retry schedule is no longer readable from the source; re-derive this bound");

  const base = Number(backoff);
  let worstCase = attempts * timeoutMs;
  for (let attempt = 1; attempt < attempts; attempt++) worstCase += base * 2 ** (attempt - 1);

  assert.ok(worstCase < SHARIAH_EVIDENCE_MAX_AGE_MS,
    `the worst-case delivery takes ${worstCase}ms, past the receiver's `
    + `${SHARIAH_EVIDENCE_MAX_AGE_MS}ms freshness window`);
});

test("a Shariah refusal from the Bot is terminal and never advances local state", () => {
  assert.equal(httpStatusFor("shariah_blocked"), 409);
  assert.equal(mayAdvanceLocalState("shariah_blocked"), false);
  // 409 + a receiver outcome that may not advance state is the branch that
  // returns `blocked` without retrying — retrying a policy refusal would be
  // pointless, and recording it as `sent` would claim a position that is not
  // there.
  const src = read("alerts/dispatcher.ts");
  assert.match(src, /res\.status === 409 && outcome && !mayAdvanceLocalState\(outcome\)/);
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
