/**
 * RR2: the Bot now says whether its TP/SL poller is really running —
 * `tradingHalted`, `protection.polling`, `protection.haltedBy`,
 * `protection.mainnetPositionsChecked`, and a "NOT being checked" note. The
 * browser can only refuse to call a position protected if those fields reach
 * it, so the Platform's state proxy must pass them through untouched. (D3 was
 * a route that dropped fields it did not know: the Journal discarded
 * `accounts`.) An older Bot that sends none of them must also pass through as
 * it is — absent, not defaulted to "polling".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { config } from "../src/config";
import { manualTradingRoutes } from "../src/api/routes/manualTrading";

const BASE = {
  enabled: true, mainnetEnabled: false, dryRun: true, mixed: false,
  accounts: [{ id: "acct-test", name: "T", exchange: "binance", marketType: "spot", testnet: true, mode: "testnet" }],
  orders: [],
  positions: [{ id: "p1", exchangeAccountId: "acct-test", pair: "BTCUSDT", status: "active",
    manualTpPrice: 75000, manualSlPrice: 65000, protectionType: "bot-managed", protectionState: "active" }],
};

async function read(t: import("node:test").TestContext, botState: unknown): Promise<unknown> {
  const previous = config.manualTradingEnabled;
  config.manualTradingEnabled = true;
  t.after(() => { config.manualTradingEnabled = previous; });
  const paths: string[] = [];
  const app = Fastify({ logger: false });
  await manualTradingRoutes(app, { botRequest: (async (input: { path: string }) => {
    paths.push(input.path); return botState;
  }) as never });
  t.after(() => app.close());
  const res = await app.inject({ method: "GET", url: "/api/manual-trading/state?symbol=BTCUSDT" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(paths, ["/api/manual-trading/state?symbol=BTCUSDT"]);
  return res.json();
}

test("the Bot's halt and poller report reaches the browser untouched", async (t) => {
  const halted = { ...BASE, tradingHalted: true, protection: { type: "bot-managed", exchangeResting: false,
    polling: false, haltedBy: "operator", mainnetPositionsChecked: false,
    note: "TP/SL is NOT being checked: the Bot is halted. Your own SELL still works; resume the Bot to restore protection." } };
  assert.deepEqual(await read(t, halted), halted);
});

test("an older Bot's state passes through without invented poller fields", async (t) => {
  const old = { ...BASE, protection: { type: "bot-managed", exchangeResting: false,
    note: "Checked by the bot poller; no exchange-resting protective order is claimed." } };
  const body = await read(t, old) as { tradingHalted?: unknown; protection: Record<string, unknown> };
  assert.deepEqual(body, old);
  assert.equal("tradingHalted" in body, false);
  assert.equal("polling" in body.protection, false, "absent must stay absent: unknown, not polling");
});
