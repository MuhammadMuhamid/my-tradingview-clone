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

/** A Bot account or manual position id as it may appear in a deep link: plain, short, nothing else. */
const DEEP_LINK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * OD-7: which position a "Close from the Trade panel" link is about. Prefill
 * only. `accountId` is null when the link could not name it (the Bot's trade
 * view does not send account ids yet); the panel then takes the account from
 * the position itself.
 */
export interface ScannerSellTarget { accountId: string | null; positionId: string }

/**
 * Read-only chart/panel prefill. Parsing cannot create an alert or order.
 *
 * With `panel=manual&side=sell&account=<id>&position=<id>` (OD-7) it also names
 * the position to preselect on the SELL tab. Anything malformed in that part is
 * ignored (the plain symbol/panel prefill still applies); it never chooses an
 * amount beyond the position's own quantity and never submits.
 */
export function parseScannerChartTarget(search: string): {
  symbol: string;
  panel: "manual" | null;
  sell?: ScannerSellTarget;
} | null {
  const params = scannerTarget(search);
  if (!params) return null;
  const panel = params.get("panel");
  if (panel !== null && panel !== "manual") return null;
  const target = { symbol: params.get("symbol")!.toUpperCase(), panel: panel as "manual" | null };
  const accountId = params.get("account");
  const positionId = params.get("position") ?? "";
  if (panel === "manual" && params.get("side") === "sell" && DEEP_LINK_ID.test(positionId)
    && (accountId === null || DEEP_LINK_ID.test(accountId))) {
    return { ...target, sell: { accountId, positionId } };
  }
  return target;
}

/**
 * OD-7: the Trade-panel link for ONE manual position, the producer side of
 * `parseScannerChartTarget`'s `sell` (for /bot's "Close from the Trade panel").
 * `accountId` may be null (the Bot's trade view does not send it yet); the
 * panel then takes the account from the position. A malformed id names no
 * position and the link is the plain symbol + panel prefill.
 */
export function tradePanelSellHref(pair: string, target: { accountId?: string | null; positionId: string }): string | null {
  const symbol = pair.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!PLATFORM_SYMBOL.test(symbol)) return null;
  const base = `/chart?source=scanner&symbol=${encodeURIComponent(symbol)}&panel=manual`;
  if (!DEEP_LINK_ID.test(target.positionId)) return base;
  const account = target.accountId && DEEP_LINK_ID.test(target.accountId)
    ? `&account=${encodeURIComponent(target.accountId)}` : "";
  return `${base}&side=sell${account}&position=${encodeURIComponent(target.positionId)}`;
}

/** Read-only prefill for the existing level-alert review dialog. */
export function parseScannerAlertTarget(search: string): { symbol: string } | null {
  const params = scannerTarget(search);
  if (!params || params.get("create") !== "level") return null;
  return { symbol: params.get("symbol")!.toUpperCase() };
}
