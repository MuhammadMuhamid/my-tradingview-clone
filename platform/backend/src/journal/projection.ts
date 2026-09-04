import type { StrategyExecutionEvidence } from "../timeline/botEvidenceClient";
import type {
  JournalPeriod, JournalRow, JournalSource, JournalSummary, JournalSummarySlice,
} from "./types";

export interface ProvenanceEvidence {
  deploymentId: string;
  strategyId: number;
  strategyKey: string | null;
  strategyName: string | null;
  configId: string | null;
  configName: string | null;
  symbol: string;
}

export interface AutomatedRealizationEvidence extends ProvenanceEvidence {
  id: number;
  closedAt: number;
  pnlQuote: number;
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number | null;
  reason: string | null;
  sourceEventId?: string | null;
  realizationKind?: "partial" | "final" | null;
  strategyOrderIntentId?: string | null;
  exchangeOrderId?: string | null;
  platformOrderIntentId?: string | null;
  accountingBasis?: string | null;
  feeModel?: string | null;
}

export interface AutomatedActivityEvidence extends ProvenanceEvidence {
  kind: "INTENT" | "EXECUTION_SNAPSHOT";
  id: number;
  occurredAt: number;
  side: "BUY" | "SELL";
  state: string | null;
  quantity: number | null;
  price: number | null;
  intentId: number | null;
  executionId: number | null;
  exchangeOrderId: string | null;
}

export interface PaperFillEvidence extends ProvenanceEvidence {
  id: number;
  occurredAt: number;
  action: "buy" | "sell";
  price: number;
  quantity: number;
  commission: number;
  realizedPnl: number | null;
  positionQtyAfter: number;
  reason: string | null;
  entry: {
    occurredAt: number;
    price: number;
    quantity: number;
    commission: number;
  } | null;
}

export interface ManualActivityEvidence {
  id: string;
  requestId: string | null;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  status: string;
  createdAt: number;
  submittedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  filledBaseQty: number;
  averageFillPrice: number | null;
}

const iso = (value: number): string => new Date(value).toISOString();
const provenance = (row: ProvenanceEvidence) => ({
  strategy: { id: String(row.strategyId), key: row.strategyKey, name: row.strategyName },
  deploymentId: row.deploymentId,
  config: row.configId ? { id: row.configId, name: row.configName } : null,
});

export function automatedRealizationRows(rows: readonly AutomatedRealizationEvidence[]): JournalRow[] {
  return rows.map((row) => {
    const modeled = row.accountingBasis === "modeled_fee_adjusted"
      && row.feeModel === "fixed_0.1pct_each_side_not_exchange_observed";
    return ({
    id: `automated-realization:${row.id}`,
    kind: "REALIZATION",
    source: "AUTOMATED",
    environment: "REAL",
    symbol: row.symbol,
    side: "SELL",
    title: row.realizationKind === "partial" ? "Automated partial realization"
      : row.realizationKind === "final" ? "Automated final-leg realization"
      : "Persisted realized outcome",
    occurredAt: iso(row.closedAt),
    entryAt: null,
    realizationAt: iso(row.closedAt),
    durationMs: null,
    quantity: row.quantity,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    grossRealizedPnl: null,
    fees: null,
    realizedPnl: row.pnlQuote,
    netRealizedPnl: null,
    economicsState: "KNOWN",
    feeState: "UNKNOWN",
    evidenceState: "INCOMPLETE",
    evidenceDetail: modeled
      ? "Bot authoritative accounting persisted this per-event result using its fixed modeled 0.1% buy and 0.1% sell fee adjustment. It is not exchange-observed net P&L; individual commissions and a provable open time remain unavailable."
      : "Platform persisted the signed realized P&L and close time; storage does not state gross/net fee treatment, commission history, or a provable open time.",
    ...provenance(row),
    reason: row.reason,
    identifiers: {
      realizedPnlId: String(row.id), deploymentId: row.deploymentId,
      ...(row.sourceEventId ? { realizationEventId: row.sourceEventId } : {}),
      ...(row.strategyOrderIntentId ? { strategyOrderIntentId: row.strategyOrderIntentId } : {}),
      ...(row.platformOrderIntentId ? { intentId: row.platformOrderIntentId } : {}),
      ...(row.exchangeOrderId ? { exchangeOrderId: row.exchangeOrderId } : {}),
      strategyId: String(row.strategyId), ...(row.configId ? { configId: row.configId } : {}),
    },
  }); });
}

export function automatedActivityRows(rows: readonly AutomatedActivityEvidence[]): JournalRow[] {
  const seenSnapshots = new Set<string>();
  const output: JournalRow[] = [];
  for (const row of [...rows].sort((a, b) => a.occurredAt - b.occurredAt || a.id - b.id)) {
    if (row.kind === "EXECUTION_SNAPSHOT") {
      const key = [row.exchangeOrderId ?? `execution:${row.id}`, row.side, row.state,
        row.quantity, row.price].join("|");
      if (seenSnapshots.has(key)) continue;
      seenSnapshots.add(key);
    }
    output.push({
      id: `${row.kind === "INTENT" ? "automated-intent" : "execution-snapshot"}:${row.id}`,
      kind: "ACTIVITY",
      source: "AUTOMATED",
      environment: "REAL",
      symbol: row.symbol,
      side: row.side,
      title: row.kind === "INTENT" ? "Durable order intent" : "Persisted execution snapshot",
      occurredAt: iso(row.occurredAt),
      entryAt: null,
      realizationAt: null,
      durationMs: null,
      quantity: row.quantity,
      entryPrice: row.side === "BUY" ? row.price : null,
      exitPrice: row.side === "SELL" ? row.price : null,
      grossRealizedPnl: null,
      fees: null,
      realizedPnl: null,
      netRealizedPnl: null,
      economicsState: "UNKNOWN",
      feeState: "UNKNOWN",
      evidenceState: "INCOMPLETE",
      evidenceDetail: row.kind === "INTENT"
        ? `The ${row.state ?? "unknown"} intent is authoritative order activity, not proof of a fill or realized result.`
        : "This is a persisted cumulative execution report. It is not an individual exchange fill and does not prove cost basis or realized P&L.",
      ...provenance(row),
      reason: row.state,
      identifiers: {
        ...(row.intentId !== null ? { intentId: String(row.intentId) } : {}),
        ...(row.executionId !== null ? { executionId: String(row.executionId) } : {}),
        ...(row.exchangeOrderId ? { exchangeOrderId: row.exchangeOrderId } : {}),
        deploymentId: row.deploymentId, strategyId: String(row.strategyId),
        ...(row.configId ? { configId: row.configId } : {}),
      },
    });
  }
  return output;
}

export function paperFillRows(rows: readonly PaperFillEvidence[]): JournalRow[] {
  return rows.map((row) => {
    const realization = row.action === "sell" && row.realizedPnl !== null;
    const fraction = realization && row.entry && row.entry.quantity > 0
      ? Math.min(1, row.quantity / row.entry.quantity) : null;
    const allocatedEntryFee = fraction === null || !row.entry ? null : row.entry.commission * fraction;
    const fees = allocatedEntryFee === null ? null : allocatedEntryFee + row.commission;
    const entryAt = realization && row.entry ? row.entry.occurredAt : null;
    return {
      id: `paper-fill:${row.id}`,
      kind: realization ? (row.positionQtyAfter <= 0 ? "CLOSED_TRADE" : "REALIZATION") : "ACTIVITY",
      source: "PAPER",
      environment: "PAPER",
      symbol: row.symbol,
      side: row.action.toUpperCase() as "BUY" | "SELL",
      title: realization
        ? (row.positionQtyAfter <= 0 ? "Paper position closed" : "Paper partial realization")
        : "Paper entry fill",
      occurredAt: iso(row.occurredAt),
      entryAt: entryAt === null ? null : iso(entryAt),
      realizationAt: realization ? iso(row.occurredAt) : null,
      durationMs: entryAt === null ? null : Math.max(0, row.occurredAt - entryAt),
      quantity: row.quantity,
      entryPrice: realization ? row.entry?.price ?? null : row.price,
      exitPrice: realization ? row.price : null,
      grossRealizedPnl: realization && fees !== null ? row.realizedPnl! + fees : null,
      fees: realization ? fees : row.commission,
      realizedPnl: realization ? row.realizedPnl : null,
      netRealizedPnl: realization ? row.realizedPnl : null,
      economicsState: realization ? "KNOWN" : "UNKNOWN",
      feeState: realization ? (fees !== null ? "KNOWN" : "UNKNOWN") : "KNOWN",
      evidenceState: realization && fees !== null ? "COMPLETE" : "INCOMPLETE",
      evidenceDetail: realization
        ? "Persisted paper accounting; net P&L includes the proportionate entry commission and this exit commission."
        : "A simulated entry fill is activity, not a realized outcome.",
      ...provenance(row),
      reason: row.reason,
      identifiers: { paperFillId: String(row.id), deploymentId: row.deploymentId,
        strategyId: String(row.strategyId), ...(row.configId ? { configId: row.configId } : {}) },
    };
  });
}

export function manualActivityRows(rows: readonly ManualActivityEvidence[]): JournalRow[] {
  return rows.map((row) => {
    const occurredAt = row.completedAt ?? row.submittedAt ?? row.createdAt;
    return {
      id: `manual-order:${row.id}`,
      kind: "ACTIVITY",
      source: "MANUAL",
      environment: "REAL",
      symbol: row.symbol,
      side: row.side,
      title: row.filledBaseQty > 0 ? "Manual executed activity" : "Manual order activity",
      occurredAt: iso(occurredAt),
      entryAt: null,
      realizationAt: null,
      durationMs: null,
      quantity: row.filledBaseQty > 0 ? row.filledBaseQty : null,
      entryPrice: row.side === "BUY" ? row.averageFillPrice : null,
      exitPrice: row.side === "SELL" ? row.averageFillPrice : null,
      grossRealizedPnl: null,
      fees: null,
      realizedPnl: null,
      netRealizedPnl: null,
      economicsState: "UNKNOWN",
      feeState: "UNKNOWN",
      evidenceState: "INCOMPLETE",
      evidenceDetail: "The ManualOrder identity and current cumulative execution are authoritative. No cost-basis/disposition relationship or commission history proves realized economics.",
      strategy: null,
      deploymentId: null,
      config: null,
      reason: row.status,
      identifiers: {
        manualOrderId: row.id,
        ...(row.requestId ? { requestId: row.requestId } : {}),
        ...(row.clientOrderId ? { clientOrderId: row.clientOrderId } : {}),
        ...(row.exchangeOrderId ? { exchangeOrderId: row.exchangeOrderId } : {}),
      },
    };
  });
}

/** Exact Bot PartialClose events only; current cumulative snapshots never enter this projection. */
export function botPartialCloseRows(input: Array<{
  deployment: ProvenanceEvidence;
  evidence: StrategyExecutionEvidence;
}>): JournalRow[] {
  const seen = new Set<string>();
  const output: JournalRow[] = [];
  for (const { deployment, evidence } of input) {
    for (const event of evidence.events) {
      if (event.type !== "STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED") continue;
      const partialCloseId = event.identifiers?.partialCloseId;
      const pnl = event.quantities?.realizedPnlQuote;
      if (!partialCloseId || pnl === undefined || seen.has(partialCloseId)) continue;
      seen.add(partialCloseId);
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isFinite(occurredAt)) continue;
      output.push({
        id: `partial-close:${partialCloseId}`,
        kind: "REALIZATION", source: "AUTOMATED", environment: "REAL",
        symbol: deployment.symbol, side: "SELL", title: "Automated partial realization",
        occurredAt: iso(occurredAt), entryAt: null, realizationAt: iso(occurredAt),
        durationMs: null, quantity: event.quantities?.baseQuantity ?? null,
        entryPrice: null, exitPrice: event.quantities?.averagePrice ?? null,
        grossRealizedPnl: null, fees: null, realizedPnl: pnl, netRealizedPnl: pnl,
        economicsState: "KNOWN", feeState: "UNKNOWN", evidenceState: "INCOMPLETE",
        evidenceDetail: "The Bot persisted this exact PartialClose accounting event. Individual commissions and broader trade history are unavailable.",
        ...provenance(deployment), reason: evidence.order.exitLeg,
        identifiers: { partialCloseId, strategyOrderIntentId: evidence.identity.strategyOrderIntentId,
          exchangeOrderId: event.identifiers?.exchangeOrderId,
          deploymentId: deployment.deploymentId, strategyId: String(deployment.strategyId),
          ...(deployment.configId ? { configId: deployment.configId } : {}) },
      });
    }
  }
  return output;
}

const emptySlice = (): JournalSummarySlice => ({
  knownRealizedPnl: 0, knownRealizedRows: 0, realizationRows: 0,
  knownFees: 0, feeKnownRows: 0, wins: 0, losses: 0, scratches: 0,
  incompleteRows: 0, unknownEconomicRows: 0, durationKnownRows: 0,
  averageDurationMs: null,
});

function summarizeRows(rows: readonly JournalRow[]): JournalSummarySlice {
  const summary = emptySlice();
  let durationTotal = 0;
  for (const row of rows) {
    if (row.kind !== "ACTIVITY") summary.realizationRows += 1;
    if (row.realizedPnl !== null) {
      summary.knownRealizedPnl += row.realizedPnl;
      summary.knownRealizedRows += 1;
      if (row.realizedPnl > 0) summary.wins += 1;
      else if (row.realizedPnl < 0) summary.losses += 1;
      else summary.scratches += 1;
    } else summary.unknownEconomicRows += 1;
    if (row.kind !== "ACTIVITY" && row.fees !== null) {
      summary.knownFees += row.fees; summary.feeKnownRows += 1;
    }
    if (row.evidenceState === "INCOMPLETE") summary.incompleteRows += 1;
    if (row.durationMs !== null) { durationTotal += row.durationMs; summary.durationKnownRows += 1; }
  }
  summary.averageDurationMs = summary.durationKnownRows > 0
    ? durationTotal / summary.durationKnownRows : null;
  return summary;
}

function periodBucket(isoTime: string, period: JournalPeriod): string {
  const date = new Date(isoTime);
  if (period === "month") return isoTime.slice(0, 7);
  if (period === "day") return isoTime.slice(0, 10);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function grouped<K extends string>(rows: readonly JournalRow[], key: (row: JournalRow) => K) {
  const groups = new Map<K, JournalRow[]>();
  for (const row of rows) {
    const group = key(row);
    const values = groups.get(group);
    if (values) values.push(row);
    else groups.set(group, [row]);
  }
  return [...groups.entries()].map(([group, values]) => ({ group, summary: summarizeRows(values) }));
}

export function summarizeJournal(
  rows: readonly JournalRow[], period: JournalPeriod, truncated = false
): JournalSummary {
  const realizedForBuckets = rows.filter((row) => row.realizationAt !== null);
  const byPeriod = grouped(realizedForBuckets, (row) =>
    `${periodBucket(row.realizationAt!, period)}|${row.source}`)
    .map(({ group, summary }) => { const [bucket, source] = group.split("|") as [string, JournalSource];
      return { bucket, source, summary }; })
    .sort((a, b) => b.bucket.localeCompare(a.bucket) || a.source.localeCompare(b.source));
  return {
    ...summarizeRows(rows),
    real: summarizeRows(rows.filter((row) => row.environment === "REAL")),
    paper: summarizeRows(rows.filter((row) => row.environment === "PAPER")),
    bySource: grouped(rows, (row) => row.source)
      .map(({ group: source, summary }) => ({ source, summary })),
    bySymbol: grouped(rows, (row) => `${row.symbol}|${row.source}`)
      .map(({ group, summary }) => { const [symbol, source] = group.split("|") as [string, JournalSource];
        return { symbol, source, summary }; })
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.source.localeCompare(b.source)),
    byPeriod,
    evidenceRowsScanned: rows.length,
    truncated,
  };
}
