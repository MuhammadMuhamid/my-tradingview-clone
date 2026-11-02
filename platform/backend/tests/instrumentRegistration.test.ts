/**
 * Registering a pair from a chart or a backfill (Pass 1 F1): the venue's answer
 * decides. "Not listed" is an error, never a suffix-guessed row in the shared
 * catalog; the suffix fallback survives only for a directory that is down.
 *
 * Nothing here reaches Binance or PostgreSQL: every dependency is injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerInstrument, UnknownInstrumentError, type RegistrationDeps } from "../src/data/instrumentRegistration";
import type { SymbolInfo } from "../src/types/market";

const row = (symbol: string, priceTick: number | null): SymbolInfo => ({
  symbol, canonicalId: null, baseAsset: symbol.slice(0, -4), quoteAsset: "USDT",
  priceTick, qtyStep: null, minNotional: null, isActive: true, venue: "BINANCE", assetClass: "crypto_spot",
});

function harness(over: Partial<RegistrationDeps> & { existing?: SymbolInfo | null } = {}) {
  const added: Array<[string, string, string]> = [];
  const logs: string[] = [];
  const deps: RegistrationDeps = {
    getSymbol: async () => over.existing ?? null,
    ensureMetadata: over.ensureMetadata ?? (async (tickers) => tickers.map((t) => row(t, 0.01))),
    addSymbol: async (t, b, q) => { added.push([t, b, q]); },
  };
  return { deps, added, logs, log: (m: string) => logs.push(m) };
}

test("a listed pair is registered from the directory and nothing is guessed", async () => {
  const h = harness();
  await registerInstrument("ethbtc", h.log, h.deps);
  assert.deepEqual(h.added, []);
  assert.deepEqual(h.logs, []);
});

test("a pair the directory does not list is an UnknownInstrumentError, with no row written", async () => {
  const h = harness({ ensureMetadata: async (tickers) => tickers.map(() => null) });
  await assert.rejects(registerInstrument("FOOUSDT", h.log, h.deps), UnknownInstrumentError);
  assert.deepEqual(h.added, []);
});

test("Binance's -1121 refusal means the same thing as an empty directory answer", async () => {
  const h = harness({ ensureMetadata: async () => { throw new Error('Binance 400: {"code":-1121,"msg":"Invalid symbol."}'); } });
  await assert.rejects(registerInstrument("FOOUSDT", h.log, h.deps), (err: unknown) =>
    err instanceof UnknownInstrumentError && err.statusCode === 404 && /FOOUSDT is not a Binance spot symbol/.test(err.message));
  assert.deepEqual(h.added, []);
});

test("a directory that is DOWN still registers by suffix, and says so in the log", async () => {
  const h = harness({ ensureMetadata: async () => { throw new Error("fetch failed"); } });
  await registerInstrument("SOLUSDT", h.log, h.deps);
  assert.deepEqual(h.added, [["SOLUSDT", "SOL", "USDT"]]);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /registering by suffix/);
});

test("an existing row is never overwritten, whatever the directory says", async () => {
  for (const ensureMetadata of [
    async () => { throw new Error("fetch failed"); },
    async () => { throw new Error('Binance 400: {"code":-1121,"msg":"Invalid symbol."}'); },
    async (tickers: readonly string[]) => tickers.map(() => null),
  ]) {
    const h = harness({ existing: row("OLDUSDT", null), ensureMetadata });
    await registerInstrument("OLDUSDT", h.log, h.deps);
    assert.deepEqual(h.added, []);
  }
});

test("a row that already has its provider tick is left alone without asking the directory", async () => {
  let asked = 0;
  const h = harness({ existing: row("BTCUSDT", 0.01), ensureMetadata: async (t) => { asked += 1; return t.map((x) => row(x, 0.01)); } });
  await registerInstrument("BTCUSDT", h.log, h.deps);
  assert.equal(asked, 0);
});
