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

// ── the bot form (port of bot/frontend/src/lib/botForm.ts, §5 fixes) ─────────
import {
  buildBotPayload, changedFieldNames, changedFields, defaultBotForm, formFromBot, investmentEstimate, unsafeConfigReason, validateBotForm,
  weakensProtection,
} from "../components/bot/botForm";
import type { BotConfigView } from "../lib/botManageApi";

test("form defaults are the safe ones (5%, exits on, 3% stop loss) and validate once a pair is chosen", () => {
  assert.deepEqual([defaultBotForm.maxInvestmentPct, defaultBotForm.exitEnabled, defaultBotForm.stopLossEnabled, defaultBotForm.stopLossPct],
    ["5", true, true, "3"]);
  assert.deepEqual(Object.keys(validateBotForm(defaultBotForm)), ["pairs"]);
  assert.deepEqual(validateBotForm({ ...defaultBotForm, pairs: ["BTCUSDT"] }), {});
});

test("form validation mirrors the Bot: name, pairs, per-unit bounds, empty numbers, the 50% rule", () => {
  const ok = { ...defaultBotForm, pairs: ["BTCUSDT"] };
  assert.ok(validateBotForm({ ...ok, name: "   " }).name);
  assert.ok(validateBotForm({ ...ok, name: "x".repeat(65) }).name);
  assert.ok(validateBotForm({ ...ok, pairs: ["BTCEUR"] }).pairs);
  assert.equal(validateBotForm({ ...ok, pairs: ["OLD-PAIR"] }, ["OLD-PAIR"]).pairs, undefined, "a kept pair is not re-judged");
  assert.ok(validateBotForm({ ...ok, maxInvestmentPct: "101" }).maxInvestmentPct, "a percentage is at most 100");
  assert.equal(validateBotForm({ ...ok, maxInvestmentPct: "5000", maxInvestmentUnit: "usdt_bot" }).maxInvestmentPct, undefined);
  assert.ok(validateBotForm({ ...ok, entryVolumePct: "" }).entryVolumePct, "empty is an error, never 0");
  assert.ok(validateBotForm({ ...ok, stopLossPct: "abc" }).stopLossPct);
  assert.ok(validateBotForm({ ...ok, maxActiveSmartTradesEnabled: true, maxActiveSmartTrades: "1.5" }).maxActiveSmartTrades);
  assert.ok(validateBotForm({ ...ok, maxEntryOrders: "0" }).maxEntryOrders);
  assert.equal(unsafeConfigReason({ ...ok, maxInvestmentPct: "50", entryVolumePct: "100", stopLossEnabled: false })?.includes("50%"), true);
  assert.equal(unsafeConfigReason({ ...ok, maxInvestmentPct: "60", entryVolumePct: "50", stopLossEnabled: false }), null, "30% effective");
  assert.equal(unsafeConfigReason({ ...ok, maxInvestmentPct: "5000", maxInvestmentUnit: "usdt_bot", stopLossEnabled: false }), null);
});

const VIEW: BotConfigView = {
  id: "b", name: "Trend", status: "active", alertType: "custom", direction: "long", pairs: ["BTCUSDT"], maxInvestmentPct: 5,
  maxInvestmentUnit: "pct_bot", maxInvestmentLabel: "5%", entryEnabled: true, entryVolumePct: 50, entryOrderType: "market",
  exitEnabled: true, takeProfitPct: null, stopLossPct: 3, maxEntryOrders: 2, maxActiveSmartTradesEnabled: true,
  maxActiveSmartTrades: 2, exchangeAccountId: "a1", exchangeAccount: null, webhookSecretMasked: "••••abcd",
  webhookPath: "/api/webhooks/signal_bots", activeTrades: 0, unresolvedIntents: 0, createdAt: "", updatedAt: "",
};

test("payload, round trip, and an edit sends only what changed (a switch travels with its value)", () => {
  const payload = buildBotPayload({ ...defaultBotForm, pairs: ["BTCUSDT"], takeProfitEnabled: false });
  assert.deepEqual([payload.takeProfitPct, payload.stopLossPct, payload.maxActiveSmartTrades, payload.exchangeAccountId, payload.maxEntryOrders],
    [null, 3, null, null, null]);
  const form = formFromBot(VIEW);
  assert.deepEqual(changedFields(form, form), {});
  assert.deepEqual(changedFields(form, { ...form, name: "New" }), { name: "New" });
  assert.deepEqual(changedFields(form, { ...form, stopLossEnabled: false }), { stopLossEnabled: false, stopLossPct: null });
  assert.deepEqual(changedFields(form, { ...form, maxInvestmentPct: "4" }), { maxInvestmentPct: 4, maxInvestmentUnit: "pct_bot" });
  // The summary names only what changed; the unit still travels in the payload (browser defect V3-1).
  assert.deepEqual(changedFieldNames(form, { ...form, maxInvestmentPct: "4" }), ["maxInvestmentPct"]);
  assert.deepEqual(changedFieldNames(form, form), []);
});

test("the client's weakening rule matches the server's list", () => {
  const w = (changed: Record<string, unknown>) => weakensProtection(changed, VIEW);
  for (const c of [{ stopLossEnabled: false }, { stopLossPct: 4 }, { maxInvestmentPct: 6 }, { maxInvestmentUnit: "pct_trade" },
    { entryVolumePct: 60 }, { maxActiveSmartTradesEnabled: false }, { maxActiveSmartTrades: 3 }, { maxEntryOrders: null },
    { exchangeAccountId: "b2" }, { exitEnabled: false }]) assert.equal(w(c), true, JSON.stringify(c));
  assert.equal(weakensProtection({ entryEnabled: true }, { ...VIEW, entryEnabled: false }), true);
  for (const c of [{ name: "x" }, { stopLossPct: 2 }, { takeProfitPct: 9 }, { maxInvestmentPct: 4 }, { pairs: ["ETHUSDT"] }]) {
    assert.equal(w(c), false, JSON.stringify(c));
  }
  assert.equal(investmentEstimate({ ...defaultBotForm }, 812.5), "≈ 40.63 USDT of 812.50 available");
  assert.equal(investmentEstimate({ ...defaultBotForm, maxInvestmentUnit: "usdt_bot" }, 812.5), null);
});
