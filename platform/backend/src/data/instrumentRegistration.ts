/**
 * Registering a pair the platform has not seen before, with its real assets.
 *
 * ── What was here before ───────────────────────────────────────────────────
 *
 * `symbolRepo.addSymbol(symbol, symbol.replace(/USDT$/, ""), "USDT")`.
 *
 * That is a guess, and it is wrong for every pair whose quote asset is not
 * USDT: `ETHBTC` was registered as base `ETHBTC` quote `USDT`, `BTCFDUSD` as
 * base `BTCFDUSD` quote `USDT`. Nothing broke loudly, because the columns are
 * mostly used for display — which is exactly why it stayed wrong.
 *
 * ── What happens now ───────────────────────────────────────────────────────
 *
 * The venue publishes both assets. `marketData.registerInstruments` reads them
 * from `exchangeInfo`, along with the real trading status and the exchange
 * filters production freezing needs, and stores all of it. That is the
 * metadata-first rule Wave A asks for, in the one place a pair is first
 * registered from a chart or a backfill.
 *
 * ── Why there is no fallback any more ──────────────────────────────────────
 *
 * There used to be one: while the directory was unreachable, a ticker with a
 * recognisable quote suffix was registered by `assetsBySuffixFallback`. That
 * wrote a GUESSED identity into the shared catalog every account reads, and
 * only the API response said it was a guess. An outage is temporary; a wrong
 * active row is not. So an unverified pair is now refused with a retryable
 * 503 and nothing is written, while a pair that is already registered keeps
 * working on its existing row (metadata refresh is simply skipped).
 */
import * as symbolRepo from "../repositories/symbols";
import { isUnknownSymbolRefusal } from "./binanceRest";
import { storedSymbol } from "../types/instrument";
import { ensureInstrumentMetadata, hasProviderPriceTick } from "./instrumentMetadata";
import type { SymbolInfo } from "../types/market";

export type RegistrationLog = (msg: string) => void;

/**
 * The venue answered, and it does not list this pair. Raised instead of
 * registering a guessed row: a backfill of `FOOUSDT` used to leave an active
 * suffix-guessed symbol in the shared catalog for every account to see, and
 * then fail on the klines anyway.
 */
export class UnknownInstrumentError extends Error {
  readonly statusCode = 404;
  constructor(readonly ticker: string) {
    super(`${ticker} is not a Binance spot symbol`);
    this.name = "UnknownInstrumentError";
  }
}

/**
 * The directory is unreachable and the pair has no row yet, so its identity
 * cannot be verified and nothing is written. Temporary: try again later.
 */
export class InstrumentDirectoryUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(readonly ticker: string) {
    super(`the instrument directory is unavailable, so ${ticker} cannot be verified or registered right now; try again later`);
    this.name = "InstrumentDirectoryUnavailableError";
  }
}

/** Everything registration reaches outside the process; tests inject fakes. */
export interface RegistrationDeps {
  getSymbol?: (ticker: string) => Promise<SymbolInfo | null>;
  ensureMetadata?: (tickers: readonly string[]) => Promise<(SymbolInfo | null)[]>;
}

/**
 * Ensure `ticker` exists in the symbols table with venue-confirmed assets.
 *
 * Idempotent: a pair that is already registered is left alone rather than
 * re-fetched, so a hot backfill path does not call `exchangeInfo` per request.
 * A pair the venue says it does not list throws `UnknownInstrumentError`; a
 * new pair while the directory is down throws `InstrumentDirectoryUnavailableError`.
 */
export async function registerInstrument(
  rawSymbol: string, log?: RegistrationLog, deps: RegistrationDeps = {}
): Promise<void> {
  const getSymbol = deps.getSymbol ?? symbolRepo.getSymbol;
  const ensureMetadata = deps.ensureMetadata ?? ((tickers: readonly string[]) => ensureInstrumentMetadata(tickers));
  const ticker = storedSymbol(rawSymbol);
  const existing = await getSymbol(ticker);
  if (hasProviderPriceTick(existing)) return;
  try {
    const [registered] = await ensureMetadata([ticker]);
    if (registered) return;
    // The directory answered and had no entry: the pair does not exist there.
    if (!existing) throw new UnknownInstrumentError(ticker);
    log?.(`instrument directory returned no metadata for ${ticker}; keeping the existing row`);
    return;
  } catch (err) {
    if (err instanceof UnknownInstrumentError) throw err;
    if (isUnknownSymbolRefusal(err) && !existing) throw new UnknownInstrumentError(ticker);
    // A seeded/existing row already has truthful assets; keep serving it and
    // leave its unknown precision honest rather than guessing.
    if (existing) {
      log?.(`instrument metadata unavailable for ${ticker} (${(err as Error).message}); keeping the existing row`);
      return;
    }
    throw new InstrumentDirectoryUnavailableError(ticker);
  }
}
