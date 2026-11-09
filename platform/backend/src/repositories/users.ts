/**
 * Accounts.
 *
 * Every user-owned row (alerts, watchlists, layouts, scripts, drawings, pane
 * studies, push devices) carries `user_id`, and every query that reads or
 * writes one is scoped by it. This file owns the account rows themselves.
 */
import type { PoolClient } from "pg";
import { pool, query } from "../db/pool";

/** The owner of everything that existed before accounts (migration 050). */
export const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  hasPassword: boolean;
  googleLinked: boolean;
  githubLinked: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  role: UserRole;
  sessionVersion: number;
  onboardedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

interface DbUser {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  password_hash: string | null;
  google_sub: string | null;
  github_id: string | null;
  email_verified_at: Date | null;
  totp_enabled_at: Date | null;
  role: UserRole;
  session_version: number;
  onboarded_at: Date | null;
  created_at: Date;
  last_login_at: Date | null;
}

const toRow = (r: DbUser): UserRow => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  hasPassword: !!r.password_hash,
  googleLinked: !!r.google_sub,
  githubLinked: !!r.github_id,
  emailVerified: !!r.email_verified_at,
  twoFactorEnabled: !!r.totp_enabled_at,
  role: r.role,
  sessionVersion: r.session_version,
  onboardedAt: r.onboarded_at ? r.onboarded_at.toISOString() : null,
  createdAt: r.created_at.toISOString(),
  lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
});

export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

/** Shape only. Whether the address exists is the mailbox's business. */
export function isEmailShaped(raw: string): boolean {
  const e = normaliseEmail(raw);
  return e.length >= 3 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export async function getUser(id: string): Promise<UserRow | null> {
  const { rows } = await query<DbUser>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** The row plus its password hash, for the one place that verifies it. */
export async function getUserForPassword(
  email: string,
): Promise<{ user: UserRow; passwordHash: string | null } | null> {
  const { rows } = await query<DbUser>("SELECT * FROM users WHERE email = $1", [normaliseEmail(email)]);
  const r = rows[0];
  return r ? { user: toRow(r), passwordHash: r.password_hash } : null;
}

export async function getPasswordHash(id: string): Promise<string | null> {
  const { rows } = await query<{ password_hash: string | null }>(
    "SELECT password_hash FROM users WHERE id = $1", [id]);
  return rows[0]?.password_hash ?? null;
}

export async function getUserByGoogleSub(sub: string): Promise<UserRow | null> {
  const { rows } = await query<DbUser>("SELECT * FROM users WHERE google_sub = $1", [sub]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getUserByGithubId(id: string): Promise<UserRow | null> {
  const { rows } = await query<DbUser>("SELECT * FROM users WHERE github_id = $1", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await query<DbUser>("SELECT * FROM users WHERE email = $1", [normaliseEmail(email)]);
  return rows[0] ? toRow(rows[0]) : null;
}

export class EmailTakenError extends Error {
  constructor() { super("An account with this email already exists."); }
}

export async function createUser(input: {
  email: string;
  displayName: string;
  passwordHash?: string | null;
  googleSub?: string | null;
  githubId?: string | null;
  avatarUrl?: string | null;
  /** A provider that verified this address vouches for it. */
  emailVerified?: boolean;
}): Promise<UserRow> {
  try {
    const { rows } = await query<DbUser>(
      `INSERT INTO users (email, display_name, password_hash, google_sub, github_id, avatar_url,
                          email_verified_at, role, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END, 'user', now())
       RETURNING *`,
      [normaliseEmail(input.email), input.displayName.slice(0, 80), input.passwordHash ?? null,
        input.googleSub ?? null, input.githubId ?? null, input.avatarUrl ?? null, input.emailVerified === true],
    );
    return toRow(rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new EmailTakenError();
    throw err;
  }
}

// ── provider identities, each change in one transaction ──────────────────────

export type ProviderKind = "google" | "github";

/** The provider id is already on another account (a unique index said so). */
export class ProviderInUseError extends Error {
  constructor() { super("That sign-in is already linked to another account."); this.name = "ProviderInUseError"; }
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // Set when even ROLLBACK failed: the connection is then destroyed rather than
  // handed back to the pool in an unknown state.
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: Error) => { broken = rollbackError; });
    if ((error as { code?: string }).code === "23505") throw new ProviderInUseError();
    throw error;
  } finally {
    client.release(broken);
  }
}

const lockUser = async (client: PoolClient, id: string): Promise<DbUser | null> =>
  (await client.query<DbUser>("SELECT * FROM users WHERE id = $1 FOR UPDATE", [id])).rows[0] ?? null;

/**
 * A provider sign-in whose verified email matches this account, and no account
 * carries the provider id yet. Re-checked under the row lock.
 *
 * - Verified account: the provider id is attached and nothing else changes.
 * - UNVERIFIED account: whoever registered the address never proved it, and the
 *   provider just did, so the account is taken back for the provider's user and
 *   nothing the registrant set up survives: password, two-factor secret and
 *   recovery codes, BOTH provider links (a squatter may have linked their own),
 *   push devices, the avatar, outstanding verification links, every session and
 *   every step-up grant.
 *   The provider in use is then the only way in, and the email counts as verified.
 *
 * `null` when the account is gone, is the admin (never joined by email), or no
 * longer has this address. A unique-index conflict rolls everything back and
 * throws `ProviderInUseError`.
 */
export async function joinProviderByEmail(id: string, input: {
  kind: ProviderKind; providerId: string; email: string; avatarUrl: string | null;
}): Promise<{ user: UserRow; reclaimed: boolean } | null> {
  return inTransaction(async (client) => {
    const row = await lockUser(client, id);
    if (!row || row.role === "admin" || row.email !== normaliseEmail(input.email)) return null;
    const column = input.kind === "google" ? "google_sub" : "github_id";
    if (row.email_verified_at) {
      const { rows } = await client.query<DbUser>(
        `UPDATE users SET ${column} = $2, avatar_url = COALESCE(avatar_url, $3) WHERE id = $1 RETURNING *`,
        [id, input.providerId, input.avatarUrl]);
      return { user: toRow(rows[0]!), reclaimed: false };
    }
    await client.query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [id]);
    // The squatter's step-up grants too (OD-2); the version bump below would
    // also end them, this makes it explicit.
    await client.query("DELETE FROM step_up_grants WHERE user_id = $1", [id]);
    await client.query("DELETE FROM push_subscriptions WHERE user_id = $1", [id]);
    await client.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [id]);
    const { rows } = await client.query<DbUser>(
      `UPDATE users SET
         password_hash = NULL,
         totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = 0,
         google_sub = CASE WHEN $2::text = 'google' THEN $3::text END,
         github_id = CASE WHEN $2::text = 'github' THEN $3::text END,
         avatar_url = $4,
         email_verified_at = now(),
         session_version = session_version + 1
       WHERE id = $1 RETURNING *`,
      [id, input.kind, input.providerId, input.avatarUrl]);
    return { user: toRow(rows[0]!), reclaimed: true };
  });
}

/**
 * "Link Google/GitHub" from a signed-in session, finished at the callback.
 *
 * `sessionVersion` is the version the link was STARTED under: if the account has
 * signed out everywhere, changed its password or been reclaimed since, the
 * link is refused. An account whose email isn't verified may link only a
 * provider identity with that same address, which then verifies it; the admin
 * has no email and links as before.
 */
export async function linkProviderForSession(id: string, input: {
  kind: ProviderKind; providerId: string; sessionVersion: number; providerEmail: string; avatarUrl: string | null;
}): Promise<{ status: "linked"; user: UserRow } | { status: "stale" | "unverified" }> {
  return inTransaction(async (client) => {
    const row = await lockUser(client, id);
    if (!row || row.session_version !== input.sessionVersion) return { status: "stale" };
    const verified = row.role === "admin" || !!row.email_verified_at;
    const provesEmail = row.email !== null && row.email === normaliseEmail(input.providerEmail);
    if (!verified && !provesEmail) return { status: "unverified" };
    const column = input.kind === "google" ? "google_sub" : "github_id";
    const { rows } = await client.query<DbUser>(
      `UPDATE users SET ${column} = $2, avatar_url = COALESCE(avatar_url, $3),
              email_verified_at = CASE WHEN $4::boolean THEN COALESCE(email_verified_at, now()) ELSE email_verified_at END
        WHERE id = $1 RETURNING *`,
      [id, input.providerId, input.avatarUrl, !verified && provesEmail]);
    return { status: "linked", user: toRow(rows[0]!) };
  });
}

export async function markLogin(id: string): Promise<void> {
  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [id]);
}

export async function updateProfile(
  id: string, patch: { displayName?: string; avatarUrl?: string | null },
): Promise<UserRow | null> {
  const { rows } = await query<DbUser>(
    `UPDATE users SET
       display_name = COALESCE($2, display_name),
       avatar_url = CASE WHEN $3::boolean THEN $4 ELSE avatar_url END
     WHERE id = $1 RETURNING *`,
    [id, patch.displayName ?? null, patch.avatarUrl !== undefined, patch.avatarUrl ?? null],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Change the password, compare-and-set: only if the account is still at the
 * session version the request was authenticated under and still has the hash
 * the request checked. Bumps the version (ending every other session) and
 * returns it, or `null` when either moved on in between — a reclaim, a
 * sign-out-everywhere or another password change got there first.
 */
export async function setPasswordIfCurrent(id: string, input: {
  expectedVersion: number; expectedHash: string | null; newHash: string;
}): Promise<number | null> {
  const { rows } = await query<{ session_version: number }>(
    `UPDATE users SET password_hash = $4, session_version = session_version + 1
      WHERE id = $1 AND role <> 'admin' AND session_version = $2 AND password_hash IS NOT DISTINCT FROM $3
      RETURNING session_version`,
    [id, input.expectedVersion, input.expectedHash, input.newHash]);
  return rows[0]?.session_version ?? null;
}

export async function markOnboarded(id: string): Promise<UserRow | null> {
  const { rows } = await query<DbUser>(
    "UPDATE users SET onboarded_at = COALESCE(onboarded_at, now()) WHERE id = $1 RETURNING *", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Revoke every session: each carries the version it was issued under. */
export async function bumpSessionVersion(id: string): Promise<number> {
  const { rows } = await query<{ session_version: number }>(
    "UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version",
    [id],
  );
  return rows[0]?.session_version ?? 1;
}

// Deleting an account: `repositories/accountDeletion.ts` (OD-6).
