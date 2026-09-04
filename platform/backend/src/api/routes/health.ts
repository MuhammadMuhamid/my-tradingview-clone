import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { query } from "../../db/pool";
import { requiredMigrationFiles } from "../../db/migrate";

interface HealthDependencies {
  query: (sql: string) => Promise<{ rows: Array<{ filename?: string }> }>;
  requiredMigrations: () => string[];
}

export type ReadinessStatus =
  | {
      ready: true;
      checks: { database: "ok"; schema: "current" };
      schema: { expected: number; applied: number; missing: string[] };
      time: string;
    }
  | {
      ready: false;
      checks: {
        database: "unavailable" | "ok";
        schema: "unknown" | "unavailable" | "behind";
      };
      schema?: { expected: number; applied: number; missing: string[] };
      time: string;
    };

const defaultDependencies: HealthDependencies = {
  query: (sql) => query(sql),
  requiredMigrations: requiredMigrationFiles,
};

/** The existing readiness proof, reusable by read-only operational views. */
export async function readReadiness(
  deps: HealthDependencies = defaultDependencies
): Promise<ReadinessStatus> {
  const time = new Date().toISOString();
  try {
    await deps.query("SELECT 1");
  } catch {
    return {
      ready: false,
      checks: { database: "unavailable", schema: "unknown" },
      time,
    };
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
    return {
      ready: false,
      checks: { database: "ok", schema: "unavailable" },
      time,
    };
  }

  const appliedSet = new Set(applied);
  const missing = expected.filter((filename) => !appliedSet.has(filename));
  return missing.length > 0
    ? {
        ready: false,
        checks: { database: "ok", schema: "behind" },
        schema: { expected: expected.length, applied: applied.length, missing },
        time,
      }
    : {
        ready: true,
        checks: { database: "ok", schema: "current" },
        schema: { expected: expected.length, applied: applied.length, missing: [] },
        time,
      };
}

export async function registerHealthRoutes(
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
    const status = await readReadiness(deps);
    return status.ready ? status : reply.code(503).send(status);
  });
}

/** Fastify-compatible production plugin; tests inject dependencies above. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  await registerHealthRoutes(app);
};
