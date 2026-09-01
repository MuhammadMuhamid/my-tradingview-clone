export type TimelineEvidenceClass =
  | "AUTHORITATIVE_EVENT"
  | "CURRENT_AUTHORITATIVE_STATE"
  | "SAFE_DERIVATION";

export type TimelineSource = "MANUAL" | "AUTOMATED" | "PAPER" | "UNKNOWN";

export interface TimelineIdentifiers {
  requestId?: string;
  clientOrderId?: string;
  exchangeOrderId?: string;
  deploymentId?: string;
  strategyId?: string;
  signalId?: string;
  alertId?: string;
  intentId?: string;
}

export interface TimelineQuantity {
  requestedBase?: number;
  requestedQuote?: number;
  filledBase?: number;
  filledQuote?: number;
  price?: number;
  averagePrice?: number;
  reportedQuantity?: number;
}

export interface TimelineItem {
  key: string;
  timestamp: string;
  kind: string;
  state?: string;
  evidenceClass: TimelineEvidenceClass;
  title: string;
  description: string;
  source: TimelineSource;
  evidenceSource: string;
  identifiers: TimelineIdentifiers;
  quantity?: TimelineQuantity;
}

export interface TimelineReadModel {
  scope: {
    kind: "manual_order" | "deployment";
    id: string;
    source: TimelineSource;
    symbol: string | null;
    side: string | null;
    executionMode: string;
    delivery?: string;
    strategyId?: string;
    configId?: string | null;
  };
  finalKnownState: string | null;
  items: TimelineItem[];
  gaps: string[];
  truncated: boolean;
}
