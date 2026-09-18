/**
 * How old a published decision is, and when it should be looked at again.
 *
 * ── Why this is advisory, and why that is not a compromise ────────────────
 *
 * Until now the only invalidation in this system was event-driven: a base
 * symbol that reappears after being delisted forces its record STALE, because
 * a reused ticker may belong to a different project. There was no time
 * dimension at all. A decision published about an asset that never delisted
 * remained authoritative for ever, and nothing anywhere surfaced its age —
 * while a project that quietly adds a lending product is the real-world way a
 * correct verdict becomes a wrong one.
 *
 * The obvious fix is the wrong one. Demoting an aged decision to STALE would
 * silently withdraw verdicts in bulk and stop trading on an installation whose
 * operator did nothing at all, at a moment they did not choose. Worse, it would
 * do it through the gate, where the effect is invisible until an order is
 * refused.
 *
 * So nothing here demotes anything, and nothing in `gate.ts` reads this module.
 * Age is SURFACED — counted on the console, sorted to the front of the review
 * pack — and the operator re-screens. The system keeps its property that only a
 * deliberate publication changes what may be bought.
 */
import { query } from "../db/pool";

/** Days after which a published decision is surfaced as due; null disables it. */
export interface ShariahReviewPolicy {
  reviewMaxAgeDays: number | null;
}

const DAY_MS = 86_400_000;

export async function getShariahReviewPolicy(): Promise<ShariahReviewPolicy> {
  const { rows } = await query<{ review_max_age_days: number | null }>(
    "SELECT review_max_age_days FROM shariah_review_policy WHERE id = true",
  );
  return { reviewMaxAgeDays: rows[0]?.review_max_age_days ?? null };
}

export async function setShariahReviewPolicy(days: number | null): Promise<ShariahReviewPolicy> {
  if (days !== null && (!Number.isInteger(days) || days <= 0)) {
    throw new Error(`reviewMaxAgeDays must be a positive whole number of days or null, got ${days}`);
  }
  const { rows } = await query<{ review_max_age_days: number | null }>(
    `INSERT INTO shariah_review_policy (id, review_max_age_days, updated_at)
     VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET review_max_age_days = $1, updated_at = now()
     RETURNING review_max_age_days`,
    [days],
  );
  return { reviewMaxAgeDays: rows[0]?.review_max_age_days ?? null };
}

/** Whatever carries a settled decision's age. */
export interface Ageable {
  lifecycle: string;
  reviewedAt: string | null;
  publishedAt: string | null;
}

/**
 * Days since the research behind a decision was done, or null.
 *
 * `reviewedAt` rather than `publishedAt`: the operator states when the research
 * was actually carried out, and that is what ages. A pack researched in March
 * and imported in September is six months old on arrival, and saying otherwise
 * would let a backlog launder its own staleness.
 */
export function decisionAgeDays(asset: Ageable, now = Date.now()): number | null {
  const stamp = asset.reviewedAt ?? asset.publishedAt;
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/**
 * Whether a SETTLED decision has aged past the policy.
 *
 * Only `SCREENED` assets can be due: an UNSCREENED or STALE asset is already
 * in the review queue for a reason that outranks age, and counting it twice
 * would inflate the number an operator is trying to work through.
 */
export function isDueForReReview(
  asset: Ageable, policy: ShariahReviewPolicy, now = Date.now(),
): boolean {
  if (policy.reviewMaxAgeDays === null) return false;
  if (asset.lifecycle !== "SCREENED") return false;
  const age = decisionAgeDays(asset, now);
  return age !== null && age >= policy.reviewMaxAgeDays;
}
