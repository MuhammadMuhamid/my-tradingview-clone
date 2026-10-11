/*
 * Stress analysis, driven as a person drives it.
 *
 * The feature's scientific content is an ORDERING: the windows are chosen from
 * benchmark price data, and the strategy is named afterwards. A page that
 * quietly sent the strategy along with the discovery request would still look
 * identical and would mean nothing, so the first test reads the request the
 * page actually makes.
 *
 * The second holds the sentence. A stress score placed beside a holdout score
 * with nothing between them invites exactly the reading the analysis cannot
 * support, and "we wrote it in the docs" is not where a reader is standing
 * when they look at the number.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { advance, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import StressPage from "@/app/stress/page";
import { RunWindows } from "@/components/RunWindows";
import type {
  Backtest, BacktestMetrics, StressRun, StressRunDetail, StressWindow,
} from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);

const DAY = 86_400_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");

function metrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    netProfit: 0, netProfitPct: 0, grossProfit: 0, grossLoss: 0,
    profitFactor: null, totalTrades: 0, winningTrades: 0, losingTrades: 0,
    winRatePct: 0, maxDrawdownPct: 0, avgTradePct: 0, avgBarsInTrade: 0,
    commissionPaid: 0, ...over,
  } as BacktestMetrics;
}

async function mountStress(): Promise<void> {
  render(<AppRoute path="/stress"><StressPage /></AppRoute>);
  await settle();
}

test("discovery names no strategy — the ordering is the whole point", async () => {
  await mountStress();

  fireEvent.click(screen.getByRole("button", { name: /Find the windows/ }));
  await settle();

  const calls = server.callsTo("/api/stress/windows").filter((c) => c.method === "POST");
  assert.ok(calls.length > 0, "the control asked nothing");
  for (const call of calls) {
    const body = call.body as Record<string, unknown>;
    for (const forbidden of ["strategyKey", "configId", "params", "symbol", "timeframe"]) {
      assert.ok(!(forbidden in body),
        `discovery sent ${forbidden}: windows must be chosen before a strategy is named, `
        + `or the analysis selects the periods where the strategy already does badly`);
    }
    assert.ok(typeof body.benchmarkSymbol === "string" && body.benchmarkSymbol.length > 0,
      "discovery must name the benchmark it is searching");
    assert.ok(typeof body.method === "string", "discovery must name how it is ranking");
  }
});

test("C-02 a refused search says what to change, in the page copy and not only on hover", async () => {
  const SENTENCE = "the benchmark has 540 bars, which cannot contain a 900-bar window. Widen the "
    + "benchmark period, shorten the window, or choose a finer benchmark interval.";
  server.routes.set("POST /api/stress/windows", () => new Response(JSON.stringify({ error: SENTENCE }), {
    status: 400, headers: { "content-type": "application/json" },
  }));
  await mountStress();
  fireEvent.click(screen.getByRole("button", { name: /Find the windows/ }));
  await settle();

  const alert = screen.getByRole("alert");
  const said = (alert.textContent ?? "").replace(/\s+/g, " ");
  assert.match(said, /^Could not find the windows\. The benchmark has 540 bars, which cannot contain a 900-bar window\./,
    `the server's own sentence is the reason, not "The request was refused."; got: ${said}`);
  assert.ok(!/request was refused/.test(said), "the generic line must not stand in for the reason");
});

test("C-02 a provider's failure on the same search stays out of the page copy", async () => {
  server.routes.set("POST /api/stress/windows", () => new Response(
    JSON.stringify({ error: "invalid BTCUSDT 1d backfill: empty_series" }),
    { status: 502, headers: { "content-type": "application/json" } }));
  await mountStress();
  fireEvent.click(screen.getByRole("button", { name: /Find the windows/ }));
  await settle();

  const said = screen.getByRole("alert").textContent ?? "";
  assert.ok(!/backfill|empty_series/.test(said), `a provider string reached the page copy: ${said}`);
  assert.match(said, /did not answer/);
});

test("the page says the windows were chosen with hindsight, before any number", async () => {
  await mountStress();

  const notice = screen.getByText(/chosen with hindsight/i);
  assert.ok(notice, "a stress page without this sentence invites the reading it cannot support");
  const body = notice.closest("div")?.textContent ?? "";
  assert.match(body, /not\s*out-of-sample evidence/i);
  assert.match(body, /does not support a claim about future performance/i);
  // And it must not be tucked behind a disclosure the reader has to open.
  assert.equal(notice.closest("details"), null,
    "the caveat may not be collapsed away from the numbers it qualifies");
});

test("a run sends the same discovery it previewed, plus the strategy", async () => {
  await mountStress();
  fireEvent.click(screen.getByRole("button", { name: /Run the strategy through them/ }));
  await settle();

  const runs = server.callsTo("/api/stress/runs").filter((c) => c.method === "POST");
  assert.ok(runs.length > 0, "the run control asked nothing");
  const body = runs[0]!.body as Record<string, unknown>;
  assert.ok(typeof body.strategyKey === "string" && body.strategyKey.length > 0);
  assert.ok(typeof body.benchmarkSymbol === "string");
  assert.ok(typeof body.lengthBars === "number" && (body.lengthBars as number) >= 2);
  assert.ok(typeof body.topN === "number" && (body.topN as number) >= 1);
});

// ── Whose settings are stressed ─────────────────────────────────────────────

const SOURCE_ID = "3f1c2a9e-8d4b-4c6f-9a1e-2b7d5c8e0f13";
const STRATEGIES = [
  { id: 3, key: "mtf_lean", name: "MTF Lean", description: null, pineSource: null },
  { id: 7, key: "ma_rr_v9", name: "MA RR v9", description: null, pineSource: null },
];
/** A finished run with a configuration nobody would mistake for the defaults. */
const SOURCE_PARAMS = { qty_cash: 930, ma_len: 50, use_filter: true, mode: "close" };

function sourceBacktest(over: Partial<Backtest> = {}): Backtest {
  return {
    id: SOURCE_ID, strategyId: 7, configId: null, symbol: "SOLUSDT", timeframe: "4h",
    startTime: "2025-01-01T00:00:00.000Z", endTime: "2025-06-01T00:00:00.000Z",
    params: SOURCE_PARAMS, initialCapital: 2500, commissionPct: 0.075, slippageTicks: 1,
    status: "done", error: null, metrics: metrics({ netProfitPct: 12 }), equityCurve: null,
    holdoutFraction: null, segments: null, executionTruth: null, stressRunId: null,
    createdAt: "2025-06-02T00:00:00.000Z", ...over,
  };
}

function serveSource(backtest: Backtest | null = sourceBacktest()): void {
  server.routes.set("/api/strategies", () => STRATEGIES);
  server.routes.set(`GET /api/backtests/${SOURCE_ID}`, () => backtest
    ?? new Response(JSON.stringify({ error: "backtest not found" }), {
      status: 404, headers: { "content-type": "application/json" },
    }));
}

async function mountFrom(id = SOURCE_ID): Promise<void> {
  render(<AppRoute path="/stress" query={`from=${id}`}><StressPage /></AppRoute>);
  await settle(6);
}

function runBodies(): Record<string, unknown>[] {
  return server.callsTo("/api/stress/runs").filter((c) => c.method === "POST")
    .map((c) => c.body as Record<string, unknown>);
}

test("?from=<run> says whose settings it is stressing, before any number", async () => {
  serveSource();
  await mountFrom();

  const banner = document.querySelector("[data-stress-source]")?.textContent ?? "";
  assert.match(banner, /Stressing the settings of run 3f1c2a9e \(MA RR v9 · SOLUSDT · 4h\)/,
    "the reader must be told which run's configuration is about to be stressed");
  assert.match(banner, /4 parameters/);
  assert.match(banner, /2,500 initial capital/);
  assert.doesNotMatch(banner, /default parameters/i);
});

test("a run started from a backtest sends that backtest's whole configuration", async () => {
  serveSource();
  await mountFrom();
  fireEvent.click(screen.getByRole("button", { name: /Run the strategy through them/ }));
  await settle();

  const [body] = runBodies();
  assert.ok(body, "the run control asked nothing");
  assert.equal(body.strategyKey, "ma_rr_v9", "the run's strategy, not the page's default one");
  assert.equal(body.symbol, "SOLUSDT");
  assert.equal(body.timeframe, "4h");
  assert.deepEqual(body.params, SOURCE_PARAMS,
    "without the params the server runs the strategy's defaults, which is the defect");
  assert.equal(body.initialCapital, 2500);
  assert.equal(body.commissionPct, 0.075);
  assert.equal(body.slippageTicks, 1);
});

test("starting from a run still discovers the windows with no strategy named", async () => {
  /*
   * The invariant does not bend because the page now knows a configuration:
   * the configuration travels with the RUN request, and discovery sends the
   * benchmark half alone.
   */
  serveSource();
  await mountFrom();
  fireEvent.click(screen.getByRole("button", { name: /Find the windows/ }));
  await settle();
  const calls = server.callsTo("/api/stress/windows").filter((c) => c.method === "POST");
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const body = call.body as Record<string, unknown>;
    for (const forbidden of ["strategyKey", "configId", "params", "symbol", "timeframe",
      "initialCapital", "commissionPct", "slippageTicks"]) {
      assert.ok(!(forbidden in body), `discovery sent ${forbidden}`);
    }
  }
});

test("clearing the source goes back to the defaults, and says so", async () => {
  serveSource();
  await mountFrom();
  fireEvent.click(screen.getByRole("button", { name: /Use the strategy.s defaults instead/ }));
  await settle();

  assert.match(document.querySelector("[data-stress-source]")?.textContent ?? "",
    /will run with its default\s+parameters/);
  fireEvent.click(screen.getByRole("button", { name: /Run the strategy through them/ }));
  await settle();
  const [body] = runBodies();
  assert.ok(body);
  assert.equal("params" in body, false, "a defaults run must not carry the cleared run's params");
  assert.equal(body.strategyKey, "mtf_lean");
});

test("without a source the page says plainly that it runs the defaults", async () => {
  await mountStress();
  const text = document.querySelector("[data-stress-source]")?.textContent ?? "";
  assert.match(text, /will run with its default\s+parameters/);
  assert.match(text, /not a configuration you have tuned/);
});

test("a source that cannot be loaded is said, and the run falls back to defaults openly", async () => {
  serveSource(null);
  await mountFrom();
  const alert = document.querySelector("[data-stress-source] [role=alert]");
  assert.ok(alert, "a missing run must be said, not silently replaced by defaults");
  assert.match(alert.textContent ?? "", /Run 3f1c2a9e could not be loaded/);
  assert.match(alert.textContent ?? "", /default parameters/);
  assert.doesNotMatch(alert.textContent ?? "", /backtest not found/,
    "the server's own error string is the tooltip, not the copy");

  fireEvent.click(screen.getByRole("button", { name: /Run the strategy through them/ }));
  await settle();
  const [body] = runBodies();
  assert.ok(body);
  assert.equal("params" in body, false);
});

// ── What an opened run shows ────────────────────────────────────────────────

const RUN_ID = "9b2e4f60-1a3c-4d5e-8f70-a1b2c3d4e5f6";

function stressWindow(rank: number, startDay: number, over: Partial<StressWindow> = {}) {
  return {
    rank, startMs: T0 + startDay * DAY, endMs: T0 + (startDay + 21) * DAY - 1, bars: 21,
    benchmarkReturnPct: -30 + rank * 5, benchmarkDrawdownPct: 35 - rank * 4,
    benchmarkVolatilityPct: 3.1, selectedBy: { metric: "worst_return" as const, value: -30 + rank * 5 },
    backtestId: `00000000-0000-4000-8000-00000000000${rank}`, ...over,
  };
}

function stressRun(status: StressRun["status"] = "done"): StressRunDetail {
  const windows = [stressWindow(1, 40), stressWindow(2, 120)];
  return {
    id: RUN_ID, strategyId: 3, symbol: "SOLUSDT", timeframe: "1h", configId: null, params: {},
    initialCapital: 10_000, commissionPct: 0.1, slippageTicks: 2,
    benchmarkSymbol: "BTCUSDT", benchmarkInterval: "1d",
    discovery: {
      schemaVersion: "stress-discovery.v2",
      benchmark: {
        symbol: "BTCUSDT", canonicalInstrument: "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot",
        interval: "1d", providerId: "binance-spot", feedId: "binance-public-klines",
      },
      searched: { startMs: T0, endMs: T0 + 200 * DAY - 1, bars: 200 },
      config: { method: "worst_return", lengthBars: 21, topN: 2, minSeparationBars: 21 },
      epistemicNote: "",
    },
    windows, status, error: null, createdAt: "2025-08-01T00:00:00.000Z", finishedAt: null,
    epistemicNote: "",
    results: windows.map((window, i) => ({
      window,
      backtest: sourceBacktest({
        id: window.backtestId, strategyId: 3, stressRunId: RUN_ID,
        metrics: metrics({ netProfitPct: -1.5 - i, totalTrades: 3, maxDrawdownPct: 2 }),
        executionTruth: {
          requested: { startMs: window.startMs, endMs: window.endMs },
          covered: { startMs: window.startMs, endMs: window.endMs },
          barsProcessed: 504, sizing: { mode: "fixed_cash", value: 1000 },
          fillTiming: "next_bar_open",
        },
      }),
      target: i === 0
        ? { returnPct: -28.4, startMs: window.startMs, endMs: window.endMs, complete: true }
        : { returnPct: -9.2, startMs: window.startMs + 5 * DAY, endMs: window.endMs, complete: false },
    })),
  };
}

async function mountRun(detail: StressRunDetail = stressRun()): Promise<void> {
  server.routes.set("/api/strategies", () => STRATEGIES);
  server.routes.set("GET /api/stress/runs", () => [detail]);
  server.routes.set(`GET /api/stress/runs/${RUN_ID}`, () => detail);
  server.routes.set(`GET /api/stress/runs/${RUN_ID}/benchmark`, () => ({
    symbol: "BTCUSDT", interval: "1d",
    path: Array.from({ length: 200 }, (_, i) => [T0 + i * DAY, 100 - (i % 50)]),
  }));
  render(<AppRoute path="/stress" query={`run=${RUN_ID}`}><StressPage /></AppRoute>);
  await settle(6);
}

test("each window shows what the TRADED symbol did, beside what the strategy did", async () => {
  await mountRun();
  const cells = [...document.querySelectorAll("[data-stress-target]")];
  assert.equal(cells.length, 2, "one Target % per window");
  assert.match(cells[0]!.textContent ?? "", /-28\.40%/);
  assert.match(cells[1]!.textContent ?? "", /-9\.20%/);
  const partial = cells[1]!.querySelector("[title]");
  assert.match(partial?.getAttribute("title") ?? "", /covers only/,
    "a figure over part of the window must say so");
  assert.ok(screen.getByText("Target %"), "the column is named");
});

test("C-09 each window counts the entries the account could not afford", async () => {
  const detail = stressRun();
  const first = detail.results[0]!.backtest!;
  detail.results[0]!.backtest = {
    ...first,
    executionTruth: { ...first.executionTruth!, skippedEntries: { count: 17, cash: 930, equity: 842, firstMs: T0 } },
  };
  await mountRun(detail);
  assert.ok(screen.getByText("Skipped"), "the column is named");
  const cells = [...document.querySelectorAll("[data-stress-skipped]")];
  assert.equal(cells.length, 2);
  assert.equal(cells[0]!.textContent, "17");
  assert.match(cells[0]!.getAttribute("title") ?? "", /17 entries skipped — the first would have spent 930 while the account held 842/);
  assert.equal(cells[1]!.textContent, "0", "a window that afforded every entry says zero, not blank");
});

test("each window says why it qualified, its benchmark and its rank", async () => {
  await mountRun();
  assert.ok(screen.getByText("Rank"));
  assert.ok(screen.getByText(/^BTCUSDT return -25\.00%$/), "rank 1 qualified on its return");
  assert.ok(screen.getByText(/^BTCUSDT return -20\.00%$/));
});

test("the sizing is stated, and the numbers are not called directly comparable", async () => {
  await mountRun();
  const note = document.querySelector("[data-stress-exposure]")?.textContent ?? "";
  // 1,000 per entry against 10,000 capital: a tenth, which is exactly why a
  // −28 % market reads as about −3 % here.
  assert.match(note, /fixed 1,000 of quote currency — 10 % of the 10,000 initial capital/);
  assert.match(note, /moved -28\.40%, a position of that size would show about -2\.84%/);
  assert.equal(/directly comparable/i.test(document.body.textContent ?? ""), false,
    "the figures are comparable with another run only where capital, sizing and costs match");
  assert.match(document.body.textContent ?? "", /compares with another\s+run.s only where the capital, sizing and costs match/);
});

test("the provenance names the venue in words, and keeps the provider id for the tooltip", async () => {
  await mountRun();
  const label = screen.getByText("Binance market data");
  assert.match(label.getAttribute("title") ?? "", /binance-spot/);
  const body = document.body.cloneNode(true) as HTMLElement;
  for (const el of body.querySelectorAll("[title]")) el.removeAttribute("title");
  assert.equal((body.textContent ?? "").includes("binance-spot"), false,
    "a provider id is never body copy");
});

test("the benchmark is drawn over the period searched, with each window shaded", async () => {
  await mountRun();
  const chart = document.querySelector("[data-stress-benchmark-chart]");
  assert.ok(chart, "the opened run must show what its windows were chosen from");
  assert.equal(chart.querySelectorAll("[data-stress-window]").length, 2);
  assert.match(chart.querySelector("svg")?.getAttribute("aria-label") ?? "",
    /2 stress windows shaded: #1 2025-02-10 to 2025-03-02/);
});

test("a finished run stops saying Running in the list without a reload", async () => {
  /*
   * The list was read once, on mount, and the server only ever settled a run
   * it was asked for by id. Now the page re-reads the list while anything is
   * running, and the server settles each row it lists.
   */
  let listed = 0;
  server.routes.set("GET /api/stress/runs", () => {
    listed += 1;
    return [stressRun(listed === 1 ? "running" : "done")];
  });
  render(<AppRoute path="/stress"><StressPage /></AppRoute>);
  await settle(6);
  const list = (): string => screen.getByText("Previous stress runs").closest("div")!
    .parentElement!.textContent ?? "";
  assert.match(list(), /running/i);
  await advance(2700);
  assert.ok(listed >= 2, "the list was never read again");
  assert.doesNotMatch(list(), /running/i);
});

// ── C-06: whose settings a result stressed ──────────────────────────────────

test("C-06 a run started from a backtest records which one, and only on the run request", async () => {
  serveSource();
  await mountFrom();
  fireEvent.click(screen.getByRole("button", { name: /Find the windows/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Run the strategy through them/ }));
  await settle();
  const [body] = runBodies();
  assert.equal(body?.sourceBacktestId, SOURCE_ID, "the stress run must be told whose settings these are");
  for (const call of server.callsTo("/api/stress/windows").filter((c) => c.method === "POST")) {
    assert.ok(!("sourceBacktestId" in (call.body as Record<string, unknown>)),
      "discovery must not learn which run is about to be stressed");
  }
});

test("C-06 the result header and the history row say whose settings were stressed", async () => {
  await mountRun({ ...stressRun(), sourceBacktestId: SOURCE_ID });
  const header = document.querySelector("[data-stress-result] h2, [data-stress-result] h3")?.textContent ?? "";
  assert.match(header, /settings of run 3f1c2a9e/, `the result does not say whose settings it ran: ${header}`);
  const list = screen.getByText("Previous stress runs").closest("div")!.parentElement!.textContent ?? "";
  assert.match(list, /settings of run 3f1c2a9e/);
  assert.doesNotMatch(list, /explicit parameters/, "a copied run's settings are named, not called explicit");
});

test("C-06 changing the run to start from marks the shown result as not this choice", async () => {
  serveSource();
  const detail = { ...stressRun(), sourceBacktestId: SOURCE_ID };
  server.routes.set("GET /api/stress/runs", () => [detail]);
  server.routes.set(`GET /api/stress/runs/${RUN_ID}`, () => detail);
  server.routes.set(`GET /api/stress/runs/${RUN_ID}/benchmark`, () => ({ symbol: "BTCUSDT", interval: "1d", path: [] }));
  render(<AppRoute path="/stress" query={`from=${SOURCE_ID}&run=${RUN_ID}`}><StressPage /></AppRoute>);
  await settle(6);
  const result = (): HTMLElement => document.querySelector("[data-stress-result]") as HTMLElement;
  assert.equal(result().getAttribute("data-stale"), "false", "the result matches the chosen source");

  fireEvent.click(screen.getByRole("button", { name: /Use the strategy.s defaults instead/ }));
  await settle();
  assert.equal(result().getAttribute("data-stale"), "true",
    "a result for run 3f1c2a9e's settings must not sit unmarked under a form that now says defaults");
  assert.match(result().textContent ?? "", /This result stressed the settings of run 3f1c2a9e/);
});

// ── A shown run has an address (C-03) ───────────────────────────────────────

/*
 * Opening a run from the list, or starting one, changed only state: the
 * address stayed `/stress`, so a reload lost the result and there was nothing
 * to send anyone. `?run=` already opened a run; every way of showing one now
 * writes it.
 */
function withAddress(path: string, body: () => Promise<void>): Promise<void> {
  window.history.replaceState({}, "", path);
  return body().finally(() => window.history.replaceState({}, "", "/"));
}

test("opening a previous run puts it in the address, and keeps the source", () => withAddress(
  `/stress?from=${SOURCE_ID}`, async () => {
    serveSource();
    server.routes.set("GET /api/stress/runs", () => [stressRun()]);
    server.routes.set(`GET /api/stress/runs/${RUN_ID}`, () => stressRun());
    server.routes.set(`GET /api/stress/runs/${RUN_ID}/benchmark`, () => ({ symbol: "BTCUSDT", interval: "1d", path: [] }));
    await mountFrom();
    const row = screen.getByText("Previous stress runs").closest("div")!.parentElement!
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(row);
    await settle(4);
    const query = new URLSearchParams(window.location.search);
    assert.equal(window.location.pathname, "/stress");
    assert.equal(query.get("run"), RUN_ID, "the run being read must be the one a reload opens");
    assert.equal(query.get("from"), SOURCE_ID, "and showing it must not drop whose settings are loaded");
  }));

test("starting a run puts the new run in the address", () => withAddress("/stress", async () => {
  server.routes.set("POST /api/stress/runs", () => stressRun("running"));
  server.routes.set(`GET /api/stress/runs/${RUN_ID}`, () => stressRun("running"));
  server.routes.set(`GET /api/stress/runs/${RUN_ID}/benchmark`, () => ({ symbol: "BTCUSDT", interval: "1d", path: [] }));
  await mountStress();
  fireEvent.click(screen.getByRole("button", { name: /Run the strategy through them/ }));
  await settle(4);
  assert.equal(new URLSearchParams(window.location.search).get("run"), RUN_ID);
}));

test("a run to start from is listed with its window and its result", async () => {
  serveSource();
  server.routes.set("GET /api/backtests", () => [sourceBacktest()]);
  await mountStress();
  const picker = screen.getByLabelText(/Start from a run/) as HTMLSelectElement;
  const labels = [...picker.options].map((o) => o.textContent ?? "");
  assert.ok(labels.includes("3f1c2a9e · MA RR v9 · SOLUSDT · 4h · 2025-01-01 → 2025-06-01 · +12.00%"),
    `the dates covered and the net result tell two runs apart: ${JSON.stringify(labels)}`);
});

// ── The windows panel on a backtest ─────────────────────────────────────────

test("a compounding run is told WHY it has no split, not shown a blank", () => {
  /*
   * A missing block reads as "not implemented". The real answer is that this
   * run's sizing makes the question meaningless, and the reader can change it.
   */
  render(<RunWindows initialCapital={1000}
    segments={{ available: false, reason: "This run sizes each entry as a percentage of equity, so it compounds: re-run with a fixed cash size to see the split." }}
    execution={{
      requested: { startMs: T0, endMs: T0 + 100 * DAY },
      covered: { startMs: T0, endMs: T0 + 100 * DAY },
      barsProcessed: 2400,
      sizing: { mode: "percent_of_equity", value: 100 },
      fillTiming: "next_bar_open",
    }} />);

  assert.ok(screen.getByText(/percentage of equity/), "the reason must be on the page");
  assert.ok(screen.getByText(/fixed cash size/), "and it must name the change that answers it");
});

test("the last window is named for what it is, and the covered window is not the requested one", () => {
  render(<RunWindows initialCapital={1000}
    segments={{
      available: true, holdoutFraction: 0.2,
      split: {
        inSample: { startMs: T0, endMs: T0 + 40 * DAY },
        outOfSample: { startMs: T0 + 40 * DAY, endMs: T0 + 80 * DAY },
        holdout: { startMs: T0 + 80 * DAY, endMs: T0 + 100 * DAY },
      },
      inSample: metrics({ netProfitPct: 5, totalTrades: 12 }),
      outOfSample: metrics({ netProfitPct: 2, totalTrades: 7 }),
      holdout: metrics({ netProfitPct: -1, totalTrades: 3 }),
    }}
    execution={{
      // The run reached bars only from day 30: a later listing, or a cache
      // that begins inside the warmup. Printing the requested dates over that
      // is how a confident figure describes a window a third of which is empty.
      requested: { startMs: T0, endMs: T0 + 100 * DAY },
      covered: { startMs: T0 + 30 * DAY, endMs: T0 + 100 * DAY },
      barsProcessed: 1680,
      sizing: { mode: "fixed_cash", value: 930 },
      fillTiming: "signal_bar_close",
    }} />);

  /*
   * It was "Holdout (frozen) — report it, never select on it", and it is
   * neither: the engine cuts the last fraction of whatever range was chosen,
   * on every run, and the headline includes it. `researchResult.test.tsx`
   * holds the rest of that rule.
   */
  assert.ok(screen.getAllByText(/^Validation$/).length > 0, "the last window is the validation window");
  assert.ok(screen.getByText(/it is not withheld/i),
    "and the reader is told it is not withheld, rather than that it is frozen");
  assert.ok(screen.getByText(/simulated a narrower window than was requested/i),
    "a short run must say so, or its figures describe a window the reader did not ask for");
  assert.ok(screen.getByText(/at the signal bar's close/),
    "fill timing differs between shipped strategies and must be on the result");
  assert.ok(screen.getByText(/zero latency/),
    "a signal-bar-close fill assumes no latency and the reader should know");
});

test("a run recorded before the split says so, rather than implying it had none", () => {
  render(<RunWindows segments={null} execution={null} initialCapital={1000} />);
  assert.ok(screen.getByText(/predates the window split/i));
  assert.ok(screen.getByText(/not a\s*statement that it had no validation window/i),
    "absence of a record is not evidence of absence, and the panel must not imply it is");
});
