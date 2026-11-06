/**
 * Accounts.
 *
 * Every user-owned row (alerts, watchlists, layouts, scripts, drawings, pane
 * studies, push devices) carries `user_id`, and every query that reads or
 * writes one is scoped by it. This file owns the account rows themselves.
 */
import { query } from "../db/pool";

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

/** Attach a Google identity to an existing account (same verified email). */
export async function linkGoogle(id: string, sub: string, avatarUrl: string | null): Promise<UserRow> {
  const { rows } = await query<DbUser>(
    `UPDATE users SET google_sub = $2, avatar_url = COALESCE(avatar_url, $3)
     WHERE id = $1 RETURNING *`,
    [id, sub, avatarUrl],
  );
  return toRow(rows[0]!);
}

export async function linkGithub(id: string, githubId: string, avatarUrl: string | null): Promise<UserRow> {
  const { rows } = await query<DbUser>(
    `UPDATE users SET github_id = $2, avatar_url = COALESCE(avatar_url, $3)
     WHERE id = $1 RETURNING *`,
    [id, githubId, avatarUrl],
  );
  return toRow(rows[0]!);
}

/** The address a provider has just vouched for belongs to this account. */
export async function markEmailVerified(id: string): Promise<void> {
  await query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1", [id]);
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

/** `null` removes the password: the account then signs in with Google only. */
export async function setPasswordHash(id: string, hash: string | null): Promise<void> {
  await query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, hash]);
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

/** Delete an account and, by cascade, everything it owns. Never the admin. */
export async function deleteUser(id: string): Promise<boolean> {
  if (id === ADMIN_USER_ID) return false;
  const { rowCount } = await query("DELETE FROM users WHERE id = $1 AND role <> 'admin'", [id]);
  return (rowCount ?? 0) > 0;
}
