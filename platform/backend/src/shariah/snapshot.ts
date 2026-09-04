/**
 * Immutable Shariah universe snapshots.
 *
 * A snapshot freezes the authoritative Shariah state of Trading Scene's
 * Binance Spot USDT base-asset registry at one instant, so a later Research or
 * Backtester run can cite exactly which universe it used and prove it has not
 * moved since. It exists because the SH-1 registry is a MUTABLE current-state
 * table: a run that recorded "we used the eligible universe" and nothing else
 * becomes unreproducible the moment one asset is re-screened or one ticker is
 * reused.
 *
 * Three properties make that citation worth something, and all three are
 * structural rather than conventional:
 *
 * 1. NO MUTABLE JOINS. Every field needed to interpret an entry — the base
 *    symbol at snapshot time, the effective status, the underlying
 *    classification/lifecycle, Binance availability — is COPIED into
 *    `shariah_universe_snapshot_entries`. Reading an old snapshot never
 *    consults today's registry, so re-screening an asset or reusing its ticker
 *    tomorrow cannot change what the snapshot says.
 * 2. IMMUTABILITY. The snapshot tables reject UPDATE and DELETE at the
 *    database level (023_shariah_publication_and_snapshots.sql).
 * 3. DETERMINISM. Membership is canonically ordered and canonically shaped in
 *    THIS module before hashing, so `content_hash` is a function of the
 *    authoritative state alone and never of database row order.
 *
 * Repeat-creation behaviour (documented in docs/SHARIAH-UNIVERSE.md): taking a
 * second snapshot of unchanged state APPENDS A NEW snapshot row carrying the
 * SAME `content_hash`. Nothing is reused and nothing is mutated; equality of
 * universe content is expressed by the hash, not by the snapshot id.
 */
import { createHash } from "node:crypto";
import { effectiveShariahStatus, TS_SHARIAH_V1, type Classification, type Lifecycle, type PolicyVersion } from "./policy";
import type { ShariahDbClient } from "./sync";

/** pg returns timestamptz as a Date; SH-2 hands callers ISO-8601 text. */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** One frozen registry member. Deliberately flat and primitive-only — this is what gets hashed. */
export interface ShariahSnapshotEntry {
  assetId: string;
  /** The Binance base symbol AT SNAPSHOT TIME. A later rename does not reach back. */
  baseAsset: string;
  /** The resolved public answer: UNSCREENED/STALE have already collapsed to REVIEW. */
  effectiveStatus: Classification;
  /** Kept beside effectiveStatus so "reviewed and ambiguous" is distinguishable from "never screened". */
  classification: Classification;
  lifecycle: Lifecycle;
  /** Whether the asset was a currently-qualifying Binance Spot USDT base asset at snapshot time. */
  binanceAvailable: boolean;
  policyVersion: PolicyVersion;
  /** The immutable publication this state came from, when it came from one. */
  publicationId: string | null;
}

export interface ShariahSnapshotMeta {
  snapshotId: string;
  policyVersion: PolicyVersion;
  contentHash: string;
  entryCount: number;
  createdAt: string;
  createdBy: string | null;
}

export interface ShariahSnapshot extends ShariahSnapshotMeta {
  entries: ShariahSnapshotEntry[];
}

/** Raw registry state a snapshot is built from. Field names match the SELECT below. */
export interface ShariahSnapshotSource {
  asset_id: string | number;
  base_asset: string;
  classification: Classification | null;
  lifecycle: Lifecycle | null;
  policy_version: PolicyVersion | null;
  binance_available: boolean;
  current_publication_id: string | number | null;
}

/**
 * Canonical membership: one entry per registry asset, effective status already
 * resolved through the single SH-1 mapping, ordered by base symbol and then by
 * numeric asset id.
 *
 * The sort is what makes the hash independent of database row order, so it is
 * applied here rather than left to an `ORDER BY` a future query could drop.
 * A missing `shariah_records` row is read exactly as SH-1 reads it —
 * UNSCREENED/REVIEW — never as ELIGIBLE.
 */
export function canonicalSnapshotEntries(rows: readonly ShariahSnapshotSource[]): ShariahSnapshotEntry[] {
  const entries = rows.map((row): ShariahSnapshotEntry => {
    const classification = row.classification ?? "REVIEW";
    const lifecycle = row.lifecycle ?? "UNSCREENED";
    return {
      assetId: String(row.asset_id),
      baseAsset: row.base_asset,
      effectiveStatus: effectiveShariahStatus({ classification, lifecycle }),
      classification,
      lifecycle,
      binanceAvailable: row.binance_available,
      policyVersion: row.policy_version ?? TS_SHARIAH_V1,
      publicationId: row.current_publication_id === null ? null : String(row.current_publication_id),
    };
  });
  entries.sort((a, b) =>
    a.baseAsset < b.baseAsset ? -1
      : a.baseAsset > b.baseAsset ? 1
        : Number(a.assetId) - Number(b.assetId));
  return entries;
}

/**
 * sha256 over a canonical, field-ordered serialisation of the policy version
 * and the entry list. Written as explicit positional arrays rather than
 * `JSON.stringify(entry)` so the digest cannot silently change if a future
 * field is added to the interface in a different position — a new field is a
 * deliberate edit here, and therefore a deliberate hash change.
 */
export function snapshotContentHash(
  policyVersion: PolicyVersion,
  entries: readonly ShariahSnapshotEntry[]
): string {
  const canonical = {
    policyVersion,
    entries: entries.map((e) => [
      e.assetId, e.baseAsset, e.effectiveStatus, e.classification,
      e.lifecycle, e.binanceAvailable, e.policyVersion,
    ]),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * The registry read a snapshot freezes.
 *
 * Delisted assets are INCLUDED, carrying `binance_available = false`. The
 * snapshot is the authoritative universe state, not a pre-filtered trading
 * list: a consumer reconstructing "what was tradable then" filters on that
 * flag, and a consumer auditing "what did we say about asset X then" still
 * finds X. Filtering here would have thrown that away permanently.
 */
const SELECT_SNAPSHOT_SOURCE = `
  SELECT m.asset_id, m.base_asset, m.binance_available,
         r.classification, r.lifecycle, r.policy_version, r.current_publication_id
    FROM shariah_asset_binance_mappings m
    LEFT JOIN shariah_records r ON r.asset_id = m.asset_id
`;

/**
 * Freezes the current authoritative state into a new immutable snapshot.
 *
 * `db` MUST be a single dedicated connection (a `pg` PoolClient): the read and
 * the writes are one REPEATABLE READ transaction, so a publication landing
 * mid-snapshot cannot produce a half-old, half-new membership whose hash
 * describes a universe state that never existed.
 */
export async function createShariahUniverseSnapshot(
  db: ShariahDbClient,
  options: { policyVersion?: PolicyVersion; createdBy?: string | null } = {}
): Promise<ShariahSnapshot> {
  const policyVersion = options.policyVersion ?? TS_SHARIAH_V1;

  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    const { rows } = await db.query<ShariahSnapshotSource>(SELECT_SNAPSHOT_SOURCE);
    const entries = canonicalSnapshotEntries(rows);
    const contentHash = snapshotContentHash(policyVersion, entries);

    const created = await db.query<{ snapshot_id: string; created_at: string }>(
      `INSERT INTO shariah_universe_snapshots (policy_version, content_hash, entry_count, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING snapshot_id, created_at`,
      [policyVersion, contentHash, entries.length, options.createdBy ?? null]
    );
    const snapshotId = String(created.rows[0]!.snapshot_id);

    for (const [position, entry] of entries.entries()) {
      await db.query(
        `INSERT INTO shariah_universe_snapshot_entries (
           snapshot_id, asset_id, position, base_asset, effective_status,
           classification, lifecycle, binance_available, policy_version, publication_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [snapshotId, entry.assetId, position, entry.baseAsset, entry.effectiveStatus,
          entry.classification, entry.lifecycle, entry.binanceAvailable,
          entry.policyVersion, entry.publicationId]
      );
    }

    await db.query("COMMIT");
    return {
      snapshotId,
      policyVersion,
      contentHash,
      entryCount: entries.length,
      createdAt: iso(created.rows[0]!.created_at),
      createdBy: options.createdBy ?? null,
      entries,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
