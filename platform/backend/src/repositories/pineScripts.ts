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
}

interface DbPineScript {
  id: string;
  name: string;
  source: string;
  kind: "indicator" | "strategy";
  created_at: Date;
  updated_at: Date;
}

function toRow(r: DbPineScript): PineScriptRow {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    kind: r.kind,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listScripts(): Promise<PineScriptRow[]> {
  const { rows } = await query<DbPineScript>(
    "SELECT * FROM pine_scripts ORDER BY updated_at DESC"
  );
  return rows.map(toRow);
}

export async function getScript(id: string): Promise<PineScriptRow | null> {
  const { rows } = await query<DbPineScript>(
    "SELECT * FROM pine_scripts WHERE id = $1",
    [id]
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** Create, or overwrite the script that already owns this name. */
export async function upsertScript(input: {
  name: string;
  source: string;
  kind: "indicator" | "strategy";
}): Promise<PineScriptRow> {
  const { rows } = await query<DbPineScript>(
    `INSERT INTO pine_scripts (name, source, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (lower(name)) DO UPDATE
       SET source = EXCLUDED.source, kind = EXCLUDED.kind, updated_at = now()
     RETURNING *`,
    [input.name, input.source, input.kind]
  );
  return toRow(rows[0]!);
}

export async function updateScript(
  id: string,
  patch: { name?: string; source?: string; kind?: "indicator" | "strategy" }
): Promise<PineScriptRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, v: unknown): void => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.source !== undefined) push("source", patch.source);
  if (patch.kind !== undefined) push("kind", patch.kind);
  if (sets.length === 0) return getScript(id);

  const { rows } = await query<DbPineScript>(
    `UPDATE pine_scripts SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteScript(id: string): Promise<boolean> {
  const res = await query("DELETE FROM pine_scripts WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}
