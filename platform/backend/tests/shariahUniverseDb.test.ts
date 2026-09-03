/**
 * SH-2 end-to-end proof against real PostgreSQL.
 *
 * The properties SH-2 exists to guarantee are database properties: append-only
 * history, snapshot immutability under later publications, deterministic
 * content hashing over a real query result, and CHECK constraints that hold
 * even when application code is bypassed. None of those can be proved by a
 * fake, so this file runs the whole review/publication/snapshot lifecycle
 * against a real server.
 *
 * It is bounded: it drops and recreates the configured test database, applies
 * the real migration set, uses SYNTHETIC base assets only (no real Binance
 * asset is ever classified here), and makes no network call. When no local
 * PostgreSQL is listening on DATABASE_URL the whole file skips with a reason
 * rather than failing — see platform/scripts/db.sh to start one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { config } from "../src/config";
import { shariahRoutes } from "../src/api/routes/shariah";
import { migrate } from "../src/db/migrate";
import { pool, closePool, query } from "../src/db/pool";
import * as shariah from "../src/repositories/shariah";
import { TS_SHARIAH_V1 } from "../src/shariah/policy";
import {
  ShariahPublicationError, publishShariahDecision,
} from "../src/shariah/publication";
import {
  canonicalSnapshotEntries, createShariahUniverseSnapshot, snapshotContentHash,
  type ShariahSnapshotSource,
} from "../src/shariah/snapshot";
import {
  syncShariahUniverse, type BinanceSpotSymbolMeta,
} from "../src/shariah/sync";

/** Synthetic only. Nothing here names a real project or a real Binance asset. */
const SYNTH = { A: "SYNTHAA", B: "SYNTHBB", C: "SYNTHCC", D: "SYNTHDD", E: "SYNTHEE" };
const REVIEWED_AT = "2026-09-01T09:00:00.000Z";
const OPERATOR = "sh2-proof-operator";

/** Same server, `postgres` maintenance database, so the test database can be recreated. */
function maintenanceUrl(): string {
  const url = new URL(config.databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function prepareDatabase(): Promise<string | null> {
  const target = new URL(config.databaseUrl).pathname.replace(/^\//, "");
  if (!target) return "DATABASE_URL names no database";
  const admin = new Pool({ connectionString: maintenanceUrl(), connectionTimeoutMillis: 2_000, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(target)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${JSON.stringify(target)}`);
  } catch (error) {
    return `no local PostgreSQL on ${maintenanceUrl()} (${(error as Error).message})`;
  } finally {
    await admin.end();
  }
  await migrate();
  return null;
}

/** Every synthetic asset gets its own synthetic evidence; nothing is fetched. */
async function evidence(assetId: string, note: string): Promise<string> {
  const row = await shariah.addEvidence({
    assetId,
    url: `https://example.invalid/synthetic/${encodeURIComponent(note)}`,
    title: `Synthetic fixture: ${note}`,
    publisher: "SH-2 test fixture",
    retrievedAt: REVIEWED_AT,
    excerpt: note,
  });
  return String(row.id);
}

const assetIdOf = async (baseAsset: string): Promise<string> =>
  String((await shariah.getAssetByBaseSymbol(baseAsset))!.assetId);

/** Binance spot metadata as `listExchangeSymbols` returns it, synthetic only. */
const spotMeta = (baseAsset: string, over: Partial<BinanceSpotSymbolMeta> = {}): BinanceSpotSymbolMeta =>
  ({ symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: "USDT", status: "TRADING", ...over });

/** The Shariah HTTP boundary over the real pool, with the exchange stubbed. */
async function syncRouteApp(exchangeSymbols: () => Promise<readonly BinanceSpotSymbolMeta[]>) {
  const app = Fastify({ logger: false });
  await app.register(shariahRoutes, {
    connect: () => pool.connect() as Promise<PoolClient>,
    exchangeSymbols,
  });
  return app;
}

test("SH-2 publication, history and snapshot behaviour on real PostgreSQL", async (t) => {
  const unavailable = await prepareDatabase().catch((error: Error) => error.message);
  if (unavailable) return t.skip(unavailable);

  const client = await pool.connect();
  t.after(async () => { client.release(); await closePool(); });

  /*
   * ── P1-4: the registry's production population path ──────────────────────
   *
   * Nothing in production called syncShariahUniverse: no route, no npm script,
   * no migration INSERT. A fresh install therefore had an empty registry, and
   * because the gate is correctly fail-closed, turning Shariah Mode on was a
   * total BUY stop that no action inside the product could lift. This proves
   * the new operator-triggered route is that action — and that it stays
   * discovery-only.
   *
   * It runs FIRST, on the freshly migrated database, because "the registry is
   * empty before" is half of what is being proved.
   */
  await t.test("P1-4: POST /api/shariah/universe/sync is the registry's production entry point", async () => {
    for (const baseAsset of Object.values(SYNTH)) {
      await query(
        `INSERT INTO symbols (symbol, base_asset, quote_asset, is_active)
         VALUES ($1, $2, 'USDT', true) ON CONFLICT (symbol) DO NOTHING`,
        [`${baseAsset}USDT`, baseAsset]
      );
    }
    // Nothing this installation does not track, and nothing halted, may enter.
    const directory = [
      ...Object.values(SYNTH).map((base) => spotMeta(base)),
      spotMeta("SYNTHZZ"),                                  // real pair, untracked here
      spotMeta(SYNTH.A, { symbol: `${SYNTH.A}BTC`, quoteAsset: "BTC" }), // not USDT-quoted
      spotMeta("SYNTHHH", { status: "BREAK" }),             // not TRADING
    ];
    const app = await syncRouteApp(async () => directory);

    const before = await app.inject({ method: "GET", url: "/api/shariah/universe" });
    assert.equal(before.json().counts.total, 0,
      "the registry must start empty — that is the defect this route exists to fix");

    const synced = await app.inject({ method: "POST", url: "/api/shariah/universe/sync" });
    assert.equal(synced.statusCode, 200);
    assert.deepEqual(synced.json().created.sort(), Object.values(SYNTH).sort());
    assert.deepEqual(synced.json().deactivated, []);

    const after = (await app.inject({ method: "GET", url: "/api/shariah/universe" })).json();
    assert.equal(after.counts.total, 5);
    assert.equal(after.counts.eligible, 0, "discovery must never classify anything ELIGIBLE");
    assert.equal(after.counts.review, 5);
    for (const asset of after.assets) {
      assert.equal(asset.lifecycle, "UNSCREENED", asset.baseAsset);
      assert.equal(asset.effectiveStatus, "REVIEW", asset.baseAsset);
    }

    // The gate's own answer, which is what every trading surface reads. Even
    // with enforcement on, a synced-but-unreviewed asset is still refused: the
    // sync populates the review queue, it does not shorten it.
    const enforcing = Fastify({ logger: false });
    await enforcing.register(shariahRoutes, { shariah: { readMode: async () => "enforce" } });
    const status = (await enforcing.inject({
      method: "GET", url: `/api/shariah/status?symbol=${SYNTH.A}USDT` })).json();
    await enforcing.close();
    assert.notEqual(status.shariah.effectiveStatus, "ELIGIBLE");
    assert.equal(status.shariah.effectiveStatus, "REVIEW");
    assert.equal(status.buyAllowed, false);
    assert.equal(status.sellAllowed, true, "a SELL is never gated");

    /*
     * ── P2-6: the empty-set guard ──
     *
     * A degraded exchange directory would otherwise deactivate every mapping,
     * and the NEXT healthy sync would then force every SCREENED record to
     * STALE — destroying all published review work. The refusal must happen
     * before any write, so the registry is byte-identical afterwards.
     */
    const snapshotOfRegistry = async (): Promise<string> => JSON.stringify(
      (await query<{ base_asset: string; binance_available: boolean; lifecycle: string }>(
        `SELECT m.base_asset, m.binance_available, r.lifecycle
           FROM shariah_asset_binance_mappings m
           JOIN shariah_records r ON r.asset_id = m.asset_id
          ORDER BY m.base_asset`)).rows);
    const untouched = await snapshotOfRegistry();

    const starved = await syncRouteApp(async () => []);
    const refused = await starved.inject({ method: "POST", url: "/api/shariah/universe/sync" });
    await starved.close();
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /empty qualifying set/);
    assert.equal(refused.json().qualifying, 0);
    assert.equal(await snapshotOfRegistry(), untouched,
      "an empty qualifying set must not deactivate or demote anything");

    // Same refusal when the exchange is fine but this install tracks nothing.
    const untracked = await syncRouteApp(async () => [spotMeta("SYNTHQQ")]);
    const alsoRefused = await untracked.inject({ method: "POST", url: "/api/shariah/universe/sync" });
    await untracked.close();
    assert.equal(alsoRefused.statusCode, 409);
    assert.equal(await snapshotOfRegistry(), untouched);

    await app.close();
  });

  // ── Discovery: universe sync produces UNSCREENED/REVIEW and nothing else ──
  await syncShariahUniverse(client, Object.values(SYNTH).sort());

  await t.test("N: no universe sync path auto-publishes a classification", async () => {
    const assets = await shariah.listAllAssets();
    assert.equal(assets.length, 5);
    for (const asset of assets) {
      assert.equal(asset.lifecycle, "UNSCREENED", asset.baseAsset);
      assert.equal(asset.effectiveStatus, "REVIEW", asset.baseAsset);
    }
    const { rows } = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM shariah_records WHERE classification <> 'REVIEW' OR lifecycle <> 'UNSCREENED'");
    assert.equal(rows[0]!.n, "0");
    const publications = await query<{ n: string }>("SELECT count(*)::text AS n FROM shariah_publications");
    assert.equal(publications.rows[0]!.n, "0");
  });

  const idA = await assetIdOf(SYNTH.A);
  const idB = await assetIdOf(SYNTH.B);
  const idC = await assetIdOf(SYNTH.C);
  const idE = await assetIdOf(SYNTH.E);

  // ── A: UNSCREENED cannot become ELIGIBLE without full publication input ───
  await t.test("A: an UNSCREENED asset cannot reach ELIGIBLE without a complete review", async () => {
    await assert.rejects(
      publishShariahDecision(client, {
        assetId: idA, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
        reason: "", evidenceIds: [], reviewedAt: "", publishedBy: OPERATOR,
      }),
      ShariahPublicationError
    );
    await assert.rejects(
      publishShariahDecision(client, {
        assetId: idA, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
        reason: "Nothing found against it.", evidenceIds: [],
        reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
      }),
      /absence of evidence is not proof of eligibility/
    );
    const after = await shariah.getAssetById(idA);
    assert.equal(after!.lifecycle, "UNSCREENED");
    assert.equal(after!.effectiveStatus, "REVIEW");
  });

  // ── E: a complete ELIGIBLE review publishes ──────────────────────────────
  const evidenceA1 = await evidence(idA, "synthetic project A does nothing prohibited");
  let firstPublicationA: shariah.ShariahPublicationRecord;

  await t.test("E: ELIGIBLE publishes once the review and its evidence are complete", async () => {
    const decision = await publishShariahDecision(client, {
      assetId: idA, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
      reason: "Synthetic fixture A's own core activity is not a prohibited activity.",
      evidenceIds: [evidenceA1], reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
    });
    assert.equal(decision.classification, "ELIGIBLE");
    assert.equal(decision.lifecycle, "SCREENED");
    assert.equal(decision.baseAssetAtPublication, SYNTH.A);

    const state = await shariah.getAssetById(idA);
    assert.equal(state!.lifecycle, "SCREENED");
    assert.equal(state!.effectiveStatus, "ELIGIBLE");

    const history = await shariah.listPublications(idA);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0]!.evidenceIds, [evidenceA1]);
    assert.equal(history[0]!.publishedBy, OPERATOR);
    firstPublicationA = history[0]!;

    // The mutable current record points at the immutable decision behind it.
    const link = await query<{ current_publication_id: string }>(
      "SELECT current_publication_id FROM shariah_records WHERE asset_id = $1", [idA]);
    assert.equal(String(link.rows[0]!.current_publication_id), decision.publicationId);
  });

  // ── D: EXCLUDED requires reason + prohibited category + evidence ─────────
  await t.test("D: EXCLUDED requires a reason, a prohibited category and evidence", async () => {
    const evidenceB = await evidence(idB, "synthetic project B's own product is a betting market");
    await assert.rejects(publishShariahDecision(client, {
      assetId: idB, policyVersion: TS_SHARIAH_V1, classification: "EXCLUDED",
      reason: "Its own product is prohibited.", prohibitedCategories: [],
      evidenceIds: [evidenceB], reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
    }), /at least one prohibited category/);

    await assert.rejects(publishShariahDecision(client, {
      assetId: idB, policyVersion: TS_SHARIAH_V1, classification: "EXCLUDED",
      reason: "Its own product is prohibited.",
      prohibitedCategories: ["GAMBLING_BETTING_CASINO"], evidenceIds: [],
      reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
    }), /at least one supporting evidence/);

    const decision = await publishShariahDecision(client, {
      assetId: idB, policyVersion: TS_SHARIAH_V1, classification: "EXCLUDED",
      reason: "Synthetic fixture B's own core product is a betting market.",
      prohibitedCategories: ["GAMBLING_BETTING_CASINO"], evidenceIds: [evidenceB],
      reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
    });
    assert.deepEqual(decision.prohibitedCategories, ["GAMBLING_BETTING_CASINO"]);
    assert.equal((await shariah.getAssetById(idB))!.effectiveStatus, "EXCLUDED");

    // The database refuses the same shape even when application code is bypassed.
    await assert.rejects(query(
      `INSERT INTO shariah_publications (asset_id, policy_version, classification, reason, reviewed_at, published_by)
       VALUES ($1, 'TS_SHARIAH_V1', 'EXCLUDED', 'no category given', now(), 'direct-sql')`,
      [idB]), /shariah_publications_excluded_shape_ck/);
  });

  // ── F: REVIEW is publishable on ambiguity ───────────────────────────────
  await t.test("F: REVIEW publishes with an ambiguity reason and no evidence", async () => {
    const decision = await publishShariahDecision(client, {
      assetId: idC, policyVersion: TS_SHARIAH_V1, classification: "REVIEW",
      reason: "Sources conflict on whether synthetic fixture C's token finances the parent's lending desk.",
      evidenceIds: [], reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
    });
    assert.equal(decision.lifecycle, "SCREENED");
    const state = await shariah.getAssetById(idC);
    assert.equal(state!.lifecycle, "SCREENED");
    assert.equal(state!.effectiveStatus, "REVIEW");
    // Distinguishable from never-screened: it has a published reason and history.
    assert.equal((await shariah.listPublications(idC)).length, 1);

    // A publication with a blank reason is refused by the database too.
    await assert.rejects(query(
      `INSERT INTO shariah_publications (asset_id, policy_version, classification, reason, reviewed_at, published_by)
       VALUES ($1, 'TS_SHARIAH_V1', 'REVIEW', '   ', now(), 'direct-sql')`,
      [idC]), /shariah_publications_reason_ck/);
  });

  // ── Set up a STALE asset via SH-1's ticker-reuse fail-closed rule ────────
  const evidenceE1 = await evidence(idE, "synthetic project E is a plain payments network");
  await publishShariahDecision(client, {
    assetId: idE, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
    reason: "Synthetic fixture E's own activity is not prohibited.",
    evidenceIds: [evidenceE1], reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
  });

  // Delist A and E, then relist them: SH-1 demotes SCREENED -> STALE.
  await syncShariahUniverse(client, [SYNTH.B, SYNTH.C, SYNTH.D]);
  await syncShariahUniverse(client, Object.values(SYNTH).sort());

  // ── B: STALE cannot regain ELIGIBLE through a shallow reconfirmation ─────
  await t.test("B: a STALE asset cannot regain ELIGIBLE by reconfirming its old status", async () => {
    const stale = await shariah.getAssetById(idA);
    assert.equal(stale!.lifecycle, "STALE");
    assert.equal(stale!.classification, "ELIGIBLE", "the stored classification is still the old one");
    assert.equal(stale!.effectiveStatus, "REVIEW", "but the effective answer is not");

    // The shape a "reconfirm" shortcut would take: classification only.
    await assert.rejects(publishShariahDecision(client, {
      assetId: idA, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
      reason: "", evidenceIds: [], reviewedAt: "", publishedBy: OPERATOR,
    }), ShariahPublicationError);

    // And a reason without a fresh evidence package is still not a review.
    await assert.rejects(publishShariahDecision(client, {
      assetId: idA, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
      reason: "Same project as before; reconfirming the previous ELIGIBLE.",
      evidenceIds: [], reviewedAt: new Date().toISOString(), publishedBy: OPERATOR,
    }), /absence of evidence is not proof of eligibility/);

    const unchanged = await shariah.getAssetById(idA);
    assert.equal(unchanged!.lifecycle, "STALE");
    assert.equal(unchanged!.effectiveStatus, "REVIEW");
  });

  // ── C: a complete fresh review of a STALE asset publishes a NEW result ───
  await t.test("C: a completed fresh review of a STALE asset publishes a new classification", async () => {
    const evidenceA2 = await evidence(idA,
      "the ticker now maps to a different synthetic project whose own product is a casino");
    const decision = await publishShariahDecision(client, {
      assetId: idA, policyVersion: TS_SHARIAH_V1, classification: "EXCLUDED",
      reason: "Re-screened after the ticker was reused: the current project's own product is prohibited.",
      prohibitedCategories: ["GAMBLING_BETTING_CASINO"], evidenceIds: [evidenceA2],
      reviewedAt: new Date().toISOString(), publishedBy: OPERATOR,
    });
    assert.equal(decision.classification, "EXCLUDED");

    const state = await shariah.getAssetById(idA);
    assert.equal(state!.lifecycle, "SCREENED");
    assert.equal(state!.effectiveStatus, "EXCLUDED",
      "nothing copied the old ELIGIBLE forward");
    assert.equal((await shariah.listPublications(idA)).length, 2);
  });

  // ── G: earlier publications are untouched by later ones ─────────────────
  await t.test("G: publication history is unchanged after a later decision", async () => {
    const history = await shariah.listPublications(idA);
    const original = history.find((p) => p.publicationId === firstPublicationA.publicationId);
    assert.deepEqual(original, firstPublicationA);
    assert.equal(original!.classification, "ELIGIBLE");
    assert.deepEqual(original!.evidenceIds, [evidenceA1]);

    // The database itself refuses to rewrite or erase it.
    await assert.rejects(
      query("UPDATE shariah_publications SET classification = 'ELIGIBLE' WHERE publication_id = $1",
        [firstPublicationA.publicationId]),
      /shariah append-only violation: UPDATE on shariah_publications/);
    await assert.rejects(
      query("DELETE FROM shariah_publications WHERE publication_id = $1", [firstPublicationA.publicationId]),
      /shariah append-only violation: DELETE on shariah_publications/);
    await assert.rejects(
      query("DELETE FROM shariah_publication_evidence WHERE publication_id = $1",
        [firstPublicationA.publicationId]),
      /shariah append-only violation: DELETE on shariah_publication_evidence/);
  });

  // ── H/I: the snapshot is the complete, deterministic current universe ────
  const snapshotOne = await createShariahUniverseSnapshot(client, { createdBy: OPERATOR });

  await t.test("H: a snapshot freezes the complete current universe deterministically", async () => {
    assert.equal(snapshotOne.entryCount, 5);
    assert.deepEqual(snapshotOne.entries.map((e) => e.baseAsset), Object.values(SYNTH).sort());
    assert.match(snapshotOne.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(snapshotOne.policyVersion, TS_SHARIAH_V1);

    const byBase = new Map(snapshotOne.entries.map((e) => [e.baseAsset, e]));
    assert.equal(byBase.get(SYNTH.A)!.effectiveStatus, "EXCLUDED");
    assert.equal(byBase.get(SYNTH.B)!.effectiveStatus, "EXCLUDED");
    assert.equal(byBase.get(SYNTH.C)!.effectiveStatus, "REVIEW");
    assert.equal(byBase.get(SYNTH.E)!.effectiveStatus, "REVIEW");
    // All three public classifications are representable and REVIEW is kept.
    assert.ok(new Set(snapshotOne.entries.map((e) => e.effectiveStatus)).has("REVIEW"));
  });

  await t.test("I: UNSCREENED and STALE snapshot members are effectively REVIEW", async () => {
    const byBase = new Map(snapshotOne.entries.map((e) => [e.baseAsset, e]));
    const neverScreened = byBase.get(SYNTH.D)!;
    assert.equal(neverScreened.lifecycle, "UNSCREENED");
    assert.equal(neverScreened.effectiveStatus, "REVIEW");

    const stale = byBase.get(SYNTH.E)!;
    assert.equal(stale.lifecycle, "STALE");
    assert.equal(stale.classification, "ELIGIBLE");
    assert.equal(stale.effectiveStatus, "REVIEW");

    // The constraint holds even against direct SQL.
    await assert.rejects(query(
      `INSERT INTO shariah_universe_snapshot_entries (
         snapshot_id, asset_id, position, base_asset, effective_status,
         classification, lifecycle, binance_available, policy_version)
       VALUES ($1, $2, 999, 'SYNTHXX', 'ELIGIBLE', 'ELIGIBLE', 'STALE', true, 'TS_SHARIAH_V1')`,
      [snapshotOne.snapshotId, idA]), /shariah_snapshot_entries_unscreened_is_review_ck/);
  });

  // ── K: the hash does not depend on database row order ────────────────────
  await t.test("K: content hash is deterministic independent of database row order", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { rows } = await query<ShariahSnapshotSource>(
        `SELECT m.asset_id, m.base_asset, m.binance_available,
                r.classification, r.lifecycle, r.policy_version, r.current_publication_id
           FROM shariah_asset_binance_mappings m
           LEFT JOIN shariah_records r ON r.asset_id = m.asset_id
          ORDER BY random()`);
      assert.equal(
        snapshotContentHash(TS_SHARIAH_V1, canonicalSnapshotEntries(rows)),
        snapshotOne.contentHash);
    }
  });

  await t.test("re-snapshotting unchanged state appends a new snapshot with the same content hash", async () => {
    const again = await createShariahUniverseSnapshot(client, { createdBy: OPERATOR });
    assert.notEqual(again.snapshotId, snapshotOne.snapshotId);
    assert.equal(again.contentHash, snapshotOne.contentHash);
  });

  // ── J/M: later publications and ticker changes do not rewrite a snapshot ─
  await t.test("J/M: a later publication and a later ticker change leave the old snapshot untouched", async () => {
    const before = await shariah.getSnapshot(snapshotOne.snapshotId);

    // A later publication on an asset that was UNSCREENED in the snapshot.
    const idD = await assetIdOf(SYNTH.D);
    const evidenceD = await evidence(idD, "synthetic project D reviewed after the snapshot");
    await publishShariahDecision(client, {
      assetId: idD, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
      reason: "Reviewed after snapshot one was taken.",
      evidenceIds: [evidenceD], reviewedAt: new Date().toISOString(), publishedBy: OPERATOR,
    });
    assert.equal((await shariah.getAssetById(idD))!.effectiveStatus, "ELIGIBLE");

    // A later ticker change on an asset that was EXCLUDED in the snapshot.
    await query("UPDATE shariah_asset_binance_mappings SET base_asset = $1 WHERE asset_id = $2",
      ["SYNTHBX", idB]);
    // And a later delisting.
    await syncShariahUniverse(client, [SYNTH.A, SYNTH.C, SYNTH.D, SYNTH.E]);

    const after = await shariah.getSnapshot(snapshotOne.snapshotId);
    assert.deepEqual(after, before, "snapshot one changed after later registry writes");
    assert.equal(after!.contentHash, snapshotOne.contentHash);
    assert.deepEqual(after!.entries, snapshotOne.entries);
    // The snapshot still says SYNTHBB, EXCLUDED, available — the ticker has
    // moved and the asset has been delisted since, and neither reached back.
    const frozen = after!.entries.find((e) => e.assetId === idB)!;
    assert.equal(frozen.baseAsset, SYNTH.B);
    assert.equal(frozen.effectiveStatus, "EXCLUDED");
    assert.equal(frozen.binanceAvailable, true);
    // The snapshot's UNSCREENED member is still UNSCREENED there.
    assert.equal(after!.entries.find((e) => e.assetId === idD)!.effectiveStatus, "REVIEW");

    // The database refuses to rewrite a snapshot at all.
    await assert.rejects(
      query("UPDATE shariah_universe_snapshots SET content_hash = $1 WHERE snapshot_id = $2",
        ["0".repeat(64), snapshotOne.snapshotId]),
      /shariah append-only violation: UPDATE on shariah_universe_snapshots/);
    await assert.rejects(
      query("UPDATE shariah_universe_snapshot_entries SET effective_status = 'ELIGIBLE' WHERE snapshot_id = $1",
        [snapshotOne.snapshotId]),
      /shariah append-only violation: UPDATE on shariah_universe_snapshot_entries/);
    await assert.rejects(
      query("DELETE FROM shariah_universe_snapshot_entries WHERE snapshot_id = $1", [snapshotOne.snapshotId]),
      /shariah append-only violation: DELETE on shariah_universe_snapshot_entries/);
  });

  // ── L: the read contract returns exactly what was stored ────────────────
  await t.test("L: the snapshot read contract returns the stored policy, status and content identity", async () => {
    const read = await shariah.getSnapshot(snapshotOne.snapshotId);
    assert.ok(read);
    assert.equal(read.snapshotId, snapshotOne.snapshotId);
    assert.equal(read.policyVersion, TS_SHARIAH_V1);
    assert.equal(read.contentHash, snapshotOne.contentHash);
    assert.equal(read.entryCount, snapshotOne.entries.length);
    assert.equal(read.createdBy, OPERATOR);
    assert.deepEqual(read.entries, snapshotOne.entries);
    // The identity is verifiable by the consumer: rehashing the membership it
    // was handed reproduces the stored content hash.
    assert.equal(snapshotContentHash(read.policyVersion, read.entries), read.contentHash);

    const listed = await shariah.listSnapshots(10);
    assert.ok(listed.some((s) => s.snapshotId === read.snapshotId && s.contentHash === read.contentHash));
    assert.equal((await shariah.getSnapshot("999999999")), null);
  });

  // ── Evidence provenance ─────────────────────────────────────────────────
  await t.test("a publication cannot cite another asset's evidence", async () => {
    await assert.rejects(publishShariahDecision(client, {
      assetId: idC, policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
      reason: "Citing evidence that belongs to a different asset.",
      evidenceIds: [evidenceA1], reviewedAt: REVIEWED_AT, publishedBy: OPERATOR,
    }), /evidence not found for this asset/);
    assert.equal((await shariah.getAssetById(idC))!.effectiveStatus, "REVIEW");
  });

  await t.test("cited evidence cannot be deleted out from under its decision", async () => {
    await assert.rejects(
      query("DELETE FROM shariah_evidence WHERE id = $1", [evidenceA1]),
      /shariah_publication_evidence/);
  });
});
