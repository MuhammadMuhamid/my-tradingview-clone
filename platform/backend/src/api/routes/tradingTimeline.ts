import type { FastifyInstance } from "fastify";
import { ManualBotError, manualBotRequest } from "../../manualTrading/client";
import * as deploymentRepo from "../../repositories/deployments";
import * as alertRepo from "../../repositories/alerts";
import * as liveSafetyRepo from "../../repositories/liveSafety";
import * as executionRepo from "../../repositories/executions";
import * as paperRepo from "../../repositories/paperFills";
import type { DeploymentRow } from "../../types/deployments";
import type { OrderIntent } from "../../repositories/liveSafety";
import {
  projectDeploymentTimeline, projectManualOrder, type ManualAccountEvidence,
  type ManualOrderEvidence,
} from "../../timeline/projection";
import {
  readManualExecutionEvidence, readStrategyExecutionEvidence, strategyEvidenceUrl,
  type ManualExecutionEvidence,
} from "../../timeline/botEvidenceClient";

export const MAX_TIMELINE_ITEMS = 100;
export const DEFAULT_TIMELINE_ITEMS = 50;
export const MAX_AUTOMATED_BOT_EVIDENCE_LOOKUPS = 10;

export function parseTimelineLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_TIMELINE_ITEMS;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TIMELINE_ITEMS ? parsed : null;
}

interface ManualStateEvidence {
  dryRun?: boolean;
  accounts?: ManualAccountEvidence[];
  orders?: ManualOrderEvidence[];
}

function manualOrderFromEvidence(evidence: ManualExecutionEvidence): ManualOrderEvidence {
  return {
    id: evidence.identity.manualOrderId,
    requestId: evidence.identity.orderRequestId,
    clientOrderId: evidence.identity.clientOrderId,
    exchangeOrderId: evidence.identity.exchangeOrderId,
    symbol: evidence.order.symbol,
    side: evidence.order.side,
    orderType: evidence.order.orderType,
    status: evidence.currentState.orderStatus,
    requestedBaseQty: evidence.order.requestedBaseQuantity,
    requestedQuoteQty: evidence.order.requestedQuoteQuantity,
    limitPrice: evidence.order.limitPrice,
    filledBaseQty: evidence.currentState.cumulativeExecutedBaseQuantity,
    filledQuoteQty: evidence.currentState.cumulativeExecutedQuoteQuantity,
    averageFillPrice: evidence.currentState.averageFillPrice,
    updatedAt: evidence.currentState.observedAt,
  };
}

export function automatedBotEvidenceIntents(
  deployment: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">,
  intents: OrderIntent[]
): OrderIntent[] {
  return deployment.delivery === "custom" && strategyEvidenceUrl(deployment)
    ? intents.slice(0, MAX_AUTOMATED_BOT_EVIDENCE_LOOKUPS) : [];
}

export async function tradingTimelineRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/trading-timeline/manual-orders/:id", async (req, reply) => {
    // Both reads are bounded and occur only for one explicitly opened order timeline.
    // The older state snapshot remains a fallback when the richer exact lookup fails.
    const [stateResult, evidenceResult] = await Promise.allSettled([
      manualBotRequest<ManualStateEvidence>({ method: "GET", path: "/api/manual-trading/state" }),
      readManualExecutionEvidence(req.params.id),
    ]);
    const state = stateResult.status === "fulfilled" ? stateResult.value : undefined;
    const evidenceRead = evidenceResult.status === "fulfilled" ? evidenceResult.value : undefined;
    const botEvidence = evidenceRead?.state === "FOUND" ? evidenceRead.evidence : undefined;
    const order = (Array.isArray(state?.orders)
      ? state.orders.find((candidate) => candidate.id === req.params.id) : undefined)
      ?? (botEvidence ? manualOrderFromEvidence(botEvidence) : undefined);
    if (order) return projectManualOrder({ order, accounts: state?.accounts,
      dryRun: state?.dryRun, botEvidence });
    if (stateResult.status === "rejected" && stateResult.reason instanceof ManualBotError) {
      return reply.code(stateResult.reason.status).send({ error: stateResult.reason.message });
    }
    if (stateResult.status === "rejected") {
      return reply.code(503).send({ error: "manual timeline evidence is unavailable" });
    }
    return reply.code(404).send({ error: "manual order not found in the bounded Bot read contracts" });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/trading-timeline/deployments/:id",
    async (req, reply) => {
      const limit = parseTimelineLimit(req.query.limit);
      if (limit === null) {
        return reply.code(400).send({ error: `limit must be an integer from 1 to ${MAX_TIMELINE_ITEMS}` });
      }
      const deployment = await deploymentRepo.getDeployment(req.params.id);
      if (!deployment) return reply.code(404).send({ error: "deployment not found" });
      const fetchLimit = Math.min(MAX_TIMELINE_ITEMS, limit + 1);
      const [intents, alerts, executions, paperFills] = await Promise.all([
        liveSafetyRepo.listOrderIntents(deployment.id, fetchLimit),
        alertRepo.listAlerts({ deploymentId: deployment.id, limit: fetchLimit }),
        executionRepo.listByDeployment(deployment.id, fetchLimit),
        deployment.delivery === "paper" ? paperRepo.listFills(deployment.id, fetchLimit) : Promise.resolve([]),
      ]);
      const sourceWindowFull = [intents, alerts, executions, paperFills]
        .some((evidence) => evidence.length === fetchLimit);
      const exactIntents = automatedBotEvidenceIntents(deployment, intents);
      const botConfigured = deployment.delivery === "custom" && Boolean(strategyEvidenceUrl(deployment));
      const botReads = await Promise.all(exactIntents.map(async (intent) => ({
        intent, result: await readStrategyExecutionEvidence(deployment, intent),
      })));
      const botEvidence = botReads.flatMap(({ intent, result }) => result.state === "FOUND"
        ? [{ platformIntentId: intent.id, evidence: result.evidence }] : []);
      const botLookup = {
        attempted: botReads.length,
        notFound: botReads.filter(({ result }) => result.state === "NOT_FOUND").length,
        unavailable: botReads.filter(({ result }) => result.state === "UNAVAILABLE").length,
        omittedByBound: botConfigured ? Math.max(0, intents.length - exactIntents.length) : 0,
        notConfigured: deployment.delivery === "custom" && !botConfigured,
      };
      return projectDeploymentTimeline({
        deployment, intents, alerts, executions, paperFills, limit, sourceWindowFull,
        botEvidence, botLookup,
      });
    }
  );
}
