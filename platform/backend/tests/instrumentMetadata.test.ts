import assert from "node:assert/strict";
import test from "node:test";
import type { InstrumentMetadataDependencies } from "../src/data/instrumentMetadata";
import {
  ensureInstrumentMetadata, hasProviderPriceTick, syncMissingActiveInstrumentMetadata,
} from "../src/data/instrumentMetadata";
import type { SymbolInfo } from "../src/types/market";

function row(symbol: string, priceTick: number | null): SymbolInfo {
  return {
    symbol, canonicalId: `instrument:v1:BINANCE:spot:${symbol}`,
    baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT",
    priceTick, qtyStep: priceTick, minNotional: priceTick,
    isActive: true, venue: "BINANCE", assetClass: "crypto_spot",
  };
}

function fake(initial: SymbolInfo[]) {
  const rows = new Map(initial.map((item) => [item.symbol, item]));
  const calls = { register: [] as string[][], sync: [] as string[][] };
  const deps: InstrumentMetadataDependencies = {
    getSymbol: async (symbol) => rows.get(symbol) ?? null,
    listSymbols: async (activeOnly = false) => [...rows.values()].filter((item) => !activeOnly || item.isActive),
    registerInstruments: async (symbols) => {
      calls.register.push([...symbols]);
      for (const symbol of symbols) rows.set(symbol, row(symbol, 0.01));
    },
    syncInstrumentFilters: async (symbols) => {
      calls.sync.push([...symbols]);
      for (const symbol of symbols) rows.set(symbol, { ...rows.get(symbol)!, priceTick: 0.01 });
    },
  };
  return { rows, calls, deps };
}

test("seeded symbols receive provider filters once, then short-circuit without network", async () => {
  const state = fake([row("BTCUSDT", null), row("ETHUSDT", null), row("SOLUSDT", null)]);
  assert.equal(await syncMissingActiveInstrumentMetadata(state.deps), 3);
  assert.deepEqual(state.calls.sync, [["BTCUSDT", "ETHUSDT", "SOLUSDT"]]);
  assert.ok([...state.rows.values()].every(hasProviderPriceTick));

  assert.equal(await syncMissingActiveInstrumentMetadata(state.deps), 0);
  assert.equal(state.calls.sync.length, 1, "persisted metadata prevents a request on each catalog render");
});

test("new symbols use metadata-first registration and keep canonical storage identity", async () => {
  const state = fake([]);
  const [created] = await ensureInstrumentMetadata(["binance:adausdt"], state.deps);
  assert.equal(created?.symbol, "ADAUSDT");
  assert.equal(created?.priceTick, 0.01);
  assert.deepEqual(state.calls.register, [["ADAUSDT"]]);
  assert.deepEqual(state.calls.sync, []);
});

test("overlapping requests are single-flight per symbol", async () => {
  const state = fake([row("BTCUSDT", null)]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  state.deps.syncInstrumentFilters = async (symbols) => {
    state.calls.sync.push([...symbols]);
    await gate;
    state.rows.set("BTCUSDT", row("BTCUSDT", 0.01));
  };
  const first = ensureInstrumentMetadata(["BTCUSDT"], state.deps);
  const second = ensureInstrumentMetadata(["BTCUSDT"], state.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls.sync.length, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a[0]?.priceTick, 0.01);
  assert.equal(b[0]?.priceTick, 0.01);
  assert.equal(state.calls.sync.length, 1, "the overlapping caller must share the write");
});

test("provider failure writes no fake tick and can be retried", async () => {
  const state = fake([row("BTCUSDT", null)]);
  state.deps.syncInstrumentFilters = async (symbols) => {
    state.calls.sync.push([...symbols]);
    throw new Error("provider unavailable");
  };
  await assert.rejects(() => ensureInstrumentMetadata(["BTCUSDT"], state.deps), /provider unavailable/);
  assert.equal(state.rows.get("BTCUSDT")?.priceTick, null);
  await assert.rejects(() => ensureInstrumentMetadata(["BTCUSDT"], state.deps), /provider unavailable/);
  assert.equal(state.calls.sync.length, 2, "a later request may retry after the failed flight clears");
});
