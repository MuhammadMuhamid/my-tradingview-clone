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
 * ── Why there is still a fallback ──────────────────────────────────────────
 *
 * Because the alternative is worse. A backfill that fails outright because the
 * instrument directory blipped is a regression against a path that used to
 * work offline-ish; the old suffix split is kept for exactly that case, named
 * `assetsBySuffixFallback` so it is findable, and the degradation is logged
 * rather than silent. It is a fallback, never a first choice.
 */
import * as symbolRepo from "../repositories/symbols";
import { assetsBySuffixFallback, storedSymbol } from "../types/instrument";
import { marketData } from "./marketData";

export type RegistrationLog = (msg: string) => void;

/**
 * Ensure `ticker` exists in the symbols table with the best assets available.
 *
 * Idempotent: a pair that is already registered is left alone rather than
 * re-fetched, so a hot backfill path does not call `exchangeInfo` per request.
 */
export async function registerInstrument(
  rawSymbol: string, log?: RegistrationLog
): Promise<void> {
  const ticker = storedSymbol(rawSymbol);
  if (await symbolRepo.getSymbol(ticker)) return;
  try {
    const registered = await marketData.registerInstruments([ticker]);
    if (registered.length > 0) return;
    log?.(`instrument directory returned no metadata for ${ticker}; registering by suffix`);
  } catch (err) {
    log?.(
      `instrument metadata unavailable for ${ticker} ` +
      `(${(err as Error).message}); registering by suffix`
    );
  }
  const assets = assetsBySuffixFallback(ticker);
  await symbolRepo.addSymbol(ticker, assets.baseAsset, assets.quoteAsset);
}
