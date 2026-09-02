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
};
