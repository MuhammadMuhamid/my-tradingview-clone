/**
 * Time-based re-review: the gap, and why closing it must not close it hard.
 *
 * The only invalidation this system had was event-driven — a base symbol that
 * reappears on Binance after being delisted forces its record STALE, because a
 * reused ticker may belong to a different project. There was no time dimension
 * at all. A decision published about an asset that never delisted stayed
 * authoritative for ever and nothing anywhere surfaced its age, while a project
 * that quietly adds a lending product is exactly how a correct verdict becomes
 * a wrong one.
 *
 * The obvious fix is the wrong one, and these tests exist mostly to pin that.
 * Demoting an aged decision to STALE would withdraw verdicts in bulk and stop
 * trading on an installation whose operator did nothing, at a moment they did
 * not choose, through the gate — where the effect is invisible until an order
 * is refused. So age is SURFACED and nothing is demoted, the exposure gate
 * never reads any of it, and the review pack simply spends its slots better.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decisionAgeDays, isDueForReReview, type ShariahReviewPolicy } from "../src/shariah/freshness";
import { selectReviewBatch, type ReviewPackSource } from "../src/shariah/reviewPack";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-18T00:00:00Z");
const YEARLY: ShariahReviewPolicy = { reviewMaxAgeDays: 365 };

/*
 * `reviewedAt`/`publishedAt` are on the REGISTRY row rather than on
 * `ReviewPackSource`, which is the projection the pack takes. The batch
 * selector only reads `assetId`, `baseAsset`, `lifecycle`, `effectiveStatus`
 * and `binanceAvailable`, so the extra fields ride along for readability and
 * the cast is where they are admitted.
 */
function asset(
  over: Partial<ReviewPackSource> & { assetId: string; reviewedAt?: string | null },
): ReviewPackSource {
  return {
    baseAsset: over.baseAsset ?? `A${over.assetId}`,
    projectName: null,
    binanceAvailable: true,
    classification: "ELIGIBLE",
    lifecycle: "SCREENED",
    effectiveStatus: "ELIGIBLE",
    policyVersion: "TS_SHARIAH_V1",
    reason: "reviewed",
    prohibitedCategories: [],
    reviewedAt: new Date(NOW - 10 * DAY).toISOString(),
    publishedAt: new Date(NOW - 10 * DAY).toISOString(),
    updatedAt: null,
    currentPublicationId: null,
    staleSince: null,
    ...over,
  } as unknown as ReviewPackSource;
}

test("age is measured from when the research was done, not when it was filed", () => {
  /*
   * A pack researched in March and imported in September is six months old on
   * arrival. Measuring from `publishedAt` would let a backlog launder its own
   * staleness — the slower the operator, the fresher their decisions look.
   */
  const researched = new Date(NOW - 200 * DAY).toISOString();
  const filed = new Date(NOW - 5 * DAY).toISOString();
  assert.equal(decisionAgeDays({ lifecycle: "SCREENED", reviewedAt: researched, publishedAt: filed }, NOW), 200);
  // Falling back to the publication date is right only when no research date exists.
  assert.equal(decisionAgeDays({ lifecycle: "SCREENED", reviewedAt: null, publishedAt: filed }, NOW), 5);
  assert.equal(decisionAgeDays({ lifecycle: "SCREENED", reviewedAt: null, publishedAt: null }, NOW), null);
  assert.equal(decisionAgeDays({ lifecycle: "SCREENED", reviewedAt: "not a date", publishedAt: null }, NOW), null);
});

test("only a SETTLED decision can be due — the queue is not double-counted", () => {
  const old = new Date(NOW - 400 * DAY).toISOString();
  assert.equal(isDueForReReview(
    { lifecycle: "SCREENED", reviewedAt: old, publishedAt: old }, YEARLY, NOW), true);
  // An UNSCREENED or STALE asset is already in the queue for a reason that
  // outranks age; counting it again inflates the number an operator is
  // working through and tells them nothing new.
  for (const lifecycle of ["UNSCREENED", "STALE"]) {
    assert.equal(isDueForReReview(
      { lifecycle, reviewedAt: old, publishedAt: old }, YEARLY, NOW), false,
      `${lifecycle} must not also be counted as due for re-review`);
  }
  // Exactly at the boundary counts; a day short does not.
  const exact = new Date(NOW - 365 * DAY).toISOString();
  const almost = new Date(NOW - 364 * DAY).toISOString();
  assert.equal(isDueForReReview({ lifecycle: "SCREENED", reviewedAt: exact, publishedAt: exact }, YEARLY, NOW), true);
  assert.equal(isDueForReReview({ lifecycle: "SCREENED", reviewedAt: almost, publishedAt: almost }, YEARLY, NOW), false);
});

test("a null policy turns time-based surfacing off entirely", () => {
  const ancient = new Date(NOW - 5000 * DAY).toISOString();
  assert.equal(isDueForReReview(
    { lifecycle: "SCREENED", reviewedAt: ancient, publishedAt: ancient },
    { reviewMaxAgeDays: null }, NOW), false);
});

test("due assets join the pack BEHIND everything never settled", () => {
  const assets: ReviewPackSource[] = [
    asset({ assetId: "1", baseAsset: "AAA", lifecycle: "SCREENED",
      reviewedAt: new Date(NOW - 900 * DAY).toISOString() }),               // due
    asset({ assetId: "2", baseAsset: "BBB", lifecycle: "UNSCREENED",
      classification: "REVIEW", effectiveStatus: "REVIEW" }),
    asset({ assetId: "3", baseAsset: "CCC", lifecycle: "STALE",
      classification: "REVIEW", effectiveStatus: "REVIEW" }),
    asset({ assetId: "4", baseAsset: "DDD" }),                              // settled, fresh
  ];
  const due = new Set(["1"]);
  const { batch } = selectReviewBatch(assets, { batchSize: 10, dueForReReview: due });

  assert.deepEqual(batch.map((a) => a.baseAsset), ["CCC", "BBB", "AAA"],
    "STALE, then never-screened, then aged-but-settled; a fresh settled asset is not in the pack");

  // Without the due set the aged asset is simply not selected: the feature is
  // the policy, not a change to what "needs review" means.
  const { batch: unaware } = selectReviewBatch(assets, { batchSize: 10 });
  assert.deepEqual(unaware.map((a) => a.baseAsset), ["CCC", "BBB"]);
});

test("selection stays deterministic with the due set in play", () => {
  const assets: ReviewPackSource[] = ["1", "2", "3"].map((id) =>
    asset({ assetId: id, baseAsset: `Z${id}`, reviewedAt: new Date(NOW - 900 * DAY).toISOString() }));
  const due = new Set(["1", "2", "3"]);
  const a = selectReviewBatch(assets, { batchSize: 2, dueForReReview: due });
  const b = selectReviewBatch([...assets].reverse(), { batchSize: 2, dueForReReview: due });
  assert.deepEqual(a.batch.map((x) => x.assetId), b.batch.map((x) => x.assetId),
    "the same registry state must always produce the same batch");
});

test("NOTHING about freshness reaches the exposure gate", () => {
  /*
   * The load-bearing assertion of this whole feature. If age could refuse a
   * BUY, an operator's positions would start being blocked by the passage of
   * time rather than by a decision anyone made — which is precisely the
   * behaviour the advisory design exists to avoid.
   */
  const src = path.join(__dirname, "..", "src");
  const gate = fs.readFileSync(path.join(src, "shariah", "gate.ts"), "utf8");
  for (const forbidden of ["freshness", "dueForReReview", "decisionAgeDays", "reviewMaxAgeDays"]) {
    assert.ok(!gate.includes(forbidden),
      `gate.ts reads ${forbidden}: age must never decide whether an order is allowed`);
  }
  const policy = fs.readFileSync(path.join(src, "shariah", "policy.ts"), "utf8");
  assert.ok(!policy.includes("reviewMaxAgeDays"),
    "the classification rule must not depend on the advisory interval either");
});
