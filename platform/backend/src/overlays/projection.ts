import type {
  AutomatedActivityEvidence, AutomatedRealizationEvidence, ManualActivityEvidence,
  PaperFillEvidence, ProvenanceEvidence,
} from "../journal/projection";
import type {
  TradingOverlayEnvironment, TradingOverlayItem, TradingOverlayProvenance,
} from "./types";

export interface ManualOverlayOrderEvidence extends ManualActivityEvidence {
  exchangeAccountId: string | null;
  orderType: string | null;
  limitPrice: number | null;
  requestedBaseQty: number | null;
}

export interface ManualOverlayPositionEvidence {
  id: string;
  exchangeAccountId: string;
  pair: string;
  status: string;
  entryPrice: number | null;
  quantity: number;
  createdAt: number;
  updatedAt: number;
}

export interface ManualOverlayStateEvidence {
  dryRun: boolean;
  accounts: Array<{ id: string; testnet?: boolean; mode?: string }>;
  orders: ManualOverlayOrderEvidence[];
  positions: ManualOverlayPositionEvidence[];
}

export interface CurrentAutomatedOrderEvidence extends ProvenanceEvidence {
  executionId: number;
  alertId: number | null;
  exchangeOrderId: string;
  side: "BUY" | "SELL";
  orderType: string;
  quantity: number | null;
  price: number;
  state: string;
  observedAt: number;
}

export interface CurrentPositionEvidence extends ProvenanceEvidence {
  source: "AUTOMATED" | "PAPER";
  price: number;
  quantity: number | null;
  costBasis: number | null;
  observedAt: number;
}

const noProvenance: TradingOverlayProvenance = {
  deploymentId: null, strategy: null, config: null,
};
const validNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const validTime = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);
const iso = (value: number): string => new Date(value).toISOString();

function provenance(row: ProvenanceEvidence): TradingOverlayProvenance {
  return {
    deploymentId: row.deploymentId,
    strategy: { id: String(row.strategyId), key: row.strategyKey, name: row.strategyName },
    config: row.configId ? { id: row.configId, name: row.configName } : null,
  };
}

function identifiers(values: Record<string, string | number | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) =>
    value === null || value === undefined || value === "" ? [] : [[key, String(value)]]));
}

function manualEnvironment(state: ManualOverlayStateEvidence, accountId: string | null): TradingOverlayEnvironment {
  if (state.dryRun) return "DRY_RUN";
  const account = state.accounts.find((candidate) => candidate.id === accountId);
  if (account?.testnet || account?.mode === "testnet") return "TESTNET";
  if (account && (account.testnet === false || account.mode === "mainnet")) return "REAL";
  return "UNKNOWN";
}

const ACTIVE_ORDER_STATES = new Set([
  "requested", "pending", "submitted", "new", "open", "partially_filled", "working",
]);
const EXECUTED_ACTIVITY_STATES = new Set(["partially_filled", "filled"]);

export function isActiveOrderState(state: string | null | undefined): boolean {
  return ACTIVE_ORDER_STATES.has((state ?? "").trim().toLowerCase());
}

/** Final projection-side horizon guard; future evidence cannot reach serialization. */
export function overlaysWithinRange(
  items: readonly TradingOverlayItem[], from: number, to: number
): TradingOverlayItem[] {
  return items.filter((item) => {
    if (item.eventTime === null) return false;
    const time = Date.parse(item.eventTime);
    return Number.isFinite(time) && time >= from && time <= to;
  });
}

export function projectHistoricalOverlays(input: {
  symbol: string;
  manual?: ManualOverlayStateEvidence;
  automatedActivity: readonly AutomatedActivityEvidence[];
  automatedRealizations: readonly AutomatedRealizationEvidence[];
  paperFills: readonly PaperFillEvidence[];
  limit: number;
}): { items: TradingOverlayItem[]; truncated: boolean } {
  const output: TradingOverlayItem[] = [];
  const seen = new Set<string>();
  const push = (item: TradingOverlayItem): void => {
    if (!seen.has(item.id)) { seen.add(item.id); output.push(item); }
  };

  for (const order of input.manual?.orders ?? []) {
    if (order.symbol !== input.symbol || !validTime(order.completedAt)
      || !validNumber(order.filledBaseQty) || !validNumber(order.averageFillPrice)) continue;
    push({
      id: `manual-order:${order.id}:completion`, kind: "HISTORICAL_ACTIVITY_MARKER",
      evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
      evidenceKind: "ORDER_COMPLETION_EXECUTED_ACTIVITY", source: "MANUAL",
      environment: manualEnvironment(input.manual!, order.exchangeAccountId), symbol: order.symbol,
      side: order.side, eventTime: iso(order.completedAt), observedAt: null,
      price: order.averageFillPrice, quantity: order.filledBaseQty,
      state: order.status, orderType: order.orderType, completeness: "INCOMPLETE",
      detail: "Completed ManualOrder cumulative execution at its authoritative average price. This is order-level executed activity, not an individual exchange fill.",
      identifiers: identifiers({ manualOrderId: order.id, requestId: order.requestId,
        clientOrderId: order.clientOrderId, exchangeOrderId: order.exchangeOrderId }),
      provenance: noProvenance,
    });
  }

  const latestExecution = new Map<string, AutomatedActivityEvidence>();
  for (const row of input.automatedActivity) {
    if (row.kind !== "EXECUTION_SNAPSHOT" || row.symbol !== input.symbol
      || !validTime(row.occurredAt) || !validNumber(row.quantity) || !validNumber(row.price)
      || !EXECUTED_ACTIVITY_STATES.has((row.state ?? "").trim().toLowerCase())) continue;
    const key = row.exchangeOrderId
      ? `deployment:${row.deploymentId}:exchange:${row.exchangeOrderId}`
      : `execution:${row.executionId ?? row.id}`;
    const prior = latestExecution.get(key);
    if (!prior || row.occurredAt > prior.occurredAt
      || (row.occurredAt === prior.occurredAt && row.id > prior.id)) latestExecution.set(key, row);
  }
  for (const row of latestExecution.values()) {
    push({
      id: `automated-execution:${row.executionId ?? row.id}`,
      kind: "HISTORICAL_ACTIVITY_MARKER", evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
      evidenceKind: "PERSISTED_EXECUTION_SNAPSHOT", source: "AUTOMATED", environment: "REAL",
      symbol: row.symbol, side: row.side, eventTime: iso(row.occurredAt), observedAt: null,
      price: row.price!, quantity: row.quantity, state: row.state, orderType: null,
      completeness: "INCOMPLETE",
      detail: "Persisted cumulative execution report. It is not an individual exchange fill or reconstructed trade lot.",
      identifiers: identifiers({ executionId: row.executionId ?? row.id,
        exchangeOrderId: row.exchangeOrderId, deploymentId: row.deploymentId,
        strategyId: row.strategyId, configId: row.configId }), provenance: provenance(row),
    });
  }

  for (const row of input.automatedRealizations) {
    if (row.symbol !== input.symbol || !validTime(row.closedAt) || !validNumber(row.exitPrice)) continue;
    push({
      id: `automated-realization:${row.id}`, kind: "REALIZATION_MARKER",
      evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", evidenceKind: "PERSISTED_REALIZATION",
      source: "AUTOMATED", environment: "REAL", symbol: row.symbol, side: "SELL",
      eventTime: iso(row.closedAt), observedAt: null, price: row.exitPrice,
      quantity: row.quantity, state: row.reason, orderType: null, completeness: "INCOMPLETE",
      detail: "Platform-persisted economic realization. Fee treatment and unavailable fill history remain unknown.",
      identifiers: identifiers({ realizedPnlId: row.id, deploymentId: row.deploymentId,
        strategyId: row.strategyId, configId: row.configId }), provenance: provenance(row),
    });
  }

  for (const row of input.paperFills) {
    if (row.symbol !== input.symbol || !validTime(row.occurredAt)
      || !validNumber(row.price) || !validNumber(row.quantity)) continue;
    push({
      id: `paper-fill:${row.id}`, kind: "PAPER_FILL_MARKER",
      evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT", evidenceKind: "PERSISTED_PAPER_FILL",
      source: "PAPER", environment: "PAPER", symbol: row.symbol,
      side: row.action === "buy" ? "BUY" : "SELL", eventTime: iso(row.occurredAt),
      observedAt: null, price: row.price, quantity: row.quantity,
      state: row.reason, orderType: null, completeness: "COMPLETE",
      detail: "Individual simulated paper fill persisted by Platform. No exchange order was sent.",
      identifiers: identifiers({ paperFillId: row.id, deploymentId: row.deploymentId,
        strategyId: row.strategyId, configId: row.configId }), provenance: provenance(row),
    });
  }

  output.sort((a, b) => Date.parse(a.eventTime!) - Date.parse(b.eventTime!) || a.id.localeCompare(b.id));
  const truncated = output.length > input.limit;
  return { items: truncated ? output.slice(-input.limit) : output, truncated };
}

export function projectCurrentOverlays(input: {
  symbol: string;
  manual?: ManualOverlayStateEvidence;
  automatedOrders: readonly CurrentAutomatedOrderEvidence[];
  positions: readonly CurrentPositionEvidence[];
}): TradingOverlayItem[] {
  const output: TradingOverlayItem[] = [];
  for (const order of input.manual?.orders ?? []) {
    if (order.symbol !== input.symbol || order.orderType?.toUpperCase() !== "LIMIT"
      || !isActiveOrderState(order.status) || !validNumber(order.limitPrice)
      || !validTime(order.updatedAt)) continue;
    output.push({
      id: `manual-order:${order.id}:active`, kind: "ACTIVE_ORDER_LINE",
      evidenceClass: "CURRENT_AUTHORITATIVE_STATE", evidenceKind: "CURRENT_ORDER_SNAPSHOT",
      source: "MANUAL", environment: manualEnvironment(input.manual!, order.exchangeAccountId),
      symbol: order.symbol, side: order.side, eventTime: null, observedAt: iso(order.updatedAt),
      price: order.limitPrice, quantity: validNumber(order.requestedBaseQty) ? order.requestedBaseQty : null,
      state: order.status, orderType: order.orderType, completeness: "INCOMPLETE",
      detail: "Latest observed ManualOrder state. The observation time is shown because this is not a timeless exchange guarantee.",
      identifiers: identifiers({ manualOrderId: order.id, requestId: order.requestId,
        clientOrderId: order.clientOrderId, exchangeOrderId: order.exchangeOrderId }),
      provenance: noProvenance,
    });
  }
  for (const order of input.automatedOrders) {
    if (order.symbol !== input.symbol || order.orderType.toUpperCase() !== "LIMIT"
      || !isActiveOrderState(order.state) || !validNumber(order.price)
      || !validTime(order.observedAt)) continue;
    output.push({
      id: `automated-order:${order.deploymentId}:${order.exchangeOrderId}:active`,
      kind: "ACTIVE_ORDER_LINE",
      evidenceClass: "CURRENT_AUTHORITATIVE_STATE", evidenceKind: "CURRENT_ORDER_SNAPSHOT",
      source: "AUTOMATED", environment: "REAL", symbol: order.symbol, side: order.side,
      eventTime: null, observedAt: iso(order.observedAt), price: order.price,
      quantity: order.quantity, state: order.state, orderType: order.orderType,
      completeness: "INCOMPLETE",
      detail: "Latest Platform-persisted order observation. Quantity, when present, is cumulative executed quantity from that snapshot, not remaining requested quantity. A newer unpersisted exchange transition may exist.",
      identifiers: identifiers({ executionId: order.executionId, alertId: order.alertId,
        exchangeOrderId: order.exchangeOrderId, deploymentId: order.deploymentId,
        strategyId: order.strategyId, configId: order.configId }), provenance: provenance(order),
    });
  }
  for (const position of input.manual?.positions ?? []) {
    if (position.pair !== input.symbol || position.status.toLowerCase() !== "active"
      || !validNumber(position.entryPrice) || !validNumber(position.quantity)
      || !validTime(position.updatedAt)) continue;
    output.push({
      id: `manual-position:${position.id}`, kind: "POSITION_LINE",
      evidenceClass: "CURRENT_AUTHORITATIVE_STATE", evidenceKind: "EXPLICIT_MANUAL_POSITION_SNAPSHOT",
      source: "MANUAL", environment: manualEnvironment(input.manual!, position.exchangeAccountId),
      symbol: position.pair, side: "BUY", eventTime: null, observedAt: iso(position.updatedAt),
      price: position.entryPrice, quantity: position.quantity, state: position.status,
      orderType: null, completeness: "INCOMPLETE",
      detail: "Explicit Bot-owned ManualPosition snapshot. No position was reconstructed by pairing ManualOrders.",
      identifiers: { manualPositionId: position.id }, provenance: noProvenance,
    });
  }
  for (const position of input.positions) {
    if (position.symbol !== input.symbol || !validNumber(position.price)
      || !validTime(position.observedAt)) continue;
    output.push({
      id: `${position.source.toLowerCase()}-position:${position.deploymentId}`,
      kind: "POSITION_LINE", evidenceClass: "CURRENT_AUTHORITATIVE_STATE",
      evidenceKind: position.source === "PAPER" ? "PAPER_ACCOUNTING_POSITION" : "DEPLOYMENT_RUNTIME_POSITION",
      source: position.source, environment: position.source === "PAPER" ? "PAPER" : "REAL",
      symbol: position.symbol, side: "BUY", eventTime: null, observedAt: iso(position.observedAt),
      price: position.price, quantity: position.quantity, state: "long", orderType: null,
      completeness: position.quantity === null ? "INCOMPLETE" : "COMPLETE",
      detail: position.source === "PAPER"
        ? "Current paper position from the existing persisted paper accounting model."
        : "Current long position from persisted deployment runtime state; quantity is omitted because that model does not prove it.",
      identifiers: identifiers({ deploymentId: position.deploymentId,
        strategyId: position.strategyId, configId: position.configId }), provenance: provenance(position),
    });
  }
  return output.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}
