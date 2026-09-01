import type { FastifyInstance } from "fastify";
import { ManualBotError, manualBotRequest } from "../../manualTrading/client";
import * as deploymentRepo from "../../repositories/deployments";
import * as alertRepo from "../../repositories/alerts";
import * as liveSafetyRepo from "../../repositories/liveSafety";
import * as executionRepo from "../../repositories/executions";
import * as paperRepo from "../../repositories/paperFills";
import {
  projectDeploymentTimeline, projectManualOrder, type ManualAccountEvidence,
  type ManualOrderEvidence,
} from "../../timeline/projection";

export const MAX_TIMELINE_ITEMS = 100;
export const DEFAULT_TIMELINE_ITEMS = 50;

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

export async function tradingTimelineRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/trading-timeline/manual-orders/:id", async (req, reply) => {
    try {
      // The existing Bot state contract is already bounded to 100 rows. This
      // endpoint projects one exact row and does not cache or duplicate it.
      const state = await manualBotRequest<ManualStateEvidence>({
        method: "GET", path: "/api/manual-trading/state",
      });
      const order = Array.isArray(state.orders)
        ? state.orders.find((candidate) => candidate.id === req.params.id)
        : undefined;
      if (!order) return reply.code(404).send({ error: "manual order not found in the bounded Bot read contract" });
      return projectManualOrder({ order, accounts: state.accounts, dryRun: state.dryRun });
    } catch (error) {
      if (error instanceof ManualBotError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
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
      return projectDeploymentTimeline({
        deployment, intents, alerts, executions, paperFills, limit, sourceWindowFull,
      });
    }
  );
}
