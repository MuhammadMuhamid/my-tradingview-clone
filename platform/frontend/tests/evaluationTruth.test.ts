/**
 * C-03 / C-04 / C-05 / C-06: the pages say what the install will actually do,
 * and a search lands on the instrument a reader means.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ALERT_EVALUATOR_OFF_NOTICE, ARMED_NOT_EVALUATED, alertEvaluatorOff, alertInventoryTitle,
  alertsPageDescription, alertStateLabel, automationsHeadline, automationsRailCount,
  deploymentStatusLabel, runnerOff,
} from "../lib/evaluationState";
import { rankSearchResults } from "../lib/symbolSearch";
import type { MaAlert, StrategyRunnerStatus, SymbolSearchResult } from "../lib/api";

const OFF: StrategyRunnerStatus = { state: "off", evaluating: false, reason: "LIVE_RUNNER_ENABLED is not \"true\"" };
const LIVE: StrategyRunnerStatus = { state: "live", evaluating: true, reason: "lease held" };
const HALTED: StrategyRunnerStatus = { state: "halted", evaluating: true, reason: "halted" };

const alert = (over: Partial<MaAlert> = {}): MaAlert =>
  ({ id: "a", symbol: "BTCUSDT", enabled: true, completedAt: null, ...over }) as MaAlert;

/* ── C-03 ──────────────────────────────────────────────────────────────── */

test("the alert evaluator is off only when the server says so — unknown is not off", () => {
  assert.equal(alertEvaluatorOff({ evaluation: { enabled: false, reason: "x" } }), true);
  assert.equal(alertEvaluatorOff({ evaluation: { enabled: true, reason: null } }), false);
  assert.equal(alertEvaluatorOff({}), false, "an older backend sends no evaluation");
  assert.equal(alertEvaluatorOff(null), false, "a failed read is not an outage");
});

test("an armed alert says it is not evaluated, while paused and spent keep their reason", () => {
  assert.equal(alertStateLabel(alert(), false), "Active");
  assert.equal(alertStateLabel(alert(), true), ARMED_NOT_EVALUATED);
  assert.equal(alertStateLabel(alert({ enabled: false }), true), "Paused");
  assert.equal(alertStateLabel(alert({ completedAt: "2026-01-01T00:00:00Z" }), true), "Fired once — done");
  assert.match(ARMED_NOT_EVALUATED.toLowerCase(), /armed · not evaluated here/);
});

test("the inventory and page copy stop promising evaluation when the evaluator is off", () => {
  assert.equal(alertInventoryTitle(1, 1, false), "Notification alerts · 1 of 1 armed");
  assert.equal(alertInventoryTitle(1, 1, true), "Notification alerts · 1 of 1 armed · not evaluated here");
  assert.equal(alertInventoryTitle(0, 2, true), "Notification alerts · 0 of 2 armed");
  assert.match(alertsPageDescription(false), /evaluated server-side/);
  assert.doesNotMatch(alertsPageDescription(true), /evaluated server-side and pushed/);
  // The product's sentence, never the server's operator wording.
  for (const copy of [ALERT_EVALUATOR_OFF_NOTICE, alertsPageDescription(true)]) {
    assert.doesNotMatch(copy, /MA_ALERTS_ENABLED|LIVE_RUNNER_ENABLED/);
  }
  assert.equal(ALERT_EVALUATOR_OFF_NOTICE,
    "Alerts are saved but not evaluated on this install — the alert evaluator is turned off.");
});

/* ── C-04 ──────────────────────────────────────────────────────────────── */

test("an automation is not 'running' when the strategy runner is off", () => {
  assert.equal(runnerOff(OFF), true);
  assert.equal(runnerOff(LIVE), false);
  assert.equal(runnerOff(null), false, "an unanswered status is unknown, not off");

  assert.equal(automationsHeadline(1, LIVE), "1 running");
  assert.equal(automationsHeadline(1, null), "1 running");
  assert.equal(automationsHeadline(1, OFF), "1 active · runner off");
  assert.doesNotMatch(automationsHeadline(1, OFF), /running/);
  assert.equal(automationsHeadline(2, HALTED), "2 active · trading halted");
  assert.equal(automationsRailCount(1, OFF), "1 active · runner off");
  assert.equal(automationsRailCount(1, LIVE), "1 active");
});

test("the deployment badge says 'Active · runner off' and only for an active row", () => {
  assert.deepEqual(deploymentStatusLabel("active", OFF),
    { label: "Active · runner off", tone: "warning", key: "active-runner-off" });
  assert.equal(deploymentStatusLabel("active", LIVE).label, "active");
  assert.equal(deploymentStatusLabel("active", LIVE).tone, "positive");
  assert.equal(deploymentStatusLabel("paused", OFF).label, "paused",
    "a paused automation is paused whatever the runner does");
  assert.equal(deploymentStatusLabel("active", HALTED).label, "Active · halted");
});

test("every surface that arms alerts or lists automations reads the evaluation state", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  // One shared field is in every create/edit dialog, so it carries the notice.
  for (const dialog of ["PriceAlertModal", "LevelAlertModal", "MaAlertModal", "IndicatorAlertModal", "AlertEditor"]) {
    assert.match(read(`components/tv/${dialog}.tsx`), /<AlertArmedField/, `${dialog} lost the armed field`);
  }
  assert.match(read("components/tv/AlertArmedField.tsx"), /useAlertEvaluatorOff/);
  assert.match(read("components/tv/MaPanel.tsx"), /useAlertEvaluatorOff/);
  assert.match(read("app/alerts/page.tsx"), /useAlertEvaluatorOff/);
  assert.match(read("app/trading/page.tsx"), /useStrategyRunner/);
  assert.match(read("components/tv/AlertsPanel.tsx"), /useStrategyRunner/);
});

/* ── C-05 ──────────────────────────────────────────────────────────────── */

const row = (over: Partial<SymbolSearchResult>): SymbolSearchResult => ({
  symbol: "X", baseAsset: "X", quoteAsset: "USDT", tracked: true, instrumentType: "spot", ...over,
});
const HL_ETH = row({ symbol: "ETH", providerSymbol: "ETH", venueId: "HYPERLIQUID", baseAsset: "ETH", quoteAsset: "USD",
  instrumentType: "perpetual", canonicalId: "instrument:v1:HYPERLIQUID:perpetual:ETH:USD:USDC:perpetual" });
const BN_ETH = row({ symbol: "ETHUSDT", venueId: "BINANCE", baseAsset: "ETH", quoteAsset: "USDT",
  canonicalId: "instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot" });
const BN_ETHBTC = row({ symbol: "ETHBTC", venueId: "BINANCE", baseAsset: "ETH", quoteAsset: "BTC",
  canonicalId: "instrument:v1:BINANCE:spot:ETH:BTC:BTC:spot" });
const BN_ETH_PERP = row({ symbol: "ETHUSD", venueId: "BINANCE", baseAsset: "ETH", quoteAsset: "USD",
  instrumentType: "perpetual", canonicalId: "instrument:v1:BINANCE:perpetual:ETH:USD:USD:perpetual" });
const CB_ETH = row({ symbol: "ETH-USD", venueId: "COINBASE", baseAsset: "ETH", quoteAsset: "USD",
  canonicalId: "instrument:v1:COINBASE:spot:ETH:USD:USD:spot" });
const BN_WETH = row({ symbol: "WETHUSDT", venueId: "BINANCE", baseAsset: "WETH", quoteAsset: "USDT",
  canonicalId: "instrument:v1:BINANCE:spot:WETH:USDT:USDT:spot" });

test("'eth' puts Binance spot ETHUSDT first, not the Hyperliquid perpetual", () => {
  // The route's own order, as reproduced: the perpetual's listing code is `ETH`.
  const answer = [HL_ETH, CB_ETH, BN_ETH_PERP, BN_ETHBTC, BN_WETH, BN_ETH];
  const ranked = rankSearchResults(answer, "eth").map((r) => r.symbol);
  assert.equal(ranked[0], "ETHUSDT");
  assert.deepEqual(ranked, ["ETHUSDT", "ETHBTC", "ETHUSD", "ETH-USD", "ETH", "WETHUSDT"],
    "primary venue, then spot over perpetual, then mainstream quote; substring matches last");
});

test("'sol' puts Binance SOLUSDT first", () => {
  const hl = row({ symbol: "SOL", venueId: "HYPERLIQUID", baseAsset: "SOL", quoteAsset: "USD",
    instrumentType: "perpetual", canonicalId: "instrument:v1:HYPERLIQUID:perpetual:SOL:USD:USDC:perpetual" });
  const bn = row({ symbol: "SOLUSDT", venueId: "BINANCE", baseAsset: "SOL",
    canonicalId: "instrument:v1:BINANCE:spot:SOL:USDT:USDT:spot" });
  assert.equal(rankSearchResults([hl, bn], "sol")[0], bn);
  assert.equal(rankSearchResults([hl, bn], " SOL ")[0], bn);
});

test("an exact ticker wins over everything, including on another venue", () => {
  assert.equal(rankSearchResults([HL_ETH, BN_ETHBTC, BN_ETH], "ETHUSDT")[0], BN_ETH);
  assert.equal(rankSearchResults([BN_ETH, HL_ETH], "ETHUSD.P")[0], HL_ETH,
    "typing the perpetual's ticker still finds the perpetual");
  assert.equal(rankSearchResults([BN_ETH, CB_ETH], "ETH-USD")[0], CB_ETH,
    "separators are ignored, so ETH-USD is exactly Coinbase's ETHUSD and beats the primary venue");
});

test("an empty query keeps the server's order, and the sort is stable", () => {
  const answer = [HL_ETH, BN_ETH, CB_ETH];
  assert.deepEqual(rankSearchResults(answer, ""), answer);
  const a = row({ symbol: "AAPL", venueId: "NASDAQ", baseAsset: "AAPL", quoteAsset: "USD", instrumentType: "stock" });
  const b = row({ symbol: "AAPLX", venueId: "NASDAQ", baseAsset: "AAPLX", quoteAsset: "USD", instrumentType: "stock" });
  assert.deepEqual(rankSearchResults([b, a], "aapl"), [a, b]);
});

/* ── C-06 ──────────────────────────────────────────────────────────────── */

test("the watchlist's + field adds a resolved row, never the typed text", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const box = fs.readFileSync(path.join(root, "components/tv/WatchlistAddBox.tsx"), "utf8");
  const list = fs.readFileSync(path.join(root, "components/tv/Watchlist.tsx"), "utf8");
  assert.match(box, /rankSearchResults/, "the add box ranks exactly as the dialog does");
  assert.match(box, /SymbolResultLine/, "the add box renders the dialog's result rows");
  assert.match(list, /<WatchlistAddBox/);
  assert.doesNotMatch(list, /addSymbols\(\[s\]\);\s*setAddOpen\(false\)/,
    "the free-text add path is gone");
});
