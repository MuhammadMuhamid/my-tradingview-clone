/**
 * Authoritative read boundary for the Shariah universe. This is the one
 * place later Screener, Chart, Research, Paper, live-trading and Bot
 * integrations should read Shariah state from — no downstream code should
 * query shariah_* tables directly.
 *
 * Deliberately read-heavy: SH-1 has no review/publication UI, so there is no
 * generic "set classification" write path here. `src/shariah/sync.ts` is the
 * only writer, and it only ever produces UNSCREENED/REVIEW rows.
 */
import { query } from "../db/pool";
import {
  effectiveShariahStatus,
  type Classification,
  type Lifecycle,
  type PolicyVersion,
  type ProhibitedCategory,
} from "../shariah/policy";

export interface ShariahAssetState {
  assetId: string;
  baseAsset: string;
  projectName: string | null;
  binanceAvailable: boolean;
  classification: Classification;
  lifecycle: Lifecycle;
  effectiveStatus: Classification;
  policyVersion: PolicyVersion;
  reason: string | null;
  prohibitedCategories: ProhibitedCategory[];
  reviewedAt: string | null;
  publishedAt: string | null;
}

interface AssetStateRow {
  asset_id: string;
  base_asset: string;
  project_name: string | null;
  binance_available: boolean;
  classification: Classification | null;
  lifecycle: Lifecycle | null;
  policy_version: PolicyVersion | null;
  reason: string | null;
  prohibited_categories: ProhibitedCategory[] | null;
  reviewed_at: string | null;
  published_at: string | null;
}

const SELECT_ASSET_STATE = `
  SELECT m.asset_id, m.base_asset, a.project_name, m.binance_available,
         r.classification, r.lifecycle, r.policy_version, r.reason,
         r.prohibited_categories, r.reviewed_at, r.published_at
    FROM shariah_asset_binance_mappings m
    JOIN shariah_assets a ON a.asset_id = m.asset_id
    LEFT JOIN shariah_records r ON r.asset_id = m.asset_id
`;

function toAssetState(row: AssetStateRow): ShariahAssetState {
  const classification = row.classification ?? "REVIEW";
  const lifecycle = row.lifecycle ?? "UNSCREENED";
  return {
    assetId: row.asset_id,
    baseAsset: row.base_asset,
    projectName: row.project_name,
    binanceAvailable: row.binance_available,
    classification,
    lifecycle,
    effectiveStatus: effectiveShariahStatus({ classification, lifecycle }),
    policyVersion: row.policy_version ?? "TS_SHARIAH_V1",
    reason: row.reason,
    prohibitedCategories: row.prohibited_categories ?? [],
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
  };
}

/** Resolve by current Binance base symbol, e.g. "BTC" for BTCUSDT. */
export async function getAssetByBaseSymbol(baseAsset: string): Promise<ShariahAssetState | null> {
  const { rows } = await query<AssetStateRow>(
    `${SELECT_ASSET_STATE} WHERE m.base_asset = $1`,
    [baseAsset.toUpperCase()]
  );
  return rows[0] ? toAssetState(rows[0]) : null;
}

/** Every base asset currently qualifying as active Binance Spot USDT + Trading Scene supported. */
export async function listActiveUniverse(): Promise<ShariahAssetState[]> {
  const { rows } = await query<AssetStateRow>(
    `${SELECT_ASSET_STATE} WHERE m.binance_available ORDER BY m.base_asset`
  );
  return rows.map(toAssetState);
}

/** Every known base asset, including delisted ones (history is never deleted). */
export async function listAllAssets(): Promise<ShariahAssetState[]> {
  const { rows } = await query<AssetStateRow>(`${SELECT_ASSET_STATE} ORDER BY m.base_asset`);
  return rows.map(toAssetState);
}

/** Active assets whose effective status is the given public classification. */
export async function listActiveByEffectiveStatus(status: Classification): Promise<ShariahAssetState[]> {
  const all = await listActiveUniverse();
  return all.filter((a) => a.effectiveStatus === status);
}

/** Active assets needing screening attention: never screened, or screened but stale. */
export async function listMaintenanceCandidates(): Promise<ShariahAssetState[]> {
  const all = await listActiveUniverse();
  return all.filter((a) => a.lifecycle === "UNSCREENED" || a.lifecycle === "STALE");
}

export interface ShariahEvidenceInput {
  assetId: string;
  url?: string | null;
  title?: string | null;
  publisher?: string | null;
  retrievedAt?: string | null;
  excerpt?: string | null;
}

export interface ShariahEvidenceRecord extends ShariahEvidenceInput {
  id: string;
  createdAt: string;
}

interface EvidenceRow {
  id: string;
  asset_id: string;
  url: string | null;
  title: string | null;
  publisher: string | null;
  retrieved_at: string | null;
  excerpt: string | null;
  created_at: string;
}

function toEvidence(row: EvidenceRow): ShariahEvidenceRecord {
  return {
    id: row.id,
    assetId: row.asset_id,
    url: row.url,
    title: row.title,
    publisher: row.publisher,
    retrievedAt: row.retrieved_at,
    excerpt: row.excerpt,
    createdAt: row.created_at,
  };
}

/** Records a factual evidence note. No AI collection/review happens here — the caller supplies the content. */
export async function addEvidence(input: ShariahEvidenceInput): Promise<ShariahEvidenceRecord> {
  const { rows } = await query<EvidenceRow>(
    `INSERT INTO shariah_evidence (asset_id, url, title, publisher, retrieved_at, excerpt)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.assetId, input.url ?? null, input.title ?? null, input.publisher ?? null,
      input.retrievedAt ?? null, input.excerpt ?? null]
  );
  return toEvidence(rows[0]!);
}

export async function listEvidence(assetId: string): Promise<ShariahEvidenceRecord[]> {
  const { rows } = await query<EvidenceRow>(
    "SELECT * FROM shariah_evidence WHERE asset_id = $1 ORDER BY created_at",
    [assetId]
  );
  return rows.map(toEvidence);
}
