/**
 * Shariah review/publication and immutable-snapshot HTTP boundary.
 *
 * Every route here sits behind the server's global session gate
 * (`api/server.ts`): none of these paths is in `PUBLIC_PATHS`, so an
 * unauthenticated request is refused before it reaches this file. That is
 * deliberate for the read routes too — the snapshot contract is authenticated
 * exactly like the rest of the private Platform API.
 *
 * Two audiences, one boundary:
 *
 * - The private operator (the review UI at `/shariah`) reads the universe,
 *   records evidence, and PUBLISHES decisions.
 * - Future Research/Backtester integration reads snapshots. `GET
 *   /api/shariah/snapshots`, `/latest` and `/:snapshotId` are that stable
 *   contract: snapshot identity, policy version, content hash, and the frozen
 *   membership. Research stores the snapshot id + content hash in its run
 *   provenance and never opens a second connection to Platform's PostgreSQL.
 *   SH-2 does not modify Research; it only makes the contract available.
 *
 * No route here classifies anything. Publication carries the operator's own
 * decision, and the service refuses incomplete ones.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../../config";
import { pool } from "../../db/pool";
import {
  SESSION_COOKIE, readCookie, verifySession,
} from "../../security/session";
import * as shariah from "../../repositories/shariah";
import { TS_SHARIAH_V1, PROHIBITED_CATEGORIES, type Classification } from "../../shariah/policy";
import {
  ShariahPublicationError, assertPublishableDecision, publishShariahDecision,
  type PublishShariahDecisionInput,
} from "../../shariah/publication";
import { createShariahUniverseSnapshot } from "../../shariah/snapshot";
import type { PoolClient } from "pg";

/**
 * Who is publishing. The global session gate has already established that a
 * valid session exists when auth is on; this re-reads the claims because the
 * published_by field is an audit fact and must come from the signed cookie,
 * never from the request body.
 */
function operatorIdentity(req: FastifyRequest): string | null {
  if (!config.authEnabled) return "local-operator";
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const claims = token
    ? verifySession(token, config.sessionSecret, { expectedUsername: config.adminUsername })
    : null;
  return claims?.username ?? null;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

const isDigits = (v: string): boolean => /^[0-9]+$/.test(v);

export async function shariahRoutes(
  app: FastifyInstance,
  dependencies: { connect?: () => Promise<PoolClient> } = {}
): Promise<void> {
  const connect = dependencies.connect ?? (() => pool.connect());

  /** The whole registry, including delisted assets (`binanceAvailable: false`). */
  app.get("/api/shariah/universe", async () => {
    const assets = await shariah.listAllAssets();
    return {
      policyVersion: TS_SHARIAH_V1,
      prohibitedCategories: PROHIBITED_CATEGORIES,
      counts: {
        total: assets.length,
        active: assets.filter((a) => a.binanceAvailable).length,
        eligible: assets.filter((a) => a.binanceAvailable && a.effectiveStatus === "ELIGIBLE").length,
        review: assets.filter((a) => a.binanceAvailable && a.effectiveStatus === "REVIEW").length,
        excluded: assets.filter((a) => a.binanceAvailable && a.effectiveStatus === "EXCLUDED").length,
      },
      assets,
    };
  });

  /** One asset with the facts a reviewer needs: evidence, and the full immutable decision history. */
  app.get("/api/shariah/assets/:assetId", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    if (!isDigits(assetId)) return reply.code(400).send({ error: "assetId must be numeric" });
    const asset = await shariah.getAssetById(assetId);
    if (!asset) return reply.code(404).send({ error: "asset not found" });
    const [evidence, publications] = await Promise.all([
      shariah.listEvidence(assetId),
      shariah.listPublications(assetId),
    ]);
    return { asset, evidence, publications };
  });

  /**
   * Records a factual evidence note against an asset. Source material only —
   * this is not a verdict, carries no score, and fetches nothing itself.
   */
  app.post("/api/shariah/assets/:assetId/evidence", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    if (!isDigits(assetId)) return reply.code(400).send({ error: "assetId must be numeric" });
    if (!(await shariah.getAssetById(assetId))) {
      return reply.code(404).send({ error: "asset not found" });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown): string | null => {
      const s = typeof v === "string" ? v.trim() : "";
      return s.length > 0 ? s : null;
    };
    const record = await shariah.addEvidence({
      assetId,
      url: text(b.url),
      title: text(b.title),
      publisher: text(b.publisher),
      retrievedAt: text(b.retrievedAt),
      excerpt: text(b.excerpt),
    });
    return reply.code(201).send(record);
  });

  /**
   * PUBLISH. The single deliberate act that can move an asset to SCREENED and
   * give it a public classification.
   *
   * There is no companion "reconfirm" or "set status" route: an UNSCREENED or
   * STALE asset reaches ELIGIBLE only by submitting this complete package
   * again, exactly as a never-reviewed asset would.
   */
  app.post("/api/shariah/assets/:assetId/publications", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    if (!isDigits(assetId)) return reply.code(400).send({ error: "assetId must be numeric" });
    const publishedBy = operatorIdentity(req);
    if (!publishedBy) return reply.code(401).send({ error: "not authenticated" });

    const b = (req.body ?? {}) as Record<string, unknown>;
    const input: PublishShariahDecisionInput = {
      assetId,
      policyVersion: TS_SHARIAH_V1,
      classification: String(b.classification ?? "") as Classification,
      reason: typeof b.reason === "string" ? b.reason : "",
      prohibitedCategories: asStringArray(b.prohibitedCategories),
      evidenceIds: asStringArray(b.evidenceIds),
      reviewedAt: typeof b.reviewedAt === "string" ? b.reviewedAt : "",
      publishedBy,
    };
    // Refuse an incomplete review before taking a pooled connection. The
    // service asserts the same gate again — this is the cheap first pass, not
    // the authority.
    try {
      assertPublishableDecision(input);
    } catch (error) {
      if (error instanceof ShariahPublicationError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }

    const client = await connect();
    try {
      return reply.code(201).send(await publishShariahDecision(client, input));
    } catch (error) {
      if (error instanceof ShariahPublicationError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  /** Freezes current authoritative state into a new immutable snapshot. */
  app.post("/api/shariah/snapshots", async (req, reply) => {
    const createdBy = operatorIdentity(req);
    if (!createdBy) return reply.code(401).send({ error: "not authenticated" });
    const client = await connect();
    try {
      const snapshot = await createShariahUniverseSnapshot(client, { createdBy });
      return reply.code(201).send(snapshot);
    } finally {
      client.release();
    }
  });

  // ── Research-facing read contract ─────────────────────────────────────────

  app.get("/api/shariah/snapshots", async (req) => {
    const { limit } = req.query as { limit?: string };
    const snapshots = await shariah.listSnapshots(Number(limit) || 50);
    return { policyVersion: TS_SHARIAH_V1, snapshots };
  });

  app.get("/api/shariah/snapshots/latest", async (_req, reply) => {
    const meta = await shariah.getLatestSnapshotMeta();
    if (!meta) return reply.code(404).send({ error: "no snapshot has been created yet" });
    return shariah.getSnapshot(meta.snapshotId);
  });

  app.get("/api/shariah/snapshots/:snapshotId", async (req, reply) => {
    const { snapshotId } = req.params as { snapshotId: string };
    if (!isDigits(snapshotId)) return reply.code(400).send({ error: "snapshotId must be numeric" });
    const snapshot = await shariah.getSnapshot(snapshotId);
    if (!snapshot) return reply.code(404).send({ error: "snapshot not found" });
    return snapshot;
  });
}
