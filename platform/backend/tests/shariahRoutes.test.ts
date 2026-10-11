/**
 * The Shariah HTTP boundary: authentication, and the fact that a refused
 * publication never reaches the database.
 *
 * The auth assertion is the one that matters for the Research-facing contract.
 * `api/server.ts` gates every path that is not in `PUBLIC_PATHS`, so these
 * routes are protected by NOT being listed there — a property that is invisible
 * in this file and would be silently lost if someone added one. It is asserted
 * here against the real server rather than by reading the route file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import type { PoolClient } from "pg";
import { config } from "../src/config";
import { buildServer } from "../src/api/server";
import { shariahRoutes } from "../src/api/routes/shariah";
import { SESSION_COOKIE, signSession } from "../src/security/session";
import type { LiveRunner } from "../src/engine/liveRunner";
import { TS_SHARIAH_V1 } from "../src/shariah/policy";
import { toPublication, type PublicationRow, type ShariahAssetState } from "../src/repositories/shariah";

const SHARIAH_PATHS: Array<{ method: "GET" | "POST" | "PUT"; url: string }> = [
  { method: "GET", url: "/api/shariah/universe" },
  // The registry's only production population path. It writes, so it being
  // absent from PUBLIC_PATHS is not a formality.
  { method: "POST", url: "/api/shariah/universe/sync" },
  { method: "GET", url: "/api/shariah/assets/1" },
  { method: "POST", url: "/api/shariah/assets/1/evidence" },
  { method: "POST", url: "/api/shariah/assets/1/publications" },
  { method: "POST", url: "/api/shariah/snapshots" },
  { method: "GET", url: "/api/shariah/snapshots" },
  { method: "GET", url: "/api/shariah/snapshots/latest" },
  { method: "GET", url: "/api/shariah/snapshots/1" },
  // The batch review workflow. The pack is the one route that produces a file
  // intended to leave the machine, so it being behind the session gate matters
  // as much as the publication routes do.
  { method: "GET", url: "/api/shariah/review-pack" },
  { method: "POST", url: "/api/shariah/review-results/preview" },
  { method: "POST", url: "/api/shariah/review-results/import" },
  { method: "GET", url: "/api/shariah/mode" },
  { method: "PUT", url: "/api/shariah/mode" },
  { method: "GET", url: "/api/shariah/status" },
];

test("every Shariah route — snapshot reads included — requires a session", async (t) => {
  const previous = { ...config };
  config.authEnabled = true;
  config.adminUsername = "owner";
  config.sessionSecret = "shariah-route-test-session-secret-000000000000";
  t.after(() => Object.assign(config, previous));

  const app = buildServer(() => ({} as LiveRunner));
  t.after(() => app.close());

  for (const route of SHARIAH_PATHS) {
    const denied = await app.inject({ ...route, payload: route.method === "GET" ? undefined : {} });
    assert.equal(denied.statusCode, 401, `${route.method} ${route.url} was reachable without a session`);
    assert.deepEqual(denied.json(), { error: "not authenticated" });
  }

  // The signed-in operator gets past the gate (the publish route then refuses
  // the empty body on its own terms, which is the next test's subject).
  const token = signSession("owner", config.sessionSecret);
  const allowed = await app.inject({
    method: "POST", url: "/api/shariah/assets/1/publications",
    headers: { cookie: `${SESSION_COOKIE}=${token}` }, payload: {},
  });
  assert.notEqual(allowed.statusCode, 401);
});

/** Records every statement, so "nothing reached the database" is checkable. */
class RecordingClient {
  readonly statements: string[] = [];
  async query<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> {
    this.statements.push(sql);
    return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  }
  release(): void { /* pooled client stand-in */ }
}

async function routeApp(client: RecordingClient) {
  const app = Fastify({ logger: false });
  await app.register(shariahRoutes, {
    connect: async () => client as unknown as PoolClient,
  });
  return app;
}

test("an incomplete publication is refused as a 400 without touching the database", async (t) => {
  const previous = { ...config };
  config.authEnabled = false;
  t.after(() => Object.assign(config, previous));

  const client = new RecordingClient();
  const app = await routeApp(client);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST", url: "/api/shariah/assets/7/publications",
    payload: { classification: "ELIGIBLE" },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /requires a reason/);
  assert.deepEqual(client.statements, []);
});

test("a non-numeric asset or snapshot id is refused before any lookup", async (t) => {
  const previous = { ...config };
  config.authEnabled = false;
  t.after(() => Object.assign(config, previous));

  const client = new RecordingClient();
  const app = await routeApp(client);
  t.after(() => app.close());

  for (const url of [
    "/api/shariah/assets/BTC/publications",
    "/api/shariah/assets/1;DROP/publications",
  ]) {
    const response = await app.inject({ method: "POST", url, payload: { classification: "REVIEW" } });
    assert.equal(response.statusCode, 400, url);
    assert.match(response.json().error, /assetId must be numeric/);
  }

  const snapshot = await app.inject({ method: "GET", url: "/api/shariah/snapshots/abc" });
  assert.equal(snapshot.statusCode, 400);
  assert.deepEqual(client.statements, []);
});

// ── The batch review workflow at the HTTP boundary ─────────────────────────

function registryAsset(over: Partial<ShariahAssetState> & { assetId: string; baseAsset: string }): ShariahAssetState {
  return {
    projectName: null, binanceAvailable: true, classification: "REVIEW", lifecycle: "UNSCREENED",
    effectiveStatus: "REVIEW", policyVersion: TS_SHARIAH_V1, reason: null, prohibitedCategories: [],
    reviewedAt: null, publishedAt: null, updatedAt: "2026-08-01T00:00:00.000Z",
    currentPublicationId: null, ...over,
  };
}

const PACK_REGISTRY: ShariahAssetState[] = [
  registryAsset({ assetId: "5", baseAsset: "ZZZ", lifecycle: "SCREENED", classification: "ELIGIBLE",
    effectiveStatus: "ELIGIBLE", reviewedAt: "2026-08-01T00:00:00.000Z" }),
  registryAsset({ assetId: "1", baseAsset: "AAA" }),
  registryAsset({ assetId: "3", baseAsset: "CCC", lifecycle: "STALE", classification: "EXCLUDED" }),
  registryAsset({ assetId: "2", baseAsset: "BBB" }),
];

async function packApp(reads: { calls: number }) {
  const app = Fastify({ logger: false });
  await app.register(shariahRoutes, {
    connect: async () => { throw new Error("the review pack must not take a pooled connection"); },
    reviewPackReads: {
      listAllAssets: async () => { reads.calls += 1; return PACK_REGISTRY; },
      loadReviewPackContext: async () => ({ publications: new Map(), evidence: new Map() }),
      getReviewPolicy: async () => ({ reviewMaxAgeDays: null }),
    },
  });
  return app;
}

test("a review pack can be exactly the assets the operator chose, in the queue's own priority", async (t) => {
  const reads = { calls: 0 };
  const app = await packApp(reads);
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/shariah/review-pack?assetIds=5,1,3" });
  assert.equal(response.statusCode, 200, response.body);
  const pack = response.json() as { assets: Array<{ assetId: string }>; assetCount: number; batchSize: number };
  // STALE first, then UNSCREENED, then the settled ELIGIBLE the operator asked
  // for by name — BBB was not chosen and is not there.
  assert.deepEqual(pack.assets.map((a) => a.assetId), ["3", "1", "5"]);
  assert.equal(pack.assetCount, 3);
  assert.equal(pack.batchSize, 3);

  // The queue path is unchanged: settled ZZZ is not in it, and size applies.
  const queue = await app.inject({ method: "GET", url: "/api/shariah/review-pack?size=2" });
  assert.deepEqual((queue.json() as { assets: Array<{ assetId: string }> }).assets.map((a) => a.assetId), ["3", "1"]);
  const settled = await app.inject({ method: "GET", url: "/api/shariah/review-pack?includeSettled=true" });
  assert.ok((settled.json() as { assets: Array<{ assetId: string }> }).assets.some((a) => a.assetId === "5"));
});

test("an unknown, malformed, oversized or size-capped selection is a 400 that names the problem", async (t) => {
  const reads = { calls: 0 };
  const app = await packApp(reads);
  t.after(() => app.close());

  const unknown = await app.inject({ method: "GET", url: "/api/shariah/review-pack?assetIds=1,404,3,405" });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().error, /unknown assetIds: 404, 405/);
  assert.deepEqual(unknown.json().unknownAssetIds, ["404", "405"]);

  const before = reads.calls;
  for (const url of [
    "/api/shariah/review-pack?assetIds=1,BTC",
    "/api/shariah/review-pack?assetIds=1,1",
    "/api/shariah/review-pack?assetIds=",
    `/api/shariah/review-pack?assetIds=${Array.from({ length: 101 }, (_, i) => i + 1).join(",")}`,
    "/api/shariah/review-pack?assetIds=1,3&size=1",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 400, url);
  }
  assert.equal(reads.calls, before, "a refused selection still read the registry");
});

/** Answers just enough of the import's SQL for one UNSCREENED asset, AAA (#1). */
class ImportClient {
  readonly statements: string[] = [];
  private readonly inserted: string[] = [];
  async query<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> {
    this.statements.push(sql.trim());
    const ok = (rows: unknown[]): QueryResult<T> =>
      ({ rows: rows as T[], rowCount: rows.length, command: "", oid: 0, fields: [] });
    if (/FROM shariah_asset_binance_mappings m/.test(sql)) {
      return ok([{ asset_id: "1", base_asset: "AAA", binance_available: true, lifecycle: "UNSCREENED", updated_at: null }]);
    }
    if (/INSERT INTO shariah_evidence/.test(sql)) {
      const id = String(100 + this.inserted.length);
      this.inserted.push(id);
      return ok([{ id }]);
    }
    if (/SELECT id FROM shariah_evidence/.test(sql)) return ok(this.inserted.map((id) => ({ id })));
    if (/FROM shariah_assets a/.test(sql)) return ok([{ asset_id: "1", base_asset: "AAA", project_name: null }]);
    if (/INSERT INTO shariah_publications/.test(sql)) {
      return ok([{ publication_id: "77", published_at: "2026-09-02T00:00:00.000Z", reviewed_at: "2026-09-01T12:00:00.000Z" }]);
    }
    return ok([]);
  }
  release(): void { /* pooled client stand-in */ }
}

function uncertainEligibleDocument(): Record<string, unknown> {
  return {
    format: "TS_SHARIAH_REVIEW_RESULTS_V1", policyVersion: TS_SHARIAH_V1,
    researchCompletedAt: "2026-09-01T12:00:00.000Z", packGeneratedAt: "2026-09-01T08:00:00.000Z",
    results: [{
      assetId: "1", baseAsset: "AAA", policyVersion: TS_SHARIAH_V1, classification: "ELIGIBLE",
      answers: {
        project: "A synthetic ledger.", tokenFunction: "Pays fees.", rightsExposure: "No claim.",
        coreActivities: "Operating a ledger.", prohibitedEvidence: "None found.",
        evidenceSufficiency: "Mostly consistent.",
      },
      reason: "Core activity is a neutral ledger.",
      prohibitedCategories: [],
      evidence: [{ url: "https://example.com/docs", title: "Docs", publisher: "Example",
        retrievedAt: "2026-09-01T10:00:00.000Z", note: "Describes the ledger." }],
      unresolvedUncertainties: ["Treasury use of funds is undisclosed."],
    }],
  };
}

async function importApp(client: ImportClient, connects: { n: number }) {
  const app = Fastify({ logger: false });
  await app.register(shariahRoutes, {
    connect: async () => { connects.n += 1; return client as unknown as PoolClient; },
  });
  return app;
}

test("the preview shows the whole decision, and flags an ELIGIBLE that lists open questions", async (t) => {
  const previous = { ...config };
  config.authEnabled = false;
  t.after(() => Object.assign(config, previous));
  const client = new ImportClient();
  const app = await importApp(client, { n: 0 });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST", url: "/api/shariah/review-results/preview", payload: uncertainEligibleDocument(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json();
  assert.equal(preview.packGeneratedAt, "2026-09-01T08:00:00.000Z");
  assert.deepEqual(preview.acknowledgementRequired, ["1"]);
  const row = preview.results[0];
  assert.equal(row.reason, "Core activity is a neutral ledger.");
  assert.equal(row.answers.coreActivities, "Operating a ledger.");
  assert.deepEqual(row.evidence[0], { url: "https://example.com/docs", title: "Docs", publisher: "Example",
    retrievedAt: "2026-09-01T10:00:00.000Z", note: "Describes the ledger." });
  assert.deepEqual(row.unresolvedUncertainties, ["Treasury use of funds is undisclosed."]);
  assert.equal(row.requiresAcknowledgement, true);
  assert.equal(client.statements.some((s) => /^(INSERT|BEGIN)/.test(s)), false, "a preview wrote");
});

test("an import refuses an unacknowledged ELIGIBLE-with-uncertainties as a 400 naming the asset and field", async (t) => {
  const previous = { ...config };
  config.authEnabled = false;
  t.after(() => Object.assign(config, previous));
  const client = new ImportClient();
  const connects = { n: 0 };
  const app = await importApp(client, connects);
  t.after(() => app.close());

  const refused = await app.inject({
    method: "POST", url: "/api/shariah/review-results/import", payload: uncertainEligibleDocument(),
  });
  assert.equal(refused.statusCode, 400);
  const issue = refused.json().issues.find((i: { field?: string }) => i.field === "unresolvedUncertainties");
  assert.ok(issue, refused.body);
  assert.equal(issue.assetId, "1");
  assert.equal(issue.baseAsset, "AAA");
  assert.equal(client.statements.some((s) => /^(INSERT|BEGIN)/.test(s)), false, "a refused import wrote");

  // A malformed acknowledgement is refused before a connection is even taken.
  const before = connects.n;
  const malformed = await app.inject({
    method: "POST", url: "/api/shariah/review-results/import?acknowledgedAssetIds=AAA",
    payload: uncertainEligibleDocument(),
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().issues[0].field, "acknowledgedAssetIds");
  assert.equal(connects.n, before);

  // And with the operator's acknowledgement, the same file publishes.
  const accepted = await app.inject({
    method: "POST", url: "/api/shariah/review-results/import?acknowledgedAssetIds=1",
    payload: uncertainEligibleDocument(),
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().importedCount, 1);
});

test("a publication's source is read back: manual, review_import, or unknown for old rows", () => {
  const row = (source: string | null): PublicationRow => ({
    publication_id: "9", asset_id: "1", policy_version: TS_SHARIAH_V1, classification: "REVIEW",
    reason: "r", prohibited_categories: null, base_asset_at_publication: "AAA",
    project_name_at_publication: null, reviewed_at: "2026-09-01T00:00:00.000Z",
    published_at: "2026-09-01T00:00:00.000Z", published_by: "owner", source, evidence_ids: null,
  });
  assert.equal(toPublication(row("manual")).source, "manual");
  assert.equal(toPublication(row("review_import")).source, "review_import");
  // Rows from before migration 043 are NULL, and stay unknown rather than guessed.
  assert.equal(toPublication(row(null)).source, null);
  assert.equal(toPublication(row("something-else")).source, null);
});
