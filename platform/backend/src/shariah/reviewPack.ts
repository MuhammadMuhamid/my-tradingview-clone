/**
 * `TS_SHARIAH_REVIEW_PACK_V1` — the bounded, self-contained JSON batch an
 * operator downloads, researches manually (ChatGPT with web research, using
 * their own subscription), and returns as `TS_SHARIAH_REVIEW_RESULTS_V1`.
 *
 * Why this exists rather than an automated screener: Trading Scene deliberately
 * calls NO model API, NO paid search API, and runs NO crawler. The whole
 * "research" step happens outside this system, in a tool the operator already
 * pays for, and comes back as data. Nothing in this module fetches anything.
 *
 * Two properties are load-bearing:
 *
 * 1. THE PACK CARRIES NO PRIVATE STATE. Every field below comes from the
 *    Shariah registry (assets, Binance mapping, lifecycle, published decisions,
 *    cited evidence) and from `policy.ts`. There is deliberately no session,
 *    credential, user identity, balance, position, order or unrelated database
 *    state anywhere in the document — it is written to leave the machine.
 * 2. A `STALE` ENTRY ASKS FOR A FULL FRESH SCREENING, never a reconfirmation.
 *    `requiresFullFreshScreening` and `staleSince` are stated per asset, and
 *    the import side (reviewImport.ts) enforces them: evidence for a STALE
 *    asset must have been retrieved AFTER it went stale, so the previous
 *    decision cannot be copied forward. The prior publication is included as
 *    context for the researcher, never as an answer to reuse.
 */
import {
  PROHIBITED_CATEGORIES, CLASSIFICATIONS, TS_SHARIAH_V1,
  TS_SHARIAH_V1_INTERPRETATION_RULES,
  type Classification, type Lifecycle, type PolicyVersion,
} from "./policy";

export const REVIEW_PACK_FORMAT = "TS_SHARIAH_REVIEW_PACK_V1" as const;
export const REVIEW_RESULTS_FORMAT = "TS_SHARIAH_REVIEW_RESULTS_V1" as const;

/** The batch size the operator UX is built around. */
export const DEFAULT_REVIEW_BATCH_SIZE = 20;
export const MAX_REVIEW_BATCH_SIZE = 100;

/**
 * The research prompt's question list. This is the SAME four-question
 * TS_SHARIAH_V1 methodology (policy.ts `TS_SHARIAH_V1_QUESTIONS`) written out
 * as the six concrete things a researcher must answer to produce those four
 * answers — Q1/Q2 expand question 1-2, Q3/Q4 expand question 3, Q5/Q6 expand
 * question 4. It adds no rule, no threshold and no new category: extending the
 * methodology is a new policy version, not an edit here.
 */
export const TS_SHARIAH_V1_RESEARCH_QUESTIONS = [
  "What project/asset is this?",
  "What does the token do?",
  "What rights or economic exposure does it represent?",
  "What are the project's core/material activities?",
  "Is there factual evidence of any TS_SHARIAH_V1 prohibited category?",
  "Is the evidence sufficient and unambiguous?",
] as const;

/** The fixed premises, restated for a researcher who has never seen this system. */
export const TS_SHARIAH_V1_PREMISES = [
  "Venue is Binance Spot.",
  "Spot cryptocurrency trading is accepted as permissible; do not re-litigate it.",
  "USDT is accepted as permissible as the quote asset and is never screened.",
  "The unique underlying BASE ASSET is screened once, not each XYZUSDT pair.",
] as const;

/** Prior published decision, as context. Never an answer to copy forward. */
export interface ReviewPackPriorPublication {
  publicationId: string;
  classification: Classification;
  policyVersion: PolicyVersion;
  reason: string;
  prohibitedCategories: readonly string[];
  reviewedAt: string;
  publishedAt: string;
}

/** Prior evidence, as pointers only — no excerpt bodies, this is a reference list. */
export interface ReviewPackPriorEvidence {
  evidenceId: string;
  url: string | null;
  title: string | null;
  publisher: string | null;
  retrievedAt: string | null;
}

/** Registry facts the pack builder reads. Matches repositories/shariah.ts. */
export interface ReviewPackSource {
  assetId: string;
  baseAsset: string;
  projectName: string | null;
  binanceAvailable: boolean;
  classification: Classification;
  lifecycle: Lifecycle;
  effectiveStatus: Classification;
  policyVersion: PolicyVersion;
  /** When the current registry row last changed; for STALE this is when it went stale. */
  updatedAt: string | null;
  priorPublication?: ReviewPackPriorPublication | null;
  priorEvidence?: readonly ReviewPackPriorEvidence[];
}

export interface ReviewPackAsset {
  assetId: string;
  baseAsset: string;
  projectName: string | null;
  binanceAvailable: boolean;
  lifecycle: Lifecycle;
  classification: Classification;
  effectiveStatus: Classification;
  policyVersion: PolicyVersion;
  /** Plain-language statement of why this asset is in the batch. */
  reviewReason: string;
  /** True for STALE: the previous decision is void and must be re-derived from scratch. */
  requiresFullFreshScreening: boolean;
  /** For STALE, the instant the prior decision was voided. Evidence must be newer. */
  staleSince: string | null;
  priorPublication: ReviewPackPriorPublication | null;
  priorEvidence: ReviewPackPriorEvidence[];
}

export interface ShariahReviewPack {
  format: typeof REVIEW_PACK_FORMAT;
  policyVersion: PolicyVersion;
  generatedAt: string;
  batchSize: number;
  assetCount: number;
  /** How many assets still need work in total, so the operator knows how many batches remain. */
  needsReviewTotal: number;
  policy: {
    version: PolicyVersion;
    premises: readonly string[];
    questions: readonly string[];
    prohibitedCategories: readonly string[];
    interpretationRules: readonly string[];
    classifications: readonly string[];
  };
  instructions: readonly string[];
  resultContract: {
    format: typeof REVIEW_RESULTS_FORMAT;
    policyVersion: PolicyVersion;
    required: readonly string[];
    example: unknown;
  };
  assets: ReviewPackAsset[];
}

/**
 * Ordering: the assets whose current answer is most wrong come first.
 *
 * STALE outranks UNSCREENED because a STALE asset previously carried a
 * published ELIGIBLE/EXCLUDED that Trading Scene has now withdrawn — it is the
 * only bucket where a real answer was lost. UNSCREENED (never looked at) comes
 * next, and a deliberately published REVIEW last: that one already had a human
 * conclude the evidence was insufficient, so it is the least likely to move.
 *
 * Ties break on base symbol then numeric asset id, so the same registry state
 * always produces the same batch — an operator who downloads twice gets the
 * same 20 assets, and a test can assert the batch exactly.
 */
const LIFECYCLE_PRIORITY: Record<Lifecycle, number> = { STALE: 0, UNSCREENED: 1, SCREENED: 2 };

export function reviewPriority(asset: Pick<ReviewPackSource, "lifecycle">): number {
  return LIFECYCLE_PRIORITY[asset.lifecycle] ?? 3;
}

/** Assets whose effective status is not a settled ELIGIBLE/EXCLUDED answer. */
export function needsReview(asset: Pick<ReviewPackSource, "lifecycle" | "effectiveStatus">): boolean {
  return asset.lifecycle !== "SCREENED" || asset.effectiveStatus === "REVIEW";
}

export interface SelectReviewBatchOptions {
  /** Defaults to DEFAULT_REVIEW_BATCH_SIZE (20), clamped to [1, MAX_REVIEW_BATCH_SIZE]. */
  batchSize?: number;
  /** Include already-settled ELIGIBLE/EXCLUDED assets. Off by default — re-screening is not the default job. */
  includeSettled?: boolean;
  /** Include assets Binance no longer lists. Off by default — they are not tradable. */
  includeUnavailable?: boolean;
}

export function normalizeBatchSize(size: number | undefined): number {
  const n = Math.trunc(Number(size));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REVIEW_BATCH_SIZE;
  return Math.min(MAX_REVIEW_BATCH_SIZE, n);
}

/** Deterministic batch selection. Pure — the ordering is testable without a database. */
export function selectReviewBatch<T extends ReviewPackSource>(
  assets: readonly T[],
  options: SelectReviewBatchOptions = {}
): { batch: T[]; needsReviewTotal: number; batchSize: number } {
  const batchSize = normalizeBatchSize(options.batchSize);
  const available = options.includeUnavailable ? assets : assets.filter((a) => a.binanceAvailable);
  const candidates = options.includeSettled ? [...available] : available.filter(needsReview);
  const needsReviewTotal = available.filter(needsReview).length;

  candidates.sort((a, b) => {
    const byPriority = reviewPriority(a) - reviewPriority(b);
    if (byPriority !== 0) return byPriority;
    if (a.baseAsset !== b.baseAsset) return a.baseAsset < b.baseAsset ? -1 : 1;
    return Number(a.assetId) - Number(b.assetId);
  });

  return { batch: candidates.slice(0, batchSize), needsReviewTotal, batchSize };
}

function reviewReasonFor(asset: ReviewPackSource): string {
  if (asset.lifecycle === "STALE") {
    return "STALE — this base symbol reappeared on Binance after being delisted, so the previous " +
      "published decision may describe a DIFFERENT project reusing the ticker. The prior decision is " +
      "void. A FULL FRESH SCREENING is required; do not reconfirm or copy the previous classification.";
  }
  if (asset.lifecycle === "UNSCREENED") {
    return "UNSCREENED — this base asset entered the Binance Spot USDT universe and has never been screened.";
  }
  if (asset.effectiveStatus === "REVIEW") {
    return "REVIEW — a previous screening concluded the evidence was insufficient, conflicting or " +
      "materially ambiguous. New or better sources may now settle it.";
  }
  return "Included by explicit request; this asset already carries a settled published classification.";
}

const INSTRUCTIONS: readonly string[] = [
  "Research each asset in `assets` using public web sources. Answer the six questions in `policy.questions` for each one.",
  "Report only facts you can source. Every claim that drives a classification must cite a real, reachable URL you actually read.",
  "Do NOT invent, extend or substitute Shariah methodology. Use ONLY the categories in `policy.prohibitedCategories` and the rules in `policy.interpretationRules`.",
  "Do NOT apply revenue thresholds, and do NOT create special rules for memecoins, DeFi, DEXs, staking, L1/L2, GameFi or AI tokens — no such rules exist in TS_SHARIAH_V1.",
  "Third-party misuse of neutral infrastructure is not by itself grounds for EXCLUDED.",
  "A token issued by a company is not automatically equity in that company; parent-company activity matters only where the token economically represents, finances, materially depends upon, or grants rights tied to it.",
  "EXCLUDED requires at least one prohibited category from the fixed list AND at least one evidence entry establishing it.",
  "ELIGIBLE requires at least one evidence entry. Absence of evidence is never proof of eligibility.",
  "If the case is mixed, material but unclear, or the evidence is thin or conflicting, answer REVIEW and say so in `reason`. REVIEW is a correct answer, not a failure.",
  "Any asset with `requiresFullFreshScreening: true` is STALE: screen it from scratch as if it had never been reviewed. Its `priorPublication` is context only. Evidence you cite for it must be research you performed now — anything retrieved before its `staleSince` is rejected on import.",
  "`priorEvidence` is a reference list of what was cited before. Re-verify anything you intend to rely on and cite it yourself; you cannot reuse prior evidence by id.",
  `Return ONLY one JSON document in the ${REVIEW_RESULTS_FORMAT} shape shown in \`resultContract\`. No prose, no markdown fence, no commentary, no extra fields.`,
  "Return exactly one result per asset in `assets`, using the `assetId` and `baseAsset` values given here verbatim.",
];

const RESULT_CONTRACT_REQUIRED: readonly string[] = [
  "assetId — copied verbatim from this pack",
  "baseAsset — copied verbatim from this pack",
  "policyVersion — must be TS_SHARIAH_V1",
  "classification — ELIGIBLE | EXCLUDED | REVIEW",
  "answers — one factual answer per question in policy.questions (six keys)",
  "reason — the decision, in your own words, grounded in the evidence",
  "prohibitedCategories — required and non-empty for EXCLUDED, must be empty for ELIGIBLE",
  "evidence — array of { url, title, publisher, retrievedAt, note }; required for ELIGIBLE and EXCLUDED",
  "unresolvedUncertainties — array of strings; anything you could not settle",
];

const RESULT_EXAMPLE = {
  format: REVIEW_RESULTS_FORMAT,
  policyVersion: TS_SHARIAH_V1,
  researchCompletedAt: "2026-09-02T12:00:00Z",
  results: [
    {
      assetId: "123",
      baseAsset: "EXAMPLE",
      policyVersion: TS_SHARIAH_V1,
      classification: "EXCLUDED",
      answers: {
        project: "What project/asset this is.",
        tokenFunction: "What the token does.",
        rightsExposure: "What rights or economic exposure it represents.",
        coreActivities: "The project's core/material activities.",
        prohibitedEvidence: "The factual evidence of a prohibited category, or that none was found.",
        evidenceSufficiency: "Whether the evidence is sufficient and unambiguous.",
      },
      reason: "The protocol's own core product is a betting market; this is the project's material activity.",
      prohibitedCategories: ["GAMBLING_BETTING_CASINO"],
      evidence: [
        {
          url: "https://example.com/docs/product",
          title: "Product documentation",
          publisher: "Example Foundation",
          retrievedAt: "2026-09-02T11:40:00Z",
          note: "Official docs describe the core product as a wagering market with house odds.",
        },
      ],
      unresolvedUncertainties: [],
    },
  ],
};

export interface BuildReviewPackOptions {
  generatedAt: string;
  batchSize: number;
  needsReviewTotal: number;
}

/**
 * Builds the document. Pure: given the same registry facts and the same
 * `generatedAt`, the bytes are identical.
 */
export function buildReviewPack(
  batch: readonly ReviewPackSource[],
  options: BuildReviewPackOptions
): ShariahReviewPack {
  return {
    format: REVIEW_PACK_FORMAT,
    policyVersion: TS_SHARIAH_V1,
    generatedAt: options.generatedAt,
    batchSize: options.batchSize,
    assetCount: batch.length,
    needsReviewTotal: options.needsReviewTotal,
    policy: {
      version: TS_SHARIAH_V1,
      premises: TS_SHARIAH_V1_PREMISES,
      questions: TS_SHARIAH_V1_RESEARCH_QUESTIONS,
      prohibitedCategories: PROHIBITED_CATEGORIES,
      interpretationRules: TS_SHARIAH_V1_INTERPRETATION_RULES,
      classifications: CLASSIFICATIONS,
    },
    instructions: INSTRUCTIONS,
    resultContract: {
      format: REVIEW_RESULTS_FORMAT,
      policyVersion: TS_SHARIAH_V1,
      required: RESULT_CONTRACT_REQUIRED,
      example: RESULT_EXAMPLE,
    },
    assets: batch.map((asset) => ({
      assetId: String(asset.assetId),
      baseAsset: asset.baseAsset,
      projectName: asset.projectName,
      binanceAvailable: asset.binanceAvailable,
      lifecycle: asset.lifecycle,
      classification: asset.classification,
      effectiveStatus: asset.effectiveStatus,
      policyVersion: asset.policyVersion,
      reviewReason: reviewReasonFor(asset),
      requiresFullFreshScreening: asset.lifecycle === "STALE",
      staleSince: asset.lifecycle === "STALE" ? asset.updatedAt : null,
      priorPublication: asset.priorPublication ?? null,
      priorEvidence: [...(asset.priorEvidence ?? [])],
    })),
  };
}
