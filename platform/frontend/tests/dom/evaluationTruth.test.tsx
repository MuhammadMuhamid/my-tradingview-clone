/**
 * C-03 / C-04 / C-05 / C-06, on the rendered surfaces.
 *
 *   C-03  /alerts and the alert dialogs say when nothing evaluates alerts.
 *   C-04  Automations never says "running" when the strategy runner is off.
 *   C-05  "eth" + Enter in the symbol dialog lands on Binance spot ETHUSDT.
 *   C-06  the watchlist's + field adds a resolved row, never free text.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import {
  advance, assertAbsent, assertPresent, closeBrowser, compactSeries, render, resetBrowser, server, settle,
} from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";
import AlertsPage from "@/app/alerts/page";
import DeploymentsPage from "@/app/trading/page";
import { PriceAlertModal } from "@/components/tv/PriceAlertModal";
import { SymbolSearch } from "@/components/tv/SymbolSearch";
import { AlertsPanel } from "@/components/tv/AlertsPanel";
import { MaPanel } from "@/components/tv/MaPanel";
import type { MaAlert, SymbolSearchResult } from "@/lib/api";
import type { Deployment } from "@/lib/types";
import type { Interval } from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);

const OFF_NOTICE = "Alerts are saved but not evaluated on this install — the alert evaluator is turned off.";
const body = () => document.body.textContent ?? "";

const ALERT: MaAlert = {
  id: "a1", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
  maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
  targetPrice: 100, priceDirection: "either",
  filters: null,
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  rsiLength: null, rsiLevel: null, rsiMaLength: null,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null, filterStAtrMethod: null, filterStSide: null,
  nearMinPct: 0.2, nearMaxPct: 0.5,
  enabled: true, frequency: "once_per_bar_close", cooldownMin: 60, note: null,
  lastSide: null, lastBarTime: null, lastFiredAt: null, lastFiredBarTime: null, completedAt: null,
  patternId: null,
  canonicalInstrumentId: null, providerId: null, priceBasis: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
} as MaAlert;

const OPTIONS = (enabled: boolean) => ({
  maTypes: ["sma", "ema"], maLengths: [20, 50], modes: ["cross"], conditionKinds: ["price"],
  priceDirections: ["either"], noteMaxLength: 280, defaultFrequency: "once_per_bar_close",
  intrabarWarning: "", frequencies: [],
  evaluation: enabled ? { enabled: true, reason: null }
    : { enabled: false, reason: "MA_ALERTS_ENABLED is false; notification alerts are intentionally disabled." },
});

function alertsServer(evaluation: boolean | null): void {
  server.routes.set("GET /api/ma-alerts", () => [ALERT]);
  server.routes.set("/api/ma-alerts/events", () => []);
  if (evaluation !== null) server.routes.set("/api/ma-alerts/options", () => OPTIONS(evaluation));
}

/* ── C-03 ──────────────────────────────────────────────────────────────── */

test("C-03 — /alerts says the evaluator is off, and marks armed alerts as not evaluated", async () => {
  alertsServer(false);
  render(<AlertsPage />);
  await settle(6);

  assertPresent(document.querySelector("[data-alert-evaluator-off]"), "no notice that the evaluator is off");
  assert.equal(body().includes(OFF_NOTICE), true);
  assert.equal(body().includes("evaluated server-side and pushed to your devices"), false,
    "the page still promises server-side evaluation");
  assert.equal(body().includes("1 of 1 armed · not evaluated here"), true, body());
  const state = screen.getByRole("button", { name: /^Pause BTCUSDT/ });
  assert.equal(state.textContent, "Armed · not evaluated here");
  // The operator's wording is never page copy.
  assert.equal(body().includes("MA_ALERTS_ENABLED"), false);
  // Creating stays allowed.
  const add = screen.getByRole("button", { name: "Add level alert" }) as HTMLButtonElement;
  assert.equal(add.disabled, false);
});

test("C-03 — with the evaluator on, /alerts reads as before", async () => {
  alertsServer(true);
  render(<AlertsPage />);
  await settle(6);
  assertAbsent(document.querySelector("[data-alert-evaluator-off]"), "a notice on an install that evaluates");
  assert.equal(body().includes("evaluated server-side and pushed to your devices"), true);
  assert.equal(screen.getByRole("button", { name: /^Pause BTCUSDT/ }).textContent, "Active");
});

test("C-03 — an unanswered options read is unknown, not off", async () => {
  alertsServer(null);
  render(<AlertsPage />);
  await settle(6);
  assertAbsent(document.querySelector("[data-alert-evaluator-off]"), "a 404 was read as 'evaluator off'");
});

test("C-03 — the chart's price-alert dialog says the evaluator is off, and still saves", async () => {
  server.routes.set("/api/ma-alerts/options", () => OPTIONS(false));
  render(
    <PriceAlertModal
      open onClose={() => undefined} symbol="SOLUSDT" chartTimeframe={"15m" as Interval}
      resolutionNotice={null} initialPrice={100} lastPrice={100} lastPriceNotice={null}
      existing={[]} onPickFromChart={() => undefined} onSaved={() => undefined}
    />,
  );
  await settle(6);
  const notice = assertPresent(document.querySelector("[data-alert-evaluator-off]"),
    "the dialog arms an alert without saying nothing will evaluate it");
  assert.equal((notice.textContent ?? "").includes(OFF_NOTICE), true);
  assert.equal(body().includes("This alert starts watching as soon as it is saved."), false,
    "the armed field still promises it starts watching");
  const create = screen.getAllByRole("button").find((b) => /^(Create|Save)/.test(b.textContent ?? ""));
  assert.ok(create, "the dialog has no create button");
  assert.equal((create as HTMLButtonElement).disabled, false, "creation must stay allowed");
});

/* ── C-04 ──────────────────────────────────────────────────────────────── */

const PAPER: Deployment = {
  id: "d1", strategyId: 1, configId: null, symbol: "SOLUSDT", timeframe: "15m", params: {},
  status: "active", delivery: "paper", webhookUrl: null, botUuid: null, buyQuoteQty: 100,
  runtimeState: { position: "flat", entryPrice: null }, lastBarTime: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} as Deployment;

function tradingServer(state: "off" | "live" | null): void {
  server.routes.set("GET /api/deployments", () => [PAPER]);
  server.routes.set("/api/alerts", () => []);
  if (state !== null) {
    server.routes.set("/api/ops/runner", () => ({
      state, evaluating: state === "live", reason: state === "off" ? "LIVE_RUNNER_ENABLED is not \"true\"" : "lease",
    }));
  }
}

test("C-04 — Automations never says 'running' while the strategy runner is off", async () => {
  tradingServer("off");
  render(<DeploymentsPage />);
  await settle(6);

  assert.equal(body().includes("1 running"), false, "the header still says 1 running");
  assert.equal(body().includes("1 active · runner off"), true, body());
  assertPresent(document.querySelector("[data-runner-off]"), "no runner-off notice in the header");
  const badge = assertPresent(document.querySelector('[data-deployment-status="active-runner-off"]'),
    "the row's badge still reads a bare Active");
  assert.equal(badge.textContent, "Active · runner off");
  assertPresent(document.querySelector("[data-runner-off-row]"), "the row does not say nothing is evaluated");
  assert.equal(body().includes("LIVE_RUNNER_ENABLED"), false, "operator wording became page copy");
});

test("C-04 — with the runner live, the page says running", async () => {
  tradingServer("live");
  render(<DeploymentsPage />);
  await settle(6);
  assert.equal(body().includes("1 running"), true);
  assertAbsent(document.querySelector("[data-runner-off]"), "a runner-off notice with the runner live");
  assertAbsent(document.querySelector("[data-deployment-status]"), "a warning badge with the runner live");
});

test("C-04 — the chart's automation rail says the runner is off", async () => {
  tradingServer("off");
  render(<AlertsPanel onCreateAlert={() => undefined} />);
  await settle(6);
  assert.equal(body().includes("1 active · runner off"), true, body());
  assertPresent(document.querySelector("[data-runner-off]"), "no runner-off notice on the rail");
  assertPresent(document.querySelector('[data-deployment-status="active-runner-off"]'), "the rail badge reads Active");
});

test("C-03 — the chart's alert rail marks armed alerts as not evaluated", async () => {
  server.routes.set("/api/ma-alerts/options", () => OPTIONS(false));
  render(
    <MaPanel lines={[]} values={{}} alerts={[ALERT]} timeframe={"1h" as never}
      onToggle={() => undefined} onToggleAll={() => undefined} onArm={() => undefined}
      onArmPrice={() => undefined} onArmLevel={() => undefined} onArmOscillator={() => undefined}
      onOpenAlert={() => undefined} push={null} />,
  );
  await settle(6);
  assertPresent(document.querySelector("[data-alert-evaluator-off]"), "the rail says nothing about the evaluator");
  assert.equal(body().includes("Armed · not evaluated here"), true);
});

/* ── C-05 ──────────────────────────────────────────────────────────────── */

const ROW = (over: Partial<SymbolSearchResult>): SymbolSearchResult => ({
  symbol: "X", baseAsset: "X", quoteAsset: "USDT", tracked: true, instrumentType: "spot", ...over,
});
const HL_ETH = ROW({ symbol: "ETH", providerSymbol: "ETH", venueId: "HYPERLIQUID", baseAsset: "ETH",
  quoteAsset: "USD", instrumentType: "perpetual",
  canonicalId: "instrument:v1:HYPERLIQUID:perpetual:ETH:USD:USDC:perpetual" });
const BN_ETH = ROW({ symbol: "ETHUSDT", providerSymbol: "ETHUSDT", venueId: "BINANCE", baseAsset: "ETH",
  quoteAsset: "USDT", canonicalId: CANONICAL.ETHUSDT! });
const BN_ETHBTC = ROW({ symbol: "ETHBTC", providerSymbol: "ETHBTC", venueId: "BINANCE", baseAsset: "ETH",
  quoteAsset: "BTC", canonicalId: "instrument:v1:BINANCE:spot:ETH:BTC:BTC:spot" });

/** The route's order as reproduced: Hyperliquid's listing code is literally `ETH`. */
function hyperliquidFirstSearch(): void {
  server.routes.set("/api/market/v1/search", (_body, url: URL) => {
    const q = (url.searchParams.get("q") ?? "").trim().toUpperCase();
    const rows = q.length > 0 && ("ETH".startsWith(q) || q.startsWith("ETH"))
      ? [HL_ETH, BN_ETHBTC, BN_ETH] : [];
    return {
      total: rows.length, quotes: ["USD", "USDT", "BTC"],
      venues: [{ id: "BINANCE", label: "Binance" }, { id: "HYPERLIQUID", label: "Hyperliquid" }],
      results: rows, errors: [],
    };
  });
}

test("C-05 — 'eth' + Enter in the symbol dialog selects Binance spot ETHUSDT", async () => {
  hyperliquidFirstSearch();
  const selected: string[] = [];
  const view = render(
    <SymbolSearch open current={CANONICAL.SOLUSDT!} seed="eth" onClose={() => {}}
      onSelect={(s) => selected.push(s)} />,
  );
  await settle();
  await advance(220);
  const dialog = assertPresent(
    view.baseElement.querySelector('[role="dialog"][aria-label="Symbol search"]'), "no dialog");
  const first = dialog.querySelector<HTMLElement>('[data-idx="0"]');
  assert.equal((first?.textContent ?? "").includes("ETHUSDT"), true,
    `row 0 is ${JSON.stringify(first?.textContent)}`);
  const input = assertPresent(dialog.querySelector("input"), "the dialog has no search box");
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();
  assert.deepEqual(selected, [BN_ETH.canonicalId], "Enter did not land on Binance ETHUSDT");
});

/* ── C-06 ──────────────────────────────────────────────────────────────── */

async function openAddBox() {
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  const list = server.seedWatchlist([CANONICAL.SOLUSDT!]);
  const chart = await mountChart();
  await settle();
  const open = chart.container.querySelector<HTMLElement>('button[aria-label="Add a symbol to this list"]');
  assert.ok(open, "the watchlist offers no way to add a symbol");
  fireEvent.click(open);
  await settle();
  const box = screen.getByRole("textbox", { name: "Add a symbol to this watchlist" });
  return { chart, box, listId: list.id };
}

const members = (id: string): string[] => server.watchlists.get(id)?.symbols ?? [];

test("C-06 — the + field offers ranked result rows, and Enter adds Binance ETHUSDT for 'eth'", async () => {
  hyperliquidFirstSearch();
  const { box, listId } = await openAddBox();
  fireEvent.change(box, { target: { value: "eth" } });
  await advance(200);

  const listbox = screen.getByRole("listbox", { name: "Matching instruments" });
  const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
  assert.equal(options.length, 3, "the add box shows no result rows");
  assert.equal(options[0]!.getAttribute("data-add-result"), BN_ETH.canonicalId,
    "the dialog's ranking does not apply here");
  assert.equal(options[0]!.getAttribute("aria-selected"), "true");
  // Rows show the TICKER, never the canonical id.
  assert.equal((listbox.textContent ?? "").includes("instrument:v1"), false);

  fireEvent.keyDown(box, { key: "Enter" });
  await settle(6);
  assert.deepEqual(members(listId), [CANONICAL.SOLUSDT!, BN_ETH.canonicalId]);
  assert.equal(members(listId).includes(HL_ETH.canonicalId!), false, "the Hyperliquid perpetual was added");
  assertAbsent(screen.queryByRole("textbox", { name: "Add a symbol to this watchlist" }),
    "the field stays open after a successful add");
});

test("C-06 — arrows move the highlight and Enter adds the highlighted row", async () => {
  hyperliquidFirstSearch();
  const { box, listId } = await openAddBox();
  fireEvent.change(box, { target: { value: "eth" } });
  await advance(200);
  fireEvent.keyDown(box, { key: "ArrowDown" });
  await settle();
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  assert.equal(options[1]!.getAttribute("aria-selected"), "true");
  fireEvent.keyDown(box, { key: "Enter" });
  await settle(6);
  assert.deepEqual(members(listId), [CANONICAL.SOLUSDT!, options[1]!.getAttribute("data-add-result")]);
});

test("C-06 — Enter before the answer waits for it; free text with no match adds nothing", async () => {
  hyperliquidFirstSearch();
  const { box, listId } = await openAddBox();
  // Typed and entered inside the debounce: the answer decides, not the text.
  fireEvent.change(box, { target: { value: "eth" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await advance(200);
  await settle(6);
  assert.deepEqual(members(listId), [CANONICAL.SOLUSDT!, BN_ETH.canonicalId]);

  const again = await (async () => {
    const open = document.querySelector<HTMLElement>('button[aria-label="Add a symbol to this list"]');
    fireEvent.click(open!);
    await settle();
    return screen.getByRole("textbox", { name: "Add a symbol to this watchlist" });
  })();
  fireEvent.change(again, { target: { value: "zzzq" } });
  await advance(200);
  fireEvent.keyDown(again, { key: "Enter" });
  await settle(6);
  assert.deepEqual(members(listId), [CANONICAL.SOLUSDT!, BN_ETH.canonicalId], "free text was added");
  assert.equal(body().includes("No market instrument matches"), true);
  // Escape still closes only the field.
  fireEvent.keyDown(again, { key: "Escape", bubbles: true });
  await settle();
  assertAbsent(screen.queryByRole("textbox", { name: "Add a symbol to this watchlist" }),
    "Escape did not close the add field");
  assertPresent(document.querySelector("[data-watchlist]"), "Escape closed the watchlist panel");
});
