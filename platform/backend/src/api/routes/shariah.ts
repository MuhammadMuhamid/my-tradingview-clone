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
import {
  DEFAULT_REVIEW_BATCH_SIZE, buildReviewPack, normalizeBatchSize, selectReviewBatch,
  type ReviewPackSource,
} from "../../shariah/reviewPack";
import {
  ShariahReviewImportError, importShariahReviewResults, previewShariahReviewResults,
} from "../../shariah/reviewImport";
import {
  getShariahMode, isShariahMode, setShariahMode, type ShariahMode,
} from "../../shariah/mode";
import { evaluateShariahGate, type ShariahGateDeps } from "../../shariah/gate";
import {
  pushShariahModeToBot, readBotShariahMode, ShariahBotSyncError, ShariahModeDriftError,
  type BotEnforcementDeps,
} from "../../shariah/botEnforcement";
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
  dependencies: {
    connect?: () => Promise<PoolClient>;
    shariah?: ShariahGateDeps;
    botEnforcement?: BotEnforcementDeps;
    /** The stored mode, injectable so the arm-then-store ORDER can be tested. */
    mode?: { get?: () => Promise<ShariahMode>; set?: (mode: ShariahMode) => Promise<ShariahMode> };
  } = {}
): Promise<void> {
  const connect = dependencies.connect ?? (() => pool.connect());
  const gateDeps = dependencies.shariah ?? {};
  const botEnforcementDeps = dependencies.botEnforcement ?? {};
  const readMode = dependencies.mode?.get ?? getShariahMode;
  const writeMode = dependencies.mode?.set ?? setShariahMode;

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

  // ── Batch review workflow: export a pack, import the researched results ───

  /**
   * Download the next batch to research. Defaults to 20 assets, ordered
   * STALE -> UNSCREENED -> REVIEW, and by construction carries only registry
   * facts and the TS_SHARIAH_V1 instructions — no session, credential, user
   * identity, position or unrelated database state. It is written to be handed
   * to a third party.
   */
  app.get("/api/shariah/review-pack", async (req) => {
    const q = req.query as { size?: string; includeSettled?: string; includeUnavailable?: string };
    const assets = await shariah.listAllAssets();
    const { batch, needsReviewTotal, batchSize } = selectReviewBatch(assets as ReviewPackSource[], {
      batchSize: q.size === undefined ? DEFAULT_REVIEW_BATCH_SIZE : normalizeBatchSize(Number(q.size)),
      includeSettled: q.includeSettled === "true",
      includeUnavailable: q.includeUnavailable === "true",
    });

    const { publications, evidence } = await shariah.loadReviewPackContext(batch.map((a) => a.assetId));
    return buildReviewPack(
      batch.map((asset) => ({
        ...asset,
        priorPublication: publications.get(asset.assetId) ?? null,
        priorEvidence: evidence.get(asset.assetId) ?? [],
      })),
      { generatedAt: new Date().toISOString(), batchSize, needsReviewTotal }
    );
  });

  /**
   * Dry run. Validates the researched file against the live registry and
   * reports what WOULD be published, so the operator sees the counts and any
   * problems before approving. Writes nothing.
   */
  app.post("/api/shariah/review-results/preview", async (req, reply) => {
    const client = await connect();
    try {
      const { parsed, counts } = await previewShariahReviewResults(client, req.body);
      return {
        policyVersion: parsed.policyVersion,
        researchCompletedAt: parsed.researchCompletedAt,
        assetCount: parsed.results.length,
        counts,
        results: parsed.results.map((r) => ({
          assetId: r.assetId, baseAsset: r.baseAsset, classification: r.classification,
          prohibitedCategories: r.prohibitedCategories, evidenceCount: r.evidence.length,
          unresolvedUncertainties: r.unresolvedUncertainties,
        })),
      };
    } catch (error) {
      if (error instanceof ShariahReviewImportError) {
        return reply.code(400).send({ error: error.message, issues: error.issues });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * IMPORT & PUBLISH. This single request is the explicit human approval for
   * the whole researched batch — the operator approves 20 assets once, not 20
   * times — and every decision in it goes through the same publication
   * authority a hand-entered one does.
   */
  app.post("/api/shariah/review-results/import", async (req, reply) => {
    const publishedBy = operatorIdentity(req);
    if (!publishedBy) return reply.code(401).send({ error: "not authenticated" });
    const client = await connect();
    try {
      const summary = await importShariahReviewResults(client, { document: req.body, publishedBy });
      return reply.code(201).send(summary);
    } catch (error) {
      if (error instanceof ShariahReviewImportError) {
        return reply.code(400).send({ error: error.message, issues: error.issues });
      }
      if (error instanceof ShariahPublicationError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  // ── Shariah Mode ──────────────────────────────────────────────────────────

  /*
   * The stored mode, plus what the execution bot says its own floor is.
   *
   * The two are set together and should agree; they can come apart if a mode
   * change half-applied, and nothing re-converges them on its own. Reporting
   * the bot's answer here is what turns that from silent drift into something
   * an operator can see and fix — without any polling loop, because this is
   * read only when someone asks. `botMode: null` means unreachable, which is
   * "unknown", not "off".
   */
  app.get("/api/shariah/mode", async () => {
    const [mode, bot] = await Promise.all([readMode(), readBotShariahMode(botEnforcementDeps)]);
    return {
      mode,
      policyVersion: TS_SHARIAH_V1,
      botMode: bot?.mode ?? null,
      inSync: bot === null ? null : bot.mode === mode,
    };
  });

  /**
   * The mode lives server-side because the gate is server-side. The browser
   * toggle calls this and then renders whatever the server reports; it never
   * holds the authoritative value.
   */
  app.put("/api/shariah/mode", async (req, reply) => {
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    if (!isShariahMode(mode)) {
      return reply.code(400).send({ error: 'mode must be "off" or "enforce"' });
    }
    /*
     * The mode is not only Platform state. The execution Bot accepts signals
     * this Platform never sees — a direct TradingView webhook, authenticated by
     * a per-bot secret — and it can only refuse those if it has been TOLD this
     * installation enforces. Nothing else can tell it: the Bot remembers
     * enforcement per sender scope, and no Platform-originated request ever
     * lands on the webhook sender's scope.
     *
     * So the push is part of the change, not a side effect of it, and the order
     * is chosen so every intermediate state is the stricter one:
     *
     *   enforce — arm the Bot first; persist only if it agreed. A failure
     *             reports 502 and leaves the stored mode alone, so the operator
     *             is never shown "enforcing" over an executing side that isn't.
     *   off     — persist first, disarm after.
     */
    try {
      if (mode === "enforce") {
        await pushShariahModeToBot("enforce", botEnforcementDeps);
        try {
          return { mode: await writeMode(mode), policyVersion: TS_SHARIAH_V1 };
        } catch (storeError) {
          /*
           * The bot is now armed and this Platform is not. That is the SAFE
           * direction — the webhook path the push exists to protect is closed,
           * and every Platform-originated path keeps the behaviour it had — but
           * the operator asked for a change that only half happened, and a
           * generic 500 would not tell them that. Naming both sides is what
           * makes it fixable.
           */
          throw new ShariahModeDriftError("enforce", await readMode(),
            storeError instanceof Error ? storeError.message : String(storeError));
        }
      }
      const stored = await writeMode(mode);
      await pushShariahModeToBot("off", botEnforcementDeps);
      return { mode: stored, policyVersion: TS_SHARIAH_V1 };
    } catch (error) {
      if (error instanceof ShariahBotSyncError) {
        return reply.code(error.status).send({ error: error.message, mode: await readMode() });
      }
      if (error instanceof ShariahModeDriftError) {
        return reply.code(error.status).send({
          error: error.message, mode: error.storedMode, botMode: error.botMode, inSync: false });
      }
      throw error;
    }
  });

  /**
   * The one status answer the trading surfaces read.
   *
   * It returns the GATE's own decision for a hypothetical BUY, not raw registry
   * fields for a component to interpret: Screener, chart and the manual panel
   * all show what the backend would actually do, so a UI can never disagree
   * with enforcement. `sellAllowed` is a constant true and is stated explicitly
   * so no surface has to infer it.
   */
  app.get("/api/shariah/status", async (req, reply) => {
    const symbol = (req.query as { symbol?: unknown }).symbol;
    if (typeof symbol !== "string" || symbol.trim().length === 0) {
      return reply.code(400).send({ error: "symbol is required" });
    }
    const decision = await evaluateShariahGate({ symbol, side: "BUY" }, gateDeps);
    return {
      symbol: symbol.trim().toUpperCase(),
      mode: decision.context.mode,
      shariah: decision.context,
      buyAllowed: decision.allowed,
      buyBlockedReason: decision.reason,
      sellAllowed: true,
    };
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
