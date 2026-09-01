import type { AlertRow } from "../types/alerts";
import type { DeliveryMode, DeploymentRow } from "../types/deployments";
import type { OrderIntent } from "../repositories/liveSafety";
import type {
  TimelineEvidenceClass, TimelineIdentifiers, TimelineItem, TimelineQuantity,
  TimelineReadModel, TimelineSource,
} from "./types";

export interface ManualOrderEvidence {
  id: string;
  requestId?: string | null;
  clientOrderId?: string | null;
  exchangeOrderId?: string | null;
  exchangeAccountId?: string | null;
  symbol?: string | null;
  side?: string | null;
  orderType?: string | null;
  status?: string | null;
  requestedBaseQty?: number | null;
  requestedQuoteQty?: number | null;
  limitPrice?: number | null;
  filledBaseQty?: number | null;
  filledQuoteQty?: number | null;
  averageFillPrice?: number | null;
  error?: string | null;
  submittedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ManualAccountEvidence {
  id: string;
  testnet?: boolean;
  mode?: string;
}

export interface ExecutionEvidence {
  id: number;
  alertId: number | null;
  deploymentId: string | null;
  exchangeOrderId: string | null;
  side: string | null;
  orderType: string | null;
  qty: number | null;
  price: number | null;
  status: string | null;
  createdAt: number;
}

export interface PaperFillEvidence {
  id: number;
  deploymentId: string;
  alertId: number | null;
  filledAt: number;
  action: "buy" | "sell";
  price: number;
  qty: number;
  quote: number;
  reason: string | null;
}

const iso = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function item(input: {
  key: string;
  timestamp: string | number | null | undefined;
  kind: string;
  state?: string | null;
  evidenceClass: TimelineEvidenceClass;
  title: string;
  description: string;
  source: TimelineSource;
  evidenceSource: string;
  identifiers?: TimelineIdentifiers;
  quantity?: TimelineQuantity;
}): TimelineItem | null {
  const timestamp = iso(input.timestamp);
  if (!timestamp) return null;
  return {
    key: input.key,
    timestamp,
    kind: input.kind,
    ...(input.state ? { state: input.state } : {}),
    evidenceClass: input.evidenceClass,
    title: input.title,
    description: input.description,
    source: input.source,
    evidenceSource: input.evidenceSource,
    identifiers: input.identifiers ?? {},
    ...(input.quantity && Object.keys(input.quantity).length > 0 ? { quantity: input.quantity } : {}),
  };
}

/** Stable ordering only. Equal timestamps remain equal in the response. */
const KIND_ORDER: Record<string, number> = {
  REQUEST_CREATED: 10,
  INTENT_PERSISTED: 10,
  SIGNAL_RECORDED: 20,
  SUBMISSION_ATTEMPTED: 30,
  DELIVERY_RECORDED: 40,
  EXECUTION_STATE_RECORDED: 50,
  PAPER_FILL: 50,
  CURRENT_STATE: 90,
  COMPLETED: 100,
};

export function sortTimeline(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) =>
    Date.parse(a.timestamp) - Date.parse(b.timestamp)
    || (KIND_ORDER[a.kind] ?? 60) - (KIND_ORDER[b.kind] ?? 60)
    || a.key.localeCompare(b.key));
}

const compact = <T>(values: Array<T | null>): T[] => values.filter((v): v is T => v !== null);

function manualDescription(order: ManualOrderEvidence): string {
  const side = order.side ?? "Unknown side";
  const type = order.orderType ?? "unknown order type";
  const amount = order.requestedQuoteQty != null
    ? `${order.requestedQuoteQty} quote`
    : order.requestedBaseQty != null ? `${order.requestedBaseQty} base` : "unknown quantity";
  return `${side} ${type} requested for ${amount}.`;
}

function manualMode(dryRun: boolean, account: ManualAccountEvidence | undefined): string {
  if (dryRun) return "DRY RUN · simulated by execution bot (not paper mode)";
  if (account?.testnet || account?.mode === "testnet") return "BINANCE TESTNET · not real funds";
  if (account && (account.testnet === false || account.mode === "mainnet")) {
    return "BINANCE MAINNET · real funds";
  }
  return "UNKNOWN EXECUTION MODE";
}

export function projectManualOrder(input: {
  order: ManualOrderEvidence;
  accounts?: ManualAccountEvidence[];
  dryRun?: boolean;
}): TimelineReadModel {
  const { order } = input;
  const account = input.accounts?.find((candidate) => candidate.id === order.exchangeAccountId);
  const executionMode = manualMode(Boolean(input.dryRun), account);
  const requestIdentifiers: TimelineIdentifiers = {
    ...(order.requestId ? { requestId: order.requestId } : {}),
    ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
  };
  const currentIdentifiers: TimelineIdentifiers = {
    ...requestIdentifiers,
    ...(order.exchangeOrderId ? { exchangeOrderId: order.exchangeOrderId } : {}),
  };
  const requestedQuantity: TimelineQuantity = {
    ...(order.requestedBaseQty != null ? { requestedBase: order.requestedBaseQty } : {}),
    ...(order.requestedQuoteQty != null ? { requestedQuote: order.requestedQuoteQty } : {}),
    ...(order.limitPrice != null ? { price: order.limitPrice } : {}),
  };
  const currentQuantity: TimelineQuantity = {
    ...requestedQuantity,
    ...(order.filledBaseQty != null ? { filledBase: order.filledBaseQty } : {}),
    ...(order.filledQuoteQty != null ? { filledQuote: order.filledQuoteQty } : {}),
    ...(order.averageFillPrice != null ? { averagePrice: order.averageFillPrice } : {}),
  };
  const status = order.status?.toLowerCase() ?? "unknown";
  const terminal = ["filled", "canceled", "rejected", "failed"].includes(status);
  const terminalTitles: Record<string, string> = {
    filled: "Order filled",
    canceled: "Order canceled",
    rejected: "Submission rejected",
    failed: "Local submission failed",
  };
  const terminalDescriptions: Record<string, string> = {
    filled: "The persisted manual order reached the filled terminal state.",
    canceled: "The persisted exchange snapshot reached the canceled terminal state.",
    rejected: "The execution bot classified submission as rejected; this may be local exchange-filter validation or an exchange response.",
    failed: "The execution bot recorded a local failure; this is not presented as an exchange rejection.",
  };

  const items = compact([
    item({
      key: `manual:${order.id}:created`, timestamp: order.createdAt, kind: "REQUEST_CREATED",
      state: "requested", evidenceClass: "AUTHORITATIVE_EVENT", title: "Manual request persisted",
      description: manualDescription(order), source: "MANUAL", evidenceSource: "Bot ManualOrder.createdAt",
      identifiers: requestIdentifiers, quantity: requestedQuantity,
    }),
    item({
      key: `manual:${order.id}:submitted`, timestamp: order.submittedAt, kind: "SUBMISSION_ATTEMPTED",
      state: "submitted", evidenceClass: "AUTHORITATIVE_EVENT", title: "Submission attempted",
      description: "The durable submission boundary was crossed. This does not by itself prove exchange acceptance.",
      source: "MANUAL", evidenceSource: "Bot ManualOrder.submittedAt", identifiers: requestIdentifiers,
    }),
    terminal ? item({
      key: `manual:${order.id}:completed`, timestamp: order.completedAt, kind: "COMPLETED",
      state: status, evidenceClass: "AUTHORITATIVE_EVENT", title: terminalTitles[status] ?? "Order completed",
      description: `${terminalDescriptions[status] ?? "A terminal state was persisted."}${order.error ? ` ${order.error}` : ""}`,
      source: "MANUAL", evidenceSource: "Bot ManualOrder.status + completedAt",
      identifiers: currentIdentifiers, quantity: currentQuantity,
    }) : null,
    !terminal || !order.completedAt ? item({
      key: `manual:${order.id}:current`, timestamp: order.updatedAt, kind: "CURRENT_STATE",
      state: status, evidenceClass: "CURRENT_AUTHORITATIVE_STATE", title: "Current known state",
      description: `${status === "submitted" && order.error ? "Outcome remains unresolved; reconciliation is pending. " : ""}`
        + `This is the latest persisted snapshot, not proof of every transition before it.${order.error ? ` ${order.error}` : ""}`,
      source: "MANUAL", evidenceSource: "Bot ManualOrder.status + updatedAt",
      identifiers: currentIdentifiers, quantity: currentQuantity,
    }) : null,
  ]);

  const gaps: string[] = [];
  if (!order.createdAt) gaps.push("Request creation time is unavailable for this older record.");
  if (status !== "requested" && !order.submittedAt) gaps.push("Submission-attempt time is unavailable.");
  if ((order.filledBaseQty ?? 0) > 0) {
    gaps.push("Individual fills and earlier cumulative fill snapshots are not exposed by the current manual read contract.");
  }
  if (status === "canceled") {
    gaps.push("A linked cancel-request timestamp is not exposed by the current manual read contract.");
    gaps.push("The Bot read contract folds exchange CANCELED and EXPIRED into canceled, so the exact terminal reason is unavailable.");
  }
  if (terminal && !order.completedAt) gaps.push("The terminal state is known, but its transition time is unavailable.");
  if (items.length === 0) gaps.push("No trustworthy event or observation timestamp is available for this record.");

  return {
    scope: { kind: "manual_order", id: order.id, source: "MANUAL", symbol: order.symbol ?? null,
      side: order.side ?? null, executionMode },
    finalKnownState: order.status ?? null,
    items: sortTimeline(items), gaps, truncated: false,
  };
}

function automatedSource(delivery: DeliveryMode): TimelineSource {
  return delivery === "paper" ? "PAPER" : delivery === "custom" || delivery === "3commas"
    ? "AUTOMATED" : "UNKNOWN";
}

function intentResolution(intent: OrderIntent, identifiers: TimelineIdentifiers,
  source: TimelineSource, delivery: DeliveryMode): TimelineItem | null {
  if (!intent.resolvedAt || intent.state === "pending") return null;
  const labels: Record<string, [string, string]> = {
    delivered: ["Delivery accepted", "The receiver reported that it placed an order; exchange lifecycle after that is not implied."],
    duplicate: ["Duplicate reconciled", "The receiver suppressed this duplicate and reported the original logical order already executed."],
    blocked: ["Execution blocked", "No order was placed and the receiver was not in the requested state."],
    rejected: ["Delivery rejected", "The receiver refused the request. This is delivery evidence, not an exchange rejection."],
    failed: ["Delivery failed", "The delivery attempt failed locally or in transport; exchange rejection is not implied."],
    stale: ["Intent marked stale", "Recovery superseded this unresolved intent without claiming execution success or rejection."],
  };
  if (intent.state === "delivered" && delivery === "paper") {
    labels.delivered = ["Paper outcome recorded", "The paper branch resolved this intent locally; no order was sent."];
  } else if (intent.state === "delivered" && delivery === "off") {
    labels.delivered = ["Signal-only outcome recorded", "Delivery was off; no order was sent or simulated."];
  }
  const [title, description] = labels[intent.state] ?? ["Intent resolved", "The durable intent was resolved."];
  return item({ key: `intent:${intent.id}:resolved`, timestamp: intent.resolvedAt,
    kind: "DELIVERY_RECORDED", state: intent.state, evidenceClass: "AUTHORITATIVE_EVENT",
    title, description: `${description}${intent.detail ? ` ${intent.detail}` : ""}`, source,
    evidenceSource: "Platform order_intents.state + resolved_at", identifiers });
}

function executionItems(executions: ExecutionEvidence[], source: TimelineSource,
  deploymentId: string, strategyId: string): TimelineItem[] {
  const seen = new Set<string>();
  const output: TimelineItem[] = [];
  for (const execution of [...executions].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)) {
    const fingerprint = execution.exchangeOrderId
      ? [execution.exchangeOrderId, execution.status, execution.qty, execution.price, execution.side].join(":")
      : `row:${execution.id}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const status = execution.status?.toUpperCase() ?? "UNKNOWN";
    const identifiers: TimelineIdentifiers = {
      deploymentId, strategyId,
      ...(execution.alertId != null ? { alertId: String(execution.alertId) } : {}),
      ...(execution.exchangeOrderId ? { exchangeOrderId: execution.exchangeOrderId } : {}),
    };
    const projected = item({
      key: `execution:${execution.id}`, timestamp: execution.createdAt, kind: "EXECUTION_STATE_RECORDED",
      state: status.toLowerCase(), evidenceClass: "AUTHORITATIVE_EVENT",
      title: status === "PARTIALLY_FILLED" ? "Partial-fill state recorded"
        : status === "FILLED" ? "Filled state recorded"
        : status === "REJECTED" ? "Exchange rejection recorded"
        : `${status} execution state recorded`,
      description: "Platform persisted an execution report at this time. It is not expanded into unobserved prior transitions.",
      source, evidenceSource: "Platform executions row + created_at", identifiers,
      quantity: {
        ...(execution.qty != null ? { reportedQuantity: execution.qty } : {}),
        ...(execution.price != null ? { price: execution.price } : {}),
      },
    });
    if (projected) output.push(projected);
  }
  return output;
}

export function projectDeploymentTimeline(input: {
  deployment: DeploymentRow;
  intents: OrderIntent[];
  alerts: AlertRow[];
  executions: ExecutionEvidence[];
  paperFills: PaperFillEvidence[];
  limit: number;
  sourceWindowFull?: boolean;
}): TimelineReadModel {
  const { deployment } = input;
  const strategyId = String(deployment.strategyId);
  const source = automatedSource(deployment.delivery);
  const baseIds: TimelineIdentifiers = { deploymentId: deployment.id, strategyId };
  const linkedIntentAlerts = new Set(input.intents.flatMap((intent) =>
    intent.alertId == null ? [] : [intent.alertId]));
  const items: TimelineItem[] = [];

  for (const alert of input.alerts) {
    const identifiers = { ...baseIds, alertId: String(alert.id) };
    const signal = item({ key: `alert:${alert.id}:fired`, timestamp: alert.firedAt,
      kind: "SIGNAL_RECORDED", state: alert.action, evidenceClass: "AUTHORITATIVE_EVENT",
      title: `${alert.action.toUpperCase()} signal recorded`,
      description: `Trading Scene recorded the ${alert.reason ?? "strategy"} signal at ${alert.triggerPrice}.`,
      source, evidenceSource: "Platform alerts.fired_at", identifiers });
    if (signal) items.push(signal);
    // New durable intents carry the richer and more precise delivery outcome.
    // Keep sent_at for legacy alert rows that have no linked intent.
    if (!linkedIntentAlerts.has(alert.id) && alert.sentAt) {
      const delivery = item({ key: `alert:${alert.id}:sent`, timestamp: alert.sentAt,
        kind: "DELIVERY_RECORDED", state: alert.deliveryStatus, evidenceClass: "AUTHORITATIVE_EVENT",
        title: alert.deliveryStatus === "skipped" ? "Delivery skipped" : "Delivery recorded",
        description: alert.deliveryStatus === "sent"
          ? "The legacy alert row records successful delivery. It does not prove later exchange states."
          : "The legacy alert row records that no new delivery was required.",
        source, evidenceSource: "Platform alerts.delivery_status + sent_at", identifiers });
      if (delivery) items.push(delivery);
    }
  }

  for (const intent of input.intents) {
    const identifiers: TimelineIdentifiers = { ...baseIds, intentId: String(intent.id),
      ...(intent.alertId != null ? { alertId: String(intent.alertId) } : {}) };
    const created = item({ key: `intent:${intent.id}:created`, timestamp: intent.createdAt,
      kind: "INTENT_PERSISTED", state: "pending", evidenceClass: "AUTHORITATIVE_EVENT",
      title: "Durable order intent persisted",
      description: `${intent.action.toUpperCase()} intent was stored before delivery${intent.exitLeg ? ` for ${intent.exitLeg}` : ""}.`,
      source, evidenceSource: "Platform order_intents.created_at", identifiers });
    if (created) items.push(created);
    const resolved = intentResolution(intent, identifiers, source, deployment.delivery);
    if (resolved) items.push(resolved);
  }

  items.push(...executionItems(input.executions, source, deployment.id, strategyId));
  for (const fill of input.paperFills) {
    const projected = item({ key: `paper-fill:${fill.id}`, timestamp: fill.filledAt,
      kind: "PAPER_FILL", state: "filled", evidenceClass: "AUTHORITATIVE_EVENT",
      title: `Simulated ${fill.action.toUpperCase()} fill`,
      description: `Paper simulation filled ${fill.qty} at ${fill.price}. No exchange order was sent.`,
      source: "PAPER", evidenceSource: "Platform paper_fills.filled_at",
      identifiers: { ...baseIds, ...(fill.alertId != null ? { alertId: String(fill.alertId) } : {}) },
      quantity: { filledBase: fill.qty, filledQuote: fill.quote, price: fill.price } });
    if (projected) items.push(projected);
  }

  const ordered = sortTimeline(items);
  const responseTrimmed = ordered.length > input.limit;
  const truncated = responseTrimmed || Boolean(input.sourceWindowFull);
  const bounded = responseTrimmed ? ordered.slice(-input.limit) : ordered;
  const gaps: string[] = [];
  if (responseTrimmed) gaps.push("Earlier bounded entries are not included in this response.");
  else if (input.sourceWindowFull) {
    gaps.push("The bounded evidence window is full; earlier persisted evidence may exist.");
  }
  if (deployment.delivery === "custom" && input.executions.length === 0) {
    gaps.push("Bot-side strategy order, fill, client-order ID, and exchange-order evidence is not exposed to Platform by the current contract.");
  }
  if (deployment.delivery === "3commas" && input.executions.length === 0) {
    gaps.push("3Commas/exchange order and fill lifecycle is not persisted in Platform for this deployment.");
  }
  if (input.alerts.some((alert) => ["failed", "blocked"].includes(alert.deliveryStatus)
      && !input.intents.some((intent) => intent.alertId === alert.id && intent.resolvedAt))) {
    gaps.push("Some legacy delivery outcomes have no trustworthy outcome timestamp and are therefore omitted as historical events.");
  }
  if (bounded.length === 0) gaps.push("No persisted order or fill evidence exists for this deployment.");

  const pending = input.intents.some((intent) => intent.state === "pending");
  const latestExecution = [...input.executions].sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    scope: { kind: "deployment", id: deployment.id, source, symbol: deployment.symbol,
      side: null, executionMode: deployment.delivery === "paper" ? "PAPER · simulated; no exchange order"
        : deployment.delivery === "off" ? "SIGNAL ONLY · no order sent" : `${deployment.delivery.toUpperCase()} · live delivery`,
      delivery: deployment.delivery, strategyId, configId: deployment.configId },
    finalKnownState: pending ? "reconciling" : latestExecution?.status ?? null,
    items: bounded, gaps, truncated,
  };
}
