/**
 * Shariah Mode enforcement: the exposure rule itself, the fact that every
 * Platform Spot BUY path runs it, and the signed `shariah` block the Bot
 * receives.
 *
 * Three of these assertions are source-level pins rather than behavioural
 * tests, and deliberately so. "Paper and live agree" is true here because both
 * pass through ONE gate call placed above the branch that separates them —
 * a property that a behavioural test of each path separately would keep
 * passing even after someone added a second, divergent gate. Same for "no path
 * bypasses the gate" and "a status change never liquidates": those are claims
 * about code that does not exist, and only reading the source can check them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { config } from "../src/config";
import { manualTradingRoutes } from "../src/api/routes/manualTrading";
import { signManualCommand } from "../src/manualTrading/client";
import { CLASSIFICATIONS, effectiveShariahStatus, type Classification } from "../src/shariah/policy";
import {
  baseAssetOfSymbol, decideSpotExposure, evaluateShariahGate, normalizeSpotSide,
  type ShariahGateDeps,
} from "../src/shariah/gate";
import { coerceShariahMode, DEFAULT_SHARIAH_MODE, type ShariahMode } from "../src/shariah/mode";

const SRC = path.join(__dirname, "..", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

/** A registry where BTC has whatever status the test wants and nothing else exists. */
function deps(mode: ShariahMode, status: Classification, publicationId: string | null = "42"): ShariahGateDeps {
  return {
    readMode: async () => mode,
    lookupBaseAsset: async (base) => base === "BTC"
      ? { assetId: "7", baseAsset: "BTC", effectiveStatus: status, currentPublicationId: publicationId }
      : null,
  };
}

// ── 10: mode OFF changes nothing ───────────────────────────────────────────

test("Shariah Mode is off by default", () => {
  assert.equal(DEFAULT_SHARIAH_MODE, "off");
  assert.equal(coerceShariahMode(null), "off");
  assert.equal(coerceShariahMode(undefined), "off");
  assert.equal(coerceShariahMode("nonsense"), "off");
  assert.equal(coerceShariahMode({ mode: "enforce" }), "enforce");
});

test("with the mode off, every status may still be bought — behaviour is unchanged", async () => {
  for (const status of CLASSIFICATIONS) {
    const decision = await evaluateShariahGate({ symbol: "BTCUSDT", side: "BUY" }, deps("off", status));
    assert.equal(decision.allowed, true, `mode off blocked a BUY into ${status}`);
    assert.equal(decision.reason, null);
    assert.equal(decision.context.mode, "off");
    assert.equal(decision.context.policyVersion, null);
  }
  // Even a symbol with no registry identity at all.
  const unknown = await evaluateShariahGate({ symbol: "WIFSOL", side: "BUY" }, deps("off", "REVIEW"));
  assert.equal(unknown.allowed, true);
});

// ── 11-14: mode ON gates new exposure to ELIGIBLE ──────────────────────────

test("with the mode on, a BUY is allowed only for ELIGIBLE", async () => {
  const eligible = await evaluateShariahGate({ symbol: "BTCUSDT", side: "BUY" }, deps("enforce", "ELIGIBLE"));
  assert.equal(eligible.allowed, true);
  assert.equal(eligible.reason, null);

  const review = await evaluateShariahGate({ symbol: "BTCUSDT", side: "BUY" }, deps("enforce", "REVIEW"));
  assert.equal(review.allowed, false);
  assert.match(review.reason!, /not ELIGIBLE/);
  assert.match(review.reason!, /Selling or reducing an existing position is still allowed/);

  const excluded = await evaluateShariahGate({ symbol: "BTCUSDT", side: "BUY" }, deps("enforce", "EXCLUDED"));
  assert.equal(excluded.allowed, false);
  assert.match(excluded.reason!, /is EXCLUDED under TS_SHARIAH_V1/);
});

test("UNSCREENED and STALE reach the gate as REVIEW, and are blocked as REVIEW", async () => {
  // The collapse happens in policy.ts and nowhere else; the gate consumes it.
  assert.equal(effectiveShariahStatus({ classification: "ELIGIBLE", lifecycle: "UNSCREENED" }), "REVIEW");
  assert.equal(effectiveShariahStatus({ classification: "ELIGIBLE", lifecycle: "STALE" }), "REVIEW");
  assert.equal(effectiveShariahStatus(null), "REVIEW");

  for (const lifecycle of ["UNSCREENED", "STALE"] as const) {
    const status = effectiveShariahStatus({ classification: "ELIGIBLE", lifecycle });
    const decision = await evaluateShariahGate({ symbol: "BTCUSDT", side: "BUY" }, deps("enforce", status));
    assert.equal(decision.allowed, false, `a ${lifecycle} asset was buyable`);
    assert.equal(decision.context.effectiveStatus, "REVIEW");
  }
});

test("an asset with no registry identity fails closed, never open", async () => {
  for (const symbol of ["ETHBTC", "", "USDT", "NOTLISTEDUSDT"]) {
    const decision = await evaluateShariahGate({ symbol, side: "BUY" }, deps("enforce", "ELIGIBLE"));
    assert.equal(decision.allowed, false, `${JSON.stringify(symbol)} was buyable with no registry identity`);
    assert.equal(decision.context.effectiveStatus, "REVIEW");
    assert.equal(decision.context.assetId, null);
  }
  assert.equal(baseAssetOfSymbol("BTCUSDT"), "BTC");
  assert.equal(baseAssetOfSymbol("ethusdt"), "ETH");
  assert.equal(baseAssetOfSymbol("ETHBTC"), null);
  assert.equal(baseAssetOfSymbol("USDT"), null);
});

// ── 15-16: exits are never blocked, and nothing ever liquidates ────────────

test("SELL succeeds in every status, in every mode", async () => {
  for (const mode of ["off", "enforce"] as const) {
    for (const status of CLASSIFICATIONS) {
      const decision = await evaluateShariahGate({ symbol: "BTCUSDT", side: "SELL" }, deps(mode, status));
      assert.equal(decision.allowed, true, `SELL was blocked in mode=${mode} status=${status}`);
      assert.equal(decision.reason, null);
    }
    // Including a symbol the registry cannot resolve at all: an exit must
    // never depend on identity resolution succeeding.
    const orphan = await evaluateShariahGate({ symbol: "DELISTEDUSDT", side: "SELL" }, deps(mode, "EXCLUDED"));
    assert.equal(orphan.allowed, true);
  }
});

test("a status change cannot liquidate anything — the gate emits no order", () => {
  const gate = read("shariah/gate.ts");
  // The gate answers allow/deny for an intent the caller already had. If it
  // could construct or send one, a re-screening could sell a position.
  for (const forbidden of [/deliver\s*\(/, /manualBotRequest/, /applyPaperSignal/, /createAlert/, /fetch\s*\(/]) {
    assert.doesNotMatch(gate, forbidden, `gate.ts can reach an execution path: ${forbidden}`);
  }
  assert.equal(/\bside:\s*"SELL"/.test(gate), false, "gate.ts synthesises a SELL side of its own");
});

// ── 17: Paper and live cannot diverge, because there is one gate ───────────

test("the live runner gates once, above the branch that splits paper from live", () => {
  const runner = read("engine/liveRunner.ts");
  const gateAt = runner.indexOf("await evaluateShariahGate(");
  const paperAt = runner.indexOf('dep.delivery === "paper"');
  const deliverAt = runner.indexOf("await deliver(built.url");
  const claimAt = runner.indexOf("liveSafety.claimIntent");

  assert.ok(gateAt > 0, "the live runner does not call the Shariah gate");
  assert.equal(runner.split("await evaluateShariahGate(").length - 1, 1,
    "more than one gate call in the live runner — paper and live could diverge");
  assert.ok(gateAt < paperAt, "the paper branch is reached before the Shariah gate");
  assert.ok(gateAt < deliverAt, "delivery happens before the Shariah gate");
  assert.ok(gateAt < claimAt, "an order intent is claimed before the Shariah gate");
});

test("the exposure rule is one pure function that every path shares", () => {
  for (const status of CLASSIFICATIONS) {
    // Paper, live and manual all ask this same question with the same inputs.
    assert.equal(decideSpotExposure({ mode: "off", side: "BUY", effectiveStatus: status }).allowed, true);
    assert.equal(decideSpotExposure({ mode: "enforce", side: "SELL", effectiveStatus: status }).allowed, true);
    assert.equal(
      decideSpotExposure({ mode: "enforce", side: "BUY", effectiveStatus: status }).allowed,
      status === "ELIGIBLE"
    );
  }
});

// ── 18: no Spot BUY path skips the backend authority ──────────────────────

test("every Platform path that can create Spot exposure calls the gate first", () => {
  const manual = read("api/routes/manualTrading.ts");
  const botCall = manual.indexOf("sendBotRequest({ method: \"POST\", path: \"/api/manual-trading/orders\"");
  assert.ok(botCall > 0, "the manual order route has no identifiable Bot boundary");
  assert.ok(manual.indexOf("assertShariahExposureAllowed") < botCall,
    "the manual order route contacts the Bot before gating");

  const deployments = read("api/routes/deployments.ts");
  const testSignalGate = deployments.indexOf("await evaluateShariahGate(");
  assert.ok(testSignalGate > 0, "the live test-signal route does not call the Shariah gate");
  assert.ok(testSignalGate < deployments.indexOf("await deliver(built.url"),
    "the test-signal route delivers before gating");
});

test("the browser is never trusted to have applied the rule", () => {
  const manual = read("api/routes/manualTrading.ts");
  // A client-supplied `shariah` key is destructured away, not forwarded.
  assert.match(manual, /shariah:\s*_neverTrustedFromClient/);
  const frontend = path.join(SRC, "..", "..", "frontend");
  if (fs.existsSync(frontend)) {
    // The rule must not be reimplemented client-side, where it is only UX.
    for (const file of fs.readdirSync(path.join(frontend, "lib"))) {
      if (!file.endsWith(".ts")) continue;
      const source = fs.readFileSync(path.join(frontend, "lib", file), "utf8");
      assert.doesNotMatch(source, /effectiveStatus\s*===\s*"ELIGIBLE"\s*\?/,
        `${file} re-derives the exposure rule in the browser`);
    }
  }
});

// ── 19-20: the signed Platform -> Bot context block ───────────────────────

async function manualApp(gateDeps: ShariahGateDeps) {
  const app = Fastify({ logger: false });
  await app.register(manualTradingRoutes, { shariah: gateDeps });
  return app;
}

const ORDER = {
  requestId: "browser-request-id-0000000",
  accountId: "11111111-1111-1111-1111-111111111111",
  symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quoteQuantity: 25,
};

test("disabled manual trading exposes one stable capability without contacting the Bot", async (t) => {
  const previous = { ...config };
  config.manualTradingEnabled = false;
  t.after(() => Object.assign(config, previous));

  const realFetch = globalThis.fetch;
  let reached = false;
  globalThis.fetch = (async () => {
    reached = true;
    throw new Error("a disabled installation must not contact the execution Bot");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const app = await manualApp(deps("enforce", "ELIGIBLE"));
  t.after(() => app.close());

  const state = await app.inject({
    method: "GET", url: "/api/manual-trading/state?symbol=BTCUSDT",
  });
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json(), {
    enabled: false,
    mainnetEnabled: false,
    dryRun: true,
    mixed: false,
    accounts: [],
    orders: [],
    positions: [],
    protection: {
      type: "bot-managed",
      exchangeResting: false,
      note: "Manual trading is disabled; no execution Bot was contacted.",
    },
  });
  assert.equal(reached, false);

  const order = await app.inject({
    method: "POST", url: "/api/manual-trading/orders", payload: ORDER,
  });
  assert.equal(order.statusCode, 404, "mutating routes remain disabled and fail closed");
  assert.equal(reached, false);
});

test("a blocked manual BUY is a 403 with the reason, and never reaches the Bot", async (t) => {
  const previous = { ...config };
  config.manualTradingEnabled = true;
  config.manualTradingBotUrl = "http://127.0.0.1:9";
  config.manualTradingHmacSecret = "test-only-manual-hmac-secret-0000000000";
  t.after(() => Object.assign(config, previous));

  const realFetch = globalThis.fetch;
  let reached = false;
  globalThis.fetch = (async () => { reached = true; throw new Error("must not be called"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const app = await manualApp(deps("enforce", "EXCLUDED"));
  t.after(() => app.close());

  const blocked = await app.inject({ method: "POST", url: "/api/manual-trading/orders", payload: ORDER });
  assert.equal(blocked.statusCode, 403);
  assert.match(blocked.json().error, /EXCLUDED/);
  assert.equal(blocked.json().shariah.effectiveStatus, "EXCLUDED");
  assert.equal(reached, false, "a blocked BUY still contacted the execution bot");

  // The same asset can still be sold.
  const sell = await app.inject({ method: "POST", url: "/api/manual-trading/orders",
    payload: { ...ORDER, side: "SELL", baseQuantity: 1 } });
  assert.notEqual(sell.statusCode, 403);
});

test("the outbound Bot request carries exactly the agreed Shariah context, inside the signed body", async (t) => {
  const previous = { ...config };
  config.manualTradingEnabled = true;
  config.manualTradingBotUrl = "http://127.0.0.1:9";
  config.manualTradingHmacSecret = "test-only-manual-hmac-secret-0000000000";
  t.after(() => Object.assign(config, previous));

  const realFetch = globalThis.fetch;
  // Collected into an array rather than a nullable binding: the assignment
  // happens inside a callback, which control-flow analysis cannot see.
  const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify({ ok: true }), { status: 200,
      headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const app = await manualApp(deps("enforce", "ELIGIBLE"));
  t.after(() => app.close());

  const response = await app.inject({ method: "POST", url: "/api/manual-trading/orders", payload: ORDER });
  assert.equal(response.statusCode, 200);
  assert.equal(sent.length, 1);
  const { body, headers } = sent[0]!;

  // The exact key set and exact values, as agreed with the Bot.
  assert.deepEqual(Object.keys(body.shariah as object).sort(),
    ["assetId", "baseAsset", "effectiveStatus", "mode", "policyVersion", "publicationId"]);
  assert.deepEqual(body.shariah, {
    mode: "enforce",
    policyVersion: "TS_SHARIAH_V1",
    assetId: "7",
    baseAsset: "BTC",
    effectiveStatus: "ELIGIBLE",
    publicationId: "42",
  });
  // assetId is the registry's own scalar, not re-encoded.
  assert.equal(typeof (body.shariah as { assetId: unknown }).assetId, "string");
  // The browser's own requestId never becomes part of the command.
  assert.equal("requestId" in body, false);

  // ── 20: the block is covered by the HMAC, so tampering breaks auth ──
  const signed = {
    method: "POST", path: "/api/manual-trading/orders",
    timestamp: headers["x-manual-timestamp"]!, nonce: headers["x-manual-nonce"]!,
    requestId: headers["x-manual-request-id"]!,
  };
  assert.equal(signManualCommand({ ...signed, body }, config.manualTradingHmacSecret),
    headers["x-manual-signature"]);

  const tampered = [
    { ...body, shariah: { ...(body.shariah as object), effectiveStatus: "ELIGIBLE", mode: "off" } },
    { ...body, shariah: { ...(body.shariah as object), effectiveStatus: "EXCLUDED" } },
    { ...body, shariah: { ...(body.shariah as object), assetId: "8" } },
    { ...body, shariah: { ...(body.shariah as object), publicationId: null } },
    (() => { const { shariah: _dropped, ...rest } = body; return rest; })(),
  ];
  for (const [i, candidate] of tampered.entries()) {
    assert.notEqual(
      signManualCommand({ ...signed, body: candidate }, config.manualTradingHmacSecret),
      headers["x-manual-signature"],
      `tampering case ${i} still produced a valid signature`
    );
  }
});

test("a mode-off order still states the mode explicitly", async (t) => {
  const previous = { ...config };
  config.manualTradingEnabled = true;
  config.manualTradingBotUrl = "http://127.0.0.1:9";
  config.manualTradingHmacSecret = "test-only-manual-hmac-secret-0000000000";
  t.after(() => Object.assign(config, previous));

  const realFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const app = await manualApp(deps("off", "REVIEW", null));
  t.after(() => app.close());
  await app.inject({ method: "POST", url: "/api/manual-trading/orders", payload: ORDER });

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.shariah, {
    mode: "off", policyVersion: null, assetId: "7", baseAsset: "BTC",
    effectiveStatus: "REVIEW", publicationId: null,
  });
});

test("an unreadable side is gated as new exposure, not waved through as an exit", () => {
  assert.equal(normalizeSpotSide("buy"), "BUY");
  assert.equal(normalizeSpotSide(" SELL "), "SELL");
  assert.equal(normalizeSpotSide("long"), null);
  assert.equal(normalizeSpotSide(undefined), null);
  assert.match(read("api/routes/manualTrading.ts"), /normalizeSpotSide\(command\.side\) \?\? "BUY"/);
});
