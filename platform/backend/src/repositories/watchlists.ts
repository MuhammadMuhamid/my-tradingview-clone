import { query } from "../db/pool";

export interface WatchlistRow {
  id: string;
  name: string;
  symbols: string[];
  position: number;
  updatedAt: string;
}

interface DbRow {
  id: string;
  name: string;
  symbols: string[];
  position: number;
  updated_at: Date;
}

const toRow = (r: DbRow): WatchlistRow => ({
  id: r.id,
  name: r.name,
  symbols: r.symbols ?? [],
  position: r.position,
  updatedAt: r.updated_at.toISOString(),
});

export async function listWatchlists(): Promise<WatchlistRow[]> {
  const { rows } = await query<DbRow>(
    "SELECT * FROM watchlists ORDER BY position, created_at"
  );
  return rows.map(toRow);
}

/** Create or update by case-insensitive name, mirroring layout semantics. */
export async function upsertByName(
  name: string, symbols: string[], position = 0
): Promise<WatchlistRow> {
  const { rows } = await query<DbRow>(
    `INSERT INTO watchlists (name, symbols, position)
     VALUES ($1, $2, $3)
     ON CONFLICT (upper(btrim(name))) DO UPDATE
       SET symbols = EXCLUDED.symbols, position = EXCLUDED.position, updated_at = now()
     RETURNING *`,
    [name.trim() || "Watchlist", symbols, position]
  );
  return toRow(rows[0]!);
}

export async function updateWatchlist(
  id: string, patch: { name?: string; symbols?: string[]; position?: number }
): Promise<WatchlistRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.name !== undefined) push("name", patch.name.trim() || "Watchlist");
  if (patch.symbols !== undefined) push("symbols", patch.symbols);
  if (patch.position !== undefined) push("position", patch.position);
  if (sets.length === 0) {
    const { rows } = await query<DbRow>("SELECT * FROM watchlists WHERE id = $1", [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }
  const { rows } = await query<DbRow>(
    `UPDATE watchlists SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteWatchlist(id: string): Promise<boolean> {
  const { rowCount } = await query("DELETE FROM watchlists WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
