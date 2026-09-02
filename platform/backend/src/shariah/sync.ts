/**
 * Idempotent sync boundary: current Binance Spot exchange metadata + Trading
 * Scene's supported-symbol set -> the Shariah universe (shariah_assets /
 * shariah_asset_binance_mappings). No network calls happen here — callers
 * pass in already-fetched exchange metadata (see data/binanceRest.ts
 * `listExchangeSymbols`, which already scopes to Binance's SPOT permission).
 *
 * Discovery never classifies: a newly seen base asset is created UNSCREENED,
 * which is REVIEW under policy.ts effectiveShariahStatus. This module has no
 * path that writes 'ELIGIBLE' or 'EXCLUDED'.
 */
import type { QueryResult, QueryResultRow } from "pg";

export interface ShariahDbClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

/** One row of current Binance spot exchange metadata (see binanceRest.ExchangeSymbol). */
export interface BinanceSpotSymbolMeta {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

/**
 * ACTIVE + SPOT + USDT-QUOTED + SUPPORTED BY TRADING SCENE, reduced to the
 * unique set of base assets. `supportedSymbols` is Trading Scene's own
 * tracked-pair set (the existing `symbols` table) — the "supported by
 * Trading Scene" authority; `exchangeSymbols` is expected to already be
 * SPOT-scoped, so ACTIVE here means Binance status === "TRADING".
 */
export function qualifyingBaseAssets(
  exchangeSymbols: readonly BinanceSpotSymbolMeta[],
  supportedSymbols: ReadonlySet<string>
): string[] {
  const bases = new Set<string>();
  for (const s of exchangeSymbols) {
    if (s.status !== "TRADING") continue;
    if (s.quoteAsset !== "USDT") continue;
    if (!supportedSymbols.has(s.symbol)) continue;
    bases.add(s.baseAsset);
  }
  return [...bases].sort();
}

export interface ShariahSyncResult {
  created: string[];
  reactivated: string[];
  deactivated: string[];
}

async function upsertMapping(
  db: ShariahDbClient,
  baseAsset: string
): Promise<{ created: boolean; reactivated: boolean }> {
  const existing = await db.query<{ asset_id: string; binance_available: boolean }>(
    "SELECT asset_id, binance_available FROM shariah_asset_binance_mappings WHERE base_asset = $1",
    [baseAsset]
  );
  const row = existing.rows[0];

  if (row) {
    const wasInactive = row.binance_available === false;
    await db.query(
      "UPDATE shariah_asset_binance_mappings SET binance_available = true, last_seen_at = now() WHERE base_asset = $1",
      [baseAsset]
    );
    return { created: false, reactivated: wasInactive };
  }

  const asset = await db.query<{ asset_id: string }>(
    "INSERT INTO shariah_assets DEFAULT VALUES RETURNING asset_id"
  );
  const assetId = asset.rows[0]!.asset_id;
  await db.query(
    `INSERT INTO shariah_asset_binance_mappings (asset_id, base_asset, binance_available, last_seen_at)
     VALUES ($1, $2, true, now())
     ON CONFLICT (base_asset) DO UPDATE SET binance_available = true, last_seen_at = now()`,
    [assetId, baseAsset]
  );
  await db.query(
    `INSERT INTO shariah_records (asset_id, classification, lifecycle, policy_version)
     VALUES ($1, 'REVIEW', 'UNSCREENED', 'TS_SHARIAH_V1')
     ON CONFLICT (asset_id) DO NOTHING`,
    [assetId]
  );
  return { created: true, reactivated: false };
}

/**
 * Applies the current qualifying base-asset set. Repeated calls with the same
 * input are no-ops beyond `last_seen_at` bookkeeping: one base asset always
 * resolves to the same asset_id (base_asset is the mappings table's primary
 * key), and a base asset already known never gets a second shariah_assets row.
 *
 * Delisting only flips `binance_available`; it never deletes an asset,
 * mapping, or Shariah record.
 */
export async function syncShariahUniverse(
  db: ShariahDbClient,
  qualifying: readonly string[]
): Promise<ShariahSyncResult> {
  const created: string[] = [];
  const reactivated: string[] = [];
  for (const baseAsset of qualifying) {
    const result = await upsertMapping(db, baseAsset);
    if (result.created) created.push(baseAsset);
    else if (result.reactivated) reactivated.push(baseAsset);
  }

  const deactivated = await db.query<{ base_asset: string }>(
    `UPDATE shariah_asset_binance_mappings SET binance_available = false
     WHERE binance_available = true AND base_asset <> ALL($1::text[])
     RETURNING base_asset`,
    [[...qualifying]]
  );

  return { created, reactivated, deactivated: deactivated.rows.map((r) => r.base_asset) };
}
