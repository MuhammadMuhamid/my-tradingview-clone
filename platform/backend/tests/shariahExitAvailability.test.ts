import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { config } from "../src/config";
import { manualTradingRoutes } from "../src/api/routes/manualTrading";
import type { ShariahGateDeps } from "../src/shariah/gate";
import { spotExecutionRoutes } from "../src/api/routes/spotExecution";
import { deploymentRoutes } from "../src/api/routes/deployments";
import { LiveRunner } from "../src/engine/liveRunner";
import { initialRuntimeState, type DeploymentRow } from "../src/types/deployments";
import { pool } from "../src/db/pool";
import type { MtfLeanDecision } from "../src/engine/mtfLeanLiveEvaluator";
import { DEFAULT_RISK_LIMITS } from "../src/engine/riskControls";

const ORDER = {
  requestId: "shariah-outage-request-000001",
  accountId: "11111111-1111-4111-8111-111111111111",
  symbol: "BTCUSDT", orderType: "MARKET", baseQuantity: 0.1,
};

for (const failAt of ["readMode", "lookupBaseAsset"] as const) {
  for (const side of ["BUY", "SELL"] as const) {
    test(`manual ${side} ${side === "SELL" ? "remains available" : "fails closed"} when Shariah ${failAt} fails`, async (t) => {
      const previous = config.manualTradingEnabled;
      config.manualTradingEnabled = true;
      t.after(() => { config.manualTradingEnabled = previous; });
      const sent: unknown[] = [];
      const app = Fastify({ logger: false });
      t.after(() => app.close());
      const shariah: ShariahGateDeps = {
        readMode: async () => {
          if (failAt === "readMode") throw new Error("Shariah mode store unavailable");
          return "enforce";
        },
        lookupBaseAsset: async () => { throw new Error("Shariah registry unavailable"); },
      };
      await app.register(manualTradingRoutes, {
        // Exits must remain available during a halt, too; BUY reaches the
        // failing Shariah read so this test checks its fail-closed behavior.
        riskLimits: async () => ({ tradingHalted: side === "SELL", haltedReason: "operator" }),
        shariah,
        botRequest: async (input: { body?: unknown }) => {
          sent.push(input.body);
          return { ok: true };
        },
      });
      const response = await app.inject({
        method: "POST", url: "/api/manual-trading/orders",
        // A browser-supplied claim must not replace unavailable provenance.
        payload: { ...ORDER, side, shariah: { mode: "off", effectiveStatus: "ELIGIBLE" } },
      });
      if (side === "BUY") {
        assert.equal(response.statusCode, 500);
        assert.equal(sent.length, 0, "unavailable screening must never authorize an entry");
      } else {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(sent.length, 1);
        assert.equal(Object.hasOwn(sent[0] as object, "shariah"), false,
          "an exit needs no decision; unavailable provenance must not be fabricated or copied from the browser");
      }
    });
  }
}

test("the live runner preserves an exit on screening failure, while BUY and the automation halt stay closed", async (t) => {
  let halted = false;
  let claimed = false;
  t.mock.method(pool, "query", async (sql: string) => {
    if (sql.includes("FROM risk_controls")) {
      return { rows: [{ trading_halted: halted, halted_reason: null, halted_by: null,
        max_total_exposure_quote: null, max_concurrent_positions: null,
        max_daily_loss_quote: null, daily_loss_window_hours: DEFAULT_RISK_LIMITS.dailyLossWindowHours }] };
    }
    if (sql.includes("INSERT INTO order_intents")) {
      claimed = true;
      throw new Error("exit reached durable intent claim");
    }
    if (sql.includes("INSERT INTO alerts")) throw new Error("halt reached blocked alert recording");
    throw new Error(`unexpected database query: ${sql}`);
  });
  const dep: DeploymentRow = { id: "11111111-1111-4111-8111-111111111111", strategyId: 1,
    configId: null, symbol: "BTCUSDT", timeframe: "1m", params: {}, status: "active",
    delivery: "custom", webhookUrl: "https://example.com/webhook", secret: "fixture", botUuid: null,
    buyQuoteQty: 10, runtimeState: { ...initialRuntimeState(), position: "long", entryPrice: 50000 },
    lastBarTime: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
  // Exercise the actual chokepoint without starting its websocket/lease loops.
  const runner = Object.create(LiveRunner.prototype) as {
    holdsLease: boolean; shariahDeps: ShariahGateDeps; log: { error: () => void; warn: () => void };
    riskSnapshot: () => Promise<{ currentExposureQuote: number; openPositions: number; realisedPnlInWindow: number }>;
    fireAlert: (dep: DeploymentRow, decision: MtfLeanDecision, next: { position: "flat" | "long" }) => Promise<boolean>;
  };
  runner.holdsLease = true;
  runner.log = { error: () => {}, warn: () => {} };
  runner.shariahDeps = { readMode: async () => { throw new Error("screening unavailable"); } };
  runner.riskSnapshot = async () => ({ currentExposureQuote: 10, openPositions: 1, realisedPnlInWindow: 0 });
  const decision = (action: "buy" | "sell"): MtfLeanDecision => ({ action, price: 50000,
    barTime: 1_788_678_000_000, barIndex: 0, reason: "regression", sellPercent: action === "sell" ? 100 : undefined });
  await assert.rejects(() => runner.fireAlert(dep, decision("sell"), { position: "flat" }),
    /exit reached durable intent claim/);
  assert.equal(claimed, true);
  claimed = false;
  await assert.rejects(() => runner.fireAlert(dep, decision("buy"), { position: "long" }), /screening unavailable/);
  assert.equal(claimed, false);
  halted = true;
  await assert.rejects(() => runner.fireAlert(dep, decision("sell"), { position: "flat" }),
    /halt reached blocked alert recording/);
  assert.equal(claimed, false, "the separate automation halt must still stop all automated emissions");
});

test("a healthy manual SELL preserves its actual Shariah provenance", async (t) => {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });
  let sent: Record<string, unknown> | undefined;
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(manualTradingRoutes, {
    riskLimits: async () => ({ tradingHalted: true, haltedReason: "operator" }),
    shariah: {
      readMode: async () => "enforce",
      lookupBaseAsset: async () => ({ assetId: "7", baseAsset: "BTC",
        effectiveStatus: "EXCLUDED", currentPublicationId: "42" }),
    },
    botRequest: async (input: { body?: unknown }) => {
      sent = input.body as Record<string, unknown>;
      return { ok: true };
    },
  });
  const response = await app.inject({ method: "POST", url: "/api/manual-trading/orders",
    payload: { ...ORDER, side: "SELL" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(sent?.shariah, { mode: "enforce", policyVersion: "TS_SHARIAH_V1",
    assetId: "7", baseAsset: "BTC", effectiveStatus: "EXCLUDED", publicationId: "42" });
});

for (const side of ["BUY", "SELL"] as const) {
  test(`X3A ${side} keeps the same exit/entry rule when screening is unavailable`, async (t) => {
    const previous = config.spotExecutionEnabled;
    config.spotExecutionEnabled = true;
    t.after(() => { config.spotExecutionEnabled = previous; });
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    const sent: Record<string, unknown>[] = [];
    let claimed = false;
    await app.register(spotExecutionRoutes, {
      shariah: { readMode: async () => { throw new Error("screening unavailable"); } },
      claimIntent: async () => {
        claimed = true;
        return { claimed: true, intent: { id: 41, deploymentId: "11111111-1111-4111-8111-111111111111",
          alertId: null, dedupeKey: "outage:BTCUSDT:1788678000000", action: side === "BUY" ? "buy" : "sell",
          barTime: 1_788_678_000_000, exitLeg: null, state: "pending", resolvedAt: null,
          detail: null, emitterId: null, createdAt: 1_788_678_000_000 } };
      },
      resolveIntent: async () => {},
      botRequest: async (input: { body?: unknown }) => {
        sent.push(input.body as Record<string, unknown>);
        return { status: "filled" };
      },
    });
    const response = await app.inject({ method: "POST", url: "/api/spot-execution/v1/orders", payload: {
      deploymentId: "11111111-1111-4111-8111-111111111111", accountId: ORDER.accountId,
      dedupeKey: "outage:BTCUSDT:1788678000000", barTime: 1_788_678_000_000,
      canonicalInstrumentId: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:primary",
      venueSymbol: "BTCUSDT", venue: "binance", environment: "paper",
      side, orderType: "MARKET", baseQuantity: "0.1", paperReferencePrice: "50000",
    } });
    assert.equal(response.statusCode, side === "SELL" ? 200 : 500, response.body);
    assert.equal(claimed, side === "SELL");
    assert.equal(sent.length, side === "SELL" ? 1 : 0);
    if (side === "SELL") assert.equal(Object.hasOwn(sent[0]!, "shariah"), false);
  });

  test(`test-signal ${side} keeps the same exit/entry rule when screening is unavailable`, async (t) => {
    const previous = config.liveTestEnabled;
    config.liveTestEnabled = true;
    t.after(() => { config.liveTestEnabled = previous; });
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    const previousFetch = globalThis.fetch;
    let reachedTicker = false;
    // Stop at the next real seam: proving an exit gets past screening needs
    // neither a database write nor any order delivery.
    globalThis.fetch = async () => { reachedTicker = true; return new Response("provider unavailable", { status: 503 }); };
    t.after(() => { globalThis.fetch = previousFetch; });
    await app.register(deploymentRoutes(() => ({} as LiveRunner), {
      riskLimits: async () => ({ tradingHalted: side === "SELL", haltedReason: "operator" }),
      getDeployment: async () => ({ id: "11111111-1111-4111-8111-111111111111", strategyId: 1,
        configId: null, symbol: "BTCUSDT", timeframe: "1m", params: {}, status: "paused",
        delivery: "custom", webhookUrl: "https://example.com/webhook", secret: "fixture", botUuid: null,
        buyQuoteQty: 10, runtimeState: initialRuntimeState(), enabled: false,
        lastBarTime: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }),
      shariah: { readMode: async () => { throw new Error("screening unavailable"); } },
    }));
    const response = await app.inject({ method: "POST",
      url: "/api/deployments/11111111-1111-4111-8111-111111111111/test-signal",
      payload: { action: side === "BUY" ? "buy" : "sell", confirmation: "LIVE_TEST" } });
    assert.equal(response.statusCode, side === "SELL" ? 502 : 500, response.body);
    assert.equal(reachedTicker, side === "SELL");
    if (side === "SELL") assert.match(response.body, /Binance ticker failed/);
  });
}
