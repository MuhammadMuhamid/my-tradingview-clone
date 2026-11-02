/**
 * Registering a pair from a chart or a backfill (Pass 1 F1): the venue's answer
 * decides. "Not listed" is an error, never a suffix-guessed row in the shared
 * catalog — and neither is "the directory is down": an unverified pair is a
 * retryable 503 with nothing written, while an existing row keeps working.
 *
 * Nothing here reaches Binance or PostgreSQL: the directory is injected, and
 * the catalog's writers are mocked so "nothing written" is a counted fact.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  InstrumentDirectoryUnavailableError, registerInstrument, UnknownInstrumentError, type RegistrationDeps,
} from "../src/data/instrumentRegistration";
import type { SymbolInfo } from "../src/types/market";
import * as symbolRepo from "../src/repositories/symbols";
import { pool } from "../src/db/pool";

const row = (symbol: string, priceTick: number | null): SymbolInfo => ({
  symbol, canonicalId: null, baseAsset: symbol.slice(0, -4), quoteAsset: "USDT",
  priceTick, qtyStep: null, minNotional: null, isActive: true, venue: "BINANCE", assetClass: "crypto_spot",
});

/*
 * PostgreSQL replaced at the pool, the one place every repository query goes
 * through: any write to the catalog, by `symbolRepo.addSymbol` or any other
 * route, is recorded here as a call rather than surfacing as a connection
 * error that happens to fail the test. Registering a symbol writes the
 * symbols row as `insert <ticker> <base> <quote>`.
 */
function catalogWrites(t: TestContext): string[] {
  const writes: string[] = [];
  t.mock.method(pool, "query", async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO symbols/.test(sql)) {
      const [, symbol, base, quote] = params as string[];
      writes.push(`insert ${symbol} ${base} ${quote}`);
      return { rows: [{ symbol, base_asset: base, quote_asset: quote, price_tick: null, qty_step: null,
        min_notional: null, is_active: true }] };
    }
    if (!/^\s*SELECT/i.test(sql)) writes.push(`sql ${sql.trim().slice(0, 40)}`);
    return { rows: [] };
  });
  return writes;
}

/** The venue's own assets, which differ from any suffix guess for ETHBTC. */
const VENUE: Record<string, [string, string]> = { ETHBTC: ["ETH", "BTC"] };

/*
 * The default directory behaves as the real metadata path does: it writes the
 * VENUE's assets through the repository, then returns the row.
 */
function harness(over: Partial<RegistrationDeps> & { existing?: SymbolInfo | null } = {}) {
  const logs: string[] = [];
  const deps: RegistrationDeps = {
    getSymbol: async () => over.existing ?? null,
    ensureMetadata: over.ensureMetadata ?? (async (tickers) => {
      const rows: SymbolInfo[] = [];
      for (const ticker of tickers) {
        const [base, quote] = VENUE[ticker] ?? [ticker.slice(0, -4), "USDT"];
        await symbolRepo.addSymbol(ticker, base, quote);
        rows.push(row(ticker, 0.01));
      }
      return rows;
    }),
  };
  return { deps, logs, log: (m: string) => logs.push(m) };
}

test("a listed pair is registered from the directory and nothing is guessed", async (t) => {
  const writes = catalogWrites(t);
  const h = harness();
  await registerInstrument("ethbtc", h.log, h.deps);
  assert.deepEqual(writes, ["insert ETHBTC ETH BTC"], "exactly one write, the venue's own assets");
  assert.deepEqual(h.logs, []);
});

test("a pair the directory does not list is an UnknownInstrumentError, with no row written", async (t) => {
  const writes = catalogWrites(t);
  const h = harness({ ensureMetadata: async (tickers) => tickers.map(() => null) });
  await assert.rejects(registerInstrument("FOOUSDT", h.log, h.deps), UnknownInstrumentError);
  assert.deepEqual(writes, []);
});

test("Binance's -1121 refusal means the same thing as an empty directory answer", async (t) => {
  const writes = catalogWrites(t);
  const h = harness({ ensureMetadata: async () => { throw new Error('Binance 400: {"code":-1121,"msg":"Invalid symbol."}'); } });
  await assert.rejects(registerInstrument("FOOUSDT", h.log, h.deps), (err: unknown) =>
    err instanceof UnknownInstrumentError && err.statusCode === 404 && /FOOUSDT is not a Binance spot symbol/.test(err.message));
  assert.deepEqual(writes, []);
});

test("a directory that is DOWN refuses a NEW pair (503) and writes no guessed row", async (t) => {
  const writes = catalogWrites(t);
  // SOLUSDT has a perfectly recognisable suffix; that is no longer a licence
  // to put a guessed identity into the shared catalog.
  for (const ticker of ["SOLUSDT", "ETHBTC", "BTCFDUSD"]) {
    const h = harness({ ensureMetadata: async () => { throw new Error("fetch failed"); } });
    await assert.rejects(registerInstrument(ticker, h.log, h.deps), (err: unknown) =>
      err instanceof InstrumentDirectoryUnavailableError && err.statusCode === 503
      && /instrument directory is unavailable/.test(err.message) && /try again later/.test(err.message)
      && !/quote asset/.test(err.message));
    assert.deepEqual(writes, [], `${ticker}: nothing written`);
  }
});

test("a directory that is DOWN keeps a KNOWN pair working on its existing row, and logs the skip", async (t) => {
  const writes = catalogWrites(t);
  const h = harness({ existing: row("SOLUSDT", null), ensureMetadata: async () => { throw new Error("fetch failed"); } });
  await registerInstrument("SOLUSDT", h.log, h.deps);
  assert.deepEqual(writes, []);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /metadata unavailable for SOLUSDT.*keeping the existing row/);
});

test("an existing row is never overwritten, whatever the directory says", async (t) => {
  const writes = catalogWrites(t);
  for (const ensureMetadata of [
    async () => { throw new Error("fetch failed"); },
    async () => { throw new Error('Binance 400: {"code":-1121,"msg":"Invalid symbol."}'); },
    async (tickers: readonly string[]) => tickers.map(() => null),
  ]) {
    const h = harness({ existing: row("OLDUSDT", null), ensureMetadata });
    await registerInstrument("OLDUSDT", h.log, h.deps);
    assert.deepEqual(writes, []);
  }
});

test("a row that already has its provider tick is left alone without asking the directory", async (t) => {
  const writes = catalogWrites(t);
  let asked = 0;
  const h = harness({ existing: row("BTCUSDT", 0.01), ensureMetadata: async (tickers) => { asked += 1; return tickers.map((x) => row(x, 0.01)); } });
  await registerInstrument("BTCUSDT", h.log, h.deps);
  assert.equal(asked, 0);
  assert.deepEqual(writes, []);
});

test("a directory that is DOWN and a ticker with no recognisable quote writes nothing (503)", async (t) => {
  const writes = catalogWrites(t);
  const h = harness({ ensureMetadata: async () => { throw new Error("fetch failed"); } });
  await assert.rejects(registerInstrument("FOOBAR", h.log, h.deps), (err: unknown) =>
    err instanceof InstrumentDirectoryUnavailableError && err.statusCode === 503);
  assert.deepEqual(writes, [], "no row with an empty quote asset");
});
