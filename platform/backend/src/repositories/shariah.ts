/**
 * Authoritative read boundary for the Shariah universe. This is the one
 * place later Screener, Chart, Research, Paper, live-trading and Bot
 * integrations should read Shariah state from — no downstream code should
 * query shariah_* tables directly.
 *
 * Deliberately read-heavy. There is still no generic "set classification"
 * write path here: `src/shariah/sync.ts` writes only UNSCREENED/REVIEW rows,
 * and the ONLY way a classification is ever published is
 * `src/shariah/publication.ts`, which requires a complete evidence-backed
 * review and appends immutable history. SH-2 adds read access to that history
 * and to the immutable universe snapshots below.
 */
import { query } from "../db/pool";
import {
  effectiveShariahStatus,
  type Classification,
  type Lifecycle,
  type PolicyVersion,
  type ProhibitedCategory,
} from "../shariah/policy";
import type { ShariahSnapshot, ShariahSnapshotMeta } from "../shariah/snapshot";

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

/** Resolve by stable identity — the form every mutation path uses, since ticker text is not identity. */
export async function getAssetById(assetId: string): Promise<ShariahAssetState | null> {
  const { rows } = await query<AssetStateRow>(
    `${SELECT_ASSET_STATE} WHERE m.asset_id = $1`,
    [assetId]
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

// ── SH-2: published-decision history ────────────────────────────────────────

export interface ShariahPublicationRecord {
  publicationId: string;
  assetId: string;
  policyVersion: PolicyVersion;
  classification: Classification;
  lifecycle: "SCREENED";
  reason: string;
  prohibitedCategories: ProhibitedCategory[];
  baseAssetAtPublication: string | null;
  projectNameAtPublication: string | null;
  reviewedAt: string;
  publishedAt: string;
  publishedBy: string;
  /** `shariah_evidence.id` values cited by this decision. */
  evidenceIds: string[];
}

interface PublicationRow {
  publication_id: string;
  asset_id: string;
  policy_version: PolicyVersion;
  classification: Classification;
  reason: string;
  prohibited_categories: ProhibitedCategory[] | null;
  base_asset_at_publication: string | null;
  project_name_at_publication: string | null;
  reviewed_at: string;
  published_at: string;
  published_by: string;
  evidence_ids: (string | number)[] | null;
}

function toPublication(row: PublicationRow): ShariahPublicationRecord {
  return {
    publicationId: String(row.publication_id),
    assetId: String(row.asset_id),
    policyVersion: row.policy_version,
    classification: row.classification,
    lifecycle: "SCREENED",
    reason: row.reason,
    prohibitedCategories: row.prohibited_categories ?? [],
    baseAssetAtPublication: row.base_asset_at_publication,
    projectNameAtPublication: row.project_name_at_publication,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    evidenceIds: (row.evidence_ids ?? []).map(String),
  };
}

const SELECT_PUBLICATION = `
  SELECT p.*,
         COALESCE(
           (SELECT array_agg(pe.evidence_id ORDER BY pe.evidence_id)
              FROM shariah_publication_evidence pe
             WHERE pe.publication_id = p.publication_id),
           '{}'::bigint[]
         ) AS evidence_ids
    FROM shariah_publications p
`;

/** Full immutable decision history for one asset, newest first. */
export async function listPublications(assetId: string): Promise<ShariahPublicationRecord[]> {
  const { rows } = await query<PublicationRow>(
    `${SELECT_PUBLICATION} WHERE p.asset_id = $1 ORDER BY p.published_at DESC, p.publication_id DESC`,
    [assetId]
  );
  return rows.map(toPublication);
}

// ── SH-2: immutable universe snapshots ──────────────────────────────────────

interface SnapshotRow {
  snapshot_id: string;
  policy_version: PolicyVersion;
  content_hash: string;
  entry_count: number;
  created_at: string;
  created_by: string | null;
}

interface SnapshotEntryRow {
  asset_id: string | number;
  base_asset: string;
  effective_status: Classification;
  classification: Classification;
  lifecycle: Lifecycle;
  binance_available: boolean;
  policy_version: PolicyVersion;
  publication_id: string | number | null;
}

function toSnapshotMeta(row: SnapshotRow): ShariahSnapshotMeta {
  return {
    snapshotId: String(row.snapshot_id),
    policyVersion: row.policy_version,
    contentHash: row.content_hash,
    entryCount: row.entry_count,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export async function listSnapshots(limit = 50): Promise<ShariahSnapshotMeta[]> {
  const { rows } = await query<SnapshotRow>(
    `SELECT * FROM shariah_universe_snapshots
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT $1`,
    [Math.max(1, Math.min(500, Math.trunc(limit)))]
  );
  return rows.map(toSnapshotMeta);
}

export async function getLatestSnapshotMeta(): Promise<ShariahSnapshotMeta | null> {
  const [first] = await listSnapshots(1);
  return first ?? null;
}

/**
 * The full frozen snapshot: metadata plus its membership, read entirely from
 * the snapshot tables. There is deliberately no join to
 * `shariah_asset_binance_mappings` or `shariah_records` here — that is what
 * makes an old snapshot mean the same thing after a later rename, delisting or
 * re-screening.
 */
export async function getSnapshot(snapshotId: string): Promise<ShariahSnapshot | null> {
  const meta = await query<SnapshotRow>(
    "SELECT * FROM shariah_universe_snapshots WHERE snapshot_id = $1",
    [snapshotId]
  );
  if (!meta.rows[0]) return null;

  const entries = await query<SnapshotEntryRow>(
    `SELECT asset_id, base_asset, effective_status, classification, lifecycle,
            binance_available, policy_version, publication_id
       FROM shariah_universe_snapshot_entries
      WHERE snapshot_id = $1
      ORDER BY position`,
    [snapshotId]
  );

  return {
    ...toSnapshotMeta(meta.rows[0]),
    entries: entries.rows.map((e) => ({
      assetId: String(e.asset_id),
      baseAsset: e.base_asset,
      effectiveStatus: e.effective_status,
      classification: e.classification,
      lifecycle: e.lifecycle,
      binanceAvailable: e.binance_available,
      policyVersion: e.policy_version,
      publicationId: e.publication_id === null ? null : String(e.publication_id),
    })),
  };
}
