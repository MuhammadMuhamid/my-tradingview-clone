/**
 * The pure logic ported from the standalone Bot dashboard, and its
 * corrections (parity inventory §5): durations, pair names, the history
 * summary ("Worst trade", not a drawdown), the partial preview (fee is an
 * estimate), the polling loop, capability gating and Close gating.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcHistoryStats, capability, capabilityNote, closeBlockReason, fmtDuration, formatPair, pairsPreview,
  partialPreview, startSummary, tradesCap,
} from "../components/bot/botLogic";
import { startPolling } from "../components/bot/polling";
import type { BotControlPanel, BotViewBot, BotViewTrade } from "../lib/api";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

test("fmtDuration: minutes, hours, days, never negative", () => {
  assert.equal(fmtDuration("2026-11-09T11:53:00.000Z", NOW), "7m");
  assert.equal(fmtDuration("2026-11-09T07:48:00.000Z", NOW), "4h 12m");
  assert.equal(fmtDuration("2026-11-07T09:00:00.000Z", NOW), "2d 3h");
  assert.equal(fmtDuration("2026-11-10T00:00:00.000Z", NOW), "0m");
  assert.equal(fmtDuration("not a date", NOW), "—");
});

test("formatPair and pairsPreview", () => {
  assert.equal(formatPair("BTCUSDT"), "BTC/USDT");
  assert.equal(formatPair("ETHUSDC"), "ETH/USDC");
  assert.equal(formatPair("BTC/USDT"), "BTC/USDT");
  assert.equal(pairsPreview(["A1USDT", "B1USDT", "C1USDT", "D1USDT", "E1USDT"]), "A1USDT, B1USDT, C1USDT +2");
  assert.equal(pairsPreview([]), "No pairs");
});

test("history stats: winners, losers, net and the single worst trade", () => {
  const stats = calcHistoryStats([
    { pnlUsdt: 5, pnlPct: 5, pair: "A" }, { pnlUsdt: -3, pnlPct: -3, pair: "B" },
    { pnlUsdt: -7, pnlPct: -6.5, pair: "C" }, { pnlUsdt: 0, pnlPct: 0, pair: "D" },
  ]);
  assert.deepEqual([stats.count, stats.winners, stats.losers], [4, 1, 2]);
  assert.deepEqual([stats.totalProfitUsdt, stats.totalLossUsdt, stats.netUsdt], [5, -10, -5]);
  assert.deepEqual(stats.worstTrade, { pnlUsdt: -7, pnlPct: -6.5, pair: "C" });
  assert.equal(calcHistoryStats([{ pnlUsdt: 1, pnlPct: 1, pair: "A" }]).worstTrade, null);
});

test("partial preview: share, estimated fee on both sides, clamped to 1-99", () => {
  const trade = { quantity: 2, quoteSpent: 200, entryPrice: 100, currentPrice: 110 };
  const p = partialPreview(trade, 50);
  assert.equal(p.sellQty, 1);
  assert.equal(p.costBasis, 100);
  assert.ok(Math.abs(p.estRevenue - 109.89) < 1e-9);
  assert.ok(Math.abs(p.estPnl - (109.89 - 100.1)) < 1e-9);
  assert.equal(p.remainingPct, 50);
  assert.equal(partialPreview(trade, 0).sellQty, 0.02, "at least 1%");
  assert.equal(partialPreview(trade, 100).sellQty, 1.98, "at most 99%");
  assert.equal(partialPreview({ ...trade, entryPrice: null, currentPrice: null }, 50).priceKnown, false);
});

test("startPolling: one loop on the interval, and a cleanup that stops it once", () => {
  const set: { cb: () => void; ms: number }[] = [];
  let cleared = 0;
  let runs = 0;
  const stop = startPolling(() => { runs += 1; }, {
    setInterval: (cb, ms) => { set.push({ cb, ms }); return 7; },
    clearInterval: (h) => { assert.equal(h, 7); cleared += 1; },
  });
  assert.equal(set.length, 1);
  assert.equal(set[0]!.ms, 15_000, "every 15 s, as the Bot dashboard (its footer said 30)");
  set[0]!.cb(); set[0]!.cb();
  assert.equal(runs, 2);
  stop(); stop();
  assert.equal(cleared, 1);
});

const BOT: BotViewBot = {
  id: "b1", name: "Trend", status: "active", pairs: ["BTCUSDT"], investment: "5% of balance", entryEnabled: true,
  exitEnabled: true, takeProfitPct: null, stopLossPct: 3, maxEntryOrders: null, maxActiveSmartTrades: 2,
  account: null, activeTrades: 1, closedTrades: 0, realizedPnl: 0, signalCount: 0, createdAt: "2026-11-01T00:00:00.000Z",
};
const TRADE: BotViewTrade = {
  id: "t1", botId: "b1", botName: "Trend", source: "strategy", pair: "BTCUSDT", status: "active", entryPrice: 1,
  currentPrice: 1, quantity: 1, quoteSpent: 1, pnlUsdt: 0, pnlPct: 0, exchangeOrderId: null, closedReason: null,
  partialCloses: 0, account: null, createdAt: "2026-11-01T00:00:00.000Z", closedAt: null,
};

test("start summary: pairs, size and guards; a missing stop loss or exit is loud", () => {
  const s = startSummary({ ...BOT, stopLossPct: null, exitEnabled: false });
  assert.equal(s.size, "5% of balance per entry");
  assert.deepEqual(s.guards.filter((g) => g.missing).map((g) => g.text), ["NO STOP LOSS", "EXITS DISABLED"]);
  assert.equal(tradesCap(BOT), "1 / 2 open");
  assert.equal(tradesCap({ ...BOT, maxActiveSmartTrades: null }), "1 open");
});

test("capabilities: yes / no (older Bot) / unknown (status unreadable)", () => {
  const panel = (capabilities?: string[]) => ({ facts: { capabilities } }) as unknown as BotControlPanel;
  assert.equal(capability(panel(["bots.v1"]), "bots.v1"), "yes");
  assert.equal(capability(panel(["entries.v1"]), "bots.v1"), "no");
  assert.equal(capability(panel(undefined), "bots.v1"), "no");
  assert.equal(capability({ facts: null } as unknown as BotControlPanel, "bots.v1"), "unknown");
  assert.equal(capability(null, "bots.v1"), "unknown");
  assert.equal(capabilityNote("yes", "X"), null);
  assert.match(capabilityNote("no", "X") ?? "", /needs a newer Bot/);
});

test("Close gating: only an older Bot refuses stopped, delisted and twin trades", () => {
  assert.equal(closeBlockReason(TRADE, [BOT], [TRADE], "no"), null);
  assert.match(closeBlockReason(TRADE, [{ ...BOT, status: "paused" }], [TRADE], "no") ?? "", /stopped/);
  assert.match(closeBlockReason(TRADE, [{ ...BOT, pairs: ["ETHUSDT"] }], [TRADE], "no") ?? "", /no longer in the bot's list/);
  assert.match(closeBlockReason(TRADE, [BOT], [TRADE, { ...TRADE, id: "t2" }], "no") ?? "", /more than one open trade/);
  for (const bots of [[{ ...BOT, status: "paused" }], [{ ...BOT, pairs: [] }]]) {
    assert.equal(closeBlockReason(TRADE, bots, [TRADE, { ...TRADE, id: "t2" }], "yes"), null, "operatorExit.v1 closes by id");
  }
});
