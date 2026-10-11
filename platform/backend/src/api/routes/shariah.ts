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
import { listExchangeSymbols } from "../../data/binanceRest";
import * as shariah from "../../repositories/shariah";
import * as symbolRepo from "../../repositories/symbols";
import { TS_SHARIAH_V1, PROHIBITED_CATEGORIES, type Classification } from "../../shariah/policy";
import {
  ShariahPublicationError, assertPublishableDecision, publishShariahDecision,
  type PublishShariahDecisionInput,
} from "../../shariah/publication";
import { createShariahUniverseSnapshot } from "../../shariah/snapshot";
import {
  DEFAULT_REVIEW_BATCH_SIZE, buildReviewPack, normalizeBatchSize, parseAssetIdSelection,
  selectReviewBatch, unknownAssetIds, type ReviewPackSource,
} from "../../shariah/reviewPack";
import {
  ShariahReviewImportError, importShariahReviewResults, parseAcknowledgedAssetIds,
  previewShariahReviewResults, requiresUncertaintyAcknowledgement,
} from "../../shariah/reviewImport";
import {
  getShariahMode, isShariahMode, setShariahMode, type ShariahMode,
} from "../../shariah/mode";
import { evaluateShariahGate, type ShariahGateDeps } from "../../shariah/gate";
import {
  decisionAgeDays, getShariahReviewPolicy, isDueForReReview, setShariahReviewPolicy,
} from "../../shariah/freshness";
import {
  qualifyingBaseAssets, syncShariahUniverse, type BinanceSpotSymbolMeta,
} from "../../shariah/sync";
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
    /**
     * The audit write, injectable for the same reason the mode is.
     *
     * The arm-then-store tests fake `mode.set` precisely so they can prove the
     * ORDER without a database, and an audit row that went straight to the pool
     * would put one back — which is exactly what happened: the write outlived
     * the test and surfaced as an uncaught "terminating connection".
     */
    recordModeChange?: typeof shariah.recordShariahModeChange;
    /** Binance SPOT metadata, injectable so the sync is provable without a network call. */
    exchangeSymbols?: () => Promise<readonly BinanceSpotSymbolMeta[]>;
    /**
     * The registry reads the review-pack route makes, injectable so its
     * selection rules (explicit ids, unknown ids refused, deterministic
     * order) are provable without PostgreSQL. Production uses the repository.
     */
    reviewPackReads?: {
      listAllAssets?: typeof shariah.listAllAssets;
      loadReviewPackContext?: typeof shariah.loadReviewPackContext;
      getReviewPolicy?: typeof getShariahReviewPolicy;
    };
  } = {}
): Promise<void> {
  const connect = dependencies.connect ?? (() => pool.connect());
  const readExchangeSymbols = dependencies.exchangeSymbols ?? listExchangeSymbols;
  const gateDeps = dependencies.shariah ?? {};
  const botEnforcementDeps = dependencies.botEnforcement ?? {};
  const readMode = dependencies.mode?.get ?? getShariahMode;
  const writeMode = dependencies.mode?.set ?? setShariahMode;
  const recordModeChange = dependencies.recordModeChange ?? shariah.recordShariahModeChange;
  const packReads = {
    listAllAssets: dependencies.reviewPackReads?.listAllAssets ?? shariah.listAllAssets,
    loadReviewPackContext:
      dependencies.reviewPackReads?.loadReviewPackContext ?? shariah.loadReviewPackContext,
    getReviewPolicy: dependencies.reviewPackReads?.getReviewPolicy ?? getShariahReviewPolicy,
  };

  /** The whole registry, including delisted assets (`binanceAvailable: false`). */
  app.get("/api/shariah/universe", async () => {
    const [assets, reviewPolicy] = await Promise.all([
      shariah.listAllAssets(), getShariahReviewPolicy(),
    ]);
    const now = Date.now();
    /*
     * Age is reported per asset and counted once, and it changes nothing.
     *
     * Until now the only invalidation here was event-driven — a delisted
     * ticker reappearing forces STALE — so a decision about an asset that
     * never delisted stayed authoritative for ever with nothing surfacing its
     * age. Demoting aged decisions would have been the obvious fix and the
     * wrong one: it withdraws verdicts in bulk and stops trading on an
     * installation whose operator did nothing, at a moment they did not
     * choose, through the gate, where the effect is invisible until an order
     * is refused. So this is a count and a flag. `shariah/gate.ts` does not
     * read it.
     */
    const decorated = assets.map((asset) => ({
      ...asset,
      decisionAgeDays: decisionAgeDays(asset, now),
      dueForReReview: isDueForReReview(asset, reviewPolicy, now),
    }));
    const active = decorated.filter((a) => a.binanceAvailable);
    return {
      policyVersion: TS_SHARIAH_V1,
      prohibitedCategories: PROHIBITED_CATEGORIES,
      reviewPolicy,
      counts: {
        total: decorated.length,
        active: active.length,
        eligible: active.filter((a) => a.effectiveStatus === "ELIGIBLE").length,
        review: active.filter((a) => a.effectiveStatus === "REVIEW").length,
        excluded: active.filter((a) => a.effectiveStatus === "EXCLUDED").length,
        /** Settled, and older than the advisory policy. Never demoted by it. */
        dueForReReview: active.filter((a) => a.dueForReReview).length,
      },
      assets: decorated,
    };
  });

  /** Every Shariah Mode change, newest first. Append-only; nothing edits it. */
  app.get("/api/shariah/mode/history", async () => ({
    changes: await shariah.listShariahModeChanges(),
  }));

  /**
   * The advisory re-review interval.
   *
   * A setting rather than a constant because how long a screening stays
   * current is a research-policy judgement, and one nobody can see is one
   * nobody can question. `null` turns time-based surfacing off entirely.
   */
  app.get("/api/shariah/review-policy", async () => getShariahReviewPolicy());
  app.put("/api/shariah/review-policy", async (req, reply) => {
    const raw = (req.body as { reviewMaxAgeDays?: unknown } | null)?.reviewMaxAgeDays;
    const days = raw === null ? null : Number(raw);
    if (days !== null && (!Number.isInteger(days) || days <= 0)) {
      return reply.code(400).send({
        error: "reviewMaxAgeDays must be a positive whole number of days, or null to turn "
          + "time-based re-review off",
      });
    }
    return setShariahReviewPolicy(days);
  });

  /**
   * POPULATE. The registry's only production entry point.
   *
   * Nothing else creates a shariah_assets row: review, publication and
   * snapshots all resolve against rows that must already exist. Without this
   * route a fresh install has an empty registry, so `effectiveShariahStatus`
   * answers REVIEW for every symbol and turning Shariah Mode on is a total BUY
   * stop with no action inside the product that can lift it.
   *
   * Discovery is not classification. `syncShariahUniverse` creates every newly
   * seen base asset UNSCREENED, which reads as REVIEW under policy.ts, and has
   * no path that writes ELIGIBLE or EXCLUDED. Publication remains the only act
   * that can allow a BUY, so running this can never widen what may be bought.
   *
   * Operator-triggered, not scheduled: there is no background job here. An
   * unattended sync is what would make the mass-demotion below dangerous.
   */
  app.post("/api/shariah/universe/sync", async (_req, reply) => {
    let exchangeSymbols: readonly BinanceSpotSymbolMeta[];
    try {
      exchangeSymbols = await readExchangeSymbols();
    } catch (error) {
      return reply.code(502).send({
        error: `symbol directory unavailable: ${(error as Error).message}`,
      });
    }
    const supported = new Set((await symbolRepo.listSymbols()).map((s) => s.symbol));
    const qualifying = qualifyingBaseAssets(exchangeSymbols, supported);

    /*
     * REFUSE AN EMPTY SET BEFORE ANY WRITE.
     *
     * syncShariahUniverse deactivates every mapping that is not in the
     * qualifying set, so an empty set — a degraded exchange directory, or an
     * emptied `symbols` table — deactivates the entire registry. That alone
     * is fail-safe. What is not recoverable is the NEXT healthy sync: every
     * asset reappears as previously-inactive, and upsertMapping then forces
     * each SCREENED record to STALE for ticker-reuse safety, so every
     * published operator decision is silently thrown back to REVIEW.
     *
     * A universe that legitimately qualifies nothing is indistinguishable
     * from that failure at this boundary, and refusing costs an operator one
     * message while the alternative costs them all of their review work. The
     * guard lives here, at the caller, so sync.ts keeps exactly the
     * "apply this set" contract its own tests pin.
     */
    if (qualifying.length === 0) {
      return reply.code(409).send({
        error: "refusing to sync an empty qualifying set: this would deactivate the "
          + "whole registry and send every published decision back to REVIEW on the "
          + "next healthy sync. Check that Binance spot metadata is reachable and "
          + "that this installation tracks at least one active USDT spot pair.",
        qualifying: 0,
        exchangeSymbols: exchangeSymbols.length,
        supportedSymbols: supported.size,
      });
    }

    const client = await connect();
    try {
      await client.query("BEGIN");
      // Sync touches the whole registry (including deactivation). Hold its
      // mapping identities in the same order as review imports, and keep a
      // reactivated ticker's mapping and STALE transition in one transaction.
      // Otherwise an import can see the mapping update before STALE and
      // overwrite the subsequent withdrawal using pre-reactivation research.
      await client.query(
        "SELECT m.asset_id FROM shariah_asset_binance_mappings m ORDER BY m.asset_id FOR UPDATE"
      );
      const result = await syncShariahUniverse(client, qualifying);
      await client.query("COMMIT");
      return {
        policyVersion: TS_SHARIAH_V1,
        qualifying: qualifying.length,
        created: result.created,
        reactivated: result.reactivated,
        deactivated: result.deactivated,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
  app.get("/api/shariah/review-pack", async (req, reply) => {
    const q = req.query as {
      size?: string; includeSettled?: string; includeUnavailable?: string;
      assetIds?: string | string[];
    };
    /*
     * `assetIds` is the operator choosing WHAT gets researched, rather than
     * taking the next twenty in queue order. Everything about it is refused
     * loudly before any registry read: a malformed or duplicate id, more than
     * one pack can carry, or a `size` beside it — a size smaller than the
     * selection would silently drop assets the operator picked by name.
     */
    let explicitIds: string[] | undefined;
    if (q.assetIds !== undefined) {
      const selection = parseAssetIdSelection(q.assetIds);
      if (!selection.ok) return reply.code(400).send({ error: selection.error });
      if (q.size !== undefined) {
        return reply.code(400).send({
          error: "assetIds and size cannot be combined: an explicit selection is the whole pack",
        });
      }
      explicitIds = selection.ids;
    }
    const [assets, reviewPolicy] = await Promise.all([
      packReads.listAllAssets(), packReads.getReviewPolicy(),
    ]);
    if (explicitIds) {
      const unknown = unknownAssetIds(assets, explicitIds);
      if (unknown.length > 0) {
        return reply.code(400).send({
          error: `unknown assetIds: ${unknown.join(", ")} — not in the Shariah registry`,
          unknownAssetIds: unknown,
        });
      }
    }
    const now = Date.now();
    /*
     * A settled decision nobody has revisited in a year is exactly what a
     * pack's twenty slots should be spending themselves on — after everything
     * that has never been settled at all. Surfacing it here is the whole of
     * the time-based re-review: the asset is not demoted, its verdict still
     * stands, and it simply reaches the front of the queue.
     */
    const dueForReReview = new Set(
      assets.filter((a) => isDueForReReview(a, reviewPolicy, now)).map((a) => a.assetId));
    const { batch, needsReviewTotal, batchSize } = selectReviewBatch(assets as ReviewPackSource[], {
      batchSize: q.size === undefined ? DEFAULT_REVIEW_BATCH_SIZE : normalizeBatchSize(Number(q.size)),
      includeSettled: q.includeSettled === "true",
      includeUnavailable: q.includeUnavailable === "true",
      dueForReReview,
      assetIds: explicitIds,
    });

    const { publications, evidence } = await packReads.loadReviewPackContext(batch.map((a) => a.assetId));
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
   *
   * It returns the WHOLE of each decision — reason, the six answers, every
   * evidence citation, the uncertainties — because this is the last look
   * before up to a hundred immutable publications. It used to return a name,
   * an evidence count and a status, so the "review" step was a rubber stamp:
   * the operator approved verdicts whose grounds they had no way to read.
   */
  app.post("/api/shariah/review-results/preview", async (req, reply) => {
    const client = await connect();
    try {
      const { parsed, counts } = await previewShariahReviewResults(client, req.body);
      return {
        policyVersion: parsed.policyVersion,
        researchCompletedAt: parsed.researchCompletedAt,
        packGeneratedAt: parsed.packGeneratedAt,
        assetCount: parsed.results.length,
        counts,
        /** The assets the import request must acknowledge, in file order. */
        acknowledgementRequired: parsed.results
          .filter(requiresUncertaintyAcknowledgement).map((r) => r.assetId),
        results: parsed.results.map((r) => ({
          assetId: r.assetId, baseAsset: r.baseAsset, classification: r.classification,
          reason: r.reason, answers: r.answers,
          prohibitedCategories: r.prohibitedCategories, evidenceCount: r.evidence.length,
          evidence: r.evidence.map((e) => ({
            url: e.url, title: e.title, publisher: e.publisher, retrievedAt: e.retrievedAt, note: e.note,
          })),
          unresolvedUncertainties: r.unresolvedUncertainties,
          requiresAcknowledgement: requiresUncertaintyAcknowledgement(r),
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
   *
   * `?acknowledgedAssetIds=` is the operator's per-asset sign-off on ELIGIBLE
   * results that list unresolved uncertainties. It is a request parameter, not
   * a document field, because the document was written by a model and must
   * not be able to acknowledge itself. A missing or surplus acknowledgement
   * refuses the whole import with a 400 naming the asset and the field.
   */
  app.post("/api/shariah/review-results/import", async (req, reply) => {
    const publishedBy = operatorIdentity(req);
    if (!publishedBy) return reply.code(401).send({ error: "not authenticated" });
    let acknowledgedAssetIds: string[];
    try {
      acknowledgedAssetIds = parseAcknowledgedAssetIds(
        (req.query as { acknowledgedAssetIds?: unknown }).acknowledgedAssetIds);
    } catch (error) {
      if (error instanceof ShariahReviewImportError) {
        return reply.code(400).send({ error: error.message, issues: error.issues });
      }
      throw error;
    }
    const client = await connect();
    try {
      const summary = await importShariahReviewResults(client, {
        document: req.body, publishedBy, acknowledgedAssetIds,
      });
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
    const previousMode = await readMode();
    const operator = operatorIdentity(req);
    /*
     * The audit row is written after the change has actually landed, and never
     * blocks it: `app_settings` held this switch as one mutable key/value row
     * with a single `updated_at`, so "someone turned it off at some point" was
     * the only recoverable fact about the one control that governs religious
     * compliance for the whole installation. Every publication here is
     * append-only and attributed; the switch deciding whether publications are
     * enforced at all was not. A failure to record is logged and swallowed —
     * a mode change must never fail because its own audit row did.
     */
    const audit = async (pushed: boolean): Promise<void> => {
      if (previousMode === mode) return;
      try {
        await recordModeChange({
          fromMode: previousMode, toMode: mode,
          changedBy: operator ?? "unknown-operator",
          botFloorPushed: pushed, policyVersion: TS_SHARIAH_V1,
        });
      } catch (error) {
        req.log.warn({ error }, "Shariah mode changed but the audit row could not be written");
      }
    };
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
        /*
         * `pushed` is reported, never assumed. It is true only when the Bot
         * answered with the floor it was actually asked for; it is false only
         * when this installation has no Bot control channel configured at all,
         * which is a real deployment and not a success to be claimed. Anything
         * in between raises, below. Callers therefore never have to guess
         * whether "200" meant the executing side is armed.
         */
        const { pushed } = await pushShariahModeToBot("enforce", botEnforcementDeps);
        try {
          const stored = await writeMode(mode);
          await audit(pushed);
          return { mode: stored, policyVersion: TS_SHARIAH_V1, botFloorPushed: pushed };
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
      const { pushed } = await pushShariahModeToBot("off", botEnforcementDeps);
      await audit(pushed);
      return { mode: stored, policyVersion: TS_SHARIAH_V1, botFloorPushed: pushed };
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
