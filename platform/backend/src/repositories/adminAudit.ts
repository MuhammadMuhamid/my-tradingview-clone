/**
 * Appending to `admin_audit` (migration 053) from outside the package ledger.
 *
 * The table is append-only by trigger: UPDATE, DELETE and TRUNCATE all raise.
 * `repositories/packages.ts` writes it through a private helper that needs the
 * caller's transaction; Bot commands and two-factor changes have no
 * transaction to join, so they come through here.
 *
 * A credential never reaches this table. `detail` is scrubbed of any key that
 * could carry one before it is written, so a caller that passes a body by
 * mistake records the shape of the mistake, not the secret.
 */
import type { PoolClient } from "pg";
import { query } from "../db/pool";

/** Keys that name a secret. Matched case-insensitively, at any depth. */
const SECRET_KEY = /^(password|credential|credentials|secret|secrets|totp|otp|recoverycode|recovery_code|token|cookie|signature)$/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[nested]";
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === undefined) continue;
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : scrub(inner, depth + 1);
  }
  return out;
}

export interface AdminAuditRow {
  id: number;
  actor: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  at: string;
}

/**
 * One row. `actor` is the account that acted (null when it has none, as the
 * column allows); `action` is dotted (`bot.halt.requested`); `target` names
 * what was acted on (`bot`, `bot:<id>`, `trade:<id>`, `user:<id>`).
 */
export async function appendAdminAudit(
  actor: string | null, action: string, target: string, detail: Record<string, unknown> = {},
  client?: PoolClient,
): Promise<void> {
  const params = [actor, action, target, JSON.stringify(scrub(detail))];
  const sql = "INSERT INTO admin_audit (actor, action, target, detail) VALUES ($1, $2, $3, $4)";
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

/** For tests and the audit listing: the newest rows whose action starts with `prefix`. */
export async function listAdminAudit(prefix: string, limit = 100): Promise<AdminAuditRow[]> {
  const { rows } = await query<{ id: number; actor: string | null; action: string; target: string;
    detail: Record<string, unknown>; at: Date }>(
    `SELECT id, actor, action, target, detail, at FROM admin_audit
      WHERE action LIKE $1 ORDER BY id DESC LIMIT $2`,
    [`${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, limit],
  );
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}
