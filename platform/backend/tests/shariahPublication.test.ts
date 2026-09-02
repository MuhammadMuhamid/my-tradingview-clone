/**
 * SH-2 review/publication rules and snapshot determinism, at the level that
 * does not need a database: the completeness gate every publication passes
 * through, the canonical/hashing behaviour that makes a snapshot citable, and
 * source-level pins on the two properties that would be silently lost if a
 * later change reintroduced a shortcut.
 *
 * The end-to-end behaviour (history immutability, STALE re-screening, snapshot
 * immutability under later publications) is proved against real PostgreSQL in
 * tests/shariahUniverseDb.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TS_SHARIAH_V1 } from "../src/shariah/policy";
import {
  ShariahPublicationError, assertPublishableDecision,
  type PublishShariahDecisionInput,
} from "../src/shariah/publication";
import {
  canonicalSnapshotEntries, snapshotContentHash, type ShariahSnapshotSource,
} from "../src/shariah/snapshot";

const SRC = path.join(__dirname, "..", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

function decision(over: Partial<PublishShariahDecisionInput> = {}): PublishShariahDecisionInput {
  return {
    assetId: "1",
    policyVersion: TS_SHARIAH_V1,
    classification: "ELIGIBLE",
    reason: "Reviewed: the project's own activity is a synthetic test fixture.",
    prohibitedCategories: [],
    evidenceIds: ["10"],
    reviewedAt: "2026-09-01T00:00:00.000Z",
    publishedBy: "test-operator",
    ...over,
  };
}

const refuses = (input: PublishShariahDecisionInput, match: RegExp): void => {
  assert.throws(() => assertPublishableDecision(input), (err: unknown) => {
    assert.ok(err instanceof ShariahPublicationError, `expected ShariahPublicationError, got ${err}`);
    assert.match((err as Error).message, match);
    return true;
  });
};

// ── E: ELIGIBLE requires a completed, evidence-backed review ────────────────

test("ELIGIBLE cannot be published without supporting evidence", () => {
  refuses(decision({ evidenceIds: [] }), /absence of evidence is not proof of eligibility/);
});

test("ELIGIBLE cannot be published without a reason", () => {
  refuses(decision({ reason: "   " }), /requires a reason/);
});

test("ELIGIBLE cannot be published without the completed review timestamp", () => {
  refuses(decision({ reviewedAt: "" }), /requires reviewed_at/);
  refuses(decision({ reviewedAt: "not-a-date" }), /requires reviewed_at/);
});

test("a review cannot be dated in the future", () => {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  refuses(decision({ reviewedAt: tomorrow }), /cannot be in the future/);
});

test("ELIGIBLE cannot carry prohibited categories", () => {
  refuses(
    decision({ prohibitedCategories: ["GAMBLING_BETTING_CASINO"] }),
    /cannot carry prohibited categories/
  );
});

test("a complete ELIGIBLE review is accepted", () => {
  assert.doesNotThrow(() => assertPublishableDecision(decision()));
});

// ── A/B: a bare status toggle is not a publication ──────────────────────────

/**
 * The shape an "UNSCREENED -> ELIGIBLE" or "STALE -> ELIGIBLE" shortcut would
 * take if one existed: a classification and nothing else. Every field the gate
 * demands is a field a real review had to produce.
 */
test("a bare classification toggle is refused for ELIGIBLE and EXCLUDED alike", () => {
  const bare = { assetId: "1", policyVersion: TS_SHARIAH_V1, publishedBy: "test-operator",
    reason: "", reviewedAt: "", evidenceIds: [] as string[] };
  refuses({ ...bare, classification: "ELIGIBLE" }, /requires a reason/);
  refuses({ ...bare, classification: "EXCLUDED" }, /requires a reason/);
  // Even with a reason, the evidence package is still missing.
  refuses({ ...bare, classification: "ELIGIBLE", reason: "looks fine",
    reviewedAt: "2026-09-01T00:00:00.000Z" }, /ELIGIBLE requires at least one supporting evidence/);
});

// ── D: EXCLUDED requires reason + prohibited category + evidence ────────────

test("EXCLUDED requires at least one prohibited category", () => {
  refuses(
    decision({ classification: "EXCLUDED", prohibitedCategories: [] }),
    /at least one prohibited category/
  );
});

test("EXCLUDED requires supporting evidence", () => {
  refuses(
    decision({ classification: "EXCLUDED", prohibitedCategories: ["ALCOHOL"], evidenceIds: [] }),
    /EXCLUDED requires at least one supporting evidence/
  );
});

test("EXCLUDED rejects a category outside the fixed TS_SHARIAH_V1 vocabulary", () => {
  refuses(
    decision({ classification: "EXCLUDED", prohibitedCategories: ["VIBES"] }),
    /invalid prohibited category/
  );
});

test("a complete EXCLUDED review is accepted", () => {
  assert.doesNotThrow(() => assertPublishableDecision(decision({
    classification: "EXCLUDED",
    prohibitedCategories: ["GAMBLING_BETTING_CASINO"],
    reason: "The protocol's own core product is a synthetic betting market (test fixture).",
  })));
});

// ── F: REVIEW is publishable on ambiguity, and must say so ─────────────────

test("REVIEW may be published with no evidence, because insufficiency is the finding", () => {
  assert.doesNotThrow(() => assertPublishableDecision(decision({
    classification: "REVIEW",
    evidenceIds: [],
    reason: "Sources conflict on whether the token finances the parent's lending desk.",
  })));
});

test("REVIEW still requires a reason", () => {
  refuses(decision({ classification: "REVIEW", evidenceIds: [], reason: "" }), /requires a reason/);
});

test("an unknown classification or policy version is refused", () => {
  refuses(decision({ classification: "HALAL" as never }), /invalid classification/);
  refuses(decision({ policyVersion: "TS_SHARIAH_V2" as never }), /unknown policy version/);
});

// ── H/I/K: snapshot canonical form and hashing ─────────────────────────────

const source = (over: Partial<ShariahSnapshotSource>): ShariahSnapshotSource => ({
  asset_id: 1, base_asset: "AAA", classification: "REVIEW", lifecycle: "UNSCREENED",
  policy_version: TS_SHARIAH_V1, binance_available: true, current_publication_id: null, ...over,
});

const UNIVERSE: ShariahSnapshotSource[] = [
  source({ asset_id: 3, base_asset: "CCC", classification: "ELIGIBLE", lifecycle: "SCREENED", current_publication_id: 7 }),
  source({ asset_id: 1, base_asset: "AAA", classification: "REVIEW", lifecycle: "UNSCREENED" }),
  source({ asset_id: 4, base_asset: "DDD", classification: "EXCLUDED", lifecycle: "SCREENED", current_publication_id: 8 }),
  // Previously ELIGIBLE, demoted to STALE by SH-1's ticker-reuse fail-closed rule.
  source({ asset_id: 2, base_asset: "BBB", classification: "ELIGIBLE", lifecycle: "STALE" }),
  source({ asset_id: 5, base_asset: "EEE", classification: "REVIEW", lifecycle: "SCREENED", current_publication_id: 9 }),
  source({ asset_id: 6, base_asset: "FFF", classification: "ELIGIBLE", lifecycle: "SCREENED", binance_available: false, current_publication_id: 10 }),
];

test("snapshot membership is the complete registry, deterministically ordered", () => {
  const entries = canonicalSnapshotEntries(UNIVERSE);
  assert.deepEqual(entries.map((e) => e.baseAsset), ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"]);
  // Delisted assets stay in, carrying their availability, so a consumer can
  // reconstruct either the tradable universe or the full audit view.
  assert.equal(entries.find((e) => e.baseAsset === "FFF")?.binanceAvailable, false);
  assert.equal(entries.length, UNIVERSE.length);
});

test("UNSCREENED and STALE members are effectively REVIEW in a snapshot", () => {
  const byBase = new Map(canonicalSnapshotEntries(UNIVERSE).map((e) => [e.baseAsset, e]));
  const unscreened = byBase.get("AAA")!;
  assert.equal(unscreened.lifecycle, "UNSCREENED");
  assert.equal(unscreened.effectiveStatus, "REVIEW");

  const stale = byBase.get("BBB")!;
  assert.equal(stale.lifecycle, "STALE");
  // The stored classification is still the old ELIGIBLE; the snapshot's
  // effective answer is not.
  assert.equal(stale.classification, "ELIGIBLE");
  assert.equal(stale.effectiveStatus, "REVIEW");

  // A published REVIEW is distinguishable from a never-screened one.
  assert.equal(byBase.get("EEE")!.lifecycle, "SCREENED");
  assert.equal(byBase.get("EEE")!.effectiveStatus, "REVIEW");
});

test("a snapshot distinguishes ELIGIBLE, REVIEW and EXCLUDED", () => {
  const statuses = new Set(canonicalSnapshotEntries(UNIVERSE).map((e) => e.effectiveStatus));
  assert.deepEqual([...statuses].sort(), ["ELIGIBLE", "EXCLUDED", "REVIEW"]);
});

test("a missing shariah_records row reads as UNSCREENED/REVIEW, never ELIGIBLE", () => {
  const [entry] = canonicalSnapshotEntries([
    source({ asset_id: 11, base_asset: "ZZZ", classification: null, lifecycle: null, policy_version: null }),
  ]);
  assert.equal(entry!.lifecycle, "UNSCREENED");
  assert.equal(entry!.effectiveStatus, "REVIEW");
  assert.equal(entry!.policyVersion, TS_SHARIAH_V1);
});

test("content hash is independent of the order rows arrive in", () => {
  const baseline = snapshotContentHash(TS_SHARIAH_V1, canonicalSnapshotEntries(UNIVERSE));
  const shuffles = [
    [...UNIVERSE].reverse(),
    [UNIVERSE[4]!, UNIVERSE[0]!, UNIVERSE[5]!, UNIVERSE[2]!, UNIVERSE[1]!, UNIVERSE[3]!],
    [UNIVERSE[1]!, UNIVERSE[3]!, UNIVERSE[5]!, UNIVERSE[4]!, UNIVERSE[2]!, UNIVERSE[0]!],
  ];
  for (const shuffled of shuffles) {
    assert.equal(snapshotContentHash(TS_SHARIAH_V1, canonicalSnapshotEntries(shuffled)), baseline);
  }
  assert.match(baseline, /^[0-9a-f]{64}$/);
});

test("content hash changes when the authoritative state changes", () => {
  const baseline = snapshotContentHash(TS_SHARIAH_V1, canonicalSnapshotEntries(UNIVERSE));
  const changed = UNIVERSE.map((r) =>
    r.base_asset === "AAA" ? source({ ...r, classification: "ELIGIBLE", lifecycle: "SCREENED" }) : r);
  assert.notEqual(snapshotContentHash(TS_SHARIAH_V1, canonicalSnapshotEntries(changed)), baseline);

  const renamed = UNIVERSE.map((r) => (r.base_asset === "AAA" ? source({ ...r, base_asset: "AAB" }) : r));
  assert.notEqual(snapshotContentHash(TS_SHARIAH_V1, canonicalSnapshotEntries(renamed)), baseline);
});

// ── N + no-shortcut: properties pinned at the source level ─────────────────

/**
 * No universe-sync path can publish a classification. SH-1 pinned this by
 * construction; SH-2 adds a real writer beside it, so the property is now
 * asserted rather than assumed.
 */
test("the universe sync boundary contains no ELIGIBLE/EXCLUDED write and no SCREENED promotion", () => {
  const sync = read("shariah/sync.ts");
  const statements = sync.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(statements, /'ELIGIBLE'/);
  assert.doesNotMatch(statements, /'EXCLUDED'/);
  // 'SCREENED' appears in sync.ts only as a WHERE predicate on the fail-closed
  // demotion; it is never written.
  assert.doesNotMatch(statements, /SET lifecycle = 'SCREENED'/);
  assert.doesNotMatch(statements, /VALUES[^)]*'SCREENED'/);
  // The only lifecycle values sync writes are the fail-closed ones.
  assert.match(statements, /'UNSCREENED'/);
  assert.match(statements, /lifecycle = 'STALE'/);
  // And it cannot reach the publication authority.
  assert.doesNotMatch(sync, /from "\.\/publication"/);
});

/**
 * There is no "reconfirm the old status" shortcut, and there cannot
 * accidentally become one: the publication authority never reads the asset's
 * existing classification or lifecycle, so it has nothing to copy forward. A
 * STALE asset's route back to SCREENED is the same complete call a
 * never-reviewed asset makes.
 */
test("the publication authority never reads the prior classification or lifecycle", () => {
  const publication = read("shariah/publication.ts");
  const statements = publication.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(statements, /FROM shariah_records/i);
  assert.doesNotMatch(statements, /r\.classification|records\.classification/i);
  // The one write to shariah_records sets SCREENED from the submitted input.
  assert.match(statements, /INSERT INTO shariah_records/);
  assert.match(statements, /lifecycle = 'SCREENED'/);
});

test("no repository or route exposes a bare classification setter", () => {
  for (const rel of ["repositories/shariah.ts", "api/routes/shariah.ts"]) {
    const text = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(text, /UPDATE shariah_records/i, `${rel} must not update the current record directly`);
    assert.doesNotMatch(text, /reconfirm/i, `${rel} must not offer a reconfirmation shortcut`);
  }
});

test("no snapshot table is ever updated or deleted from application code", () => {
  for (const rel of ["shariah/snapshot.ts", "repositories/shariah.ts", "api/routes/shariah.ts"]) {
    const text = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(text, /UPDATE shariah_universe_snapshot/i, rel);
    assert.doesNotMatch(text, /DELETE FROM shariah_universe_snapshot/i, rel);
    assert.doesNotMatch(text, /UPDATE shariah_publications/i, rel);
    assert.doesNotMatch(text, /DELETE FROM shariah_publications/i, rel);
  }
});

test("migration 023 is additive and guards its history tables", () => {
  const sql = fs.readFileSync(
    path.join(SRC, "db", "migrations", "023_shariah_publication_and_snapshots.sql"), "utf8");
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|ALTER COLUMN/i);
  for (const table of ["shariah_publications", "shariah_publication_evidence",
    "shariah_universe_snapshots", "shariah_universe_snapshot_entries"]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER ${table}_append_only\\s+BEFORE UPDATE OR DELETE ON ${table}`));
  }
  // 022 and earlier are untouched apart from one additive nullable column.
  const alters = sql.match(/ALTER TABLE[^;]+;/g) ?? [];
  assert.equal(alters.length, 1);
  assert.match(alters[0]!, /ADD COLUMN current_publication_id bigint/);
});
