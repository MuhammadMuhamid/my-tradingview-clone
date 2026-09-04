export type TradingOverlaySource = "MANUAL" | "AUTOMATED" | "PAPER";
export type TradingOverlayEnvironment = "REAL" | "PAPER" | "TESTNET" | "DRY_RUN" | "UNKNOWN";
export type TradingOverlayKind =
  | "HISTORICAL_ACTIVITY_MARKER"
  | "REALIZATION_MARKER"
  | "PAPER_FILL_MARKER"
  | "ACTIVE_ORDER_LINE"
  | "POSITION_LINE";

export interface TradingOverlayProvenance {
  deploymentId: string | null;
  strategy: { id: string; key: string | null; name: string | null } | null;
  config: { id: string; name: string | null } | null;
}

export interface TradingOverlayItem {
  id: string;
  kind: TradingOverlayKind;
  evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT" | "CURRENT_AUTHORITATIVE_STATE";
  evidenceKind: string;
  source: TradingOverlaySource;
  environment: TradingOverlayEnvironment;
  symbol: string;
  side: "BUY" | "SELL" | null;
  eventTime: string | null;
  observedAt: string | null;
  price: number;
  quantity: number | null;
  state: string | null;
  orderType: string | null;
  completeness: "COMPLETE" | "INCOMPLETE";
  detail: string;
  identifiers: Record<string, string>;
  provenance: TradingOverlayProvenance;
}

export interface TradingOverlayResponse {
  symbol: string;
  range: { from: string; to: string; replayCutoff: string | null };
  items: TradingOverlayItem[];
  truncated: boolean;
  limit: number;
  limitations: string[];
}
