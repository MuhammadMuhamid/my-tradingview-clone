import { test } from "node:test";
import assert from "node:assert/strict";
import {
  botStatusCandidates, isBotOperationalStatus, readBotStatus,
} from "../src/operations/botStatus";

const secret = "s".repeat(40);
const deployment = {
  delivery: "custom" as const,
  webhookUrl: "https://bot.alphawebstudioz.com/api/webhooks/signal_bots",
  secret,
};

const payload = {
  service: { reachable: true, name: "signal-bot", version: "1.0.0" },
  execution: { mode: "LIVE", dryRun: false, halted: false, haltedBy: null, haltedReason: null },
  exchange: {
    mode: "MIXED", processDefault: "MAINNET",
    configuredAccounts: { total: 2, testnet: 1, mainnet: 1 },
  },
  realisedPnl: {
    currency: "USDT", today: -12.5, dayStart: "2026-08-31T00:00:00.000Z",
    timezone: "UTC", rollingWindowHours: 24, rolling: -9,
  },
  openTrades: { count: 2, exposureQuote: 150, currency: "USDT" },
  dailyLossProtection: {
    authority: "BOT", limitQuote: 100, windowHours: 24,
    realisedPnlInWindow: -9, enabled: true,
  },
  time: "2026-08-31T12:00:00.000Z",
};

test("bot status URL is derived from the already-validated webhook endpoint", () => {
  const candidates = botStatusCandidates([deployment]);
  assert.equal(candidates.length, 1);
  assert.equal(
    candidates[0]?.url,
    "https://bot.alphawebstudioz.com/api/webhooks/signal_bots/operations"
  );
  assert.equal(botStatusCandidates([{ ...deployment, webhookUrl: "http://127.0.0.1/signal_bots" }]).length, 0);
});

test("connected bot status is validated and the credential is sent only in the request body", async () => {
  let seenUrl = "";
  let seenBody = "";
  const result = await readBotStatus([deployment], async (input, init) => {
    seenUrl = String(input);
    seenBody = String(init?.body);
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  assert.equal(result.state, "CONNECTED");
  assert.ok(!seenUrl.includes(secret));
  assert.deepEqual(JSON.parse(seenBody), { secret });
});

test("auth rejection and malformed responses render as unavailable, without remote details", async () => {
  const rejected = await readBotStatus([deployment], async () => new Response("no", { status: 401 }));
  assert.deepEqual(rejected, {
    state: "UNAVAILABLE", configuredEndpoints: 1, reason: "authentication_rejected",
  });

  assert.equal(isBotOperationalStatus({ ...payload, realisedPnl: { today: "guess" } }), false);
  const malformed = await readBotStatus(
    [deployment],
    async () => new Response(JSON.stringify({ secret, status: "ok" }), { status: 200 })
  );
  assert.deepEqual(malformed, {
    state: "UNAVAILABLE", configuredEndpoints: 1, reason: "invalid_response",
  });
});
