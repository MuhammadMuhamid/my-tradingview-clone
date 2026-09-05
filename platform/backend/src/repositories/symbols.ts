import { query } from "../db/pool";
import type { SymbolInfo } from "../types/market";
import { DEFAULT_ASSET_CLASS, DEFAULT_VENUE, type AssetClass } from "../types/instrument";

interface SymbolRow {
  symbol: string;
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
  const { rows } = await query<SymbolRow>(
    `INSERT INTO symbols (symbol, base_asset, quote_asset)
     VALUES ($1, $2, $3)
     ON CONFLICT (symbol) DO UPDATE SET is_active = true
     RETURNING *`,
    [symbol, baseAsset, quoteAsset]
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
