/**
 * U1: the Operations page said NOT CONFIGURED for a Bot this Platform could
 * reach perfectly well over its signed control channel, because the status
 * read only ever looked at custom webhook deployments.
 *
 * Now the signed C0 is preferred whenever the channel is configured, the
 * webhook path is the fallback, and each fact is reported under its own name.
 * A configured channel that cannot reach the Bot is UNREACHABLE — never
 * "not configured", which is a statement about this Platform's settings.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { isBotControlStatus, readBotOperations, readBotStatus } from "../src/operations/botStatus";
import { FakeBot, controlStatus } from "./support/fakeBot";

const SECRET = "bot-status-signed-secret-0123456789abcdef";
const bot = new FakeBot(SECRET);
before(() => bot.start());
after(() => bot.stop());

function channel(t: { after: (fn: () => void) => void }, url: string, secret = SECRET) {
  const previous = { url: config.manualTradingBotUrl, secret: config.manualTradingHmacSecret };
  config.manualTradingBotUrl = url;
  config.manualTradingHmacSecret = secret;
  t.after(() => { config.manualTradingBotUrl = previous.url; config.manualTradingHmacSecret = previous.secret; });
}

const webhookDeployment = {
  delivery: "custom" as const,
  webhookUrl: "https://bot.alphawebstudioz.com/api/webhooks/signal_bots",
  secret: "w".repeat(40),
};

test("with the signed channel configured, C0 answers and there is no NOT CONFIGURED", async (t) => {
  channel(t, bot.url);
  bot.reset();
  const connection = await readBotStatus([]);
  assert.equal(connection.state, "CONNECTED", "no webhook deployment exists, and that no longer matters");
  assert.equal(bot.requests.length, 1);
  assert.equal(bot.requests[0]!.path, "/api/manual-trading/control/status");
  assert.equal(bot.requests[0]!.verified, true, "the read is signed like every other control call");
});

test("the panel reports each fact separately; dry run and halt are independent", async (t) => {
  channel(t, bot.url);
  bot.reset();
  bot.halted = true;
  bot.haltedBy = "daily_loss";
  const { connection, panel } = await readBotOperations([]);
  assert.equal(connection.state, "CONNECTED");
  assert.deepEqual(panel.channel, { configured: true });
  assert.deepEqual(panel.signed, { state: "CONNECTED", cause: null });
  assert.equal(panel.preferred, "signed");
  // The webhook-credential path is a different trust path, reported on its own.
  assert.equal(panel.webhook.state, "NOT_CONFIGURED");
  assert.ok(panel.facts);
  assert.equal(panel.facts.dryRun, true);
  assert.equal(panel.facts.halt.halted, true, "a dry-run Bot can be halted, and says so");
  assert.equal(panel.facts.halt.haltedBy, "daily_loss");
  assert.equal(panel.facts.exchange.routing, "TESTNET");
  assert.equal(panel.facts.shariahFloor.mode, "enforce");
  assert.equal(panel.facts.protection.exchangeResting, false);
  assert.deepEqual(panel.facts.manual, { enabled: true, mainnetEnabled: false });
  assert.ok(!("ready" in panel) && !("state" in panel), "there is no single overall word");
});

test("without a signed channel, the webhook candidates are the fallback", async (t) => {
  channel(t, bot.url, "");
  bot.reset();
  const seen: string[] = [];
  const { connection, panel } = await readBotOperations([webhookDeployment], async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify(controlStatus().operational), { status: 200 });
  });
  assert.equal(connection.state, "CONNECTED");
  assert.deepEqual(seen, ["https://bot.alphawebstudioz.com/api/webhooks/signal_bots/operations"]);
  assert.equal(bot.requests.length, 0, "nothing signed is sent without a key");
  assert.deepEqual(panel.signed, { state: "NOT_CONFIGURED", cause: null });
  assert.equal(panel.channel.configured, false);
  assert.equal(panel.preferred, "webhook");
  assert.equal(panel.facts, null, "could not read is not none");
});

test("a configured channel with the Bot down is UNREACHABLE, not 'not configured'", async (t) => {
  channel(t, "http://127.0.0.1:9");
  const connection = await readBotStatus([]);
  assert.deepEqual(connection, { state: "UNAVAILABLE", configuredEndpoints: 1, reason: "request_failed" });
  const { panel } = await readBotOperations([]);
  assert.equal(panel.channel.configured, true);
  assert.deepEqual(panel.signed, { state: "UNREACHABLE", cause: null });
});

test("a Bot that refuses the signature is REJECTED with its cause", async (t) => {
  channel(t, bot.url, "a-different-secret-0123456789abcdef0123");
  bot.reset();
  const { connection, panel } = await readBotOperations([]);
  assert.deepEqual(panel.signed, { state: "REJECTED", cause: "auth" });
  assert.equal(connection.state, "UNAVAILABLE");
  assert.equal(connection.state === "UNAVAILABLE" && connection.reason, "authentication_rejected");
});

test("an answer that is not the status contract is INVALID, and a limiter is RATE_LIMITED", async (t) => {
  channel(t, bot.url);
  bot.reset();
  bot.replies.push({ status: 200, json: { operational: {}, dryRun: "maybe" } });
  assert.deepEqual((await readBotOperations([])).panel.signed, { state: "INVALID", cause: null });
  bot.replies.push({ status: 429, json: { error: "slow", code: "bot_rate_limited" } });
  assert.deepEqual((await readBotOperations([])).panel.signed, { state: "RATE_LIMITED", cause: null });
  bot.replies.push({ status: 403, raw: "" });
  assert.deepEqual((await readBotOperations([])).panel.signed, { state: "REJECTED", cause: "proxy" });
});

test("the C0 guard rejects drift in any field the Platform shows", () => {
  const good = controlStatus();
  assert.equal(isBotControlStatus(good), true);
  assert.equal(isBotControlStatus({ ...good, exchange: { ...good.exchange, routing: "BOTH" } }), false);
  assert.equal(isBotControlStatus({ ...good, halt: { ...good.halt, halted: "no" } }), false);
  assert.equal(isBotControlStatus({ ...good, risk: { ...good.risk, latched: undefined } }), false);
  assert.equal(isBotControlStatus({ ...good, operational: { service: {} } }), false);
});
