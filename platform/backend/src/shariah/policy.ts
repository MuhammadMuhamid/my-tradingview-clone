/**
 * TS_SHARIAH_V1 — Trading Scene Shariah screening methodology, v1.
 *
 * This is a screening methodology, not a fatwa generator. It answers exactly
 * one question per asset: is the underlying asset/project that we are buying
 * itself materially connected to a prohibited activity under this policy?
 *
 * Fixed product/religious premises (not re-litigated here): spot crypto
 * trading is permissible, USDT is permissible, Binance Spot is the venue.
 * The unique underlying BASE ASSET is screened once, not every USDT pair.
 *
 * A future methodology change is a new explicit version (e.g. TS_SHARIAH_V2).
 * TS_SHARIAH_V1's meaning never silently mutates.
 */
export const TS_SHARIAH_V1 = "TS_SHARIAH_V1" as const;

export const POLICY_VERSIONS = [TS_SHARIAH_V1] as const;
export type PolicyVersion = (typeof POLICY_VERSIONS)[number];

export function isPolicyVersion(v: string): v is PolicyVersion {
  return (POLICY_VERSIONS as readonly string[]).includes(v);
}

/** The substantive questions TS_SHARIAH_V1 asks of every base asset. */
export const TS_SHARIAH_V1_QUESTIONS = [
  "What is the actual project/asset?",
  "What does the token/coin represent or do?",
  "Does the project's own core/material activity, or the asset itself, " +
    "directly represent, finance, provide, or materially depend upon an excluded activity?",
  "Is there enough reliable evidence to classify it?",
] as const;

/** Prohibited categories under TS_SHARIAH_V1. Fixed — not dynamically extended. */
export const PROHIBITED_CATEGORIES = [
  "RIBA_INTEREST_BASED_FINANCE",
  "GAMBLING_BETTING_CASINO",
  "PORNOGRAPHY_ADULT_SEXUAL_BUSINESS",
  "ALCOHOL",
  "PORK_PROHIBITED_FOOD",
  "TOBACCO",
  "CONVENTIONAL_INSURANCE",
  "PROHIBITED_BUSINESS_OWNERSHIP_OR_FINANCING",
] as const;
export type ProhibitedCategory = (typeof PROHIBITED_CATEGORIES)[number];

export function isProhibitedCategory(v: string): v is ProhibitedCategory {
  return (PROHIBITED_CATEGORIES as readonly string[]).includes(v);
}

/**
 * TS_SHARIAH_V1 interpretation rules. These are the load-bearing part of the
 * policy: they exist precisely to block the shortcut classifications SH-1
 * must not make (meme status, category-label, or infrastructure-use based).
 */
export const TS_SHARIAH_V1_INTERPRETATION_RULES = [
  "Third-party use of neutral infrastructure for prohibited purposes does not itself exclude the asset.",
  "Meme status has no Shariah classification effect.",
  "Category labels (DeFi, DEX, staking, GameFi, AI, L1, L2, utility, and similar) do not independently determine classification.",
  "A token issued by a company is not automatically equivalent to owning equity in that company.",
  "Parent-company activity matters only when the token/project economically represents, finances, materially depends upon, or grants rights tied to that activity.",
  "No percentage prohibited-revenue thresholds are invented.",
  "Mixed, significant, or unclear materiality resolves to REVIEW.",
  "Absence of evidence is not proof of eligibility.",
  "AI statements are not evidence.",
] as const;

/** Public classification, once a screening is published. */
export const CLASSIFICATIONS = ["ELIGIBLE", "EXCLUDED", "REVIEW"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export function isClassification(v: string): v is Classification {
  return (CLASSIFICATIONS as readonly string[]).includes(v);
}

/** Internal screening lifecycle. */
export const LIFECYCLES = ["SCREENED", "UNSCREENED", "STALE"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export function isLifecycle(v: string): v is Lifecycle {
  return (LIFECYCLES as readonly string[]).includes(v);
}

export interface ShariahRecordState {
  classification: Classification;
  lifecycle: Lifecycle;
}

/**
 * The one place effective status is derived. UNSCREENED and STALE always
 * resolve to REVIEW regardless of any stored classification value (a stored
 * default of 'REVIEW' backs this up, but the mapping does not trust it — a
 * SCREENED lifecycle is the only path to a published classification), and a
 * missing record (asset never screened, or unknown to the registry) resolves
 * to REVIEW rather than defaulting to ELIGIBLE.
 */
export function effectiveShariahStatus(record: ShariahRecordState | null): Classification {
  if (!record) return "REVIEW";
  if (record.lifecycle !== "SCREENED") return "REVIEW";
  return record.classification;
}

/** Guard used at the write boundary — the CHECK constraints in 022_shariah_universe.sql are the durable enforcement. */
export function assertValidShariahRecordInput(input: {
  classification: string;
  lifecycle: string;
  policyVersion: string;
  reason?: string | null;
  prohibitedCategories?: string[] | null;
}): void {
  if (!isClassification(input.classification)) {
    throw new Error(`invalid classification: ${JSON.stringify(input.classification)}`);
  }
  if (!isLifecycle(input.lifecycle)) {
    throw new Error(`invalid lifecycle: ${JSON.stringify(input.lifecycle)}`);
  }
  if (!isPolicyVersion(input.policyVersion)) {
    throw new Error(`invalid policy_version: ${JSON.stringify(input.policyVersion)}`);
  }
  for (const category of input.prohibitedCategories ?? []) {
    if (!isProhibitedCategory(category)) {
      throw new Error(`invalid prohibited category: ${JSON.stringify(category)}`);
    }
  }
  if (input.classification === "EXCLUDED") {
    if (!input.reason) throw new Error("EXCLUDED classification requires a reason");
    if (!input.prohibitedCategories || input.prohibitedCategories.length === 0) {
      throw new Error("EXCLUDED classification requires at least one prohibited category");
    }
  }
}
