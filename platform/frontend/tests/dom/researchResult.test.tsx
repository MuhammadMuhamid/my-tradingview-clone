/*
 * Quick backtest results, read as a person reads them.
 *
 * A fresh reviewer measured these on a default run, against the live product:
 *
 *   - the headline said 242 trades at 17.4 % — exit LEGS — over windows of
 *     68 / 148 / 26 legs whose win rates were over 60 / 128 / 20 ENTRIES;
 *   - the last window was "Holdout (frozen) — report it, never select on it",
 *     and it is neither frozen nor withheld;
 *   - the result page showed symbol, timeframe and dates, and nothing else a
 *     reader would need to reproduce it;
 *   - a run with no data said "Hover for the reason", and the list printed the
 *     engine's `invalid SOLUSDT 1h backfill: empty_series` as its body;
 *   - a zero-trade run's profit factor was a green ∞;
 *   - the form accepted a negative capital.
 *
 * Each test mounts the real component or page against the fixture origin.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathParamsContext, PathnameContext, SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { assertAbsent, assertPresent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { RunWindows } from "@/components/RunWindows";
import { Metrics } from "@/components/Metrics";
import BacktestDetail from "@/app/research/[id]/page";
import BacktestsPage from "@/app/research/page";
import type { Backtest, BacktestMetrics, Strategy } from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const ID = "8f6d2c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b";
const ID2 = "1a2b3c4d-1111-4222-8333-444455556666";

function metrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    netProfit: 0, netProfitPct: 0, grossProfit: 0, grossLoss: 0, profitFactor: null,
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRatePct: 0, maxDrawdownPct: 0,
    avgTradePct: 0, avgBarsInTrade: 0, commissionPaid: 0, ...over,
  };
}

/** A window in entries, with its legs, as the engine records it now. */
function windowMetrics(entries: number, legs: number, wins: number): BacktestMetrics {
  return metrics({
    totalTrades: legs, entries, winningEntries: wins, losingEntries: entries - wins,
    entryWinRatePct: (wins / entries) * 100, entryProfitFactor: 1.2,
    winRatePct: (wins / entries) * 100, winningTrades: wins, losingTrades: entries - wins, profitFactor: 1.2,
    netProfitPct: 1,
  });
}

const STRATEGIES: Strategy[] = [
  { id: 3, key: "srtrend_v10", name: "SR Trend v10", description: null, pineSource: null },
];

function run(over: Partial<Backtest> = {}): Backtest {
  return {
    id: ID, strategyId: 3, configId: null, symbol: "SOLUSDT", timeframe: "1h",
    startTime: new Date(T0).toISOString(), endTime: new Date(T0 + 100 * DAY).toISOString(),
    params: { rrRatio: 2, qty_cash: 930, qty_pct_equity: 0 },
    initialCapital: 1000, commissionPct: 0.1, slippageTicks: 2,
    status: "done", error: null,
    metrics: metrics({
      totalTrades: 242, winRatePct: 17.4, entries: 208, winningEntries: 40, losingEntries: 168,
      entryWinRatePct: 19.2, entryProfitFactor: 0.9, netProfitPct: -3,
    }),
    equityCurve: [], holdoutFraction: 0.2,
    segments: {
      available: true, holdoutFraction: 0.2,
      split: {
        inSample: { startMs: T0, endMs: T0 + 40 * DAY },
        outOfSample: { startMs: T0 + 40 * DAY, endMs: T0 + 80 * DAY },
        holdout: { startMs: T0 + 80 * DAY, endMs: T0 + 100 * DAY },
      },
      inSample: windowMetrics(60, 68, 15),
      outOfSample: windowMetrics(128, 148, 20),
      holdout: windowMetrics(20, 26, 5),
    },
    executionTruth: null, stressRunId: null,
    engineFingerprint: "corrections:v7:abc123", semanticsStatus: "reproducible",
    resultProvenance: { engineVersion: "v2-corrected", providerId: "binance-spot", feedId: "binance-public-klines" },
    createdAt: "2026-09-02T08:15:00.000Z",
    ...over,
  };
}

const pushes: string[] = [];
const ROUTER = {
  push: (href: string) => { pushes.push(href); }, replace: () => {}, prefetch: () => {},
  back: () => {}, forward: () => {}, refresh: () => {}, hmrRefresh: () => {},
};

/** The App Router's contexts, with a router that records where it was sent. */
function Route({ path, params = {}, children }: { path: string; params?: Record<string, string>; children: ReactNode }) {
  return (
    <AppRouterContext.Provider value={ROUTER as never}>
      <PathnameContext.Provider value={path}>
        <PathParamsContext.Provider value={params}>
          <SearchParamsContext.Provider value={new URLSearchParams() as never}>
            {children}
          </SearchParamsContext.Provider>
        </PathParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

function serve(rows: Backtest[]): void {
  server.routes.set("GET /api/strategies", () => STRATEGIES);
  server.routes.set("GET /api/backtests", () => rows);
  for (const r of rows) {
    server.routes.set(`GET /api/backtests/${r.id}`, () => r);
    server.routes.set(`GET /api/backtests/${r.id}/trades`, () => []);
  }
}

// ── C-1 / C-3 / C-15: the windows table ─────────────────────────────────────

test("every row of the windows table is in entries, and says so", () => {
  render(<RunWindows segments={run().segments} execution={null} initialCapital={1000} />);
  const table = screen.getByRole("table");
  assertPresent(within(table).queryByRole("columnheader", { name: "Entries" }),
    "the count column must name its unit — 'Trades' above an entry count was half the defect");
  const validation = table.querySelector('[data-window="validation"]');
  assertPresent(validation, "the validation row must be set apart");
  const cells = [...validation!.querySelectorAll("td")].map((td) => td.textContent ?? "");
  assert.match(cells[4] ?? "", /^20/, "the count is ENTRIES (20), not legs (26)");
  assert.equal(cells[5], "25.0%", "and the rate is over the same twenty");
});

test("the last window is called validation, and is not claimed to be withheld", () => {
  render(<RunWindows segments={run().segments} execution={null} initialCapital={1000} />);
  assertAbsent(screen.queryByText(/frozen/i), "nothing freezes it");
  assertAbsent(screen.queryByText(/never select on it/i), "nothing enforces that, so the page must not imply it");
  assert.ok(screen.queryAllByText(/last 20% of the window/).length > 0, "it is the last N% of THIS range");
  assertPresent(screen.queryByText(/headline\s+figures and the equity curve include it/),
    "and the headline's relationship to it is stated");
});

test("a validation window with a handful of entries is marked low sample", () => {
  render(<RunWindows segments={run().segments} execution={null} initialCapital={1000} />);
  const validation = document.querySelector('[data-window="validation"]')!;
  assertPresent(within(validation as HTMLElement).queryByText("low sample"), "twenty entries is not a rate");
  const outOfSample = document.querySelectorAll('[data-window="development"]')[1]!;
  assertAbsent(within(outOfSample as HTMLElement).queryByText("low sample"), "128 entries is");
});

test("the headline is the same population as the windows, and covers validation", () => {
  render(<Metrics m={run().metrics!} initialCapital={1000} />);
  assertPresent(screen.queryByText("Trades (entries)"), "the tile names its unit");
  assertPresent(screen.queryByText("208"), "208 entries, not 242 legs");
  assertAbsent(screen.queryByText("242"), "the leg count must not be the headline");
  assertPresent(screen.queryByText("19.2%"), "the entry win rate, not the leg one");
  assertPresent(screen.queryByText(/including the validation window/), "and it says it covers the whole window");
});

test("a run that took nothing does not claim an infinite profit factor", () => {
  render(<Metrics m={metrics({ entries: 0, entryWinRatePct: 0, entryProfitFactor: null })} initialCapital={1000} />);
  assertAbsent(screen.queryByText("∞"), "a zero-trade run must not show ∞");
  assertPresent(screen.queryByText("no trades"), "it says why there is no figure");
});

test("C-01 entries the account could not pay for are counted where a structural zero is said", () => {
  const execution = {
    requested: { startMs: T0, endMs: T0 + 100 * DAY },
    covered: { startMs: T0, endMs: T0 + 100 * DAY },
    barsProcessed: 2400,
    sizing: { mode: "fixed_cash" as const, value: 930 },
    fillTiming: "next_bar_open" as const,
    skippedEntries: { count: 12, cash: 930, equity: 812.4, firstMs: T0 + 30 * DAY },
  };
  render(<RunWindows segments={run().segments} execution={execution} initialCapital={1000} />);
  assertPresent(screen.queryByText("This run could not have taken 12 of its entries."),
    "a run that ran out of money must not read like a strategy that grew quieter");
  assertPresent(screen.queryByText(/would have spent 930 while the account held less — 812\.40 at the first, on 2026-01-31/),
    "and it says why, with the first one");
});

test("C-01 a run that skipped every entry says so once, in the engine's sentence", () => {
  const execution = {
    requested: { startMs: T0, endMs: T0 + 100 * DAY },
    covered: { startMs: T0, endMs: T0 + 100 * DAY },
    barsProcessed: 2400,
    sizing: { mode: "fixed_cash" as const, value: 930 },
    fillTiming: "next_bar_open" as const,
    noEntryReason: "Every entry would have spent 930 while the account held 100. A spot account has no margin, so all 39 entries were skipped.",
    skippedEntries: { count: 39, cash: 930, equity: 100, firstMs: T0 },
  };
  render(<RunWindows segments={run().segments} execution={execution} initialCapital={100} />);
  assert.equal(screen.queryAllByText(/could not have taken/).length, 1, "one notice, not two");
  assertPresent(screen.queryByText(/all 39 entries were skipped/), "the engine's own sentence carries the count");
});

// ── C-2: reproducible from the page ─────────────────────────────────────────

test("the result page states its settings and re-runs the same request", async () => {
  serve([run()]);
  server.routes.set("POST /api/backtests", () => ({ ...run(), id: ID2, status: "queued" }));
  pushes.length = 0;
  render(<Route path={`/research/${ID}`} params={{ id: ID }}><BacktestDetail /></Route>);
  await settle(6);

  const card = screen.getByRole("heading", { name: "Run settings" }).closest(".rounded-md") as HTMLElement;
  for (const text of ["SR Trend v10", "0.1% per fill", "2 ticks per fill", "last 20% of the window",
    "Binance Spot", "v2-corrected", "2026-09-02 08:15 UTC"]) {
    assertPresent(within(card).queryByText(text), `the settings card must state ${text}`);
  }
  assertPresent(within(card).queryByText(/Strategy parameters \(3\)/), "and disclose the parameters");

  const stress = within(card).getByRole("link", { name: "Stress this run" });
  assert.equal(stress.getAttribute("href"), `/stress?from=${ID}`);
  assert.equal(within(card).getByRole("link", { name: "Edit and re-run" }).getAttribute("href"), `/research?from=${ID}`);

  fireEvent.click(within(card).getByRole("button", { name: "Re-run with these settings" }));
  await settle(4);
  const posts = server.callsTo("/api/backtests").filter((c) => c.method === "POST");
  assert.equal(posts.length, 1, "re-running must queue exactly one run");
  const body = posts[0]!.body as Record<string, unknown>;
  assert.equal(body.strategyKey, "srtrend_v10");
  assert.equal(body.startTime, run().startTime);
  assert.equal(body.endTime, run().endTime);
  assert.deepEqual(body.params, run().params);
  assert.equal(body.commissionPct, 0.1);
  assert.equal(body.slippageTicks, 2);
  assert.equal(body.holdoutFraction, 0.2);
  assert.deepEqual(pushes, [`/research/${ID2}`], "and open the new run");
});

test("the equity card can show the drawdown, and shades the validation window", async () => {
  const curve = Array.from({ length: 101 }, (_, i) => ({ t: T0 + i * DAY, equity: 1000 + i, drawdownPct: i % 7 }));
  serve([run({ equityCurve: curve })]);
  render(<Route path={`/research/${ID}`} params={{ id: ID }}><BacktestDetail /></Route>);
  await settle(6);
  const chart = document.querySelector("[data-view]")!;
  assert.equal(chart.getAttribute("data-validation-shaded"), "true");
  assert.equal(chart.getAttribute("data-view"), "equity");
  fireEvent.click(screen.getByRole("button", { name: "Drawdown" }));
  await settle();
  assert.equal(document.querySelector("[data-view]")!.getAttribute("data-view"), "drawdown");
  assert.equal(screen.getByRole("button", { name: "Drawdown" }).getAttribute("aria-pressed"), "true");
});

// ── C-10: a failure in the reader's words ───────────────────────────────────

test("a run with no data says what happened and what to do, and keeps the cause", async () => {
  const raw = "invalid SOLUSDT 1h backfill: empty_series";
  serve([run({ status: "error", error: raw, metrics: null, segments: null })]);
  render(<Route path={`/research/${ID}`} params={{ id: ID }}><BacktestDetail /></Route>);
  await settle(6);
  const alert = screen.getByRole("alert");
  assert.match(alert.textContent ?? "", /no candles for SOLUSDT 1h in the window you chose/);
  assert.match(alert.textContent ?? "", /trading history/);
  assertAbsent(screen.queryByText(/Hover for the reason/), "the old non-answer is gone");
  const detail = within(alert).getByText("Technical detail").closest("details")!;
  assert.match(detail.textContent ?? "", /empty_series/, "the engine's words are kept, behind a disclosure");
  assert.ok(!(alert.querySelector("p")?.textContent ?? "").includes("empty_series"),
    "and are never the headline");
});

// ── The list: strategy, stress, failures, comparison ────────────────────────

test("the list names the strategy, marks stress windows, and never prints the engine's words", async () => {
  serve([
    run(),
    run({ id: ID2, stressRunId: "s1" }),
    run({ id: "33333333-3333-4333-8333-333333333333", status: "error", metrics: null,
      error: "invalid SOLUSDT 1h backfill: empty_series" }),
  ]);
  render(<Route path="/research"><BacktestsPage /></Route>);
  await settle(6);
  const table = screen.getAllByRole("table")[0]!;
  assert.ok(within(table).getAllByText("SR Trend v10").length >= 2, "the Strategy column carries the name");
  assert.equal(within(table).getAllByText("Stress").length, 1, "exactly the stress window is marked");
  assertAbsent(within(table).queryByText(/empty_series/), "the raw engine string is not page copy");
  assertPresent(within(table).queryByText(/There were no candles/), "the row says what happened");
});

test("two ticked runs are compared side by side, and a third cannot be ticked", async () => {
  const third = "44444444-4444-4444-8444-444444444444";
  serve([run(), run({ id: ID2, commissionPct: 0.2 }), run({ id: third })]);
  render(<Route path="/research"><BacktestsPage /></Route>);
  await settle(6);
  const boxes = screen.getAllByRole("checkbox", { name: /^Compare/ }) as HTMLInputElement[];
  assert.equal(boxes.length, 3);
  fireEvent.click(boxes[0]!);
  fireEvent.click(boxes[1]!);
  await settle();
  assert.equal(boxes[2]!.disabled, true, "at most two at once");
  const cmp = screen.getByRole("table", { name: "Two runs compared" });
  const commission = within(cmp).getByRole("rowheader", { name: "Commission" }).closest("tr")!;
  assert.equal(commission.getAttribute("data-differs"), "true", "the differing setting is flagged");
  assert.match(commission.textContent ?? "", /0\.1% per fill.*0\.2% per fill/);
  assertPresent(within(cmp).queryByRole("rowheader", { name: /^Validation — Net profit/ }),
    "the windows are compared too, not only the headline");
});

// ── C-9 / C-3: the form ─────────────────────────────────────────────────────

test("the form refuses a negative capital before sending, and sends the validation share", async () => {
  serve([]);
  server.routes.set("POST /api/backtests", () => ({ ...run(), id: ID2, status: "queued" }));
  pushes.length = 0;
  render(<Route path="/research"><BacktestsPage /></Route>);
  await settle(6);

  const capital = screen.getByLabelText("Initial capital") as HTMLInputElement;
  assert.equal(capital.getAttribute("min"), "1", "the field states its own bound");
  fireEvent.change(capital, { target: { value: "-5" } });
  fireEvent.click(screen.getByRole("button", { name: "Run backtest" }));
  await settle();
  assertPresent(screen.queryByText(/Initial capital must be greater than 0/), "the reason is said");
  assert.equal(server.callsTo("/api/backtests").filter((c) => c.method === "POST").length, 0,
    "and nothing is queued");

  fireEvent.change(capital, { target: { value: "1000" } });
  fireEvent.change(screen.getByLabelText(/Validation window/), { target: { value: "0.3" } });
  fireEvent.click(screen.getByRole("button", { name: "Run backtest" }));
  await settle(4);
  const posts = server.callsTo("/api/backtests").filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal((posts[0]!.body as Record<string, unknown>).holdoutFraction, 0.3);
  // Run lands on the run it queued, exactly as Re-run on a result page does,
  // rather than leaving the reader to find it in the list (C-04).
  assert.deepEqual(pushes, [`/research/${ID2}`], "a queued run opens its own page");
});

test("'Edit and re-run' fills the form from the earlier run", async () => {
  serve([run({ initialCapital: 2500, commissionPct: 0.05, holdoutFraction: 0.4 })]);
  window.history.pushState({}, "", `/research?from=${ID}`);
  try {
    render(<Route path="/research"><BacktestsPage /></Route>);
    await settle(8);
    assert.equal((screen.getByLabelText("Initial capital") as HTMLInputElement).value, "2500");
    assert.equal((screen.getByLabelText("Commission % per fill") as HTMLInputElement).value, "0.05");
    assert.equal((screen.getByLabelText(/Validation window/) as HTMLSelectElement).value, "0.4");
    assert.equal((screen.getByLabelText("Strategy") as HTMLSelectElement).value, "srtrend_v10");
  } finally {
    window.history.pushState({}, "", "/");
  }
});
