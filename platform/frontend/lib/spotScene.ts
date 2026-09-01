import type { ScreenerRow } from "@/lib/scanner/types";

const PLATFORM_SYMBOL = /^[A-Z0-9]{2,24}$/;
const SCANNER_SYMBOL = /^([A-Z0-9]{1,20})\/([A-Z0-9]{1,20})$/;

export interface ScannerActionHrefs {
  chart: string | null;
  alert: string | null;
  trade: string | null;
}

/**
 * Convert the Scanner's ccxt Spot identity to Platform's existing compact
 * Binance Spot symbol. Exact API provenance is required; aliases and contract
 * substitutions stay unavailable instead of being guessed.
 */
export function platformSpotSymbol(row: ScreenerRow): string | null {
  const market = row.market;
  if (!market || row.state === "unresolved" || market.exchange !== "binance" || !market.spot) {
    return null;
  }
  const configured = market.config_symbol ?? row.symbol;
  if (configured !== row.symbol || market.native_symbol !== configured) return null;
  const match = SCANNER_SYMBOL.exec(configured);
  if (!match) return null;
  const compact = `${match[1]}${match[2]}`;
  return PLATFORM_SYMBOL.test(compact) ? compact : null;
}

export function scannerActionHrefs(row: ScreenerRow): ScannerActionHrefs {
  const symbol = platformSpotSymbol(row);
  if (!symbol) return { chart: null, alert: null, trade: null };
  const query = `source=scanner&symbol=${encodeURIComponent(symbol)}`;
  return {
    chart: `/chart?${query}`,
    alert: `/alerts?${query}&create=level`,
    trade: `/chart?${query}&panel=manual`,
  };
}

function scannerTarget(search: string): URLSearchParams | null {
  const params = new URLSearchParams(search);
  if (params.get("source") !== "scanner") return null;
  const symbol = (params.get("symbol") ?? "").toUpperCase();
  return PLATFORM_SYMBOL.test(symbol) ? params : null;
}

/** Read-only chart/panel prefill. Parsing cannot create an alert or order. */
export function parseScannerChartTarget(search: string): {
  symbol: string;
  panel: "manual" | null;
} | null {
  const params = scannerTarget(search);
  if (!params) return null;
  const panel = params.get("panel");
  if (panel !== null && panel !== "manual") return null;
  return { symbol: params.get("symbol")!.toUpperCase(), panel };
}

/** Read-only prefill for the existing level-alert review dialog. */
export function parseScannerAlertTarget(search: string): { symbol: string } | null {
  const params = scannerTarget(search);
  if (!params || params.get("create") !== "level") return null;
  return { symbol: params.get("symbol")!.toUpperCase() };
}
