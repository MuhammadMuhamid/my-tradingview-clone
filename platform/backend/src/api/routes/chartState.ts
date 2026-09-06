/**
 * Chart state: a user's drawings, and the studies applied to each pane.
 *
 * ── The one rule, at the HTTP boundary ─────────────────────────────────────
 *
 * A write carries `baseVersion`: the version the client last read. If the
 * stored version has moved on, the write is refused with 409 and the response
 * body IS the current state — not an error the client has to go and fetch
 * around. That is deliberate: a conflict is not a failure, it is news, and a
 * client that must make a second request to learn what happened is a client
 * that will sometimes not make it.
 *
 * A 409 is therefore an ordinary outcome and the frontend treats it as one:
 * adopt what came back, then decide whether to write again.
 */
import type { FastifyInstance } from "fastify";
import * as chartState from "../../repositories/chartState";

/** Reject a payload before it reaches the database, with the reason. */
const listOr400 = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

const baseVersionOf = (v: unknown): number => {
  const n = Number(v);
  // Absent means "I believe nothing is stored", which is how a first write and
  // a one-time import both arrive.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export async function chartStateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/chart-state/drawings/:symbol", async (req) => {
    const { symbol } = req.params as { symbol: string };
    return chartState.getDrawings(symbol);
  });

  app.put("/api/chart-state/drawings/:symbol", async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const b = req.body as { drawings?: unknown; baseVersion?: unknown };
    const drawings = listOr400(b?.drawings);
    if (!drawings) return reply.code(400).send({ error: "drawings must be a list" });
    if (drawings.length > chartState.MAX_ITEMS) {
      return reply.code(400).send({
        error: `a chart may hold at most ${chartState.MAX_ITEMS} drawings`,
      });
    }
    const result = await chartState.putDrawings(symbol, drawings, baseVersionOf(b?.baseVersion));
    if (chartState.isConflict(result)) return reply.code(409).send(result.current);
    return result;
  });

  app.get("/api/chart-state/panes", async () => chartState.listPaneStudies());

  app.get("/api/chart-state/panes/:scope", async (req, reply) => {
    const { scope } = req.params as { scope: string };
    try {
      return await chartState.getPaneStudies(scope);
    } catch {
      return reply.code(400).send({ error: "invalid pane scope" });
    }
  });

  /*
   * Either half may be omitted, and an omitted half is left alone.
   *
   * A pane's Pine studies and its built-in studies are owned by two different
   * hooks. A writer that has nothing to say about the other half must not be
   * able to erase it — which is exactly what sending `pine: []` from the
   * native hook did.
   */
  app.put("/api/chart-state/panes/:scope", async (req, reply) => {
    const { scope } = req.params as { scope: string };
    const b = req.body as { pine?: unknown; native?: unknown; baseVersion?: unknown };
    if (b?.pine === undefined && b?.native === undefined) {
      return reply.code(400).send({ error: "a write must carry pine, native, or both" });
    }
    const pine = b?.pine === undefined ? undefined : listOr400(b.pine);
    const native = b?.native === undefined ? undefined : listOr400(b.native);
    if (pine === null || native === null) {
      return reply.code(400).send({ error: "pine and native must be lists when present" });
    }
    if ((pine?.length ?? 0) + (native?.length ?? 0) > chartState.MAX_ITEMS) {
      return reply.code(400).send({
        error: `a pane may hold at most ${chartState.MAX_ITEMS} studies`,
      });
    }
    try {
      const result = await chartState.putPaneStudies(
        scope, pine, native, baseVersionOf(b?.baseVersion));
      if (chartState.isConflict(result)) return reply.code(409).send(result.current);
      return result;
    } catch {
      return reply.code(400).send({ error: "invalid pane scope" });
    }
  });

  /** Instruments with drawings stored — what the one-time import reads first. */
  app.get("/api/chart-state/instruments", async () => chartState.listDrawnInstruments());
}
