import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act } from "@testing-library/react";
import { api, type MarketTrade } from "@/lib/api";
import { useMarketTrades } from "@/lib/useMarketTrades";
import { render, FakeSocket, closeBrowser, resetBrowser, settle  } from "./harness/env";

type Deferred = { promise: Promise<MarketTrade[]>; resolve: (rows: MarketTrade[]) => void };
function deferred(): Deferred {
  let resolve!: (rows: MarketTrade[]) => void;
  const promise = new Promise<MarketTrade[]>((r) => { resolve = r; });
  return { promise, resolve };
}

function Probe({ symbol, replayToMs = null, scope = "range|1m", enabled = true }: {
  symbol: string; replayToMs?: number | null; scope?: string; enabled?: boolean;
}) {
  const state = useMarketTrades(symbol, enabled, replayToMs, scope);
  return <output data-testid="market-trades">{JSON.stringify({ identity: state.identity, ids: state.trades.map((t) => t.id), loading: state.loading, error: state.error })}</output>;
}

function read(container: HTMLElement): { ids: number[]; identity: string | null; loading: boolean } {
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
