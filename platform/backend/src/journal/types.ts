export type JournalSource = "MANUAL" | "AUTOMATED" | "PAPER";
export type JournalKind = "ACTIVITY" | "REALIZATION" | "CLOSED_TRADE";
export type JournalPeriod = "day" | "week" | "month";

export interface JournalIdentifiers {
  manualOrderId?: string;
  requestId?: string;
  clientOrderId?: string;
  exchangeOrderId?: string;
  executionId?: string;
  intentId?: string;
  realizedPnlId?: string;
  paperFillId?: string;
  partialCloseId?: string;
  strategyOrderIntentId?: string;
  realizationEventId?: string;
  deploymentId?: string;
  strategyId?: string;
  configId?: string;
}

export interface JournalRow {
  id: string;
  kind: JournalKind;
  source: JournalSource;
  environment: "REAL" | "PAPER";
  symbol: string;
  side: "BUY" | "SELL" | null;
  title: string;
  occurredAt: string;
  entryAt: string | null;
  realizationAt: string | null;
  durationMs: number | null;
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  grossRealizedPnl: number | null;
  fees: number | null;
  /** Persisted realized result even when storage does not state gross/net treatment. */
  realizedPnl: number | null;
  netRealizedPnl: number | null;
  economicsState: "KNOWN" | "UNKNOWN";
  feeState: "KNOWN" | "UNKNOWN";
  evidenceState: "COMPLETE" | "INCOMPLETE";
  evidenceDetail: string;
  strategy: { id: string; key: string | null; name: string | null } | null;
  deploymentId: string | null;
  config: { id: string; name: string | null } | null;
  reason: string | null;
  identifiers: JournalIdentifiers;
}

export interface JournalSummarySlice {
  knownRealizedPnl: number;
  knownRealizedRows: number;
  realizationRows: number;
  knownFees: number;
  feeKnownRows: number;
  wins: number;
  losses: number;
  scratches: number;
  incompleteRows: number;
  unknownEconomicRows: number;
  durationKnownRows: number;
  averageDurationMs: number | null;
}

export interface JournalSummary extends JournalSummarySlice {
  real: JournalSummarySlice;
  paper: JournalSummarySlice;
  bySource: Array<{ source: JournalSource; summary: JournalSummarySlice }>;
  bySymbol: Array<{ symbol: string; source: JournalSource; summary: JournalSummarySlice }>;
  byPeriod: Array<{ bucket: string; source: JournalSource; summary: JournalSummarySlice }>;
  evidenceRowsScanned: number;
  truncated: boolean;
}

export interface JournalResponse {
  rows: JournalRow[];
  page: { number: number; limit: number; hasNext: boolean };
  range: { from: string; toExclusive: string; period: JournalPeriod };
  summary: JournalSummary;
  limitations: string[];
}
