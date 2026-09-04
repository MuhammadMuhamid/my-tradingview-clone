/**
 * The ONE authority that publishes a Shariah result under `TS_SHARIAH_V1`.
 *
 * SH-1 deliberately had no write path for a classification: universe sync only
 * ever produces `UNSCREENED`/`REVIEW`, and a base symbol reappearing after a
 * delisting is demoted `SCREENED` -> `STALE` because SH-1 cannot tell "same
 * project, briefly delisted" from "different project reusing the ticker".
 * This module is the only thing that may undo either state, and it may only do
 * so by recording a complete, evidence-backed, deliberately published review.
 *
 * Consequences that are load-bearing, not incidental:
 *
 * - There is no `reconfirm(assetId)`, no `setClassification(assetId, status)`,
 *   and no code path here that READS the asset's prior classification. A
 *   `STALE` asset that was `ELIGIBLE` last year goes through exactly the same
 *   call, carrying exactly the same complete input, as an asset reviewed for
 *   the first time. Old status can never be copied forward, because nothing
 *   here can see it.
 * - Every successful publication appends an immutable `shariah_publications`
 *   row (the database rejects UPDATE/DELETE on it) plus the evidence links
 *   that supported it, and only then updates the mutable current record.
 * - Nothing here classifies anything. The caller supplies the decision; this
 *   module refuses the incomplete ones.
 */
import type { ShariahDbClient } from "./sync";
import {
  isClassification, isPolicyVersion, isProhibitedCategory,
  type Classification, type PolicyVersion, type ProhibitedCategory,
} from "./policy";

/** A publication input the policy refuses. Always a caller/operator error, never a 500. */
export class ShariahPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShariahPublicationError";
  }
}

export interface PublishShariahDecisionInput {
  assetId: string;
  policyVersion: PolicyVersion;
  classification: Classification;
  /** Required for every classification, REVIEW included. */
  reason: string;
  /** Required (non-empty) for EXCLUDED; forbidden for ELIGIBLE; optional for REVIEW. */
  prohibitedCategories?: readonly string[];
  /** `shariah_evidence.id` values, which must already belong to this asset. */
  evidenceIds?: readonly (string | number)[];
  /** When the human review was actually completed. Not defaulted to now(). */
  reviewedAt: string;
  /** Operator identity from the current session (see api/routes/shariah.ts). */
  publishedBy: string;
}

export interface PublishedShariahDecision {
  publicationId: string;
  assetId: string;
  policyVersion: PolicyVersion;
  classification: Classification;
  lifecycle: "SCREENED";
  reason: string;
  prohibitedCategories: ProhibitedCategory[];
  evidenceIds: string[];
  baseAssetAtPublication: string | null;
  reviewedAt: string;
  publishedAt: string;
  publishedBy: string;
}

/**
 * Pure shape/completeness gate, applied before anything touches the database.
 *
 * "Absence of evidence is never enough" (policy.ts interpretation rules) is
 * enforced literally here: ELIGIBLE and EXCLUDED both require at least one
 * cited evidence row. REVIEW does not — a deliberately published REVIEW is
 * precisely the statement that the evidence is insufficient, conflicting or
 * materially ambiguous, and it must say so in `reason`.
 */
export function assertPublishableDecision(input: PublishShariahDecisionInput): void {
  if (!isPolicyVersion(input.policyVersion)) {
    throw new ShariahPublicationError(`unknown policy version: ${JSON.stringify(input.policyVersion)}`);
  }
  if (!isClassification(input.classification)) {
    throw new ShariahPublicationError(`invalid classification: ${JSON.stringify(input.classification)}`);
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    throw new ShariahPublicationError("a publication requires a reason, including a published REVIEW");
  }
  if (typeof input.publishedBy !== "string" || input.publishedBy.trim().length === 0) {
    throw new ShariahPublicationError("a publication requires the publishing operator identity");
  }
  const reviewedAtMs = Date.parse(input.reviewedAt ?? "");
  if (!Number.isFinite(reviewedAtMs)) {
    throw new ShariahPublicationError("a publication requires reviewed_at, the time the review was completed");
  }
  if (reviewedAtMs > Date.now() + 60_000) {
    throw new ShariahPublicationError("reviewed_at cannot be in the future");
  }

  const categories = [...new Set(input.prohibitedCategories ?? [])];
  for (const category of categories) {
    if (!isProhibitedCategory(category)) {
      throw new ShariahPublicationError(`invalid prohibited category: ${JSON.stringify(category)}`);
    }
  }
  const evidenceCount = new Set((input.evidenceIds ?? []).map(String)).size;

  if (input.classification === "EXCLUDED") {
    if (categories.length === 0) {
      throw new ShariahPublicationError("EXCLUDED requires at least one prohibited category");
    }
    if (evidenceCount === 0) {
      throw new ShariahPublicationError("EXCLUDED requires at least one supporting evidence record");
    }
  }
  if (input.classification === "ELIGIBLE") {
    if (evidenceCount === 0) {
      throw new ShariahPublicationError(
        "ELIGIBLE requires at least one supporting evidence record — absence of evidence is not proof of eligibility"
      );
    }
    if (categories.length > 0) {
      throw new ShariahPublicationError("ELIGIBLE cannot carry prohibited categories");
    }
  }
}

/** pg returns timestamptz as a Date; SH-2 hands callers ISO-8601 text. */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Numeric-ascending, de-duplicated — bigint ids must not sort as text ("10" < "9"). */
function sortedEvidenceIds(ids: readonly (string | number)[] | undefined): string[] {
  return [...new Set((ids ?? []).map(String))].sort((a, b) => Number(a) - Number(b));
}

interface AssetIdentityRow {
  asset_id: string;
  base_asset: string | null;
  project_name: string | null;
}

/**
 * Records one deliberate publication.
 *
 * `db` MUST be a single dedicated connection (a `pg` PoolClient), not the
 * pool: the whole publication — history row, evidence links, current record —
 * is one transaction, and a pool would spread those statements over different
 * connections.
 */
export async function publishShariahDecision(
  db: ShariahDbClient,
  input: PublishShariahDecisionInput
): Promise<PublishedShariahDecision> {
  await db.query("BEGIN");
  try {
    const published = await publishShariahDecisionWithin(db, input);
    await db.query("COMMIT");
    return published;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/**
 * The same publication, performed inside a transaction the CALLER owns.
 *
 * This exists for the batch review import (`reviewImport.ts`), which publishes
 * a whole reviewed batch all-or-nothing: a partially applied import of a
 * malformed research file is worse for an operator than a rejected one. It is
 * NOT a second classification writer — it is this function's body, and
 * `publishShariahDecision` above is now just the single-decision BEGIN/COMMIT
 * wrapper around it. Every rule (the completeness gate, evidence ownership,
 * the immutable history row, the evidence links, the current-record mirror)
 * applies identically, because it is the same code.
 *
 * The caller MUST have an open transaction on `db`, and MUST roll it back if
 * this throws.
 */
export async function publishShariahDecisionWithin(
  db: ShariahDbClient,
  input: PublishShariahDecisionInput
): Promise<PublishedShariahDecision> {
  assertPublishableDecision(input);

  const assetId = String(input.assetId);
  const categories = [...new Set(input.prohibitedCategories ?? [])] as ProhibitedCategory[];
  const evidenceIds = sortedEvidenceIds(input.evidenceIds);

  const identity = await db.query<AssetIdentityRow>(
    `SELECT a.asset_id, m.base_asset, a.project_name
       FROM shariah_assets a
       LEFT JOIN shariah_asset_binance_mappings m ON m.asset_id = a.asset_id
      WHERE a.asset_id = $1`,
    [assetId]
  );
  const asset = identity.rows[0];
  if (!asset) throw new ShariahPublicationError(`unknown asset_id: ${assetId}`);

  // Evidence must belong to the asset being published. Citing another asset's
  // evidence would make the decision history unfalsifiable.
  if (evidenceIds.length > 0) {
    const owned = await db.query<{ id: string }>(
      "SELECT id FROM shariah_evidence WHERE asset_id = $1 AND id = ANY($2::bigint[])",
      [assetId, evidenceIds]
    );
    const found = new Set(owned.rows.map((r) => String(r.id)));
    const missing = evidenceIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new ShariahPublicationError(
        `evidence not found for this asset: ${missing.join(", ")}`
      );
    }
  }

  const inserted = await db.query<{
    publication_id: string; published_at: string; reviewed_at: string;
  }>(
    `INSERT INTO shariah_publications (
       asset_id, policy_version, classification, lifecycle, reason,
       prohibited_categories, base_asset_at_publication, project_name_at_publication,
       reviewed_at, published_by)
     VALUES ($1, $2, $3, 'SCREENED', $4, $5, $6, $7, $8, $9)
     RETURNING publication_id, published_at, reviewed_at`,
    [assetId, input.policyVersion, input.classification, input.reason.trim(),
      categories.length > 0 ? categories : null, asset.base_asset, asset.project_name,
      input.reviewedAt, input.publishedBy.trim()]
  );
  const publication = inserted.rows[0]!;
  const publicationId = String(publication.publication_id);

  for (const evidenceId of evidenceIds) {
    await db.query(
      "INSERT INTO shariah_publication_evidence (publication_id, evidence_id) VALUES ($1, $2)",
      [publicationId, evidenceId]
    );
  }

  // The mutable current record now mirrors the immutable row just appended.
  // It is a cache of the latest publication, never an independent decision.
  await db.query(
    `INSERT INTO shariah_records (
       asset_id, classification, lifecycle, policy_version, reason,
       prohibited_categories, reviewed_at, published_at, updated_at, current_publication_id)
     VALUES ($1, $2, 'SCREENED', $3, $4, $5, $6, $7, now(), $8)
     ON CONFLICT (asset_id) DO UPDATE SET
       classification = EXCLUDED.classification,
       lifecycle = 'SCREENED',
       policy_version = EXCLUDED.policy_version,
       reason = EXCLUDED.reason,
       prohibited_categories = EXCLUDED.prohibited_categories,
       reviewed_at = EXCLUDED.reviewed_at,
       published_at = EXCLUDED.published_at,
       updated_at = now(),
       current_publication_id = EXCLUDED.current_publication_id`,
    [assetId, input.classification, input.policyVersion, input.reason.trim(),
      categories.length > 0 ? categories : null, input.reviewedAt,
      publication.published_at, publicationId]
  );

  return {
    publicationId,
    assetId,
    policyVersion: input.policyVersion,
    classification: input.classification,
    lifecycle: "SCREENED",
    reason: input.reason.trim(),
    prohibitedCategories: categories,
    evidenceIds,
    baseAssetAtPublication: asset.base_asset,
    reviewedAt: iso(publication.reviewed_at),
    publishedAt: iso(publication.published_at),
    publishedBy: input.publishedBy.trim(),
  };
}
