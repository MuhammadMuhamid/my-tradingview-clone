import { query } from "../db/pool";
import { canonicalInstrumentId } from "../market/model";
import type { SymbolInfo } from "../types/market";
import { DEFAULT_ASSET_CLASS, DEFAULT_VENUE, type AssetClass } from "../types/instrument";

interface SymbolRow {
  symbol: string;
  canonical_id?: string | null;
  base_asset: string;
  quote_asset: string;
  price_tick: number | null;
  qty_step: number | null;
  min_notional: number | null;
  is_active: boolean;
  /**
   * Added by 026 with the only defaults this installation has, so a row
   * written before that migration reads exactly as it always meant. Optional
   * on the row type because a caller may `SELECT` a projection without them.
   */
  venue?: string | null;
  asset_class?: string | null;
}

function toSymbolInfo(r: SymbolRow): SymbolInfo {
  return {
    symbol: r.symbol,
    canonicalId: r.canonical_id ?? null,
    baseAsset: r.base_asset,
    quoteAsset: r.quote_asset,
    priceTick: r.price_tick,
    qtyStep: r.qty_step,
    minNotional: r.min_notional,
    isActive: r.is_active,
    venue: r.venue ?? DEFAULT_VENUE,
    assetClass: (r.asset_class ?? DEFAULT_ASSET_CLASS) as AssetClass,
  };
}

export async function listSymbols(activeOnly = false): Promise<SymbolInfo[]> {
  const { rows } = await query<SymbolRow>(
    `SELECT * FROM symbols ${activeOnly ? "WHERE is_active" : ""} ORDER BY symbol`
  );
  return rows.map(toSymbolInfo);
}

export async function getSymbol(symbol: string): Promise<SymbolInfo | null> {
  const { rows } = await query<SymbolRow>(
    "SELECT * FROM symbols WHERE symbol = $1",
    [symbol]
  );
  return rows[0] ? toSymbolInfo(rows[0]) : null;
}

export async function addSymbol(
  symbol: string,
  baseAsset: string,
  quoteAsset: string
): Promise<SymbolInfo> {
  const providerSymbol = symbol.trim().toUpperCase();
  const base = baseAsset.trim().toUpperCase();
  const quote = quoteAsset.trim().toUpperCase();
  const canonicalId = canonicalInstrumentId({
    venueId: "BINANCE", instrumentType: "spot", baseAsset: base, quoteAsset: quote,
    settlementAsset: quote, series: { kind: "spot" },
  });
  const { rows } = await query<SymbolRow>(
    `WITH canonical_row AS (
       INSERT INTO canonical_instruments (
         canonical_id, venue_id, asset_class, instrument_type, base_asset, quote_asset,
         settlement_asset, currency, series, precision_rules, session_model,
         price_capabilities, derivative_terms, event_capabilities,
         execution_capabilities, compliance_metadata
       ) VALUES (
         $1, 'BINANCE', 'crypto', 'spot', $3, $4, $4, $4,
         '{"kind":"spot"}'::jsonb,
         '{"priceTick":{"state":"unknown","reason":"not synced"},"quantityLot":{"state":"unknown","reason":"not synced"},"minimumQuantity":{"state":"unknown","reason":"not synced"},"minimumNotional":{"state":"unknown","reason":"not synced"},"priceDecimals":{"state":"unknown","reason":"not synced"},"quantityDecimals":{"state":"unknown","reason":"not synced"}}'::jsonb,
         '{"kind":"continuous","timezone":"UTC","calendarId":"24x7","supports24x7":true}'::jsonb,
         '{"last":{"support":"supported"},"bid":{"support":"unsupported","reason":"not loaded"},"ask":{"support":"unsupported","reason":"not loaded"},"mid":{"support":"unsupported","reason":"not loaded"},"mark":{"support":"unsupported","reason":"spot"},"index":{"support":"unsupported","reason":"spot"}}'::jsonb,
         '{"kind":"none"}'::jsonb,
         '{"corporateActions":{"support":"unsupported","reason":"no feed"},"funding":{"support":"unsupported","reason":"spot"},"openInterest":{"support":"unsupported","reason":"spot"}}'::jsonb,
         '{"mutationBoundary":"bot_only","availability":{"paper":true,"testnet":true,"live":true},"directions":{"long":true,"short":false},"shortSale":{"support":"unsupported","reason":"cash spot"},"leverage":{"support":"unsupported","reason":"cash spot"},"marginModes":["cash"],"reduceOnly":false,"positionModes":["one_way"]}'::jsonb,
         '{"shariah":{"status":"unknown","reason":"not_classified_by_market_metadata","classificationAuthority":"platform_shariah_policy"},"jurisdictionTags":[]}'::jsonb
       ) ON CONFLICT (canonical_id) DO NOTHING
     ), symbol_row AS (
       INSERT INTO symbols (symbol, base_asset, quote_asset, canonical_id)
       VALUES ($2, $3, $4, $1)
       ON CONFLICT (symbol) DO UPDATE SET is_active = true,
         canonical_id = COALESCE(symbols.canonical_id, EXCLUDED.canonical_id)
       RETURNING *
     ), mapping_row AS (
       INSERT INTO provider_instrument_mappings
         (provider_id, provider_symbol, canonical_id, listing_status)
       VALUES ('binance-spot', $2, $1, 'active')
       ON CONFLICT (provider_id, provider_symbol) DO UPDATE SET
         canonical_id = EXCLUDED.canonical_id, listing_status = 'active'
       RETURNING provider_symbol
     )
     SELECT symbol_row.* FROM symbol_row, mapping_row`,
    [canonicalId, providerSymbol, base, quote]
  );
  return toSymbolInfo(rows[0]!);
}

export async function setSymbolActive(
  symbol: string,
  isActive: boolean
): Promise<SymbolInfo | null> {
  const { rows } = await query<SymbolRow>(
    "UPDATE symbols SET is_active = $2 WHERE symbol = $1 RETURNING *",
    [symbol, isActive]
  );
  return rows[0] ? toSymbolInfo(rows[0]) : null;
}

/** Exchange filters synced from GET /api/v3/exchangeInfo (Stage 3 fills these). */
export async function updateSymbolFilters(
  symbol: string,
  filters: { priceTick: number; qtyStep: number; minNotional: number }
): Promise<void> {
  await query(
    "UPDATE symbols SET price_tick = $2, qty_step = $3, min_notional = $4 WHERE symbol = $1",
    [symbol, filters.priceTick, filters.qtyStep, filters.minNotional]
  );
}
