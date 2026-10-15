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

/** Every function takes the owner first: no watchlist is reachable without one. */
export async function listWatchlists(userId: string): Promise<WatchlistRow[]> {
  const { rows } = await query<DbRow>(
    "SELECT * FROM watchlists WHERE user_id = $1 ORDER BY position, created_at", [userId]
  );
  return rows.map(toRow);
}

/** Create or update by case-insensitive name, mirroring layout semantics. */
export async function upsertByName(
  userId: string, name: string, symbols: string[], position = 0
): Promise<WatchlistRow> {
  const { rows } = await query<DbRow>(
    `INSERT INTO watchlists (user_id, name, symbols, position)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, upper(btrim(name))) DO UPDATE
       SET symbols = EXCLUDED.symbols, position = EXCLUDED.position, updated_at = now()
     RETURNING *`,
    [userId, name.trim() || "Watchlist", symbols, position]
  );
  return toRow(rows[0]!);
}

export async function updateWatchlist(
  userId: string, id: string, patch: { name?: string; symbols?: string[]; position?: number }
): Promise<WatchlistRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, userId];
  const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (patch.name !== undefined) push("name", patch.name.trim() || "Watchlist");
  if (patch.symbols !== undefined) push("symbols", patch.symbols);
  if (patch.position !== undefined) push("position", patch.position);
  if (sets.length === 0) {
    const { rows } = await query<DbRow>(
      "SELECT * FROM watchlists WHERE id = $1 AND user_id = $2", [id, userId]);
    return rows[0] ? toRow(rows[0]) : null;
  }
  const { rows } = await query<DbRow>(
    `UPDATE watchlists SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    params
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function deleteWatchlist(userId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM watchlists WHERE id = $1 AND user_id = $2", [id, userId]);
  return (rowCount ?? 0) > 0;
}
