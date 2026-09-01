import type { AlertRow } from "../types/alerts";
import type { DeliveryMode, DeploymentRow } from "../types/deployments";
import type { OrderIntent } from "../repositories/liveSafety";
import type {
  TimelineEvidenceClass, TimelineIdentifiers, TimelineItem, TimelineQuantity,
  TimelineReadModel, TimelineSource,
} from "./types";
import type {
  BotEvidenceEvent, ManualExecutionEvidence, StrategyExecutionEvidence,
} from "./botEvidenceClient";

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
  linkageEvidenceClass?: "AUTHORITATIVE_LINKAGE";
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
    ...(input.linkageEvidenceClass ? { linkageEvidenceClass: input.linkageEvidenceClass } : {}),
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
  CANCEL_COMMAND_CURRENT_STATE: 91,
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
  botEvidence?: ManualExecutionEvidence;
}): TimelineReadModel {
  const originalOrder = input.order;
  const evidence = input.botEvidence;
  const evidenceEvent = (type: string): BotEvidenceEvent | undefined =>
    evidence?.events.find((candidate) => candidate.type === type);
  const createdEvidence = evidenceEvent("MANUAL_ORDER_PERSISTED");
  const submittedEvidence = evidenceEvent("SUBMISSION_ATTEMPTED");
  const completedEvidence = evidenceEvent("MANUAL_ORDER_COMPLETED");
  const originalObservedAt = Date.parse(originalOrder.updatedAt ?? "");
  const evidenceObservedAt = Date.parse(evidence?.currentState.observedAt ?? "");
  const evidenceCurrentIsNewest = !Number.isFinite(originalObservedAt)
    || (Number.isFinite(evidenceObservedAt) && evidenceObservedAt >= originalObservedAt);
  const order: ManualOrderEvidence = evidence ? {
    ...originalOrder,
    id: evidence.identity.manualOrderId,
    requestId: evidence.identity.orderRequestId,
    clientOrderId: evidence.identity.clientOrderId,
    exchangeOrderId: evidenceCurrentIsNewest ? evidence.identity.exchangeOrderId
      : originalOrder.exchangeOrderId ?? evidence.identity.exchangeOrderId,
    symbol: evidence.order.symbol,
    side: evidence.order.side,
    orderType: evidence.order.orderType,
    requestedBaseQty: evidence.order.requestedBaseQuantity,
    requestedQuoteQty: evidence.order.requestedQuoteQuantity,
    limitPrice: evidence.order.limitPrice,
    status: evidenceCurrentIsNewest ? evidence.currentState.orderStatus : originalOrder.status,
    filledBaseQty: evidenceCurrentIsNewest ? evidence.currentState.cumulativeExecutedBaseQuantity
      : originalOrder.filledBaseQty,
    filledQuoteQty: evidenceCurrentIsNewest ? evidence.currentState.cumulativeExecutedQuoteQuantity
      : originalOrder.filledQuoteQty,
    averageFillPrice: evidenceCurrentIsNewest ? evidence.currentState.averageFillPrice
      : originalOrder.averageFillPrice,
    updatedAt: evidenceCurrentIsNewest ? evidence.currentState.observedAt : originalOrder.updatedAt,
  } : originalOrder;
  const account = input.accounts?.find((candidate) => candidate.id === order.exchangeAccountId);
  const executionMode = manualMode(Boolean(input.dryRun), account);
  const requestIdentifiers: TimelineIdentifiers = {
    ...(evidence ? { manualOrderId: evidence.identity.manualOrderId } : {}),
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
    ...(order.filledBaseQty != null ? evidence
      ? { cumulativeExecutedBaseQuantity: order.filledBaseQty } : { filledBase: order.filledBaseQty } : {}),
    ...(order.filledQuoteQty != null ? evidence
      ? { cumulativeExecutedQuoteQuantity: order.filledQuoteQty } : { filledQuote: order.filledQuoteQty } : {}),
    ...(order.averageFillPrice != null ? { averagePrice: order.averageFillPrice } : {}),
  };
  const completedQuantity: TimelineQuantity = completedEvidence?.quantities ? {
    ...(completedEvidence.quantities.cumulativeExecutedBaseQuantity != null
      ? { cumulativeExecutedBaseQuantity: completedEvidence.quantities.cumulativeExecutedBaseQuantity } : {}),
    ...(completedEvidence.quantities.cumulativeExecutedQuoteQuantity != null
      ? { cumulativeExecutedQuoteQuantity: completedEvidence.quantities.cumulativeExecutedQuoteQuantity } : {}),
    ...(completedEvidence.quantities.averageFillPrice != null
      ? { averagePrice: completedEvidence.quantities.averageFillPrice } : {}),
  } : currentQuantity;
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
      key: `manual:${order.id}:created`, timestamp: createdEvidence?.occurredAt ?? order.createdAt,
      kind: "REQUEST_CREATED", state: createdEvidence?.state ?? "requested",
      evidenceClass: createdEvidence?.evidenceClass ?? "AUTHORITATIVE_EVENT", title: "Manual request persisted",
      description: manualDescription(order), source: "MANUAL", evidenceSource: "Bot ManualOrder.createdAt",
      identifiers: requestIdentifiers, quantity: requestedQuantity,
      linkageEvidenceClass: evidence?.identity.evidenceClass,
    }),
    item({
      key: `manual:${order.id}:submitted`, timestamp: submittedEvidence?.occurredAt ?? order.submittedAt,
      kind: "SUBMISSION_ATTEMPTED", state: submittedEvidence?.state ?? "submitted",
      evidenceClass: submittedEvidence?.evidenceClass ?? "AUTHORITATIVE_EVENT", title: "Submission attempted",
      description: "The durable submission boundary was crossed. This does not by itself prove exchange acceptance.",
      source: "MANUAL", evidenceSource: "Bot ManualOrder.submittedAt", identifiers: requestIdentifiers,
      linkageEvidenceClass: evidence?.identity.evidenceClass,
    }),
    terminal ? item({
      key: `manual:${order.id}:completed`, timestamp: completedEvidence?.occurredAt ?? order.completedAt,
      kind: "COMPLETED", state: completedEvidence?.state ?? status,
      evidenceClass: completedEvidence?.evidenceClass ?? "AUTHORITATIVE_EVENT",
      title: terminalTitles[status] ?? "Order completed",
      description: `${terminalDescriptions[status] ?? "A terminal state was persisted."}${order.error ? ` ${order.error}` : ""}`,
      source: "MANUAL", evidenceSource: "Bot ManualOrder.status + completedAt",
      identifiers: currentIdentifiers, quantity: completedQuantity,
      linkageEvidenceClass: evidence?.identity.evidenceClass,
    }) : null,
    evidence || !terminal || !order.completedAt ? item({
      key: `manual:${order.id}:current`, timestamp: order.updatedAt, kind: "CURRENT_STATE",
      state: status, evidenceClass: "CURRENT_AUTHORITATIVE_STATE", title: "Current known state",
      description: `${status === "submitted" && order.error ? "Outcome remains unresolved; reconciliation is pending. " : ""}`
        + `This is the latest persisted snapshot, not proof of every transition before it.${order.error ? ` ${order.error}` : ""}`,
      source: "MANUAL", evidenceSource: "Bot ManualOrder.status + updatedAt",
      identifiers: currentIdentifiers, quantity: currentQuantity,
      linkageEvidenceClass: evidence?.identity.evidenceClass,
    }) : null,
  ]);

  const seenCommands = new Set<string>();
  for (const linked of evidence?.linkedCommands ?? []) {
    if (seenCommands.has(linked.identity.manualCommandId)) continue;
    seenCommands.add(linked.identity.manualCommandId);
    const identifiers: TimelineIdentifiers = {
      manualOrderId: evidence!.identity.manualOrderId,
      manualCommandId: linked.identity.manualCommandId,
      commandRequestId: linked.identity.commandRequestId,
      targetManualOrderId: linked.identity.targetManualOrderId,
    };
    const persisted = item({ key: `manual-command:${linked.identity.manualCommandId}:persisted`,
      timestamp: linked.event.occurredAt, kind: linked.event.type,
      state: linked.event.state, evidenceClass: linked.event.evidenceClass,
      title: "Cancel command persisted",
      description: "The Bot persisted a successful cancel command linked by the exact ManualOrder ID. This is not proof of exchange cancellation completion.",
      source: "MANUAL", evidenceSource: "Bot ManualCommand.createdAt + exact persisted result linkage",
      identifiers, linkageEvidenceClass: linked.identity.evidenceClass });
    const current = item({ key: `manual-command:${linked.identity.manualCommandId}:current`,
      timestamp: linked.currentState.observedAt, kind: "CANCEL_COMMAND_CURRENT_STATE",
      state: linked.currentState.commandStatus, evidenceClass: linked.currentState.evidenceClass,
      title: "Current cancel-command state",
      description: "This is the latest persisted command snapshot, not a separately persisted completion event.",
      source: "MANUAL", evidenceSource: "Bot ManualCommand.status + updatedAt",
      identifiers, linkageEvidenceClass: linked.identity.evidenceClass });
    if (persisted) items.push(persisted);
    if (current) items.push(current);
  }

  const gaps: string[] = [];
  if (!createdEvidence && !order.createdAt) gaps.push("Request creation time is unavailable for this older record.");
  if (status !== "requested" && !submittedEvidence && !order.submittedAt) {
    gaps.push("Submission-attempt time is unavailable.");
  }
  if ((order.filledBaseQty ?? 0) > 0) {
    gaps.push("Individual fills, commission history, and earlier cumulative fill snapshots are not exposed by the current manual read contract.");
  }
  if (status === "canceled") {
    if (seenCommands.size === 0) {
      gaps.push("A cancel-request timestamp is not exposed because no successful cancel command is exactly linked to this order.");
    } else {
      gaps.push("The linked cancel command has no distinct persisted command-completion timestamp.");
    }
    gaps.push("The Bot read contract folds exchange CANCELED and EXPIRED into canceled, so the exact terminal reason is unavailable.");
  }
  if (evidence?.linkedCommandsTruncated) gaps.push("Additional exactly linked cancel commands exist beyond the Bot's 10-command bound.");
  if (evidence) {
    const identifierConflicts = [
      ["request ID", originalOrder.requestId, evidence.identity.orderRequestId],
      ["client order ID", originalOrder.clientOrderId, evidence.identity.clientOrderId],
      ["exchange order ID", originalOrder.exchangeOrderId, evidence.identity.exchangeOrderId],
    ].filter(([, prior, current]) => prior != null && current != null && prior !== current);
    const terminalStates = new Set(["filled", "canceled", "rejected", "failed"]);
    const statusConflict = originalOrder.status != null
      && norm(originalOrder.status) !== norm(evidence.currentState.orderStatus)
      && terminalStates.has(norm(originalOrder.status))
      && terminalStates.has(norm(evidence.currentState.orderStatus));
    const conflicts = [...identifierConflicts.map(([name]) => name), ...(statusConflict ? ["status"] : [])];
    if (conflicts.length > 0) {
      gaps.push(`Conflicting authoritative manual snapshots were returned for ${conflicts.join(", ")}; values were not heuristically reconciled.`);
    }
  }
  if (terminal && !completedEvidence && !order.completedAt) {
    gaps.push("The terminal state is known, but its transition time is unavailable.");
  }
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

export interface LinkedStrategyExecutionEvidence {
  platformIntentId: number;
  evidence: StrategyExecutionEvidence;
}

export interface BotEvidenceLookupSummary {
  attempted: number;
  notFound: number;
  unavailable: number;
  omittedByBound: number;
  notConfigured?: boolean;
}

function botIdentifiers(link: LinkedStrategyExecutionEvidence,
  deploymentId: string, strategyId: string): TimelineIdentifiers {
  const identity = link.evidence.identity;
  return {
    deploymentId, strategyId, intentId: String(link.platformIntentId),
    strategyOrderIntentId: identity.strategyOrderIntentId,
    sourceKey: identity.sourceKey, callerDedupeKey: identity.callerDedupeKey,
    botId: identity.botId, clientOrderId: identity.clientOrderId,
  };
}

function botEventQuantity(event: BotEvidenceEvent): TimelineQuantity | undefined {
  const q = event.quantities;
  if (!q) return undefined;
  return {
    ...(q.baseQuantity != null ? { baseQuantity: q.baseQuantity } : {}),
    ...(q.quoteRevenue != null ? { quoteRevenue: q.quoteRevenue } : {}),
    ...(q.realizedPnlQuote != null ? { realizedPnlQuote: q.realizedPnlQuote } : {}),
    ...(q.averagePrice != null ? { averagePrice: q.averagePrice } : {}),
    ...(q.cumulativeExecutedBaseQuantity != null
      ? { cumulativeExecutedBaseQuantity: q.cumulativeExecutedBaseQuantity } : {}),
    ...(q.cumulativeExecutedQuoteQuantity != null
      ? { cumulativeExecutedQuoteQuantity: q.cumulativeExecutedQuoteQuantity } : {}),
    ...(q.averageFillPrice != null ? { averagePrice: q.averageFillPrice } : {}),
  };
}

function botStrategyItems(links: LinkedStrategyExecutionEvidence[], deploymentId: string,
  strategyId: string): TimelineItem[] {
  const output: TimelineItem[] = [];
  const partialCloseIds = new Set<string>();
  const strategyIntentIds = new Set<string>();
  for (const link of links) {
    if (strategyIntentIds.has(link.evidence.identity.strategyOrderIntentId)) continue;
    strategyIntentIds.add(link.evidence.identity.strategyOrderIntentId);
    const identifiers = botIdentifiers(link, deploymentId, strategyId);
    for (const event of link.evidence.events) {
      const partialCloseId = event.identifiers?.partialCloseId;
      if (partialCloseId && partialCloseIds.has(partialCloseId)) continue;
      if (partialCloseId) partialCloseIds.add(partialCloseId);
      const labels: Record<string, [string, string]> = {
        STRATEGY_INTENT_PERSISTED: ["Bot strategy intent persisted",
          "The Bot persisted the exact StrategyOrderIntent selected by Platform source identity."],
        SUBMISSION_ATTEMPTED: ["Bot submission attempted",
          "The Bot crossed its durable submission boundary. This does not prove exchange acceptance."],
        STRATEGY_INTENT_RESOLVED: ["Bot strategy intent resolved",
          "The Bot persisted this resolution and cumulative execution accounting at the recorded time."],
        STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED: ["Partial-close accounting applied",
          "The Bot persisted this exact linked PartialClose economic event; it is not an individual exchange fill."],
      };
      const [title, description] = labels[event.type]
        ?? ["Bot execution evidence persisted", "The Bot returned an exact persisted execution-evidence event."];
      const projected = item({
        key: partialCloseId ? `bot-partial-close:${partialCloseId}`
          : `bot-intent:${link.evidence.identity.strategyOrderIntentId}:${event.type}`,
        timestamp: event.occurredAt, kind: event.type, state: event.state,
        evidenceClass: event.evidenceClass, title, description, source: "AUTOMATED",
        evidenceSource: `Bot ${event.type} persisted event`,
        identifiers: { ...identifiers,
          ...(event.identifiers?.exchangeOrderId
            ? { exchangeOrderId: event.identifiers.exchangeOrderId } : {}),
          ...(partialCloseId ? { partialCloseId } : {}) },
        quantity: botEventQuantity(event), linkageEvidenceClass: link.evidence.identity.evidenceClass,
      });
      if (projected) output.push(projected);
    }
    const current = link.evidence.currentState;
    const projected = item({
      key: `bot-intent:${link.evidence.identity.strategyOrderIntentId}:current`,
      timestamp: current.observedAt, kind: "CURRENT_STATE",
      state: current.exchangeOrderStatus?.toLowerCase() ?? current.intentStatus,
      evidenceClass: current.evidenceClass, title: "Current Bot order state",
      description: "This is the latest persisted cumulative snapshot, not proof of unpersisted intermediate exchange transitions.",
      source: "AUTOMATED", evidenceSource: "Bot StrategyOrderIntent current state + updatedAt",
      identifiers: { ...identifiers,
        ...(link.evidence.identity.exchangeOrderId
          ? { exchangeOrderId: link.evidence.identity.exchangeOrderId } : {}) }, quantity: {
        cumulativeExecutedBaseQuantity: current.cumulativeExecutedBaseQuantity,
        cumulativeExecutedQuoteQuantity: current.cumulativeExecutedQuoteQuantity,
        ...(current.averageFillPrice != null ? { averagePrice: current.averageFillPrice } : {}),
      }, linkageEvidenceClass: link.evidence.identity.evidenceClass,
    });
    if (projected) output.push(projected);
  }
  return output;
}

const norm = (value: string | null | undefined): string => (value ?? "").toLowerCase();
const equalNumber = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-12;

function quantityCompatible(platformItem: TimelineItem, botQuantity: number | undefined): boolean {
  const platformQuantity = platformItem.quantity?.reportedQuantity;
  return platformQuantity === undefined || botQuantity === undefined
    || equalNumber(platformQuantity, botQuantity);
}

function duplicateExecution(botItems: TimelineItem[], links: LinkedStrategyExecutionEvidence[],
  platformItem: TimelineItem): boolean {
  if (platformItem.kind !== "EXECUTION_STATE_RECORDED" || !platformItem.identifiers.exchangeOrderId) return false;
  return botItems.some((bot) => bot.evidenceClass === "AUTHORITATIVE_HISTORICAL_EVENT"
    && bot.identifiers.exchangeOrderId === platformItem.identifiers.exchangeOrderId
    && bot.timestamp === platformItem.timestamp && norm(bot.state) === norm(platformItem.state)
    && quantityCompatible(platformItem, bot.quantity?.cumulativeExecutedBaseQuantity))
    || links.some((link) => link.evidence.identity.exchangeOrderId === platformItem.identifiers.exchangeOrderId
      && norm(link.evidence.currentState.exchangeOrderStatus) === norm(platformItem.state)
      && quantityCompatible(platformItem,
        link.evidence.currentState.cumulativeExecutedBaseQuantity)
      && link.evidence.events.some((event) => event.type === "STRATEGY_INTENT_RESOLVED"
        && event.occurredAt === platformItem.timestamp));
}

function automatedConflicts(executions: ExecutionEvidence[], links: LinkedStrategyExecutionEvidence[]): string[] {
  const terminalConflicts = new Set<string>();
  const quantityConflicts = new Set<string>();
  for (const link of links) {
    const exchangeOrderId = link.evidence.identity.exchangeOrderId;
    const botStatus = link.evidence.currentState.exchangeOrderStatus;
    if (!exchangeOrderId || !botStatus) continue;
    const terminal = executions.filter((row) => row.exchangeOrderId === exchangeOrderId
      && ["filled", "canceled", "rejected", "expired"].includes(norm(row.status)))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (terminal && norm(terminal.status) !== norm(botStatus)
        && Date.parse(link.evidence.currentState.observedAt) >= terminal.createdAt) {
      terminalConflicts.add(exchangeOrderId);
    }
    for (const row of executions.filter((candidate) => candidate.exchangeOrderId === exchangeOrderId
      && candidate.qty != null && norm(candidate.status) === norm(botStatus))) {
      const resolvedAtSameTime = link.evidence.events.some((event) =>
        event.type === "STRATEGY_INTENT_RESOLVED"
        && Date.parse(event.occurredAt) === row.createdAt);
      if (resolvedAtSameTime
          && !equalNumber(row.qty!, link.evidence.currentState.cumulativeExecutedBaseQuantity)) {
        quantityConflicts.add(exchangeOrderId);
      }
    }
  }
  return [
    ...[...terminalConflicts].map((id) =>
      `Conflicting authoritative terminal evidence exists for exchange order ${id}; both persisted observations are shown without guessing exchange truth.`),
    ...[...quantityConflicts].map((id) =>
      `Conflicting authoritative execution quantities exist for exchange order ${id}; both persisted observations are shown without guessing exchange truth.`),
  ];
}

export function projectDeploymentTimeline(input: {
  deployment: DeploymentRow;
  intents: OrderIntent[];
  alerts: AlertRow[];
  executions: ExecutionEvidence[];
  paperFills: PaperFillEvidence[];
  limit: number;
  sourceWindowFull?: boolean;
  botEvidence?: LinkedStrategyExecutionEvidence[];
  botLookup?: BotEvidenceLookupSummary;
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

  const botItems = botStrategyItems(input.botEvidence ?? [], deployment.id, strategyId);
  items.push(...executionItems(input.executions, source, deployment.id, strategyId)
    .filter((candidate) => !duplicateExecution(botItems, input.botEvidence ?? [], candidate)));
  items.push(...botItems);
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
  if (deployment.delivery === "custom") {
    if (input.botLookup?.notConfigured) {
      gaps.push("Bot execution-evidence enrichment is not configured for this deployment; existing Platform evidence remains shown.");
    }
    if ((input.botLookup?.unavailable ?? 0) > 0) {
      gaps.push("Bot execution-evidence enrichment was unavailable for some exact intents; existing Platform evidence remains shown.");
    }
    if ((input.botLookup?.notFound ?? 0) > 0) {
      gaps.push("Some exact Platform source identities had no persisted Bot StrategyOrderIntent; no heuristic correlation was attempted.");
    }
    if ((input.botLookup?.omittedByBound ?? 0) > 0) {
      gaps.push(`Bot enrichment is bounded to the newest exact intents; ${input.botLookup!.omittedByBound} older intent lookup(s) were not requested.`);
    }
    if ((input.botEvidence?.length ?? 0) > 0) {
      gaps.push("The Bot does not persist individual exchange fills, commission history, or earlier cumulative snapshots for these strategy intents.");
    }
  }
  if (deployment.delivery === "3commas" && input.executions.length === 0) {
    gaps.push("3Commas/exchange order and fill lifecycle is not persisted in Platform for this deployment.");
  }
  if (input.alerts.some((alert) => ["failed", "blocked"].includes(alert.deliveryStatus)
      && !input.intents.some((intent) => intent.alertId === alert.id && intent.resolvedAt))) {
    gaps.push("Some legacy delivery outcomes have no trustworthy outcome timestamp and are therefore omitted as historical events.");
  }
  if (bounded.length === 0) gaps.push("No persisted order or fill evidence exists for this deployment.");
  gaps.push(...automatedConflicts(input.executions, input.botEvidence ?? []));

  const pending = input.intents.some((intent) => intent.state === "pending");
  const latestExecution = [...input.executions].sort((a, b) => b.createdAt - a.createdAt)[0];
  const latestBot = [...(input.botEvidence ?? [])].sort((a, b) =>
    Date.parse(b.evidence.currentState.observedAt) - Date.parse(a.evidence.currentState.observedAt))[0];
  const hasConflict = automatedConflicts(input.executions, input.botEvidence ?? []).length > 0;
  return {
    scope: { kind: "deployment", id: deployment.id, source, symbol: deployment.symbol,
      side: null, executionMode: deployment.delivery === "paper" ? "PAPER · simulated; no exchange order"
        : deployment.delivery === "off" ? "SIGNAL ONLY · no order sent" : `${deployment.delivery.toUpperCase()} · live delivery`,
      delivery: deployment.delivery, strategyId, configId: deployment.configId },
    finalKnownState: hasConflict ? "conflicting evidence" : pending ? "reconciling"
      : latestBot?.evidence.currentState.exchangeOrderStatus
        ?? latestBot?.evidence.currentState.intentStatus ?? latestExecution?.status ?? null,
    items: bounded, gaps, truncated,
  };
}
