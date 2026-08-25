import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, customDedupeKey, deliver, validateWebhookUrl } from "../src/engine/../alerts/dispatcher";
import type { DeploymentRow } from "../src/types/deployments";
import { initialRuntimeState } from "../src/types/deployments";
import type { CustomBotAlertPayload, ThreeCommasAlertPayload } from "../src/types/alerts";

function dep(overrides: Partial<DeploymentRow>): DeploymentRow {
  return {
    id: "d1", strategyId: 1, configId: null, symbol: "APTUSDT", timeframe: "5m",
    params: {}, status: "active", delivery: "custom",
    webhookUrl: "http://localhost:9999/hook", secret: "s".repeat(40), botUuid: null,
    buyQuoteQty: 800, runtimeState: initialRuntimeState(), lastBarTime: null,
    createdAt: "", updatedAt: "", ...overrides,
  };
}

const ctx = {
  action: "buy" as const, price: 12.34, barTime: 1_700_000_000_000, barIndex: 42,
  marketPosition: "long" as const, positionSize: 64.8,
  prevMarketPosition: "flat" as const, prevPositionSize: 0, contracts: 64.8,
};

test("webhook validation permits only exact approved HTTPS hosts", () => {
  assert.doesNotThrow(() => validateWebhookUrl("https://bot.alphawebstudioz.com/api/webhooks/signal_bots"));
  assert.throws(() => validateWebhookUrl("http://bot.alphawebstudioz.com/api/webhooks/signal_bots"));
  assert.throws(() => validateWebhookUrl("https://127.0.0.1/hook"));
  assert.throws(() => validateWebhookUrl("https://bot.alphawebstudioz.com.evil.test/hook"));
});

test("custom BUY payload matches f_bot_json_buy shape exactly", () => {
  const { payload, dedupeKey } = buildPayload(dep({ delivery: "custom" }), ctx);
  const p = payload as CustomBotAlertPayload;
  assert.equal(p.action, "buy");
  assert.equal(p.symbol, "APTUSDT");
  assert.equal(p.quote_order_qty, 800);
  // Contract v1: the key is derived from bar OPEN TIME only. The bar index is
  // gone because the two senders computed it differently (X-02).
  assert.equal(p.dedupe_key, "L-1700000000000");
  assert.equal(dedupeKey, "L-1700000000000");
  assert.equal(p.secret, "s".repeat(40));
});

test("custom SELL payload omits quote_order_qty and uses X- prefix", () => {
  const { payload } = buildPayload(dep({ delivery: "custom" }), { ...ctx, action: "sell", marketPosition: "flat" });
  const p = payload as CustomBotAlertPayload;
  assert.equal(p.action, "sell");
  assert.equal(p.dedupe_key, "X-1700000000000");
  assert.ok(!("quote_order_qty" in p));
});

test("custom partial SELL carries current-position percentage and tier-scoped dedupe", () => {
  const { payload, dedupeKey } = buildPayload(dep({ delivery: "custom" }), {
    ...ctx,
    action: "sell",
    marketPosition: "long",
    sellPercent: 50,
    exitLeg: "tp2",
  });
  const p = payload as CustomBotAlertPayload;
  assert.equal(p.sell_percent, 50);
  assert.equal(p.exit_leg, "tp2");
  assert.equal(p.dedupe_key, "X-1700000000000-tp2");
  assert.equal(dedupeKey, p.dedupe_key);
  assert.ok(!("quote_order_qty" in p));
});

test("3commas payload matches template field-for-field, all strings", () => {
  const { payload, url } = buildPayload(
    dep({ delivery: "3commas", botUuid: "bot-123", webhookUrl: undefined }), ctx
  );
  const p = payload as ThreeCommasAlertPayload;
  assert.equal(url, "https://api.3commas.io/signal_bots/webhooks");
  assert.equal(p.max_lag, "300");
  assert.equal(p.tv_exchange, "BINANCE");
  assert.equal(p.tv_instrument, "APTUSDT");
  assert.equal(p.action, "buy");
  assert.equal(p.bot_uuid, "bot-123");
  assert.equal(p.order.currency_type, "base");
  assert.equal(p.order.amount, "64.8");
  assert.equal(p.strategy_info.market_position, "long");
  assert.equal(p.strategy_info.prev_market_position, "flat");
  assert.equal(typeof p.trigger_price, "string");
});

test("delivery=off builds a payload but no url", () => {
  const { url } = buildPayload(dep({ delivery: "off" }), ctx);
  assert.equal(url, null);
});

test("customDedupeKey prefixes, and the bar index is ignored", () => {
  assert.equal(customDedupeKey("buy", 5, 1000), "L-1000");
  assert.equal(customDedupeKey("sell", 5, 1000), "X-1000");
  assert.equal(customDedupeKey("sell", 5, 1000, "tp1"), "X-1000-tp1");
  // Contract v1 drops the bar index: the two senders computed it differently,
  // so the same bar produced different keys (X-02). The parameter is kept so
  // callers do not have to change shape, and is deliberately not used.
  assert.equal(customDedupeKey("buy", 5, 1000), customDedupeKey("buy", 999_999, 1000));
});

test("deliver returns skipped when url is null", async () => {
  const res = await deliver(null, buildPayload(dep({ delivery: "off" }), ctx).payload);
  assert.equal(res.status, "skipped");
  assert.equal(res.attempts, 0);
});

test("deliver posts JSON and returns sent on 200", async () => {
  const { createServer } = await import("node:http");
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await deliver(
      `http://localhost:${port}/hook`,
      buildPayload(dep({}), ctx).payload,
      { allowUnsafeTestUrl: true }
    );
    assert.equal(res.status, "sent");
    assert.equal(res.httpStatus, 200);
    assert.equal((received[0] as CustomBotAlertPayload).dedupe_key, "L-1700000000000");
  } finally {
    // Without the finally, a failed assertion leaves this server listening and
    // the test FILE never exits — the failure becomes a hang.
    server.close();
  }
});

test("deliver stops early on 4xx (no retry storm)", async () => {
  const { createServer } = await import("node:http");
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.writeHead(400); res.end("bad"); });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const res = await deliver(`http://localhost:${port}/hook`, buildPayload(dep({}), ctx).payload, { maxAttempts: 4, allowUnsafeTestUrl: true });
  assert.equal(res.status, "failed");
  assert.equal(res.httpStatus, 400);
  assert.equal(hits, 1); // 400 is terminal
  server.close();
});

test("deliver reconciles an already-flat custom SELL", async () => {
  const { createServer } = await import("node:http");
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No active SmartTrade for ALLOUSDT" }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const payload = buildPayload(dep({}), {
    ...ctx,
    action: "sell",
    marketPosition: "flat",
  }).payload;
  const res = await deliver(`http://localhost:${port}/hook`, payload, {
    maxAttempts: 4,
    allowUnsafeTestUrl: true,
  });
  assert.equal(res.status, "skipped");
  assert.equal(res.reconciled, true);
  assert.equal(res.attempts, 1);
  assert.equal(hits, 1);
  server.close();
});
