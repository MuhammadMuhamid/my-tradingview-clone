import type { DeploymentRow } from "../types/deployments";
import type { OrderIntent } from "../repositories/liveSafety";
import { validateWebhookUrl } from "../alerts/dispatcher";
import { ManualBotError, manualBotRequest } from "../manualTrading/client";

export type BotEvidenceClass =
  | "AUTHORITATIVE_HISTORICAL_EVENT"
  | "CURRENT_AUTHORITATIVE_STATE"
  | "AUTHORITATIVE_LINKAGE";

export interface BotEvidenceEvent {
  evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT";
  type: string;
  occurredAt: string;
  state?: string;
  identifiers?: Record<string, string>;
  quantities?: Record<string, number>;
}

export interface StrategyExecutionEvidence {
  evidenceType: "STRATEGY_ORDER_INTENT";
  identity: {
    evidenceClass: "AUTHORITATIVE_LINKAGE";
    strategyOrderIntentId: string;
    sourceKey: string;
    callerDedupeKey: string;
    botId: string;
    clientOrderId: string;
    exchangeOrderId: string | null;
  };
  order: {
    symbol: string; side: string; orderType: string;
    requestedBaseQuantity: number | null; requestedQuoteQuantity: number | null;
    sellPercent: number | null; exitLeg: string | null; simulated: boolean;
  };
  events: BotEvidenceEvent[];
  currentState: {
    evidenceClass: "CURRENT_AUTHORITATIVE_STATE";
    intentStatus: string; exchangeOrderStatus: string | null;
    cumulativeExecutedBaseQuantity: number; cumulativeExecutedQuoteQuantity: number;
    averageFillPrice: number | null; observedAt: string;
  };
  limitations: string[];
}

export interface ManualExecutionEvidence {
  evidenceType: "MANUAL_ORDER";
  identity: {
    evidenceClass: "AUTHORITATIVE_LINKAGE";
    manualOrderId: string; orderRequestId: string; clientOrderId: string;
    exchangeOrderId: string | null;
  };
  order: {
    symbol: string; side: string; orderType: string; quantityType: string;
    requestedBaseQuantity: number | null; requestedQuoteQuantity: number | null;
    limitPrice: number | null;
  };
  events: BotEvidenceEvent[];
  currentState: {
    evidenceClass: "CURRENT_AUTHORITATIVE_STATE";
    orderStatus: string; cumulativeExecutedBaseQuantity: number;
    cumulativeExecutedQuoteQuantity: number; averageFillPrice: number | null;
    observedAt: string;
  };
  linkedCommands: Array<{
    identity: {
      evidenceClass: "AUTHORITATIVE_LINKAGE";
      manualCommandId: string; commandRequestId: string; targetManualOrderId: string;
    };
    event: BotEvidenceEvent;
    currentState: {
      evidenceClass: "CURRENT_AUTHORITATIVE_STATE";
      commandStatus: string; observedAt: string;
    };
  }>;
  linkedCommandsTruncated: boolean;
  limitations: string[];
}

export type EvidenceRead<T> =
  | { state: "FOUND"; evidence: T }
  | { state: "NOT_FOUND" }
  | { state: "NOT_CONFIGURED" }
  | { state: "UNAVAILABLE" };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableFinite = (value: unknown): value is number | null => value === null || finite(value);
const stringMap = (value: unknown): value is Record<string, string> =>
  record(value) && Object.values(value).every(text);
const numberMap = (value: unknown): value is Record<string, number> =>
  record(value) && Object.values(value).every(finite);
const normalizeBotSymbol = (raw: string): string => {
  const upper = raw.trim().toUpperCase();
  const colon = upper.lastIndexOf(":");
  return (colon >= 0 ? upper.slice(colon + 1) : upper).replace(/[/-]/g, "");
};

function evidenceEvent(value: unknown): value is BotEvidenceEvent {
  if (!record(value) || value.evidenceClass !== "AUTHORITATIVE_HISTORICAL_EVENT"
      || !text(value.type) || !text(value.occurredAt)) return false;
  return (value.state === undefined || text(value.state))
    && (value.identifiers === undefined || stringMap(value.identifiers))
    && (value.quantities === undefined || numberMap(value.quantities));
}

export function isStrategyExecutionEvidence(value: unknown): value is StrategyExecutionEvidence {
  if (!record(value) || value.evidenceType !== "STRATEGY_ORDER_INTENT"
      || !record(value.identity) || value.identity.evidenceClass !== "AUTHORITATIVE_LINKAGE"
      || !text(value.identity.strategyOrderIntentId) || !text(value.identity.sourceKey)
      || !text(value.identity.callerDedupeKey) || !text(value.identity.botId)
      || !text(value.identity.clientOrderId) || !nullableText(value.identity.exchangeOrderId)
      || !record(value.order) || !text(value.order.symbol) || !text(value.order.side)
      || !text(value.order.orderType) || !nullableFinite(value.order.requestedBaseQuantity)
      || !nullableFinite(value.order.requestedQuoteQuantity) || !nullableFinite(value.order.sellPercent)
      || !nullableText(value.order.exitLeg) || typeof value.order.simulated !== "boolean"
      || !Array.isArray(value.events) || !value.events.every(evidenceEvent)
      || !record(value.currentState) || value.currentState.evidenceClass !== "CURRENT_AUTHORITATIVE_STATE"
      || !text(value.currentState.intentStatus) || !nullableText(value.currentState.exchangeOrderStatus)
      || !finite(value.currentState.cumulativeExecutedBaseQuantity)
      || !finite(value.currentState.cumulativeExecutedQuoteQuantity)
      || !nullableFinite(value.currentState.averageFillPrice) || !text(value.currentState.observedAt)) return false;
  return Array.isArray(value.limitations) && value.limitations.every(text);
}

export function isManualExecutionEvidence(value: unknown): value is ManualExecutionEvidence {
  if (!record(value) || value.evidenceType !== "MANUAL_ORDER" || !record(value.identity)
      || value.identity.evidenceClass !== "AUTHORITATIVE_LINKAGE"
      || !text(value.identity.manualOrderId) || !text(value.identity.orderRequestId)
      || !text(value.identity.clientOrderId) || !nullableText(value.identity.exchangeOrderId)
      || !record(value.order) || !text(value.order.symbol) || !text(value.order.side)
      || !text(value.order.orderType) || !text(value.order.quantityType)
      || !nullableFinite(value.order.requestedBaseQuantity)
      || !nullableFinite(value.order.requestedQuoteQuantity) || !nullableFinite(value.order.limitPrice)
      || !Array.isArray(value.events) || !value.events.every(evidenceEvent)
      || !record(value.currentState) || value.currentState.evidenceClass !== "CURRENT_AUTHORITATIVE_STATE"
      || !text(value.currentState.orderStatus)
      || !finite(value.currentState.cumulativeExecutedBaseQuantity)
      || !finite(value.currentState.cumulativeExecutedQuoteQuantity)
      || !nullableFinite(value.currentState.averageFillPrice) || !text(value.currentState.observedAt)
      || !Array.isArray(value.linkedCommands) || typeof value.linkedCommandsTruncated !== "boolean"
      || !Array.isArray(value.limitations) || !value.limitations.every(text)) return false;
  return value.linkedCommands.every((linked) => record(linked) && record(linked.identity)
    && linked.identity.evidenceClass === "AUTHORITATIVE_LINKAGE"
    && text(linked.identity.manualCommandId) && text(linked.identity.commandRequestId)
    && text(linked.identity.targetManualOrderId) && evidenceEvent(linked.event)
    && record(linked.currentState) && linked.currentState.evidenceClass === "CURRENT_AUTHORITATIVE_STATE"
    && text(linked.currentState.commandStatus) && text(linked.currentState.observedAt));
}

export function strategyEvidenceUrl(
  deployment: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">
): string | null {
  if (deployment.delivery !== "custom" || !deployment.webhookUrl || !deployment.secret) return null;
  try {
    const url = new URL(deployment.webhookUrl);
    if (!/\/signal_bots\/?$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/signal_bots\/?$/, "/signal_bots/execution-evidence");
    return validateWebhookUrl(url.toString());
  } catch { return null; }
}

export async function readStrategyExecutionEvidence(
  deployment: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret" | "symbol">,
  intent: Pick<OrderIntent, "action" | "dedupeKey">,
  fetchImpl: typeof fetch = fetch
): Promise<EvidenceRead<StrategyExecutionEvidence>> {
  const url = strategyEvidenceUrl(deployment);
  if (!url || !deployment.secret) return { state: "NOT_CONFIGURED" };
  const body = { secret: deployment.secret, symbol: deployment.symbol,
    action: intent.action, dedupe_key: intent.dedupeKey };
  try {
    const response = await fetchImpl(url, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000) });
    if (response.status === 404) return { state: "NOT_FOUND" };
    if (!response.ok) return { state: "UNAVAILABLE" };
    const evidence: unknown = await response.json();
    const normalizedSymbol = normalizeBotSymbol(deployment.symbol);
    const sourceSuffix = `:${normalizedSymbol}:${intent.action}:${intent.dedupeKey}`;
    if (!isStrategyExecutionEvidence(evidence)
        || evidence.identity.callerDedupeKey !== intent.dedupeKey
        || !evidence.identity.sourceKey.endsWith(sourceSuffix)
        || evidence.order.side.toLowerCase() !== intent.action
        || normalizeBotSymbol(evidence.order.symbol)
          !== normalizedSymbol) return { state: "UNAVAILABLE" };
    return { state: "FOUND", evidence };
  } catch { return { state: "UNAVAILABLE" }; }
}

export async function readManualExecutionEvidence(
  orderId: string, fetchImpl: typeof fetch = fetch
): Promise<EvidenceRead<ManualExecutionEvidence>> {
  try {
    const evidence = await manualBotRequest<unknown>({ method: "POST",
      path: "/api/manual-trading/execution-evidence/manual-orders/lookup", body: { orderId } }, fetchImpl);
    if (!isManualExecutionEvidence(evidence) || evidence.identity.manualOrderId !== orderId
        || evidence.linkedCommands.some((linked) =>
          linked.identity.targetManualOrderId !== orderId)) {
      return { state: "UNAVAILABLE" };
    }
    return { state: "FOUND", evidence };
  } catch (error) {
    if (error instanceof ManualBotError && error.status === 404) return { state: "NOT_FOUND" };
    if (error instanceof ManualBotError && /disabled/i.test(error.message)) return { state: "NOT_CONFIGURED" };
    return { state: "UNAVAILABLE" };
  }
}
