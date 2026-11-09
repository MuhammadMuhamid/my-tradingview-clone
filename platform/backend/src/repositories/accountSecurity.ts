/** Email verification tokens, two-factor state, recovery codes and sign-in history. */
import { createHash, randomBytes } from "node:crypto";
import { query } from "../db/pool";
import { decryptSecret, encryptSecret } from "../security/secrets";
import { hashRecoveryCode, type SignInMethod } from "../security/twoFactor";

const VERIFY_TTL_HOURS = 24;
const HISTORY_KEPT = 50;

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A new link, replacing any earlier one. Only its hash is stored. */
export async function issueEmailToken(userId: string, email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await query("DELETE FROM email_verification_tokens WHERE user_id = $1", [userId]);
  await query(
    `INSERT INTO email_verification_tokens (token_hash, user_id, email, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [tokenHash(token), userId, email, VERIFY_TTL_HOURS],
  );
  return token;
}

/** Marks the account verified if the link is valid, unused and still its address. */
export async function consumeEmailToken(token: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `WITH used AS (
       UPDATE email_verification_tokens SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id, email
     )
     UPDATE users SET email_verified_at = COALESCE(email_verified_at, now())
       FROM used WHERE users.id = used.user_id AND users.email = used.email
       RETURNING users.id`,
    [tokenHash(token)],
  );
  return rows[0]?.id ?? null;
}

export async function startTotpSetup(userId: string, secret: string): Promise<void> {
  await query("UPDATE users SET totp_secret_enc = $2, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = $1",
    [userId, encryptSecret(secret)]);
}

export async function readTotp(userId: string): Promise<{ secret: string; lastStep: number; enabled: boolean } | null> {
  const { rows } = await query<{ totp_secret_enc: string | null; totp_last_step: string; totp_enabled_at: Date | null }>(
    "SELECT totp_secret_enc, totp_last_step, totp_enabled_at FROM users WHERE id = $1", [userId]);
  const row = rows[0];
  const secret = row ? decryptSecret(row.totp_secret_enc) : null;
  return row && secret ? { secret, lastStep: Number(row.totp_last_step), enabled: !!row.totp_enabled_at } : null;
}

/** False when another request already used this step or a later one. */
export async function recordTotpStep(userId: string, step: number): Promise<boolean> {
  const { rowCount } = await query(
    "UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2", [userId, step]);
  return (rowCount ?? 0) > 0;
}

export async function enableTotp(userId: string): Promise<void> {
  await query("UPDATE users SET totp_enabled_at = now() WHERE id = $1", [userId]);
}

/**
 * Two-factor on AND every existing session ended, in one statement (OD-2).
 * Returns the new session version, for re-issuing the caller's own session.
 */
export async function enableTotpAndRotateSessions(userId: string): Promise<number> {
  const { rows } = await query<{ session_version: number }>(
    `UPDATE users SET totp_enabled_at = now(), session_version = session_version + 1
      WHERE id = $1 RETURNING session_version`, [userId]);
  return rows[0]?.session_version ?? 1;
}

export async function clearTotp(userId: string): Promise<void> {
  await query("UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = $1", [userId]);
  await query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [userId]);
}

export async function replaceRecoveryCodes(userId: string, codes: string[]): Promise<void> {
  await query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [userId]);
  await query(
    `INSERT INTO totp_recovery_codes (code_hash, user_id) SELECT unnest($1::text[]), $2`,
    [codes.map(hashRecoveryCode), userId],
  );
}

export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const { rowCount } = await query(
    "UPDATE totp_recovery_codes SET used_at = now() WHERE code_hash = $1 AND user_id = $2 AND used_at IS NULL",
    [hashRecoveryCode(code), userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function countRecoveryCodes(userId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    "SELECT count(*) AS n FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [userId]);
  return Number(rows[0]?.n ?? 0);
}

export async function recordLogin(input: {
  userId: string; method: SignInMethod; twoFactor: boolean; ip: string | null; userAgent: string | null;
}): Promise<void> {
  await query(
    "INSERT INTO login_events (user_id, method, two_factor, ip, user_agent) VALUES ($1, $2, $3, $4, $5)",
    [input.userId, input.method, input.twoFactor, input.ip?.slice(0, 64) ?? null, input.userAgent?.slice(0, 300) ?? null],
  );
  await query(
    `DELETE FROM login_events WHERE user_id = $1 AND id NOT IN (
       SELECT id FROM login_events WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2)`,
    [input.userId, HISTORY_KEPT],
  );
}

export async function listLogins(userId: string, limit = 20) {
  const { rows } = await query<{ method: string; two_factor: boolean; ip: string | null; user_agent: string | null; at: Date }>(
    `SELECT method, two_factor, ip, user_agent, at FROM login_events
      WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ method: r.method, twoFactor: r.two_factor, ip: r.ip, userAgent: r.user_agent, at: r.at.toISOString() }));
}
