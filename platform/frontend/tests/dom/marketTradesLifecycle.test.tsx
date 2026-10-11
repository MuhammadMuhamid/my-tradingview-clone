import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act } from "@testing-library/react";
import { api, type MarketTrade } from "@/lib/api";
import { MAX_TRADE_WINDOW_MS, TRADE_PAGE_ROWS, tradeWindowMs, useMarketTrades } from "@/lib/useMarketTrades";
import { render, FakeSocket, closeBrowser, resetBrowser, settle  } from "./harness/env";

type Deferred = { promise: Promise<MarketTrade[]>; resolve: (rows: MarketTrade[]) => void };
function deferred(): Deferred {
  let resolve!: (rows: MarketTrade[]) => void;
  const promise = new Promise<MarketTrade[]>((r) => { resolve = r; });
  return { promise, resolve };
}

function Probe({ symbol, replayToMs = null, scope = "range|1m", enabled = true, intervalMs }: {
  symbol: string; replayToMs?: number | null; scope?: string; enabled?: boolean; intervalMs?: number;
}) {
  const state = useMarketTrades(symbol, enabled, replayToMs, scope, intervalMs);
  return <output data-testid="market-trades">{JSON.stringify({ identity: state.identity, ids: state.trades.map((t) => t.id), loading: state.loading, error: state.error })}</output>;
}

function read(container: HTMLElement): { ids: number[]; identity: string | null; loading: boolean; error: string | null } {
  return JSON.parse(container.querySelector("output")!.textContent!);
}

const trade = (id: number, timestamp: number): MarketTrade => ({ id, timestamp, price: id, quantity: 1, aggressor: "buy" });

let original: typeof api.marketTrades;
beforeEach(() => { resetBrowser(); original = api.marketTrades; });
after(() => { api.marketTrades = original; closeBrowser(); });

test("published executions invalidate immediately on identity and coverage changes", async () => {
  const pending: Deferred[] = [];
  api.marketTrades = async () => { const d = deferred(); pending.push(d); return d.promise; };
  const view = render(<Probe symbol="BTCUSDT" replayToMs={200} />);
  assert.deepEqual(read(view.container).ids, []);
  pending[0]!.resolve([trade(1, 100), trade(2, 200), trade(3, 300)]);
  await settle();
  assert.deepEqual(read(view.container).ids, [1, 2]);
  await act(async () => { view.rerender(<Probe symbol="BTCUSDT" replayToMs={50} />); });
  assert.deepEqual(read(view.container).ids, [], "a moved horizon cannot expose the old published window");
  await settle();
  assert.deepEqual(read(view.container).ids, []);
  await act(async () => { view.rerender(<Probe symbol="ETHUSDT" replayToMs={50} />); });
  assert.deepEqual(read(view.container).ids, [], "a symbol switch invalidates published executions");
});

test("late history from identity A cannot mutate identity B", async () => {
  const requests: Record<string, Deferred[]> = { BTCUSDT: [], ETHUSDT: [] };
  api.marketTrades = async (symbol) => { const d = deferred(); requests[symbol]!.push(d); return d.promise; };
  const view = render(<Probe symbol="BTCUSDT" />);
  await act(async () => { view.rerender(<Probe symbol="ETHUSDT" />); });
  assert.deepEqual(read(view.container).ids, []);
  requests.BTCUSDT[0]!.resolve([trade(1, 100)]);
  await settle();
  assert.deepEqual(read(view.container).ids, [], "late A response was published into B");
  requests.ETHUSDT[0]!.resolve([trade(2, 100)]);
  await settle();
  assert.deepEqual(read(view.container).ids, [2]);
});

test("Replay is bounded, clips backward, and exiting restores live state without replay data", async () => {
  const requests: Deferred[] = [];
  api.marketTrades = async () => { const d = deferred(); requests.push(d); return d.promise; };
  const view = render(<Probe symbol="SOLUSDT" replayToMs={200} />);
  requests[0]!.resolve([trade(1, 100), trade(2, 200), trade(3, 300)]);
  await settle();
  assert.deepEqual(read(view.container).ids, [1, 2]);
  await act(async () => { view.rerender(<Probe symbol="SOLUSDT" replayToMs={50} />); });
  assert.deepEqual(read(view.container).ids, []);
  await settle();
  assert.deepEqual(read(view.container).ids, []);
  await act(async () => { view.rerender(<Probe symbol="SOLUSDT" replayToMs={null} />); });
  assert.deepEqual(read(view.container).ids, []);
  requests[1]!.resolve([trade(4, 400)]);
  await settle();
  assert.deepEqual(read(view.container).ids, [4]);
});

test("Replay advancement fetches only the new horizon and deduplicates overlap", async () => {
  const requests: Deferred[] = [];
  api.marketTrades = async () => { const d = deferred(); requests.push(d); return d.promise; };
  const view = render(<Probe symbol="XRPUSDT" replayToMs={200} />);
  requests[0]!.resolve([trade(1, 100), trade(2, 200)]);
  await settle();
  await act(async () => { view.rerender(<Probe symbol="XRPUSDT" replayToMs={300} />); });
  assert.deepEqual(read(view.container).ids, [], "the old horizon must not remain published during advance");
  requests[1]!.resolve([trade(2, 200), trade(3, 300)]);
  await settle();
  assert.deepEqual(read(view.container).ids, [1, 2, 3]);
});

test("entering Replay drops live executions, including future trades", async () => {
  api.marketTrades = async () => [trade(1, 100), trade(2, 300)];
  const view = render(<Probe symbol="LINKUSDT" replayToMs={null} />);
  await settle();
  assert.deepEqual(read(view.container).ids, [1, 2]);
  await act(async () => { view.rerender(<Probe symbol="LINKUSDT" replayToMs={200} />); });
  assert.ok(!read(view.container).ids.includes(2), "future live execution leaked into Replay");
  await settle();
  assert.deepEqual(read(view.container).ids, [1]);
});

test("a late live callback from disposed identity A is ignored after switching to B", async () => {
  api.marketTrades = async () => [];
  const view = render(<Probe symbol="ADAUSDT" replayToMs={null} />);
  await settle();
  const oldSocket = FakeSocket.opened.at(-1)!;
  oldSocket.open();
  await act(async () => { oldSocket.deliver({ a: 10, T: 100, p: "10", q: "1", m: false }); });
  assert.deepEqual(read(view.container).ids, [10]);
  await act(async () => { view.rerender(<Probe symbol="DOTUSDT" replayToMs={null} />); });
  assert.deepEqual(read(view.container).ids, []);
  await act(async () => { oldSocket.deliver({ a: 11, T: 101, p: "11", q: "1", m: false }); });
  assert.deepEqual(read(view.container).ids, [], "disposed A callback contaminated B");
});

// ── D-F7: the tape window follows the chart's bars, bounded by one page ────

const MIN = 60_000;
const HORIZON = 1_800_000_000_000;

test("the first window covers eight bars, never under thirty minutes, and never a day's worth more", () => {
  assert.equal(tradeWindowMs(MIN), 30 * MIN, "a minute chart keeps the thirty minutes it had");
  assert.equal(tradeWindowMs(15 * MIN), 120 * MIN, "a fifteen-minute chart asks for eight bars");
  assert.equal(tradeWindowMs(undefined), 30 * MIN);
  assert.equal(tradeWindowMs(24 * 60 * MIN), MAX_TRADE_WINDOW_MS, "a daily chart is capped at the first ask");
});

test("a fifteen-minute footprint asks the provider for its newest eight bars of tape", async () => {
  const asked: Array<[number, number]> = [];
  api.marketTrades = async (_s, from, to) => { asked.push([from, to]); return [trade(1, to - 1)]; };
  const view = render(<Probe symbol="BTCUSDT" scope="footprint|15m" replayToMs={HORIZON} intervalMs={15 * MIN} />);
  await settle();
  assert.deepEqual(asked, [[HORIZON - 120 * MIN, HORIZON]]);
  assert.deepEqual(read(view.container).ids, [1]);
});

test("a page that fills short of the horizon is narrowed to what it covered and asked again", async () => {
  const asked: Array<[number, number]> = [];
  api.marketTrades = async (_s, from, to) => {
    asked.push([from, to]);
    if (asked.length === 1) {
      // The provider walks forward from `from`: a full page that reached only
      // thirty minutes into a two-hour window.
      return Array.from({ length: TRADE_PAGE_ROWS }, (_, i) =>
        trade(i + 1, from + Math.floor((i * 30 * MIN) / TRADE_PAGE_ROWS)));
    }
    return [trade(900_001, to - 2), trade(900_002, to - 1)];
  };
  const view = render(<Probe symbol="BTCUSDT" scope="footprint|15m" replayToMs={HORIZON} intervalMs={15 * MIN} />);
  await settle(6);
  assert.equal(asked.length, 2, `asked ${JSON.stringify(asked)}`);
  const [from, to] = asked[1]!;
  assert.equal(to, HORIZON, "the retry still ends at the horizon — the newest bars are the point");
  assert.ok(to - from < 30 * MIN && to - from >= 25 * MIN, `the retry spans what one page held (${(to - from) / MIN}m)`);
  const state = read(view.container);
  assert.equal(state.error, null);
  assert.deepEqual(state.ids, [900_001, 900_002], "nothing from the page that missed the horizon is published");
});

test("a page that is still partial after narrowing keeps the honest partial-page failure", async () => {
  let calls = 0;
  api.marketTrades = async (_s, from) => {
    calls += 1;
    return Array.from({ length: TRADE_PAGE_ROWS }, (_, i) => trade(calls * 100_000 + i, from + i));
  };
  const view = render(<Probe symbol="BTCUSDT" scope="footprint|15m" replayToMs={HORIZON} intervalMs={15 * MIN} />);
  await settle(8);
  const state = read(view.container);
  assert.match(state.error ?? "", /Trade history is partial: provider page limit reached/);
  assert.deepEqual(state.ids, []);
  assert.ok(calls <= 3, `bounded retries (${calls})`);
});
