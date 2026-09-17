/**
 * Ensure the local instrument catalog contains the provider's real exchange
 * filters before a consumer needs precision-sensitive data.
 *
 * The initial migration seeds a few symbols so a fresh installation has a
 * chart immediately, but those rows deliberately contain no guessed
 * `price_tick`. Newly discovered symbols take the metadata-first registration
 * path; seeded rows used to bypass it merely because they already existed.
 * This seam makes both paths converge without making chart rendering itself
 * call a provider.
 */
import * as symbolRepo from "../repositories/symbols";
import type { SymbolInfo } from "../types/market";
import { storedSymbol } from "../types/instrument";
import { marketData } from "./marketData";

export interface InstrumentMetadataDependencies {
  getSymbol(symbol: string): Promise<SymbolInfo | null>;
  listSymbols(activeOnly?: boolean): Promise<SymbolInfo[]>;
  registerInstruments(symbols: string[]): Promise<unknown>;
  syncInstrumentFilters(symbols: string[]): Promise<void>;
}

const DEFAULT_DEPS: InstrumentMetadataDependencies = {
  getSymbol: symbolRepo.getSymbol,
  listSymbols: symbolRepo.listSymbols,
  registerInstruments: (symbols) => marketData.registerInstruments(symbols),
  syncInstrumentFilters: (symbols) => marketData.syncInstrumentFilters(symbols),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** One process must never race two writes for the same provider symbol. */
const inFlight = new Map<string, Deferred<SymbolInfo | null>>();

/** The chart's precision-sensitive features require a genuine positive tick. */
export function hasProviderPriceTick(row: SymbolInfo | null): boolean {
  return row !== null && row.priceTick !== null
    && Number.isFinite(row.priceTick) && row.priceTick > 0;
}

/**
 * Ensure metadata for an explicit set of provider symbols.
 *
 * Calls are batched, idempotent after persistence, and single-flight per
 * symbol. An upstream failure rejects the callers so they can log or disclose
 * degradation; it never writes a fallback tick.
 */
export async function ensureInstrumentMetadata(
  rawSymbols: readonly string[],
  deps: InstrumentMetadataDependencies = DEFAULT_DEPS,
): Promise<(SymbolInfo | null)[]> {
  const symbols = [...new Set(rawSymbols.map(storedSymbol))];
  if (symbols.length === 0) return [];

  const waiting = new Map<string, Promise<SymbolInfo | null>>();
  const owned = new Map<string, Deferred<SymbolInfo | null>>();
  for (const symbol of symbols) {
    const existing = inFlight.get(symbol);
    if (existing) {
      waiting.set(symbol, existing.promise);
      continue;
    }
    const reservation = deferred<SymbolInfo | null>();
    inFlight.set(symbol, reservation);
    owned.set(symbol, reservation);
    waiting.set(symbol, reservation.promise);
  }

  if (owned.size > 0) {
    const task = async (): Promise<void> => {
      const ownedSymbols = [...owned.keys()];
      try {
        const before = await Promise.all(ownedSymbols.map((symbol) => deps.getSymbol(symbol)));
        const register: string[] = [];
        const sync: string[] = [];
        for (let i = 0; i < ownedSymbols.length; i += 1) {
          const symbol = ownedSymbols[i]!;
          const row = before[i] ?? null;
          if (hasProviderPriceTick(row)) continue;
          if (row === null) register.push(symbol);
          else sync.push(symbol);
        }
        if (register.length > 0) await deps.registerInstruments(register);
        if (sync.length > 0) await deps.syncInstrumentFilters(sync);

        const after = await Promise.all(ownedSymbols.map((symbol) => deps.getSymbol(symbol)));
        for (let i = 0; i < ownedSymbols.length; i += 1) {
          owned.get(ownedSymbols[i]!)!.resolve(after[i] ?? null);
        }
      } catch (error) {
        for (const reservation of owned.values()) reservation.reject(error);
      } finally {
        for (const [symbol, reservation] of owned) {
          if (inFlight.get(symbol) === reservation) inFlight.delete(symbol);
        }
      }
    };
    void task();
  }

  return Promise.all(symbols.map((symbol) => waiting.get(symbol)!));
}

/**
 * How long a fruitless catalog sweep waits before asking the provider again.
 *
 * The sweep runs at boot AND on `GET /api/symbols`, which is not a rare call:
 * the chart page loads it once and every chart pane loads it again
 * (`ChartPane.tsx`), so a four-pane workspace asks for the catalog five times
 * before it has drawn anything, and each symbol change re-asks. While every
 * row has its tick the sweep costs one query and stops. While a row does NOT
 * — the provider is unreachable, or the venue genuinely publishes no
 * PRICE_FILTER for that pair — an uncooled sweep would put a provider round
 * trip in front of every one of those requests, so a metadata outage would
 * degrade into a catalog outage: the list the frontend needs in order to
 * DISCLOSE the missing precision would itself stall behind the timeout.
 *
 * The cooldown bounds that to one attempt a minute. It is deliberately not a
 * negative cache: nothing is written, the row keeps its honest null, and the
 * explicit paths — registering a symbol, charting a new one — still call
 * `ensureInstrumentMetadata` directly and are never cooled.
 */
const SWEEP_COOLDOWN_MS = 60_000;
let lastSweepAt = 0;

/** Let a test start from a cold sweep without reaching into module state. */
export function resetInstrumentMetadataSweep(): void {
  lastSweepAt = 0;
}

/**
 * Sync every active legacy/seed row that still lacks a provider price tick.
 *
 * Returns how many rows this call actually attempted — 0 both when there was
 * nothing to do and when the cooldown above declined to ask again yet.
 */
export async function syncMissingActiveInstrumentMetadata(
  deps: InstrumentMetadataDependencies = DEFAULT_DEPS,
  now: number = Date.now(),
): Promise<number> {
  const rows = await deps.listSymbols(true);
  const missing = rows.filter((row) => !hasProviderPriceTick(row)).map((row) => row.symbol);
  if (missing.length === 0) return 0;
  if (lastSweepAt !== 0 && now - lastSweepAt < SWEEP_COOLDOWN_MS) return 0;
  // Before the await, so a sweep that throws still starts the cooldown.
  lastSweepAt = now;
  await ensureInstrumentMetadata(missing, deps);
  return missing.length;
}
