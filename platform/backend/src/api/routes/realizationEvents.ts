import type { FastifyInstance } from "fastify";
import { config } from "../../config";
import { normalizeRealizationBatch } from "../../contract/realizationEventContract";
import { pool } from "../../db/pool";
import { verifyRealizationRequest } from "../../realizations/auth";
import {
  ingestRealizationBatch, RealizationCorrelationError, RealizationIntegrityConflict,
  reserveRealizationNonce,
} from "../../realizations/ingestion";
import type { PoolClient } from "pg";

const PATH = "/api/internal/realization-events/v1";

export async function realizationEventRoutes(
  app: FastifyInstance,
  dependencies: { connect?: () => Promise<PoolClient> } = {}
): Promise<void> {
  app.post(PATH, { bodyLimit: 128 * 1024 }, async (req, reply) => {
    if (!config.realizationIngestionEnabled) return reply.code(404).send({ error: "not found" });
    const auth = verifyRealizationRequest({ secret: config.realizationHmacSecret,
      method: req.method, path: PATH, body: req.body,
      timestamp: req.headers["x-realization-timestamp"] as string | undefined,
      nonce: req.headers["x-realization-nonce"] as string | undefined,
      requestId: req.headers["x-realization-request-id"] as string | undefined,
      signature: req.headers["x-realization-signature"] as string | undefined });
    if (!auth.ok) return reply.code(401).send({ error: auth.error });
    let batch;
    try { batch = normalizeRealizationBatch(req.body); }
    catch { return reply.code(400).send({ error: "invalid realization batch" }); }

    const client = dependencies.connect ? await dependencies.connect() : await pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await reserveRealizationNonce(client, auth.nonce, auth.expiresAt))) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "realization nonce was already used" });
      }
      const acceptedEventIds = await ingestRealizationBatch(client, batch);
      await client.query("COMMIT");
      return reply.send({ status: "accepted", acceptedEventIds });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof RealizationIntegrityConflict) {
        return reply.code(409).send({ error: "realization event integrity conflict" });
      }
      if (error instanceof RealizationCorrelationError) {
        return reply.code(422).send({ error: "realization provenance is not valid" });
      }
      throw error;
    } finally { client.release(); }
  });
}
