/**
 * The rules a quick-backtest result is read by.
 *
 * Each case here is a defect a reviewer measured on a default run: a headline
 * of 242 LEGS at a leg win rate over windows whose win rates were over
 * ENTRIES; a zero-trade run's profit factor printed as a green ∞; the engine's
 * `invalid SOLUSDT 1h backfill: empty_series` as a list row's body; and a
 * result page from which the run could not be reproduced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareRuns, profitFactorText, profitFactorTone, rerunRequest, runFailure, runFormProblem,
  runSettings, tradeFigures, validationFractionOf, winRateText,
} from "../lib/backtestFigures";
import type { Backtest, BacktestMetrics, Strategy } from "../lib/types";

function metrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    netProfit: 0, netProfitPct: 0, grossProfit: 0, grossLoss: 0, profitFactor: null,
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRatePct: 0, maxDrawdownPct: 0,
    avgTradePct: 0, avgBarsInTrade: 0, commissionPaid: 0, ...over,
  };
}

const STRATEGIES: Strategy[] = [
  { id: 3, key: "srtrend_v10", name: "SR Trend v10", description: null, pineSource: null },
];

function run(over: Partial<Backtest> = {}): Backtest {
  return {
    id: "8f6d2c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b", strategyId: 3, configId: null,
    symbol: "SOLUSDT", timeframe: "1h",
    startTime: "2026-06-01T00:00:00.000Z", endTime: "2026-09-01T23:59:59.000Z",
    params: { rrRatio: 2, qty_cash: 930, qty_pct_equity: 0 },
    initialCapital: 1000, commissionPct: 0.1, slippageTicks: 2,
    status: "done", error: null, metrics: metrics(), equityCurve: [],
    holdoutFraction: null, segments: null, executionTruth: null, stressRunId: null,
    engineFingerprint: "corrections:v7:abc123", semanticsStatus: "reproducible",
    resultProvenance: { engineVersion: "v2-corrected", providerId: "binance-spot", feedId: "binance-public-klines", costs: { tickSize: 0.01 } },
    createdAt: "2026-09-02T08:15:00.000Z",
    ...over,
  };
}

// ── C-1: one denominator ────────────────────────────────────────────────────

test("a run that names its entries is read in entries, headline and window alike", () => {
  // The measured default run: 242 legs at 17.4 %, but 208 entries.
  const headline = tradeFigures(metrics({
    totalTrades: 242, winRatePct: 17.4, winningTrades: 42, losingTrades: 200, profitFactor: 0.8,
    entries: 208, winningEntries: 40, losingEntries: 168, entryWinRatePct: 19.23, entryProfitFactor: 0.9,
  }));
  assert.equal(headline.basis, "entries");
  assert.equal(headline.count, 208, "the count must be entries, the population the rate describes");
  assert.equal(headline.winRatePct, 19.23);
  assert.equal(headline.profitFactor, 0.9);
  assert.equal(headline.legs, 242, "legs are kept, for the trade list's row count");
});

test("a window recorded before the entry names is still read in entries", () => {
  // The engine overwrote winRatePct/profitFactor/win-loss with entry values
  // and left totalTrades as legs. The old table printed 68 beside a rate over 60.
  const w = tradeFigures(metrics({
    totalTrades: 68, entries: 60, winRatePct: 25, winningTrades: 15, losingTrades: 45, profitFactor: 1.1,
  }));
  assert.equal(w.basis, "entries");
  assert.equal(w.count, 60);
  assert.equal(w.wins + w.losses, w.count, "every number in the row shares the denominator");
});

test("an old headline that recorded only legs says legs, rather than pretending", () => {
  const h = tradeFigures(metrics({ totalTrades: 242, winRatePct: 17.4, winningTrades: 42, losingTrades: 200 }));
  assert.equal(h.basis, "legs");
  assert.equal(h.count, 242);
});

// ── C-15: no ∞ for nothing ──────────────────────────────────────────────────

test("a run that took nothing has no profit factor and no win rate", () => {
  const none = tradeFigures(metrics({ entries: 0, entryWinRatePct: 0, entryProfitFactor: null }));
  assert.equal(profitFactorText(none), "—", "a zero-trade run must not claim ∞");
  assert.equal(profitFactorTone(none), "none", "and must not be painted as a gain");
  assert.equal(winRateText(none), "—");
  const lossless = tradeFigures(metrics({ entries: 4, winningEntries: 4, entryWinRatePct: 100, entryProfitFactor: null }));
  assert.equal(profitFactorText(lossless), "∞", "four trades and no loss is a real ∞");
  assert.equal(profitFactorTone(lossless), "up");
});

// ── C-10: failures in the reader's words ────────────────────────────────────

test("an empty window is explained and given a recovery; the engine's words are kept", () => {
  const f = runFailure("invalid SOLUSDT 1h backfill: empty_series");
  assert.match(f.headline, /no candles for SOLUSDT 1h/);
  assert.match(f.action, /trading history/);
  assert.equal(f.detail, "invalid SOLUSDT 1h backfill: empty_series", "the cause is kept verbatim");
  assert.doesNotMatch(f.headline + f.action, /empty_series|backfill:/, "and is never the copy");
});

test("each known engine failure has its own sentence, and an unknown one still has a recovery", () => {
  assert.match(runFailure("internal candle gap in SOLUSDT 1h: 3 1h bar(s) missing; …").headline, /gap/);
  assert.match(runFailure("invalid SOLUSDT 15m backfill: invalid_close_time").headline, /integrity check/);
  assert.match(runFailure("no tick size available for SOLUSDT").headline, /tick size/);
  assert.match(runFailure("Binance 502: bad gateway").headline, /did not answer/);
  assert.match(runFailure("Binance returned no 1h klines for ABCUSDT in range").headline, /no candles/);
  const unknown = runFailure("TypeError: cannot read properties of undefined");
  assert.match(unknown.headline, /stopped before/);
  assert.ok(unknown.action.length > 0, "an unknown failure still says what to do");
  assert.equal(runFailure(null).detail, "");
});

// ── C-2: reproducible from the page ─────────────────────────────────────────

test("the run settings state everything needed to reproduce the result", () => {
  const rows = new Map(runSettings(run({ holdoutFraction: 0.3 }), STRATEGIES).map((r) => [r.label, r]));
  assert.equal(rows.get("Strategy")?.value, "SR Trend v10");
  assert.equal(rows.get("Strategy")?.title, "key srtrend_v10");
  assert.equal(rows.get("Window requested (UTC)")?.value, "2026-06-01 → 2026-09-01");
  assert.equal(rows.get("Validation split")?.value, "last 30% of the window");
  assert.equal(rows.get("Commission")?.value, "0.1% per fill");
  assert.equal(rows.get("Slippage")?.value, "2 ticks per fill");
  assert.equal(rows.get("Position size")?.value, "930 cash per entry");
  assert.equal(rows.get("Data source")?.value, "Binance Spot");
  assert.equal(rows.get("Engine")?.value, "v2-corrected");
  assert.equal(rows.get("Engine")?.title, "corrections:v7:abc123", "the fingerprint is one hover away");
  assert.match(rows.get("Result provenance")?.value ?? "", /^Reproducible/);
  assert.equal(rows.get("Created")?.value, "2026-09-02 08:15 UTC");
  // A run that stated no fraction took the engine's — and says it did.
  assert.equal(validationFractionOf(run()).stated, false);
  assert.match(new Map(runSettings(run(), STRATEGIES).map((r) => [r.label, r.value])).get("Validation split") ?? "",
    /last 20% of the window \(engine default\)/);
});

test("re-running sends the stored snapshot, not the config it came from", () => {
  const body = rerunRequest(run({ configId: "c0nf", holdoutFraction: 0.25 }), "srtrend_v10");
  assert.equal(body.strategyKey, "srtrend_v10");
  assert.equal(body.endTime, "2026-09-01T23:59:59.000Z", "the stored instant, not its calendar day");
  assert.deepEqual(body.params, { rrRatio: 2, qty_cash: 930, qty_pct_equity: 0 });
  assert.equal(body.holdoutFraction, 0.25);
  assert.equal(body.commissionPct, 0.1);
  assert.equal(body.slippageTicks, 2);
  assert.ok(!("configId" in body), "a config edited since must not change what 'the same settings' means");
  assert.ok(!("holdoutFraction" in rerunRequest(run(), "srtrend_v10")), "an unstated fraction stays unstated");
});

// ── C-9: the form refuses what the server refuses ───────────────────────────

test("the form refuses impossible numbers and a future window before sending", () => {
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const ok = { capital: 1000, commissionPct: 0.1, slippageTicks: 2, start: "2026-09-01", end: "2026-10-10", params: {} };
  assert.equal(runFormProblem(ok, NOW), null);
  assert.match(runFormProblem({ ...ok, capital: -5 }, NOW) ?? "", /capital must be greater than 0/);
  assert.match(runFormProblem({ ...ok, commissionPct: -1 }, NOW) ?? "", /Commission/);
  assert.match(runFormProblem({ ...ok, slippageTicks: -50 }, NOW) ?? "", /Slippage/);
  assert.match(runFormProblem({ ...ok, end: "2026-10-11" }, NOW) ?? "", /in the future/);
  assert.match(runFormProblem({ ...ok, start: "2026-10-10" }, NOW) ?? "", /before the end/);
  // The schema's own bounds: "Reward : Risk ratio" has min 0.25.
  assert.match(runFormProblem({ ...ok, params: { rrRatio: -2 } }, NOW) ?? "", /Reward : Risk ratio must be at least 0\.25/);
  // Bounds come from the CHOSEN strategy's schema: a strategy without that
  // field is not checked against another strategy's limit for it.
  assert.equal(runFormProblem({ ...ok, params: { rrRatio: -2 }, strategyKey: "no_such_strategy" }, NOW), null);
});

test("C-01 the form refuses an order size larger than the initial capital", () => {
  const NOW = Date.parse("2026-10-10T12:00:00Z");
  const ok = { capital: 1000, commissionPct: 0.1, slippageTicks: 2, start: "2026-09-01", end: "2026-10-10", params: {} };
  // The form sends no qty_cash, so the CHOSEN strategy's engine default runs:
  // 930 for ma_rr_v9, 1,000 for mtf_lean.
  assert.equal(runFormProblem({ ...ok, strategyKey: "ma_rr_v9" }, NOW), null);
  assert.equal(runFormProblem({ ...ok, capital: 100, strategyKey: "ma_rr_v9" }, NOW),
    "The order size (930 per entry) is more than the initial capital (100). "
    + "A spot account cannot spend more than it holds — lower the order size or raise the initial capital.");
  assert.equal(runFormProblem({ ...ok, capital: 950, strategyKey: "ma_rr_v9" }, NOW), null);
  assert.match(runFormProblem({ ...ok, capital: 950, strategyKey: "mtf_lean" }, NOW) ?? "",
    /order size \(1,000 per entry\)/);
  // A preset's own snapshot wins over the default, either way.
  assert.equal(runFormProblem({ ...ok, capital: 100, params: { qty_cash: 90 } }, NOW), null);
  assert.equal(runFormProblem({ ...ok, capital: 100, params: { qty_pct_equity: 50 } }, NOW), null);
});

// ── C-7: two runs side by side ──────────────────────────────────────────────

test("a comparison puts the differing settings and every window side by side", () => {
  const a = run({ metrics: metrics({ netProfitPct: 4, entries: 20, entryWinRatePct: 55, winningEntries: 11, losingEntries: 9, entryProfitFactor: 1.4 }) });
  const b = run({ id: "other", commissionPct: 0.2, metrics: metrics({ netProfitPct: -1, entries: 20, entryWinRatePct: 45, winningEntries: 9, losingEntries: 11, entryProfitFactor: 0.9 }) });
  const cmp = compareRuns(a, b, STRATEGIES);
  const commission = cmp.settings.find((r) => r.label === "Commission")!;
  assert.deepEqual([commission.a, commission.b, commission.differs], ["0.1% per fill", "0.2% per fill", true]);
  assert.equal(cmp.settings.find((r) => r.label === "Symbol")!.differs, false);
  assert.equal(cmp.headline.find((r) => r.label === "Trades")!.a, "20 entries");
  assert.equal(cmp.headline.find((r) => r.label === "Net profit")!.b, "-1.00%");
  assert.ok(cmp.windows.some((r) => r.label.startsWith("Validation")), "the validation window is compared too");
});

test("C-07 differing strategy parameters are listed key by key, not as 'differ / differ'", () => {
  const a = run({ params: { rrRatio: 2, qty_cash: 930, ma_len: 50 } });
  const b = run({ id: "other", params: { rrRatio: 3, qty_cash: 930, use_filter: true } });
  const cmp = compareRuns(a, b, STRATEGIES);
  const summary = cmp.settings.find((r) => r.label === "Strategy parameters")!;
  assert.deepEqual([summary.a, summary.b, summary.differs], ["3 of 4 differ", "3 of 4 differ", true]);
  const rows = cmp.settings.filter((r) => r.label.startsWith("Parameter "));
  assert.deepEqual(rows.map((r) => [r.label, r.a, r.b]), [
    ["Parameter ma_len", "50", "not set"],
    ["Parameter rrRatio", "2", "3"],
    ["Parameter use_filter", "not set", "true"],
  ], "each differing key, a's value beside b's; the shared qty_cash is not repeated");
  assert.ok(rows.every((r) => r.differs));

  const same = compareRuns(a, run({ id: "twin", params: { ...a.params } }), STRATEGIES);
  assert.deepEqual(same.settings.find((r) => r.label === "Strategy parameters")!.a, "same");
  assert.equal(same.settings.filter((r) => r.label.startsWith("Parameter ")).length, 0);
});

test("C-07 a setting or a window one run did not record says so, rather than a bare dash", () => {
  const a = run({ segments: null });
  const b = run({ id: "other" });
  const cmp = compareRuns(a, b, STRATEGIES);
  const validation = cmp.windows.find((r) => r.label === "Validation — Net profit")!;
  assert.equal(validation.a, "not recorded for this run");
  assert.ok(![...cmp.settings, ...cmp.headline, ...cmp.windows].some((r) => r.a === "—" || r.b === "—"),
    "no comparison cell is a bare dash");
});
