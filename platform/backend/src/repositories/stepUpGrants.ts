/**
 * Step-up grants (migration 055, owner decision OD-2).
 *
 * Every time comparison is the database's `now()`, so one clock decides both
 * when a grant was minted and whether it has expired. Only the SHA-256 of the
 * browser's handle is ever passed in or stored.
 */
import type { PoolClient } from "pg";
import { query } from "../db/pool";

export interface StepUpGrant {
  id: string;
  createdAt: string;
  expiresAt: string;
}

interface GrantRow { id: string; created_at: Date; expires_at: Date }

const toGrant = (row: GrantRow): StepUpGrant => ({
  id: row.id, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
});

/**
 * A new grant for this account, bound to its CURRENT session version and role
 * (read in the same statement), or null when two-factor is not on: only an
 * authenticator code mints a grant. Old rows of this account are pruned.
 */
export async function mintGrant(userId: string, handleHash: string, ttlMs: number): Promise<StepUpGrant | null> {
  await query("DELETE FROM step_up_grants WHERE user_id = $1 AND expires_at < now() - interval '1 day'", [userId]);
  const { rows } = await query<GrantRow>(
    `INSERT INTO step_up_grants (user_id, session_version, role, handle_hash, action_class, method, expires_at)
     SELECT id, session_version, role, $2, 'operate', 'totp', now() + make_interval(secs => $3::double precision / 1000)
       FROM users WHERE id = $1 AND totp_enabled_at IS NOT NULL
     RETURNING id, created_at, expires_at`,
    [userId, handleHash, ttlMs],
  );
  return rows[0] ? toGrant(rows[0]) : null;
}

/**
 * The grant this handle names, if it is still good for this account right now:
 * not revoked, not expired, minted under the account's current session version
 * and role, two-factor still on, and (for an administrator's command) the
 * account still an administrator. Use never extends it.
 */
export async function findValidGrant(userId: string, handleHash: string,
  options: { requireAdmin: boolean }): Promise<StepUpGrant | null> {
  const { rows } = await query<GrantRow>(
    `SELECT g.id, g.created_at, g.expires_at
       FROM step_up_grants g JOIN users u ON u.id = g.user_id
      WHERE g.handle_hash = $1 AND g.user_id = $2
        AND g.revoked_at IS NULL AND g.expires_at > now()
        AND g.session_version = u.session_version AND g.role = u.role
        AND u.totp_enabled_at IS NOT NULL
        AND ($3::boolean IS FALSE OR u.role = 'admin')`,
    [handleHash, userId, options.requireAdmin],
  );
  return rows[0] ? toGrant(rows[0]) : null;
}

/** "Lock now" and plain sign-out: this one handle stops working. */
export async function revokeGrant(handleHash: string): Promise<void> {
  await query("UPDATE step_up_grants SET revoked_at = now() WHERE handle_hash = $1 AND revoked_at IS NULL",
    [handleHash]);
}

/** Every grant of this account, gone: a session or second-factor change. */
export async function deleteAllGrants(userId: string, client?: PoolClient): Promise<void> {
  const sql = "DELETE FROM step_up_grants WHERE user_id = $1";
  if (client) await client.query(sql, [userId]);
  else await query(sql, [userId]);
}
