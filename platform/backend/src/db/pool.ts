import { Pool, types, QueryResult, QueryResultRow } from "pg";
import { config } from "../config";

// pg returns NUMERIC (OID 1700) and BIGINT (OID 20) as strings to preserve
// precision. The engine consumes prices/volumes as floats, so parse up front.
types.setTypeParser(1700, parseFloat);
types.setTypeParser(20, Number);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // Fail promptly during a database restart instead of leaving optimizer
  // workers blocked indefinitely on a dead connection.
  connectionTimeoutMillis: 5_000,
});

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  // pg types `values` as `any[]`; the public signature stays `unknown[]`.
  return pool.query<T>(text, params as unknown[] as never[]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
