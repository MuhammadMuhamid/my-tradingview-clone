import { canonicalDisplayParts } from "./instrument";
import type { SymbolInfo } from "./types";

/** Resolve provider precision across legacy, canonical and compact identities. */
export function resolvePriceTick(rows: readonly Pick<SymbolInfo, "symbol" | "canonicalId" | "priceTick">[], symbol: string): number | null {
  const wanted = symbol.toUpperCase();
  const parts = canonicalDisplayParts(symbol);
  const providerSymbol = parts?.base && parts.quote ? `${parts.base}${parts.quote}` : wanted;
  const row = rows.find((item) => item.symbol.toUpperCase() === wanted
    || item.canonicalId?.toUpperCase() === wanted
    || item.symbol.toUpperCase() === providerSymbol);
  return row?.priceTick && row.priceTick > 0 ? row.priceTick : null;
}
