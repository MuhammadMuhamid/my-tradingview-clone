/**
 * The manual-research batch workflow: what leaves the machine in a review pack,
 * and what is allowed back in as results.
 *
 * The two properties worth pinning are the ones a later change would break
 * silently. First, the pack is written to be handed to a third party, so it
 * must carry registry facts and nothing else — a test that only checked the
 * fields it expects would not notice a new one appearing. Second, a STALE asset
 * must not be reconfirmable: the import contract has no vocabulary for citing a
 * prior decision, and evidence predating the staleness event is refused.
 *
 * All of this runs without PostgreSQL; the recording client below proves the
 * database statements an import would issue, including that a rejected import
 * issues none at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import { TS_SHARIAH_V1 } from "../src/shariah/policy";
import {
  DEFAULT_REVIEW_BATCH_SIZE, REVIEW_PACK_FORMAT, REVIEW_RESULTS_FORMAT,
  buildReviewPack, selectReviewBatch, type ReviewPackSource,
} from "../src/shariah/reviewPack";
import {
  ShariahReviewImportError, composeReason, importShariahReviewResults,
  parseReviewResults, validateAgainstRegistry, type ImportRegistryAsset,
} from "../src/shariah/reviewImport";

// ── fixtures ────────────────────────────────────────────────────────────────

const STALE_SINCE = "2026-06-01T00:00:00.000Z";

function source(over: Partial<ReviewPackSource> & { assetId: string; baseAsset: string }): ReviewPackSource {
  return {
    projectName: null,
    binanceAvailable: true,
    classification: "REVIEW",
    lifecycle: "UNSCREENED",
    effectiveStatus: "REVIEW",
    policyVersion: TS_SHARIAH_V1,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** One of every state, in an order that is NOT the expected output order. */
function mixedRegistry(): ReviewPackSource[] {
  return [
    source({ assetId: "5", baseAsset: "ZZZ", lifecycle: "SCREENED", classification: "ELIGIBLE", effectiveStatus: "ELIGIBLE" }),
    source({ assetId: "2", baseAsset: "BBB", lifecycle: "SCREENED", classification: "REVIEW", effectiveStatus: "REVIEW" }),
    source({ assetId: "1", baseAsset: "AAA", lifecycle: "UNSCREENED" }),
    source({ assetId: "4", baseAsset: "DDD", lifecycle: "STALE", classification: "ELIGIBLE", effectiveStatus: "REVIEW", updatedAt: STALE_SINCE }),
    source({ assetId: "6", baseAsset: "EEE", lifecycle: "SCREENED", classification: "EXCLUDED", effectiveStatus: "EXCLUDED" }),
    source({ assetId: "3", baseAsset: "CCC", lifecycle: "STALE", classification: "EXCLUDED", effectiveStatus: "REVIEW", updatedAt: STALE_SINCE }),
    source({ assetId: "7", baseAsset: "FFF", lifecycle: "UNSCREENED", binanceAvailable: false }),
  ];
}

function evidence(over: Partial<{ url: string; title: string; publisher: string; retrievedAt: string; note: string }> = {}) {
  return {
    url: "https://example.com/docs",
    title: "Protocol documentation",
    publisher: "Example Foundation",
    retrievedAt: "2026-09-01T10:00:00.000Z",
    note: "The documentation describes the protocol's core product.",
    ...over,
  };
}

function answers() {
  return {
    project: "A synthetic test project.",
    tokenFunction: "The token pays network fees.",
    rightsExposure: "No equity, dividend or debt claim.",
    coreActivities: "Operating a general-purpose ledger.",
    prohibitedEvidence: "No evidence of any TS_SHARIAH_V1 prohibited category was found.",
    evidenceSufficiency: "Primary sources are consistent and unambiguous.",
  };
}

function result(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assetId: "1", baseAsset: "AAA", policyVersion: TS_SHARIAH_V1,
    classification: "ELIGIBLE", answers: answers(),
    reason: "The project's own core activity is a general-purpose ledger.",
    prohibitedCategories: [], evidence: [evidence()], unresolvedUncertainties: [],
    ...over,
  };
}

function document(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: REVIEW_RESULTS_FORMAT, policyVersion: TS_SHARIAH_V1,
    researchCompletedAt: "2026-09-01T12:00:00.000Z",
    results: [result()],
    ...over,
  };
}

function registry(...assets: ImportRegistryAsset[]): Map<string, ImportRegistryAsset> {
  return new Map(assets.map((a) => [a.assetId, a]));
}

const AAA: ImportRegistryAsset = {
  assetId: "1", baseAsset: "AAA", lifecycle: "UNSCREENED", binanceAvailable: true, staleSince: null,
};
const STALE_DDD: ImportRegistryAsset = {
  assetId: "4", baseAsset: "DDD", lifecycle: "STALE", binanceAvailable: true, staleSince: STALE_SINCE,
};

const rejects = (run: () => unknown, match: RegExp): ShariahReviewImportError => {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  assert.ok(caught instanceof ShariahReviewImportError, `expected a rejection, got ${caught}`);
  const messages = (caught as ShariahReviewImportError).issues.map((i) => i.message).join(" | ");
  assert.match(messages, match);
  return caught as ShariahReviewImportError;
};

// ── 1: the default batch is 20, deterministically ordered ───────────────────

test("the default review batch is 20 assets", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    source({ assetId: String(i + 1), baseAsset: `A${String(i).padStart(3, "0")}` }));
  const { batch, batchSize, needsReviewTotal } = selectReviewBatch(many);
  assert.equal(DEFAULT_REVIEW_BATCH_SIZE, 20);
  assert.equal(batchSize, 20);
  assert.equal(batch.length, 20);
  assert.equal(needsReviewTotal, 50);
});

test("the batch is ordered STALE, then UNSCREENED, then REVIEW, and is stable", () => {
  const { batch } = selectReviewBatch(mixedRegistry());
  assert.deepEqual(batch.map((a) => a.baseAsset), ["CCC", "DDD", "AAA", "BBB"]);
  // Same registry in a different arrival order produces the same batch.
  const shuffled = selectReviewBatch([...mixedRegistry()].reverse());
  assert.deepEqual(shuffled.batch.map((a) => a.baseAsset), batch.map((a) => a.baseAsset));
});

test("settled ELIGIBLE/EXCLUDED assets are not in the default batch, and delisted ones never are", () => {
  const { batch } = selectReviewBatch(mixedRegistry());
  assert.equal(batch.some((a) => a.baseAsset === "ZZZ"), false, "a settled ELIGIBLE was queued for review");
  assert.equal(batch.some((a) => a.baseAsset === "EEE"), false, "a settled EXCLUDED was queued for review");
  assert.equal(batch.some((a) => a.baseAsset === "FFF"), false, "a delisted asset was queued for review");

  const settled = selectReviewBatch(mixedRegistry(), { includeSettled: true });
  assert.equal(settled.batch.some((a) => a.baseAsset === "ZZZ"), true);
});

// ── 2: STALE asks for a full fresh screening, in the pack itself ────────────

test("a STALE entry states that a full fresh screening is required, and when it went stale", () => {
  const { batch, needsReviewTotal } = selectReviewBatch(mixedRegistry());
  const pack = buildReviewPack(batch, {
    generatedAt: "2026-09-02T00:00:00.000Z", batchSize: 20, needsReviewTotal,
  });
  const stale = pack.assets.find((a) => a.baseAsset === "DDD");
  assert.ok(stale);
  assert.equal(stale.requiresFullFreshScreening, true);
  assert.equal(stale.staleSince, STALE_SINCE);
  assert.match(stale.reviewReason, /FULL FRESH SCREENING/);
  assert.match(stale.reviewReason, /do not reconfirm or copy the previous classification/i);

  const unscreened = pack.assets.find((a) => a.baseAsset === "AAA");
  assert.equal(unscreened?.requiresFullFreshScreening, false);
  assert.equal(unscreened?.staleSince, null);

  // The instructions repeat it, because that is the text the researcher reads.
  assert.match(pack.instructions.join("\n"), /requiresFullFreshScreening.*screen it from scratch/s);
});

test("the pack is deterministic and carries the fixed TS_SHARIAH_V1 vocabulary unchanged", () => {
  const { batch, needsReviewTotal } = selectReviewBatch(mixedRegistry());
  const options = { generatedAt: "2026-09-02T00:00:00.000Z", batchSize: 20, needsReviewTotal };
  assert.equal(
    JSON.stringify(buildReviewPack(batch, options)),
    JSON.stringify(buildReviewPack(batch, options))
  );

  const pack = buildReviewPack(batch, options);
  assert.equal(pack.format, REVIEW_PACK_FORMAT);
  assert.equal(pack.policyVersion, TS_SHARIAH_V1);
  assert.equal(pack.policy.prohibitedCategories.length, 8);
  assert.equal(pack.policy.questions.length, 6);
  // No invented methodology may ride along in the researcher's instructions.
  const prose = [...pack.instructions, ...pack.policy.interpretationRules].join("\n");
  assert.match(prose, /Do NOT apply revenue thresholds/);
  assert.match(prose, /memecoins, DeFi, DEXs, staking, L1\/L2, GameFi or AI tokens/);
  assert.doesNotMatch(prose, /threshold of \d/);
});

// ── 3: nothing private leaves in a pack ────────────────────────────────────

test("a review pack contains no secret, credential, session or trading state", () => {
  const { batch, needsReviewTotal } = selectReviewBatch(mixedRegistry());
  const pack = buildReviewPack(
    batch.map((a) => ({
      ...a,
      priorPublication: {
        publicationId: "9", classification: "ELIGIBLE" as const, policyVersion: TS_SHARIAH_V1,
        reason: "prior", prohibitedCategories: [], reviewedAt: STALE_SINCE, publishedAt: STALE_SINCE,
      },
      priorEvidence: [{ evidenceId: "3", url: "https://example.com", title: "t", publisher: "p", retrievedAt: STALE_SINCE }],
    })),
    { generatedAt: "2026-09-02T00:00:00.000Z", batchSize: 20, needsReviewTotal }
  );
  const serialised = JSON.stringify(pack).toLowerCase();
  for (const forbidden of [
    "secret", "password", "apikey", "api_key", "hmac", "session", "cookie", "token=",
    "authorization", "privatekey", "private_key", "balance", "position", "order",
    "quantity", "pnl", "webhook", "username", "@", "database_url", "postgres",
  ]) {
    assert.equal(serialised.includes(forbidden), false, `review pack leaked ${forbidden}`);
  }

  // Positive control: the per-asset shape is a closed, known set of registry fields.
  assert.deepEqual(Object.keys(pack.assets[0]!).sort(), [
    "assetId", "baseAsset", "binanceAvailable", "classification", "effectiveStatus",
    "lifecycle", "policyVersion", "priorEvidence", "priorPublication", "projectName",
    "requiresFullFreshScreening", "reviewReason", "staleSince",
  ]);
  // Prior evidence is a reference list only — no excerpt bodies are re-exported.
  assert.deepEqual(Object.keys(pack.assets[0]!.priorEvidence[0]!).sort(),
    ["evidenceId", "publisher", "retrievedAt", "title", "url"]);
});

// ── 4-6: what a valid result file may say ──────────────────────────────────

test("a complete ELIGIBLE result parses and keeps its evidence", () => {
  const parsed = parseReviewResults(document());
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0]!.classification, "ELIGIBLE");
  assert.equal(parsed.results[0]!.evidence.length, 1);
  assert.equal(parsed.researchCompletedAt, "2026-09-01T12:00:00.000Z");
});

test("EXCLUDED requires a fixed-vocabulary category and supporting evidence", () => {
  rejects(() => parseReviewResults(document({ results: [result({
    classification: "EXCLUDED", prohibitedCategories: [], evidence: [evidence()],
  })] })), /EXCLUDED requires at least one prohibited category/);

  rejects(() => parseReviewResults(document({ results: [result({
    classification: "EXCLUDED", prohibitedCategories: ["GAMBLING_BETTING_CASINO"], evidence: [],
  })] })), /EXCLUDED requires at least one evidence entry/);

  const ok = parseReviewResults(document({ results: [result({
    classification: "EXCLUDED", prohibitedCategories: ["GAMBLING_BETTING_CASINO"], evidence: [evidence()],
  })] }));
  assert.deepEqual(ok.results[0]!.prohibitedCategories, ["GAMBLING_BETTING_CASINO"]);
});

test("ELIGIBLE requires evidence and cannot carry categories", () => {
  rejects(() => parseReviewResults(document({ results: [result({ evidence: [] })] })),
    /absence of evidence is not proof of eligibility/);
  rejects(() => parseReviewResults(document({ results: [result({ prohibitedCategories: ["ALCOHOL"] })] })),
    /ELIGIBLE cannot carry prohibited categories/);
});

test("REVIEW imports safely with no evidence, and still has to say why", () => {
  const parsed = parseReviewResults(document({ results: [result({
    classification: "REVIEW", evidence: [],
    reason: "Sources conflict on whether the lending product charges interest.",
    unresolvedUncertainties: ["Whether the lending product is interest-bearing."],
  })] }));
  assert.equal(parsed.results[0]!.classification, "REVIEW");
  assert.equal(parsed.results[0]!.evidence.length, 0);

  rejects(() => parseReviewResults(document({ results: [result({
    classification: "REVIEW", evidence: [], reason: "   ",
  })] })), /reason must not be empty/);
});

// ── 7: malformed / hostile files are refused ───────────────────────────────

test("the wrong format or policy version is refused", () => {
  rejects(() => parseReviewResults(document({ format: "SOMETHING_ELSE" })), /format must be/);
  rejects(() => parseReviewResults(document({ policyVersion: "TS_SHARIAH_V2" })), /policyVersion must be/);
  rejects(() => parseReviewResults(document({ results: [result({ policyVersion: "TS_SHARIAH_V2" })] })),
    /policyVersion must be/);
});

test("an invented prohibited category is refused, whatever it is called", () => {
  for (const invented of ["MEME", "HIGH_LEVERAGE", "riba_interest_based_finance", "DEFI"]) {
    rejects(() => parseReviewResults(document({ results: [result({
      classification: "EXCLUDED", prohibitedCategories: [invented],
    })] })), /is not a\s+TS_SHARIAH_V1 category/);
  }
});

test("evidence must cite a real http(s) URL and a retrieval time that is not in the future", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>x</script>", "not a url", "file:///etc/passwd"]) {
    rejects(() => parseReviewResults(document({ results: [result({ evidence: [evidence({ url })] })] })),
      /must be http\(s\)|is not a valid absolute URL/);
  }
  rejects(() => parseReviewResults(document({ results: [result({
    evidence: [evidence({ retrievedAt: new Date(Date.now() + 86_400_000).toISOString() })],
  })] })), /cannot be in the future/);
  rejects(() => parseReviewResults(document({ results: [result({
    evidence: [evidence({ title: "" })],
  })] })), /title must not be empty/);
});

test("an unrecognised field is an error, not a silently ignored extra", () => {
  // The specific shapes a copy-forward would take. None of them exists.
  rejects(() => parseReviewResults(document({ results: [result({ evidenceIds: ["3"] })] })),
    /unrecognised field "evidenceIds"/);
  rejects(() => parseReviewResults(document({ results: [result({ publicationId: "9" })] })),
    /unrecognised field "publicationId"/);
  rejects(() => parseReviewResults(document({ results: [result({ reconfirm: true })] })),
    /unrecognised field "reconfirm"/);
  rejects(() => parseReviewResults(document({ results: [result({ lifecycle: "SCREENED" })] })),
    /unrecognised field "lifecycle"/);
  rejects(() => parseReviewResults(document({ sql: "DROP TABLE shariah_publications" })),
    /unrecognised top-level field "sql"/);
});

test("duplicate and empty result sets are refused", () => {
  rejects(() => parseReviewResults(document({ results: [result(), result({ classification: "REVIEW", evidence: [] })] })),
    /duplicate result for assetId 1/);
  rejects(() => parseReviewResults(document({ results: [] })), /nothing to import/);
});

test("every problem in a file is reported at once", () => {
  const error = rejects(() => parseReviewResults(document({
    results: [result({ assetId: "abc", evidence: [evidence({ url: "nope" })], reason: "" })],
  })), /assetId must be/);
  assert.ok(error.issues.length >= 3, `expected several issues, got ${error.issues.length}`);
  assert.equal(error.issues[0]!.index, 0);
});

// ── 8: registry agreement, and the STALE reconfirmation block ──────────────

test("an unknown asset or a mismatched base symbol is refused", () => {
  rejects(() => validateAgainstRegistry(parseReviewResults(document()), registry()),
    /unknown assetId 1/);
  rejects(
    () => validateAgainstRegistry(parseReviewResults(document({ results: [result({ baseAsset: "XXX" })] })), registry(AAA)),
    /baseAsset mismatch: assetId 1 is AAA in the registry, the file says XXX/
  );
  assert.doesNotThrow(() => validateAgainstRegistry(parseReviewResults(document()), registry(AAA)));
});

test("a STALE asset cannot be reconfirmed with research predating the staleness event", () => {
  const staleResult = (retrievedAt: string, classification = "ELIGIBLE") => document({
    results: [result({
      assetId: "4", baseAsset: "DDD", classification,
      ...(classification === "REVIEW" ? { reason: "still unclear" } : {}),
      evidence: [evidence({ retrievedAt })],
    })],
  });

  // The exact attack: last year's sources pasted back to restore ELIGIBLE.
  rejects(
    () => validateAgainstRegistry(parseReviewResults(staleResult("2026-01-01T00:00:00.000Z")), registry(STALE_DDD)),
    /is STALE and requires a FULL fresh screening/
  );
  // A published REVIEW is not a loophole either — the freshness rule is unconditional.
  rejects(
    () => validateAgainstRegistry(parseReviewResults(staleResult("2026-01-01T00:00:00.000Z", "REVIEW")), registry(STALE_DDD)),
    /is STALE and requires a FULL fresh screening/
  );
  // Research actually performed after the ticker reappeared is accepted.
  assert.doesNotThrow(() =>
    validateAgainstRegistry(parseReviewResults(staleResult("2026-09-01T10:00:00.000Z")), registry(STALE_DDD)));
});

// ── 9: the import goes through the existing publication authority ──────────

/** Records every statement so "which writes happened, in what order" is checkable. */
class RecordingClient {
  readonly statements: string[] = [];
  private nextId = 100;
  /** Evidence rows this client has "inserted", so the ownership check below is real. */
  private readonly inserted: string[] = [];
  async query<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> {
    this.statements.push(sql.trim());
    const empty = { rowCount: 0, command: "", oid: 0, fields: [] };
    if (/FROM shariah_asset_binance_mappings m/.test(sql)) {
      return { ...empty, rows: [{ asset_id: "1", base_asset: "AAA", binance_available: true,
        lifecycle: "UNSCREENED", updated_at: null }] as unknown as T[] };
    }
    if (/INSERT INTO shariah_evidence/.test(sql)) {
      const id = String(this.nextId++);
      this.inserted.push(id);
      return { ...empty, rows: [{ id }] as unknown as T[] };
    }
    // publication.ts refuses to cite evidence that does not belong to the
    // asset. Answering it honestly is what makes this test prove the import
    // really goes through that check rather than around it.
    if (/SELECT id FROM shariah_evidence/.test(sql)) {
      return { ...empty, rows: this.inserted.map((id) => ({ id })) as unknown as T[] };
    }
    if (/FROM shariah_assets a/.test(sql)) {
      return { ...empty, rows: [{ asset_id: "1", base_asset: "AAA", project_name: null }] as unknown as T[] };
    }
    if (/INSERT INTO shariah_publications/.test(sql)) {
      return { ...empty, rows: [{ publication_id: "77", published_at: "2026-09-02T00:00:00.000Z",
        reviewed_at: "2026-09-01T12:00:00.000Z" }] as unknown as T[] };
    }
    return { ...empty, rows: [] as unknown as T[] };
  }
}

const matching = (client: RecordingClient, re: RegExp): string[] =>
  client.statements.filter((s) => re.test(s));

test("a valid import publishes through the publication authority, with evidence and history", async () => {
  const client = new RecordingClient();
  const summary = await importShariahReviewResults(client, {
    document: document(), publishedBy: "owner",
  });

  assert.equal(summary.importedCount, 1);
  assert.deepEqual(summary.counts, { ELIGIBLE: 1, EXCLUDED: 0, REVIEW: 0 });
  assert.equal(summary.outcomes[0]!.publicationId, "77");
  assert.deepEqual(summary.outcomes[0]!.evidenceIds, ["100"]);
  assert.equal(summary.publishedBy, "owner");

  // The full publication footprint, produced by publication.ts rather than by
  // a second writer: evidence, immutable history row, evidence join, current
  // pointer — all inside ONE transaction.
  assert.equal(matching(client, /^INSERT INTO shariah_evidence/).length, 1);
  assert.equal(matching(client, /^INSERT INTO shariah_publications/).length, 1);
  assert.equal(matching(client, /^INSERT INTO shariah_publication_evidence/).length, 1);
  assert.equal(matching(client, /^INSERT INTO shariah_records/).length, 1);
  assert.equal(matching(client, /^BEGIN$/).length, 1);
  assert.equal(matching(client, /^COMMIT$/).length, 1);
  assert.equal(matching(client, /^ROLLBACK$/).length, 0);

  // Append-only is preserved: nothing rewrites a published decision.
  assert.equal(matching(client, /UPDATE shariah_publications|DELETE FROM shariah_publications/).length, 0);
  // The current record is upserted, never the history.
  assert.match(client.statements.find((s) => s.startsWith("INSERT INTO shariah_records"))!,
    /ON CONFLICT \(asset_id\) DO UPDATE/);
});

test("one invalid entry publishes nothing at all — the batch is all-or-nothing", async () => {
  const client = new RecordingClient();
  await assert.rejects(
    () => importShariahReviewResults(client, {
      document: document({ results: [
        result(),
        result({ assetId: "2", baseAsset: "BBB", classification: "EXCLUDED", prohibitedCategories: [] }),
      ] }),
      publishedBy: "owner",
    }),
    ShariahReviewImportError
  );
  assert.equal(matching(client, /^INSERT/).length, 0, "a rejected import wrote rows");
  assert.equal(matching(client, /^BEGIN$/).length, 0, "a rejected import opened a transaction");
});

test("an import requires the approving operator identity", async () => {
  const client = new RecordingClient();
  await assert.rejects(
    () => importShariahReviewResults(client, { document: document(), publishedBy: "  " }),
    /approving operator identity/
  );
  assert.deepEqual(client.statements, []);
});

test("the published reason carries the researched answers, not just the verdict", () => {
  const parsed = parseReviewResults(document());
  const reason = composeReason(parsed.results[0]!);
  assert.match(reason, /Rights \/ economic exposure: No equity, dividend or debt claim\./);
  assert.match(reason, /Evidence sufficiency:/);
});
