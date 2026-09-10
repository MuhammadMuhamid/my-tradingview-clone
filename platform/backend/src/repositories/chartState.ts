/**
 * Chart state: a user's drawings, and the studies applied to each pane.
 *
 * ── The one rule ───────────────────────────────────────────────────────────
 *
 * Every write carries the version the client last read. If the stored version
 * has moved on, the write is refused and the caller is handed what is actually
 * stored. That single rule is what makes a second device safe:
 *
 *   the first device deletes a trendline and saves      → version 2, no line
 *   the second device still holds version 1 and saves   → refused, given v2
 *   the second device adopts v2                         → the line stays gone
 *
 * Without it, "last write wins" would let the stale device resurrect a drawing
 * its user had already deleted — silently, and on the device they were not
 * looking at.
 *
 * ── Why the payloads are opaque ────────────────────────────────────────────
 *
 * A drawing's shape is `frontend/lib/drawings`' and a study's is the native
 * registry's. Re-declaring either here would create a second definition that
 * is always one release behind the real one, and the failure mode is a save
 * that silently drops the field the server had not heard of yet. What IS
 * checked is the shape the storage depends on — that the payload is a list —
 * and that check lives in the schema as well as here.
 */
import { query } from "../db/pool";
import { DEFAULT_VENUE, resolveInstrument } from "../types/instrument";
import { normalizeCanonicalInstrumentId } from "../market/model";

export interface DrawingState {
  venue: string;
  symbol: string;
  drawings: unknown[];
  version: number;
  updatedAt: string;
}

export interface PaneStudyState {
  scope: string;
  pine: unknown[];
  native: unknown[];
  version: number;
  updatedAt: string;
  /**
   * Whether each half has ever been written.
   *
   * Not derivable from `version`: the two halves share it, so once either one
   * created the row `version > 0` was true for both. A client asking "has MY
   * half ever existed" was being answered "does this row exist", and the two
   * stopped meaning the same thing the moment the halves were written
   * separately. See migration 031.
   */
  pineWritten: boolean;
  nativeWritten: boolean;
}

/** A write refused because the stored version had moved on. */
export interface VersionConflict<T> {
  conflict: true;
  current: T;
}

export function isConflict<T>(v: T | VersionConflict<T>): v is VersionConflict<T> {
  return (v as VersionConflict<T>).conflict === true;
}

/** How many drawings or studies one row may hold. */
export const MAX_ITEMS = 2_000;

interface DrawingRow {
  venue: string;
  symbol: string;
  drawings: unknown[];
  version: string | number;
  updated_at: Date;
}

const toDrawingState = (r: DrawingRow): DrawingState => ({
  venue: r.venue,
  symbol: r.symbol,
  drawings: Array.isArray(r.drawings) ? r.drawings : [],
  // pg returns bigint as a string to preserve precision; these versions are
  // counters that will never approach 2^53, so Number is safe and keeps the
  // API shape numeric.
  version: Number(r.version),
  updatedAt: r.updated_at.toISOString(),
});

function drawingIdentity(rawSymbol: string): { venue: string; ticker: string } {
  const canonical = normalizeCanonicalInstrumentId(rawSymbol);
  if (canonical) return { venue: canonical.split(":")[2]!, ticker: canonical };
  return resolveInstrument(rawSymbol);
}

/**
 * One instrument's drawings.
 *
 * An instrument with nothing stored is `version: 0` rather than an error: "no
 * row yet" and "an empty list" are the same thing to a chart, and making the
 * caller distinguish them would put that decision in three places.
 */
export async function getDrawings(rawSymbol: string): Promise<DrawingState> {
  const id = drawingIdentity(rawSymbol);
  const { rows } = await query<DrawingRow>(
    "SELECT * FROM chart_drawings WHERE venue = $1 AND symbol = $2",
    [id.venue, id.ticker]
  );
  const row = rows[0];
  if (!row) {
    return {
      venue: id.venue, symbol: id.ticker, drawings: [], version: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return toDrawingState(row);
}

/**
 * Replace one instrument's drawings, if `baseVersion` is still current.
 *
 * `baseVersion: 0` means "I believe nothing is stored", which is how a first
 * write and a one-time import both arrive. It conflicts if a row already
 * exists — which is exactly the protection the import needs, so a device that
 * has never synced cannot flatten a chart another device already populated.
 */
export async function putDrawings(
  rawSymbol: string, drawings: unknown[], baseVersion: number
): Promise<DrawingState | VersionConflict<DrawingState>> {
  const id = drawingIdentity(rawSymbol);
  if (!Array.isArray(drawings)) throw new Error("drawings must be a list");
  if (drawings.length > MAX_ITEMS) {
    throw new Error(`a chart may hold at most ${MAX_ITEMS} drawings`);
  }
  const payload = JSON.stringify(drawings);

  if (baseVersion <= 0) {
    // First write. `ON CONFLICT DO NOTHING` rather than an upsert: a row that
    // already exists means somebody else got there first, and this write was
    // made in ignorance of them.
    const { rows } = await query<DrawingRow>(
      `INSERT INTO chart_drawings (venue, symbol, drawings, version)
       VALUES ($1, $2, $3::jsonb, 1)
       ON CONFLICT (venue, symbol) DO NOTHING
       RETURNING *`,
      [id.venue, id.ticker, payload]
    );
    if (rows[0]) return toDrawingState(rows[0]);
    return { conflict: true, current: await getDrawings(rawSymbol) };
  }

  const { rows } = await query<DrawingRow>(
    `UPDATE chart_drawings
        SET drawings = $3::jsonb, version = version + 1, updated_at = now()
      WHERE venue = $1 AND symbol = $2 AND version = $4
      RETURNING *`,
    [id.venue, id.ticker, payload, baseVersion]
  );
  if (rows[0]) return toDrawingState(rows[0]);
  return { conflict: true, current: await getDrawings(rawSymbol) };
}

interface StudyRow {
  scope: string;
  pine: unknown[];
  native: unknown[];
  version: string | number;
  updated_at: Date;
  pine_written?: boolean;
  native_written?: boolean;
}

const toStudyState = (r: StudyRow): PaneStudyState => ({
  scope: r.scope,
  pine: Array.isArray(r.pine) ? r.pine : [],
  native: Array.isArray(r.native) ? r.native : [],
  version: Number(r.version),
  updatedAt: r.updated_at.toISOString(),
  // A row read before migration 031 has neither column. Falling back to the
  // CONTENT is the same rule the migration backfills with, and it errs toward
  // re-uploading a client's work rather than discarding it.
  pineWritten: r.pine_written ?? (Array.isArray(r.pine) && r.pine.length > 0),
  nativeWritten: r.native_written ?? (Array.isArray(r.native) && r.native.length > 0),
});

const SCOPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function assertScope(scope: string): string {
  if (!SCOPE_RE.test(scope)) throw new Error(`invalid pane scope: ${JSON.stringify(scope)}`);
  return scope;
}

export async function getPaneStudies(scope: string): Promise<PaneStudyState> {
  const id = assertScope(scope);
  const { rows } = await query<StudyRow>(
    "SELECT * FROM chart_pane_studies WHERE scope = $1", [id]);
  const row = rows[0];
  if (!row) {
    return {
      scope: id, pine: [], native: [], version: 0,
      updatedAt: new Date(0).toISOString(),
      pineWritten: false, nativeWritten: false,
    };
  }
  return toStudyState(row);
}

/** Every pane that has anything stored — what a client restores on load. */
export async function listPaneStudies(): Promise<PaneStudyState[]> {
  const { rows } = await query<StudyRow>(
    "SELECT * FROM chart_pane_studies ORDER BY scope");
  return rows.map(toStudyState);
}

/**
 * Replace one pane's studies, if `baseVersion` is still current.
 *
 * ── Why either half may be omitted ─────────────────────────────────────────
 *
 * A pane's Pine studies and its built-in studies are one row, because they are
 * one list to the user and writing them separately would let a save land half
 * applied. But they are owned by two different hooks, and a writer that has
 * nothing to say about the other half must not be able to erase it: passing
 * `undefined` leaves that column exactly as it is.
 *
 * This is not a convenience. The native hook sent `pine: []` on every save,
 * and the write replaced both columns — so the moment Pine studies were also
 * persisted, every native edit would have silently deleted them. An omitted
 * half is `COALESCE`d to the stored one in SQL, so the guarantee holds even
 * for a caller that has not read this comment.
 *
 * Both halves still share one version, so two writers race the same way two
 * devices do: the second one conflicts, re-reads, and writes again.
 */
export async function putPaneStudies(
  scope: string,
  pine: unknown[] | undefined,
  native: unknown[] | undefined,
  baseVersion: number
): Promise<PaneStudyState | VersionConflict<PaneStudyState>> {
  const id = assertScope(scope);
  if (pine !== undefined && !Array.isArray(pine)) throw new Error("pine must be a list");
  if (native !== undefined && !Array.isArray(native)) throw new Error("native must be a list");
  if (pine === undefined && native === undefined) {
    throw new Error("a write must carry pine, native, or both");
  }
  if ((pine?.length ?? 0) + (native?.length ?? 0) > MAX_ITEMS) {
    throw new Error(`a pane may hold at most ${MAX_ITEMS} studies`);
  }
  const pinePayload = pine === undefined ? null : JSON.stringify(pine);
  const nativePayload = native === undefined ? null : JSON.stringify(native);

  if (baseVersion <= 0) {
    // First write. An omitted half starts empty, because there is no stored
    // value to leave alone.
    const { rows } = await query<StudyRow>(
      `INSERT INTO chart_pane_studies
         (scope, pine, native, version, pine_written, native_written)
       VALUES ($1, COALESCE($2::jsonb, '[]'::jsonb), COALESCE($3::jsonb, '[]'::jsonb), 1,
               $2::jsonb IS NOT NULL, $3::jsonb IS NOT NULL)
       ON CONFLICT (scope) DO NOTHING
       RETURNING *`,
      [id, pinePayload, nativePayload]
    );
    if (rows[0]) return toStudyState(rows[0]);
    return { conflict: true, current: await getPaneStudies(id) };
  }

  const { rows } = await query<StudyRow>(
    `UPDATE chart_pane_studies
        SET pine = COALESCE($2::jsonb, pine),
            native = COALESCE($3::jsonb, native),
            -- Written means written, including written EMPTY: a user who
            -- removed every study of one kind has made a decision, and the
            -- next client must not read that as "never uploaded".
            pine_written = pine_written OR $2::jsonb IS NOT NULL,
            native_written = native_written OR $3::jsonb IS NOT NULL,
            version = version + 1, updated_at = now()
      WHERE scope = $1 AND version = $4
      RETURNING *`,
    [id, pinePayload, nativePayload, baseVersion]
  );
  if (rows[0]) return toStudyState(rows[0]);
  return { conflict: true, current: await getPaneStudies(id) };
}

/** Instruments that have any drawings stored, newest first. */
export async function listDrawnInstruments(limit = 200): Promise<
  { venue: string; symbol: string; count: number; updatedAt: string }[]
> {
  const { rows } = await query<{
    venue: string; symbol: string; count: string | number; updated_at: Date;
  }>(
    `SELECT venue, symbol, jsonb_array_length(drawings) AS count, updated_at
       FROM chart_drawings
      WHERE jsonb_array_length(drawings) > 0
      ORDER BY updated_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 1000))]
  );
  return rows.map((r) => ({
    venue: r.venue, symbol: r.symbol, count: Number(r.count),
    updatedAt: r.updated_at.toISOString(),
  }));
}

export { DEFAULT_VENUE };
