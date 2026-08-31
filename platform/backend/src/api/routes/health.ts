import type { FastifyInstance } from "fastify";
import { query } from "../../db/pool";
import { requiredMigrationFiles } from "../../db/migrate";

interface HealthDependencies {
  query: (sql: string) => Promise<{ rows: Array<{ filename?: string }> }>;
  requiredMigrations: () => string[];
}

const defaultDependencies: HealthDependencies = {
  query: (sql) => query(sql),
  requiredMigrations: requiredMigrationFiles,
};

export async function healthRoutes(
  app: FastifyInstance,
  deps: HealthDependencies = defaultDependencies
): Promise<void> {
  /** Cheap process liveness. It deliberately does not touch the database. */
  const live = async () => ({ ok: true, time: new Date().toISOString() });
  app.get("/health", live);
  app.get("/healthz", live);

  /**
   * Application readiness. A process is ready only when it can reach its
   * database and that database has every migration shipped in this build.
   * Feed and emitter state remain operational signals: disabling live trading
   * does not make the chart/backtest application unready.
   */
  app.get("/readyz", async (_req, reply) => {
    try {
      await deps.query("SELECT 1");
    } catch {
      return reply.code(503).send({
        ready: false,
        checks: { database: "unavailable", schema: "unknown" },
        time: new Date().toISOString(),
      });
    }

    let expected: string[];
    let applied: string[];
    try {
      expected = deps.requiredMigrations();
      const result = await deps.query("SELECT filename FROM schema_migrations");
      applied = result.rows
        .map((row) => row.filename)
        .filter((filename): filename is string => typeof filename === "string");
    } catch {
      return reply.code(503).send({
        ready: false,
        checks: { database: "ok", schema: "unavailable" },
        time: new Date().toISOString(),
      });
    }

    const appliedSet = new Set(applied);
    const missing = expected.filter((filename) => !appliedSet.has(filename));
    if (missing.length > 0) {
      return reply.code(503).send({
        ready: false,
        checks: { database: "ok", schema: "behind" },
        schema: { expected: expected.length, applied: applied.length, missing },
        time: new Date().toISOString(),
      });
    }

    return {
      ready: true,
      checks: { database: "ok", schema: "current" },
      schema: { expected: expected.length, applied: applied.length, missing: [] },
      time: new Date().toISOString(),
    };
  });
}
