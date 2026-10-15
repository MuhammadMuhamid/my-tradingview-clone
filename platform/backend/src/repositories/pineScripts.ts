/**
 * Pine scripts authored in the chart's editor. Source is the only stored
 * artefact — `kind` is refreshed from the compiler on every write so the
 * script list can badge indicators and strategies without recompiling.
 */
import { query } from "../db/pool";

export interface PineScriptRow {
  id: string;
  name: string;
  source: string;
  kind: "indicator" | "strategy";
  createdAt: string;
  updatedAt: string;
  /**
   * Who put this script here.
   *
   * `builtin` means the shipped library installed it; `user` means somebody
   * wrote it in the editor or imported it. Every row that existed before
   * migration 030 is `user`, which is the safe direction — an unknown script
   * is never overwritten by a re-seed.
   */
  origin: "user" | "builtin";
  /** The library version that installed it, for a `builtin` row. */
  builtinVersion: string | null;
  /**
   * The source AS SHIPPED.
   *
   * Compared against the stored source to answer "has the user edited this",
   * which a timestamp cannot: a re-seed would look exactly like an edit.
   */
  builtinHash: string | null;
}

interface DbPineScript {
  id: string;
  name: string;
  source: string;
  kind: "indicator" | "strategy";
  created_at: Date;
  updated_at: Date;
  origin?: "user" | "builtin";
  builtin_version?: string | null;
  builtin_hash?: string | null;
}

function toRow(r: DbPineScript): PineScriptRow {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    kind: r.kind,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    // A row read before migration 030 has no ownership columns at all. `user`
    // is the safe default: it means the seed will not touch the script.
    origin: r.origin ?? "user",
    builtinVersion: r.builtin_version ?? null,
    builtinHash: r.builtin_hash ?? null,
  };
}

/**
 * A user's scripts, and the shared library.
 *
 * Library rows have no owner (`user_id IS NULL`) and every user reads them;
 * a user's own scripts are theirs alone. Only the admin may change a library
 * row in place — anyone else saving under a library name gets their own copy.
 */
export async function listScripts(userId: string): Promise<PineScriptRow[]> {
  const { rows } = await query<DbPineScript>(
    "SELECT * FROM pine_scripts WHERE user_id = $1 OR user_id IS NULL ORDER BY updated_at DESC",
    [userId]
  );
  return rows.map(toRow);
}

/** The shared library only, for the seed. */
export async function listBuiltinScripts(): Promise<PineScriptRow[]> {
  const { rows } = await query<DbPineScript>(
    "SELECT * FROM pine_scripts WHERE user_id IS NULL ORDER BY updated_at DESC"
  );
  return rows.map(toRow);
}

export async function getScript(userId: string, id: string): Promise<PineScriptRow | null> {
  const { rows } = await query<DbPineScript>(
    "SELECT * FROM pine_scripts WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)",
    [id, userId]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Create, or overwrite the user's own script that already owns this name. */
export async function upsertScript(userId: string, input: {
  name: string;
  source: string;
  kind: "indicator" | "strategy";
}): Promise<PineScriptRow> {
  const { rows } = await query<DbPineScript>(
    `INSERT INTO pine_scripts (user_id, name, source, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, lower(name)) WHERE user_id IS NOT NULL DO UPDATE
       SET source = EXCLUDED.source, kind = EXCLUDED.kind, updated_at = now()
     RETURNING *`,
    [userId, input.name, input.source, input.kind]
  );
  return toRow(rows[0]!);
}

/**
 * Install or refresh a script the shipped library owns.
 *
 * Separate from `upsertScript` because it writes the ownership columns, and
 * because the two have different rights: a user's save may overwrite anything
 * of theirs, and this may only overwrite what the library itself installed.
 * `librarySeed` decides which case applies; this just performs the write.
 *
 * An existing row is claimed as `builtin` only through this path, so a script
 * somebody wrote cannot become the library's by being saved under a shipped
 * name — the seed checks `origin` before calling.
 */
export async function upsertBuiltinScript(input: {
  name: string;
  source: string;
  kind: "indicator" | "strategy";
  builtinVersion: string;
  builtinHash: string;
}): Promise<PineScriptRow> {
  const { rows } = await query<DbPineScript>(
    `INSERT INTO pine_scripts (name, source, kind, origin, builtin_version, builtin_hash)
     VALUES ($1, $2, $3, 'builtin', $4, $5)
     ON CONFLICT (lower(name)) WHERE user_id IS NULL DO UPDATE
       SET source = EXCLUDED.source, kind = EXCLUDED.kind,
           origin = 'builtin',
           builtin_version = EXCLUDED.builtin_version,
           builtin_hash = EXCLUDED.builtin_hash,
           updated_at = now()
     RETURNING *`,
    [input.name, input.source, input.kind, input.builtinVersion, input.builtinHash]
  );
  return toRow(rows[0]!);
}

export async function updateScript(
  userId: string,
  id: string,
  patch: { name?: string; source?: string; kind?: "indicator" | "strategy" },
  /** The admin curates the shared library; nobody else may edit it in place. */
  mayEditLibrary = false,
): Promise<PineScriptRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, userId, mayEditLibrary];
  const push = (col: string, v: unknown): void => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.source !== undefined) push("source", patch.source);
  if (patch.kind !== undefined) push("kind", patch.kind);
  if (sets.length === 0) return getScript(userId, id);

  const { rows } = await query<DbPineScript>(
    `UPDATE pine_scripts SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND (user_id = $2 OR ($3::boolean AND user_id IS NULL)) RETURNING *`,
    params
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteScript(userId: string, id: string, mayEditLibrary = false): Promise<boolean> {
  const res = await query(
    "DELETE FROM pine_scripts WHERE id = $1 AND (user_id = $2 OR ($3::boolean AND user_id IS NULL))",
    [id, userId, mayEditLibrary]);
  return (res.rowCount ?? 0) > 0;
}
