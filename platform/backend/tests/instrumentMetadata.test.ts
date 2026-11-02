import assert from "node:assert/strict";
import test from "node:test";
import type { InstrumentMetadataDependencies } from "../src/data/instrumentMetadata";
import {
  ensureInstrumentMetadata, hasProviderPriceTick, resetInstrumentMetadataSweep,
  syncMissingActiveInstrumentMetadata,
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
  resetInstrumentMetadataSweep();
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

test("a catalog sweep that cannot fill a row does not ask the provider on every request", async () => {
  // `GET /api/symbols` runs this sweep, and the chart page plus every chart
  // pane calls it. A row the provider will not fill must therefore cost at
  // most one attempt a minute, or a metadata outage becomes a catalog outage.
  resetInstrumentMetadataSweep();
  const state = fake([row("BTCUSDT", null)]);
  state.deps.syncInstrumentFilters = async (symbols) => {
    state.calls.sync.push([...symbols]);
    // The venue answered, and published no PRICE_FILTER for this pair.
  };

  const t0 = 1_800_000_000_000;
  assert.equal(await syncMissingActiveInstrumentMetadata(state.deps, t0), 1);
  assert.equal(state.rows.get("BTCUSDT")?.priceTick, null, "no tick may be invented");

  assert.equal(await syncMissingActiveInstrumentMetadata(state.deps, t0 + 1_000), 0);
  assert.equal(await syncMissingActiveInstrumentMetadata(state.deps, t0 + 59_999), 0);
  assert.equal(state.calls.sync.length, 1, "the hot catalog path re-asked inside its cooldown");

  assert.equal(await syncMissingActiveInstrumentMetadata(state.deps, t0 + 60_000), 1);
  assert.equal(state.calls.sync.length, 2, "the cooldown must expire, not become a negative cache");
});

test("a failing sweep is cooled too, and the explicit path is never cooled", async () => {
  resetInstrumentMetadataSweep();
  const state = fake([row("BTCUSDT", null)]);
  state.deps.syncInstrumentFilters = async (symbols) => {
    state.calls.sync.push([...symbols]);
    throw new Error("provider unavailable");
  };

  const t0 = 1_900_000_000_000;
  await assert.rejects(() => syncMissingActiveInstrumentMetadata(state.deps, t0));
  assert.equal(await syncMissingActiveInstrumentMetadata(state.deps, t0 + 1_000), 0,
    "a thrown sweep must still start its cooldown");
  assert.equal(state.calls.sync.length, 1);

  // Registering or charting a symbol is a user asking for that symbol now.
  await assert.rejects(() => ensureInstrumentMetadata(["BTCUSDT"], state.deps));
  assert.equal(state.calls.sync.length, 2, "the explicit seam must retry immediately");
});

const REFUSED = 'Binance 400: {"code":-1121,"msg":"Invalid symbol."}';

test("one historical bad row does not stop the metadata refresh of valid rows", async () => {
  // Binance refuses the WHOLE `exchangeInfo?symbols=[…]` batch when any one
  // ticker is unlisted. A delisted or once-guessed row must cost only itself.
  resetInstrumentMetadataSweep();
  const state = fake([row("BTCUSDT", null), row("DEADUSDT", null), row("ETHUSDT", null)]);
  const sync = state.deps.syncInstrumentFilters;
  state.deps.syncInstrumentFilters = async (symbols) => {
    if (symbols.includes("DEADUSDT")) { state.calls.sync.push([...symbols]); throw new Error(REFUSED); }
    await sync(symbols);
  };

  await assert.rejects(() => syncMissingActiveInstrumentMetadata(state.deps), /-1121/,
    "the bad row's refusal is still reported, not swallowed");
  assert.equal(state.rows.get("BTCUSDT")?.priceTick, 0.01);
  assert.equal(state.rows.get("ETHUSDT")?.priceTick, 0.01);
  assert.equal(state.rows.get("DEADUSDT")?.priceTick, null, "no tick invented for the refused row");

  // Per-symbol callers: valid ones resolve, only the bad one carries the refusal.
  const fresh = fake([row("BTCUSDT", null), row("DEADUSDT", null)]);
  fresh.deps.syncInstrumentFilters = state.deps.syncInstrumentFilters;
  const both = ensureInstrumentMetadata(["BTCUSDT", "DEADUSDT"], fresh.deps);
  await assert.rejects(() => both, /-1121/);
});

test("a refused registration batch still registers the listed pairs", async () => {
  const state = fake([]);
  const register = state.deps.registerInstruments;
  state.deps.registerInstruments = async (symbols) => {
    state.calls.register.push([...symbols]);
    if (symbols.includes("NOPEUSDT")) throw new Error(REFUSED);
    await register(symbols);
  };
  const solo = ensureInstrumentMetadata(["ADAUSDT", "NOPEUSDT"], state.deps);
  await assert.rejects(() => solo, /-1121/);
  assert.equal(state.rows.get("ADAUSDT")?.priceTick, 0.01);
  assert.equal(state.rows.has("NOPEUSDT"), false, "the unlisted pair is never written");
});

test("an outage is not per-symbol: it fails the flight without fanning out", async () => {
  const state = fake([row("BTCUSDT", null), row("ETHUSDT", null)]);
  state.deps.syncInstrumentFilters = async (symbols) => {
    state.calls.sync.push([...symbols]);
    throw new Error("fetch failed");
  };
  await assert.rejects(() => ensureInstrumentMetadata(["BTCUSDT", "ETHUSDT"], state.deps), /fetch failed/);
  assert.deepEqual(state.calls.sync, [["BTCUSDT", "ETHUSDT"]], "one attempt, not one per symbol");
});
