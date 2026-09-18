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
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import StressPage from "@/app/stress/page";
import { RunWindows } from "@/components/RunWindows";
import type { BacktestMetrics } from "@/lib/types";

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

test("the holdout is named as frozen, and the covered window is not the requested one", () => {
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

  assert.ok(screen.getByText(/Holdout \(frozen\)/), "the frozen window must be named as frozen");
  assert.ok(screen.getByText(/never select on it/i),
    "what makes it a holdout is that nothing is chosen on it; that has to be said");
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
  assert.ok(screen.getByText(/not a\s*statement that it had no holdout/i),
    "absence of a record is not evidence of absence, and the panel must not imply it is");
});
