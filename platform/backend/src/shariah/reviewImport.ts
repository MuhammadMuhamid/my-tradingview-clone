/**
 * `TS_SHARIAH_REVIEW_RESULTS_V1` — the strict import boundary for a research
 * file produced OUTSIDE this system (the operator's own ChatGPT session, from
 * a `TS_SHARIAH_REVIEW_PACK_V1` pack) and handed back as JSON.
 *
 * The file is data from an untrusted-by-construction source: a language model
 * that may hallucinate an asset, invent a category, restate an old decision, or
 * emit a field nobody asked for. Three rules follow, and all three are enforced
 * here rather than trusted:
 *
 * 1. STRICT, CLOSED SCHEMA. Every object rejects keys it does not define. There
 *    is deliberately no `evidenceIds`, no `publicationId`, no `reconfirm` and no
 *    `lifecycle` field, so the file has NO vocabulary for reusing prior evidence
 *    or re-asserting a prior decision — an unrecognised key is an error, not a
 *    silently ignored extra. Nothing in the document names a database row to
 *    mutate; the only identity it can carry is `assetId`, which must already
 *    exist in the registry and must agree with `baseAsset`.
 * 2. STALE MEANS RE-SCREENED, NOT RECONFIRMED. A STALE asset's prior decision
 *    was withdrawn at `staleSince`. Every result for a STALE asset must cite at
 *    least one evidence entry RETRIEVED AT OR AFTER that instant, whatever the
 *    classification. Pasting back last year's research therefore fails, and
 *    there is no other route to SCREENED.
 * 3. THE DECISION IS NOT WRITTEN HERE. Validation produces an ordinary
 *    `PublishShariahDecisionInput` per result, and publication.ts — the single
 *    publication authority — applies its own completeness gate and appends its
 *    own immutable history. This module has no INSERT of its own except the
 *    evidence rows the results themselves supply.
 *
 * Content is stored and displayed as TEXT. Nothing here evaluates, fetches or
 * executes anything the document contains.
 */
import {
  PROHIBITED_CATEGORIES, TS_SHARIAH_V1,
  isClassification, isProhibitedCategory,
  type Classification, type PolicyVersion,
} from "./policy";
import { REVIEW_RESULTS_FORMAT, MAX_REVIEW_BATCH_SIZE } from "./reviewPack";
import {
  publishShariahDecisionWithin, type PublishedShariahDecision,
} from "./publication";
import type { ShariahDbClient } from "./sync";

/** A rejected import. Carries every problem found, so one round trip fixes the file. */
export class ShariahReviewImportError extends Error {
  readonly issues: ReviewImportIssue[];
  constructor(issues: ReviewImportIssue[]) {
    super(issues.length === 1
      ? issues[0]!.message
      : `${issues.length} problems in the imported review results`);
    this.name = "ShariahReviewImportError";
    this.issues = issues;
  }
}

export interface ReviewImportIssue {
  /** Index in `results`, or null for a document-level problem. */
  index: number | null;
  assetId: string | null;
  baseAsset: string | null;
  message: string;
}

/** The six answers, matching `TS_SHARIAH_V1_RESEARCH_QUESTIONS` one-for-one. */
export const ANSWER_KEYS = [
  "project", "tokenFunction", "rightsExposure",
  "coreActivities", "prohibitedEvidence", "evidenceSufficiency",
] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];

const RESULT_KEYS = new Set([
  "assetId", "baseAsset", "policyVersion", "classification", "answers",
  "reason", "prohibitedCategories", "evidence", "unresolvedUncertainties",
]);
const EVIDENCE_KEYS = new Set(["url", "title", "publisher", "retrievedAt", "note"]);
const DOCUMENT_KEYS = new Set(["format", "policyVersion", "researchCompletedAt", "packGeneratedAt", "results"]);

/** Bounded so a pasted multi-megabyte file cannot become a long transaction. */
const MAX_TEXT = 4000;
const MAX_EVIDENCE_PER_RESULT = 20;
const MAX_UNCERTAINTIES = 20;

export interface ImportedEvidence {
  url: string;
  title: string;
  publisher: string;
  retrievedAt: string;
  note: string;
}

export interface ImportedResult {
  assetId: string;
  baseAsset: string;
  policyVersion: PolicyVersion;
  classification: Classification;
  answers: Record<AnswerKey, string>;
  reason: string;
  prohibitedCategories: string[];
  evidence: ImportedEvidence[];
  unresolvedUncertainties: string[];
}

export interface ParsedReviewResults {
  policyVersion: PolicyVersion;
  researchCompletedAt: string;
  results: ImportedResult[];
}

/** Registry facts a result is checked against. Read from the database, never from the file. */
export interface ImportRegistryAsset {
  assetId: string;
  baseAsset: string;
  lifecycle: "SCREENED" | "UNSCREENED" | "STALE";
  binanceAvailable: boolean;
  /** For a STALE asset, when the prior decision was withdrawn. Evidence must be at/after it. */
  staleSince: string | null;
}

// ── primitive readers ───────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((k) => !allowed.has(k));
}

function text(value: unknown, field: string, issues: string[]): string {
  if (typeof value !== "string") {
    issues.push(`${field} must be a string`);
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) issues.push(`${field} must not be empty`);
  if (trimmed.length > MAX_TEXT) issues.push(`${field} exceeds ${MAX_TEXT} characters`);
  return trimmed;
}

/**
 * Only absolute http/https URLs are accepted as evidence.
 *
 * This is a storage guard, not a fetch guard: nothing in Trading Scene ever
 * requests these URLs. It exists so a `javascript:`, `data:` or `file:` string
 * can never be recorded as a citation and later rendered as a link.
 */
function evidenceUrl(value: unknown, field: string, issues: string[]): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) {
    issues.push(`${field} must be a URL`);
    return "";
  }
  if (raw.length > MAX_TEXT) {
    issues.push(`${field} exceeds ${MAX_TEXT} characters`);
    return raw.slice(0, MAX_TEXT);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    issues.push(`${field} is not a valid absolute URL: ${JSON.stringify(raw)}`);
    return raw;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.push(`${field} must be http(s), got ${JSON.stringify(parsed.protocol)}`);
  }
  if (!parsed.hostname) issues.push(`${field} has no host`);
  return raw;
}

function timestamp(value: unknown, field: string, issues: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${field} must be an ISO-8601 timestamp`);
    return "";
  }
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) {
    issues.push(`${field} is not a valid timestamp: ${JSON.stringify(value)}`);
    return "";
  }
  if (ms > Date.now() + 60_000) issues.push(`${field} cannot be in the future`);
  return new Date(ms).toISOString();
}

// ── structural validation (no database) ─────────────────────────────────────

function parseEvidence(raw: unknown, label: string, issues: string[]): ImportedEvidence {
  if (!isRecord(raw)) {
    issues.push(`${label} must be an object`);
    return { url: "", title: "", publisher: "", retrievedAt: "", note: "" };
  }
  for (const key of unknownKeys(raw, EVIDENCE_KEYS)) {
    issues.push(`${label} has an unrecognised field ${JSON.stringify(key)}`);
  }
  return {
    url: evidenceUrl(raw.url, `${label}.url`, issues),
    title: text(raw.title, `${label}.title`, issues),
    publisher: text(raw.publisher, `${label}.publisher`, issues),
    retrievedAt: timestamp(raw.retrievedAt, `${label}.retrievedAt`, issues),
    note: text(raw.note, `${label}.note`, issues),
  };
}

function parseAnswers(raw: unknown, issues: string[]): Record<AnswerKey, string> {
  const answers = {} as Record<AnswerKey, string>;
  if (!isRecord(raw)) {
    issues.push("answers must be an object with one answer per policy question");
    for (const key of ANSWER_KEYS) answers[key] = "";
    return answers;
  }
  for (const key of unknownKeys(raw, new Set<string>(ANSWER_KEYS))) {
    issues.push(`answers has an unrecognised field ${JSON.stringify(key)}`);
  }
  for (const key of ANSWER_KEYS) {
    answers[key] = text(raw[key], `answers.${key}`, issues);
  }
  return answers;
}

function parseResult(raw: unknown, issues: string[]): ImportedResult {
  const blank: ImportedResult = {
    assetId: "", baseAsset: "", policyVersion: TS_SHARIAH_V1, classification: "REVIEW",
    answers: parseAnswers(undefined, []), reason: "", prohibitedCategories: [],
    evidence: [], unresolvedUncertainties: [],
  };
  if (!isRecord(raw)) {
    issues.push("each entry in results must be an object");
    return blank;
  }
  for (const key of unknownKeys(raw, RESULT_KEYS)) {
    issues.push(`unrecognised field ${JSON.stringify(key)} — this contract has no such field, ` +
      "and no field of any name can reuse prior evidence or re-assert a prior decision");
  }

  const assetId = typeof raw.assetId === "string" || typeof raw.assetId === "number"
    ? String(raw.assetId).trim() : "";
  if (!/^[0-9]+$/.test(assetId)) {
    issues.push(`assetId must be the numeric id copied from the review pack, got ${JSON.stringify(raw.assetId)}`);
  }

  const baseAsset = typeof raw.baseAsset === "string" ? raw.baseAsset.trim().toUpperCase() : "";
  if (baseAsset.length === 0) issues.push("baseAsset must be the base symbol copied from the review pack");

  if (raw.policyVersion !== TS_SHARIAH_V1) {
    issues.push(`policyVersion must be ${TS_SHARIAH_V1}, got ${JSON.stringify(raw.policyVersion)}`);
  }

  const classificationRaw = typeof raw.classification === "string" ? raw.classification.trim() : "";
  if (!isClassification(classificationRaw)) {
    issues.push(`classification must be ELIGIBLE, EXCLUDED or REVIEW, got ${JSON.stringify(raw.classification)}`);
  }
  const classification = (isClassification(classificationRaw) ? classificationRaw : "REVIEW") as Classification;

  const answers = parseAnswers(raw.answers, issues);
  const reason = text(raw.reason, "reason", issues);

  const categories: string[] = [];
  if (raw.prohibitedCategories !== undefined) {
    if (!Array.isArray(raw.prohibitedCategories)) {
      issues.push("prohibitedCategories must be an array");
    } else {
      for (const category of raw.prohibitedCategories) {
        const value = typeof category === "string" ? category.trim() : "";
        if (!isProhibitedCategory(value)) {
          issues.push(`prohibitedCategories contains ${JSON.stringify(category)}, which is not a ` +
            `TS_SHARIAH_V1 category. The fixed list is: ${PROHIBITED_CATEGORIES.join(", ")}`);
          continue;
        }
        if (!categories.includes(value)) categories.push(value);
      }
    }
  }

  const evidence: ImportedEvidence[] = [];
  if (raw.evidence !== undefined) {
    if (!Array.isArray(raw.evidence)) {
      issues.push("evidence must be an array");
    } else if (raw.evidence.length > MAX_EVIDENCE_PER_RESULT) {
      issues.push(`evidence has ${raw.evidence.length} entries, more than the ${MAX_EVIDENCE_PER_RESULT} allowed`);
    } else {
      raw.evidence.forEach((entry, i) => evidence.push(parseEvidence(entry, `evidence[${i}]`, issues)));
    }
  }

  const uncertainties: string[] = [];
  if (raw.unresolvedUncertainties !== undefined) {
    if (!Array.isArray(raw.unresolvedUncertainties)) {
      issues.push("unresolvedUncertainties must be an array of strings");
    } else if (raw.unresolvedUncertainties.length > MAX_UNCERTAINTIES) {
      issues.push(`unresolvedUncertainties has more than the ${MAX_UNCERTAINTIES} allowed entries`);
    } else {
      raw.unresolvedUncertainties.forEach((entry, i) =>
        uncertainties.push(text(entry, `unresolvedUncertainties[${i}]`, issues)));
    }
  }

  // The publication authority applies these too; stating them here means the
  // operator sees every problem in the file at once instead of one per attempt.
  if (classification === "EXCLUDED") {
    if (categories.length === 0) issues.push("EXCLUDED requires at least one prohibited category");
    if (evidence.length === 0) issues.push("EXCLUDED requires at least one evidence entry");
  }
  if (classification === "ELIGIBLE") {
    if (evidence.length === 0) {
      issues.push("ELIGIBLE requires at least one evidence entry — absence of evidence is not proof of eligibility");
    }
    if (categories.length > 0) issues.push("ELIGIBLE cannot carry prohibited categories");
  }

  return { assetId, baseAsset, policyVersion: TS_SHARIAH_V1, classification, answers,
    reason, prohibitedCategories: categories, evidence, unresolvedUncertainties: uncertainties };
}

/**
 * Structural validation of the whole document, with no database access.
 * Throws `ShariahReviewImportError` carrying every problem found.
 */
export function parseReviewResults(raw: unknown): ParsedReviewResults {
  const issues: ReviewImportIssue[] = [];
  const doc = (v: string): void => { issues.push({ index: null, assetId: null, baseAsset: null, message: v }); };

  if (!isRecord(raw)) {
    throw new ShariahReviewImportError([{ index: null, assetId: null, baseAsset: null,
      message: "the imported file must be a single JSON object" }]);
  }
  for (const key of unknownKeys(raw, DOCUMENT_KEYS)) {
    doc(`unrecognised top-level field ${JSON.stringify(key)}`);
  }
  if (raw.format !== REVIEW_RESULTS_FORMAT) {
    doc(`format must be ${REVIEW_RESULTS_FORMAT}, got ${JSON.stringify(raw.format)}`);
  }
  if (raw.policyVersion !== TS_SHARIAH_V1) {
    doc(`policyVersion must be ${TS_SHARIAH_V1}, got ${JSON.stringify(raw.policyVersion)}`);
  }

  const documentIssues: string[] = [];
  const researchCompletedAt = timestamp(raw.researchCompletedAt, "researchCompletedAt", documentIssues);
  for (const message of documentIssues) doc(message);

  const results: ImportedResult[] = [];
  if (!Array.isArray(raw.results)) {
    doc("results must be an array");
  } else if (raw.results.length === 0) {
    doc("results is empty — there is nothing to import");
  } else if (raw.results.length > MAX_REVIEW_BATCH_SIZE) {
    doc(`results has ${raw.results.length} entries, more than the ${MAX_REVIEW_BATCH_SIZE} allowed in one import`);
  } else {
    const seen = new Map<string, number>();
    raw.results.forEach((entry, index) => {
      const perResult: string[] = [];
      const parsed = parseResult(entry, perResult);
      const first = seen.get(parsed.assetId);
      if (parsed.assetId && first !== undefined) {
        perResult.push(`duplicate result for assetId ${parsed.assetId} (also at results[${first}]) — ` +
          "one import carries at most one decision per asset");
      } else if (parsed.assetId) {
        seen.set(parsed.assetId, index);
      }
      for (const message of perResult) {
        issues.push({ index, assetId: parsed.assetId || null, baseAsset: parsed.baseAsset || null, message });
      }
      results.push(parsed);
    });
  }

  if (issues.length > 0) throw new ShariahReviewImportError(issues);
  return { policyVersion: TS_SHARIAH_V1, researchCompletedAt, results };
}

/**
 * Checks each parsed result against the live registry: the asset must exist,
 * the base symbol must still be the one the researcher was given, and a STALE
 * asset must be backed by evidence retrieved after it went stale.
 */
export function validateAgainstRegistry(
  parsed: ParsedReviewResults,
  registry: ReadonlyMap<string, ImportRegistryAsset>
): void {
  const issues: ReviewImportIssue[] = [];
  parsed.results.forEach((result, index) => {
    const push = (message: string): void => {
      issues.push({ index, assetId: result.assetId, baseAsset: result.baseAsset, message });
    };
    const asset = registry.get(result.assetId);
    if (!asset) {
      push(`unknown assetId ${result.assetId} — it is not in the Shariah registry`);
      return;
    }
    if (asset.baseAsset.toUpperCase() !== result.baseAsset) {
      push(`baseAsset mismatch: assetId ${result.assetId} is ${asset.baseAsset} in the registry, ` +
        `the file says ${result.baseAsset}`);
    }
    if (asset.lifecycle === "STALE") {
      // The precise failure mode this blocks: pasting back the pre-staleness
      // research (or the prior decision restated) instead of re-screening.
      const staleSince = asset.staleSince ? Date.parse(asset.staleSince) : NaN;
      const fresh = result.evidence.filter((e) => {
        const retrieved = Date.parse(e.retrievedAt);
        return Number.isFinite(retrieved) && (!Number.isFinite(staleSince) || retrieved >= staleSince);
      });
      if (fresh.length === 0) {
        push(`${asset.baseAsset} is STALE and requires a FULL fresh screening: at least one evidence ` +
          `entry must have been retrieved at or after ${asset.staleSince ?? "the staleness event"}. ` +
          "The previous classification cannot be reconfirmed or copied forward.");
      }
    }
  });
  if (issues.length > 0) throw new ShariahReviewImportError(issues);
}

// ── publication ─────────────────────────────────────────────────────────────

export interface ReviewImportOutcome {
  assetId: string;
  baseAsset: string;
  classification: Classification;
  publicationId: string;
  evidenceIds: string[];
}

export interface ReviewImportSummary {
  policyVersion: PolicyVersion;
  researchCompletedAt: string;
  importedCount: number;
  counts: Record<Classification, number>;
  publishedBy: string;
  outcomes: ReviewImportOutcome[];
}

const REGISTRY_SQL = `
  SELECT m.asset_id, m.base_asset, m.binance_available,
         COALESCE(r.lifecycle, 'UNSCREENED') AS lifecycle, r.updated_at
    FROM shariah_asset_binance_mappings m
    LEFT JOIN shariah_records r ON r.asset_id = m.asset_id
   WHERE m.asset_id = ANY($1::bigint[])
`;

interface RegistryRow {
  asset_id: string;
  base_asset: string;
  binance_available: boolean;
  lifecycle: "SCREENED" | "UNSCREENED" | "STALE";
  updated_at: string | Date | null;
}

export async function loadImportRegistry(
  db: ShariahDbClient,
  assetIds: readonly string[]
): Promise<Map<string, ImportRegistryAsset>> {
  const registry = new Map<string, ImportRegistryAsset>();
  const ids = [...new Set(assetIds.filter((id) => /^[0-9]+$/.test(id)))];
  if (ids.length === 0) return registry;
  const { rows } = await db.query<RegistryRow>(REGISTRY_SQL, [ids]);
  for (const row of rows) {
    const updatedAt = row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at === null ? null : String(row.updated_at);
    registry.set(String(row.asset_id), {
      assetId: String(row.asset_id),
      baseAsset: row.base_asset,
      lifecycle: row.lifecycle,
      binanceAvailable: row.binance_available,
      staleSince: row.lifecycle === "STALE" ? updatedAt : null,
    });
  }
  return registry;
}

/** Preview only: validates the file against the registry and reports what WOULD be published. */
export async function previewShariahReviewResults(
  db: ShariahDbClient,
  raw: unknown
): Promise<{ parsed: ParsedReviewResults; counts: Record<Classification, number> }> {
  const parsed = parseReviewResults(raw);
  const registry = await loadImportRegistry(db, parsed.results.map((r) => r.assetId));
  validateAgainstRegistry(parsed, registry);
  return { parsed, counts: countByClassification(parsed.results) };
}

export function countByClassification(
  results: readonly ImportedResult[]
): Record<Classification, number> {
  const counts: Record<Classification, number> = { ELIGIBLE: 0, EXCLUDED: 0, REVIEW: 0 };
  for (const result of results) counts[result.classification] += 1;
  return counts;
}

/**
 * The one explicit human act: importing IS the publication approval for the
 * whole batch. The operator approves 20 researched assets once, not 20 times.
 *
 * ALL-OR-NOTHING. Validation runs to completion first, so a file with one bad
 * entry publishes nothing at all; the whole batch then commits in a single
 * transaction. A partially applied import of a malformed research file is the
 * confusing outcome this deliberately avoids — the operator fixes the file and
 * re-imports, and there is no half-published state to reconcile.
 *
 * `db` MUST be a dedicated connection (a `pg` PoolClient), not the pool.
 */
export async function importShariahReviewResults(
  db: ShariahDbClient,
  options: { document: unknown; publishedBy: string }
): Promise<ReviewImportSummary> {
  const publishedBy = String(options.publishedBy ?? "").trim();
  if (publishedBy.length === 0) {
    throw new ShariahReviewImportError([{ index: null, assetId: null, baseAsset: null,
      message: "an import requires the approving operator identity" }]);
  }

  const parsed = parseReviewResults(options.document);
  const registry = await loadImportRegistry(db, parsed.results.map((r) => r.assetId));
  validateAgainstRegistry(parsed, registry);

  const outcomes: ReviewImportOutcome[] = [];
  await db.query("BEGIN");
  try {
    for (const result of parsed.results) {
      const evidenceIds: string[] = [];
      for (const entry of result.evidence) {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO shariah_evidence (asset_id, url, title, publisher, retrieved_at, excerpt)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [result.assetId, entry.url, entry.title, entry.publisher, entry.retrievedAt, entry.note]
        );
        evidenceIds.push(String(inserted.rows[0]!.id));
      }

      // Straight through the single publication authority. Nothing about this
      // call says the decision arrived in a batch or came from a research file.
      const published: PublishedShariahDecision = await publishShariahDecisionWithin(db, {
        assetId: result.assetId,
        policyVersion: TS_SHARIAH_V1,
        classification: result.classification,
        reason: composeReason(result),
        prohibitedCategories: result.prohibitedCategories,
        evidenceIds,
        reviewedAt: parsed.researchCompletedAt,
        publishedBy,
      });
      outcomes.push({
        assetId: result.assetId,
        baseAsset: result.baseAsset,
        classification: result.classification,
        publicationId: published.publicationId,
        evidenceIds,
      });
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }

  return {
    policyVersion: TS_SHARIAH_V1,
    researchCompletedAt: parsed.researchCompletedAt,
    importedCount: outcomes.length,
    counts: countByClassification(parsed.results),
    publishedBy,
    outcomes,
  };
}

/**
 * The published `reason` keeps the researched answers with the decision, so the
 * immutable history records WHY, not just WHAT. Plain text — the answers are
 * stored and rendered as text and are never interpreted.
 */
export function composeReason(result: ImportedResult): string {
  const parts = [result.reason, "", "TS_SHARIAH_V1 review answers:",
    `- Project: ${result.answers.project}`,
    `- Token function: ${result.answers.tokenFunction}`,
    `- Rights / economic exposure: ${result.answers.rightsExposure}`,
    `- Core / material activities: ${result.answers.coreActivities}`,
    `- Prohibited-category evidence: ${result.answers.prohibitedEvidence}`,
    `- Evidence sufficiency: ${result.answers.evidenceSufficiency}`];
  if (result.unresolvedUncertainties.length > 0) {
    parts.push("", "Unresolved uncertainties:",
      ...result.unresolvedUncertainties.map((u) => `- ${u}`));
  }
  return parts.join("\n");
}
