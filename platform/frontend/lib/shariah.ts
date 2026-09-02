/**
 * Client for the private Shariah review/publication API.
 *
 * Everything here is a thin pass-through. No classification logic lives in the
 * browser: the operator's decision travels to the backend intact, and the
 * backend's publication authority is the only thing that accepts or refuses
 * it. The page must never be able to make an asset ELIGIBLE by itself.
 */
export type ShariahClassification = "ELIGIBLE" | "EXCLUDED" | "REVIEW";
export type ShariahLifecycle = "SCREENED" | "UNSCREENED" | "STALE";

export interface ShariahAssetState {
  assetId: string;
  baseAsset: string;
  projectName: string | null;
  binanceAvailable: boolean;
  classification: ShariahClassification;
  lifecycle: ShariahLifecycle;
  effectiveStatus: ShariahClassification;
  policyVersion: string;
  reason: string | null;
  prohibitedCategories: string[];
  reviewedAt: string | null;
  publishedAt: string | null;
}

export interface ShariahUniverse {
  policyVersion: string;
  prohibitedCategories: string[];
  counts: { total: number; active: number; eligible: number; review: number; excluded: number };
  assets: ShariahAssetState[];
}

export interface ShariahEvidence {
  id: string;
  assetId: string;
  url: string | null;
  title: string | null;
  publisher: string | null;
  retrievedAt: string | null;
  excerpt: string | null;
  createdAt: string;
}

export interface ShariahPublication {
  publicationId: string;
  assetId: string;
  policyVersion: string;
  classification: ShariahClassification;
  lifecycle: "SCREENED";
  reason: string;
  prohibitedCategories: string[];
  baseAssetAtPublication: string | null;
  reviewedAt: string;
  publishedAt: string;
  publishedBy: string;
  evidenceIds: string[];
}

export interface ShariahAssetDetail {
  asset: ShariahAssetState;
  evidence: ShariahEvidence[];
  publications: ShariahPublication[];
}

export interface ShariahSnapshotMeta {
  snapshotId: string;
  policyVersion: string;
  contentHash: string;
  entryCount: number;
  createdAt: string;
  createdBy: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ── Batch review workflow (SH-3) ────────────────────────────────────────────

export type ShariahMode = "off" | "enforce";

export interface ShariahReviewPackAsset {
  assetId: string;
  baseAsset: string;
  projectName: string | null;
  lifecycle: ShariahLifecycle;
  effectiveStatus: ShariahClassification;
  reviewReason: string;
  requiresFullFreshScreening: boolean;
  staleSince: string | null;
}

export interface ShariahReviewPack {
  format: string;
  policyVersion: string;
  generatedAt: string;
  batchSize: number;
  assetCount: number;
  needsReviewTotal: number;
  assets: ShariahReviewPackAsset[];
}

export interface ShariahImportIssue {
  index: number | null;
  assetId: string | null;
  baseAsset: string | null;
  message: string;
}

export interface ShariahImportPreview {
  policyVersion: string;
  researchCompletedAt: string;
  assetCount: number;
  counts: Record<ShariahClassification, number>;
  results: Array<{
    assetId: string;
    baseAsset: string;
    classification: ShariahClassification;
    prohibitedCategories: string[];
    evidenceCount: number;
    unresolvedUncertainties: string[];
  }>;
}

export interface ShariahImportSummary {
  policyVersion: string;
  researchCompletedAt: string;
  importedCount: number;
  counts: Record<ShariahClassification, number>;
  publishedBy: string;
  outcomes: Array<{
    assetId: string; baseAsset: string;
    classification: ShariahClassification; publicationId: string; evidenceIds: string[];
  }>;
}

/**
 * The one status answer every trading surface reads.
 *
 * It is the BACKEND GATE's own decision, not raw registry fields for a
 * component to interpret: `buyAllowed` is what the backend would actually do
 * with a BUY right now, so a screener cell, a chart badge and the order panel
 * cannot disagree with enforcement or with each other. `sellAllowed` is always
 * true and is stated rather than inferred.
 */
export interface ShariahSymbolStatus {
  symbol: string;
  mode: ShariahMode;
  shariah: {
    mode: ShariahMode;
    policyVersion: string | null;
    assetId: string | null;
    baseAsset: string | null;
    effectiveStatus: ShariahClassification;
    publicationId: string | null;
  };
  buyAllowed: boolean;
  buyBlockedReason: string | null;
  sellAllowed: true;
}

/** An import rejection carries every problem in the file, not just the first. */
export class ShariahImportError extends Error {
  constructor(message: string, readonly issues: ShariahImportIssue[]) {
    super(message);
    this.name = "ShariahImportError";
  }
}

async function reqWithIssues<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let issues: ShariahImportIssue[] = [];
    try {
      const parsed = (await res.json()) as { error?: string; issues?: ShariahImportIssue[] };
      if (parsed.error) message = parsed.error;
      if (Array.isArray(parsed.issues)) issues = parsed.issues;
    } catch { /* keep status text */ }
    throw new ShariahImportError(message, issues);
  }
  return res.json() as Promise<T>;
}

export interface PublishRequest {
  classification: ShariahClassification;
  reason: string;
  prohibitedCategories: string[];
  evidenceIds: string[];
  reviewedAt: string;
}

export const shariahApi = {
  universe: () => req<ShariahUniverse>("/api/shariah/universe"),
  asset: (assetId: string) => req<ShariahAssetDetail>(`/api/shariah/assets/${assetId}`),
  addEvidence: (assetId: string, body: Omit<ShariahEvidence, "id" | "assetId" | "createdAt">) =>
    req<ShariahEvidence>(`/api/shariah/assets/${assetId}/evidence`, {
      method: "POST", body: JSON.stringify(body),
    }),
  publish: (assetId: string, body: PublishRequest) =>
    req<ShariahPublication>(`/api/shariah/assets/${assetId}/publications`, {
      method: "POST", body: JSON.stringify(body),
    }),
  snapshots: () => req<{ snapshots: ShariahSnapshotMeta[] }>("/api/shariah/snapshots"),
  createSnapshot: () => req<ShariahSnapshotMeta>("/api/shariah/snapshots", { method: "POST" }),

  /** The next batch to research. Defaults to 20 server-side; `size` is an override. */
  reviewPack: (size?: number) =>
    req<ShariahReviewPack>(`/api/shariah/review-pack${size ? `?size=${size}` : ""}`),
  previewResults: (document: unknown) =>
    reqWithIssues<ShariahImportPreview>("/api/shariah/review-results/preview", document),
  importResults: (document: unknown) =>
    reqWithIssues<ShariahImportSummary>("/api/shariah/review-results/import", document),

  mode: () => req<{ mode: ShariahMode }>("/api/shariah/mode"),
  setMode: (mode: ShariahMode) =>
    req<{ mode: ShariahMode }>("/api/shariah/mode", { method: "PUT", body: JSON.stringify({ mode }) }),

  status: (symbol: string) =>
    req<ShariahSymbolStatus>(`/api/shariah/status?symbol=${encodeURIComponent(symbol)}`),
};

/**
 * Saves a review pack as a file the operator uploads to ChatGPT.
 *
 * A Blob + object URL rather than a data: URL because a 20-asset pack with
 * prior context comfortably exceeds what some browsers accept in a navigable
 * data: URL. Returns false when there is no DOM (SSR), so callers can render
 * without branching on it.
 */
export function downloadReviewPack(pack: ShariahReviewPack): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const stamp = pack.generatedAt.replace(/[:.]/g, "-");
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `shariah-review-pack-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Parses a pasted or uploaded results file.
 *
 * Deliberately does NOTHING but `JSON.parse`: the browser never validates the
 * contract, never repairs a field and never decides what is publishable. The
 * backend import boundary owns all of that, and a preview that disagreed with
 * it would be worse than no preview at all.
 */
export function parseResultsFile(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("paste or choose a results file first");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      "that is not valid JSON. Paste only the JSON document ChatGPT returned — " +
      "no markdown fence, no commentary."
    );
  }
}
