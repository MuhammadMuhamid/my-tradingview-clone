/**
 * Step-up: re-confirming a credential before a consequential command, with a
 * short-lived, server-validated grant so a run of commands does not need a new
 * authenticator code each time (owner decision OD-2).
 *
 * ── Tiers ───────────────────────────────────────────────────────────────────
 *
 * Every consequential route declares a tier. Absent means `fresh`, the safe
 * default.
 *   grant  a valid grant suffices; otherwise one credential, which (when it is
 *          an authenticator code) mints a grant for the next five minutes.
 *   fresh  a new credential every time. A correct authenticator code here
 *          still mints a grant for the grant-tier commands that follow.
 *
 * ── Which credential ────────────────────────────────────────────────────────
 *
 *   two-factor on                     the authenticator code, only;
 *   two-factor off, a password exists the password, where the route allows it
 *                                     (risk-reducing commands only), else
 *                                     `two_factor_required`;
 *   two-factor off, no password       `step_up_unavailable`.
 * How the session was created (password, Google, GitHub) plays no part. Only
 * an authenticator code mints a grant; a password never does.
 *
 * ── The grant ───────────────────────────────────────────────────────────────
 *
 * The browser holds an opaque random handle (32 bytes, base64url) in the
 * cookie `srtrend_stepup`: HttpOnly, SameSite=Strict (a cross-site request
 * never carries it), Path=/api, five minutes. Only its SHA-256 is stored
 * (`repositories/stepUpGrants.ts`). It is honoured only while the account's
 * session version and role are what they were when it was minted, two-factor
 * is still on, it is not revoked and not expired; using it never extends it.
 * Everything that changes how someone signs in deletes every grant of the
 * account (see `revokeAllGrants`).
 *
 * ── Never ───────────────────────────────────────────────────────────────────
 *
 * The code, the password and the handle are never logged, stored in the
 * clear, returned or put in a URL. With AUTH_ENABLED=false nothing here can
 * succeed: every request is then the administrator and a password check would
 * pass for an account without one, so step-up would fail open.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { stepUpLimiter } from "./rateLimit";
import { readCookie } from "./session";
import * as grants from "../repositories/stepUpGrants";
import * as users from "../repositories/users";
import { passPassword, passSecondFactor } from "../api/routes/accountSecurity";

/** A refusal this Platform authors. Always carries a code the browser can branch on. */
export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string,
    readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export type StepUpTier = "grant" | "fresh";
export type CredentialMethod = "totp" | "password";

export interface StepUpOptions {
  /** Default `fresh`: a route that forgets to say is the strict kind. */
  tier?: StepUpTier;
  /** Only risk-reducing commands (halts, pausing entries) accept the password when two-factor is off. */
  allowsPassword?: boolean;
  /**
   * The credential the browser sent. Default: `body.credential` of the request,
   * `{ code }` or `{ password }`.
   */
  credential?: unknown;
  /** A grant may stand in only while the account is still an administrator. Default true. */
  requireAdmin?: boolean;
}

export interface StepUpProof {
  /** What confirmed this request: a code, the password, or a grant a code minted earlier. */
  method: CredentialMethod | "grant";
  /** The grant used (method `grant`), for the audit row. */
  grantId?: string;
  /**
   * When the credential was proved: now, or the grant's mint time. The Bot's
   * actor claim carries this, so it sees when the proof actually happened.
   */
  at: string;
}

/** The method the Bot's actor claim may carry: a grant was minted by a code. */
export const actorStepUpMethod = (proof: StepUpProof): CredentialMethod =>
  proof.method === "grant" ? "totp" : proof.method;

// ── the cookie ──────────────────────────────────────────────────────────────

export const STEP_UP_COOKIE = "srtrend_stepup";
export const GRANT_TTL_MS = 5 * 60_000;
const COOKIE_PATH = "/api";
/** 32 random bytes, base64url, no padding. Anything else is not a handle. */
const HANDLE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const hashHandle = (handle: string): string => createHash("sha256").update(handle).digest("hex");

function cookie(value: string, maxAgeSec: number): string {
  const attrs = [`${STEP_UP_COOKIE}=${value}`, `Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Strict",
    `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) attrs.push("Secure");
  return attrs.join("; ");
}

/** The Set-Cookie value that removes this browser's handle. */
export const clearStepUpCookie = (): string => cookie("", 0);

/** This browser's handle, if it sent a well-formed one. */
function handleOf(req: FastifyRequest): string | null {
  const raw = readCookie(req.headers.cookie, STEP_UP_COOKIE);
  return raw && HANDLE_SHAPE.test(raw) ? raw : null;
}

// ── which credential ────────────────────────────────────────────────────────

/**
 * Which credential this account can confirm with, or why it cannot. Mirrors
 * where `passPassword` looks for the hash (the server's ADMIN_PASSWORD_HASH for
 * the administrator, the account row otherwise), so "a hash exists" here means
 * what the check will mean. Decided BEFORE any check runs, because
 * `passPassword` says "ok" for an account with no password and that must never
 * become a bypass.
 */
export async function credentialMethodFor(account: users.UserRow, allowsPassword: boolean): Promise<CredentialMethod> {
  if (account.twoFactorEnabled) return "totp";
  if (!await hasPassword(account)) {
    throw new Refusal(403, "step_up_unavailable", "Turn on two-factor sign-in in your profile to confirm this.");
  }
  if (!allowsPassword) {
    throw new Refusal(403, "two_factor_required",
      "Turn on two-factor sign-in in your profile to operate the Bot from Trading Scene.");
  }
  return "password";
}

/** Whether a password check would mean anything for this account (the server's hash for the administrator). */
export async function hasPassword(account: users.UserRow): Promise<boolean> {
  const hash = account.role === "admin" ? config.adminPasswordHash : await users.getPasswordHash(account.id);
  return !!hash;
}

const bodyCredential = (req: FastifyRequest): unknown =>
  typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>).credential : undefined;

// ── the one entry point ─────────────────────────────────────────────────────

/**
 * Confirm this request, or throw a `Refusal`:
 *   400 step_up_required  {method, tier}  nothing supplied (and no valid grant);
 *   400 step_up_failed    {method, tier}  the code or password is wrong, or the code was already used;
 *   429 step_up_rate_limited              too many attempts (Retry-After set);
 *   429 step_up_busy                      the password check is saturated;
 *   403 two_factor_required               two-factor is off and this needs it;
 *   403 step_up_unavailable               no credential exists to ask for;
 *   403 auth_disabled                     AUTH_ENABLED=false.
 * A correct authenticator code also sets a new grant cookie on `reply`.
 */
export async function resolveStepUp(req: FastifyRequest, reply: FastifyReply, account: users.UserRow,
  options: StepUpOptions = {}): Promise<StepUpProof> {
  if (!config.authEnabled) {
    throw new Refusal(403, "auth_disabled", "Confirming this needs sign-in to be on (AUTH_ENABLED).");
  }
  const tier: StepUpTier = options.tier ?? "fresh";
  const handle = handleOf(req);

  if (tier === "grant" && handle) {
    const grant = await grants.findValidGrant(account.id, hashHandle(handle),
      { requireAdmin: options.requireAdmin ?? true });
    if (grant) return { method: "grant", grantId: grant.id, at: grant.createdAt };
  }

  const method = await credentialMethodFor(account, options.allowsPassword === true);
  const raw = options.credential !== undefined ? options.credential : bodyCredential(req);
  const credential = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const supplied = method === "totp" ? credential.code : credential.password;
  if (typeof supplied !== "string" || supplied.trim() === "" || supplied.length > 1024) {
    throw new Refusal(400, "step_up_required", method === "totp"
      ? "Enter the code from your authenticator app to confirm."
      : "Enter your password to confirm.", { method, tier });
  }

  const decision = stepUpLimiter.hit(account.id);
  if (!decision.allowed) {
    reply.header("retry-after", String(decision.retryAfterSec));
    throw new Refusal(429, "step_up_rate_limited", "Too many attempts. Try again in a few minutes.");
  }
  const result = method === "totp"
    ? (await passSecondFactor(account.id, { code: supplied }, false) ? "ok" : "wrong")
    : await passPassword(account, supplied);
  if (result === "busy") throw new Refusal(429, "step_up_busy", "Busy. Try again shortly.");
  if (result === "wrong") {
    throw new Refusal(400, "step_up_failed", method === "totp"
      ? "That code isn't correct, or it was already used. Wait for the next one."
      : "Your password isn't correct.", { method, tier });
  }
  stepUpLimiter.reset(account.id);
  const at = new Date().toISOString();
  if (method === "totp") await mintFor(req, reply, account, handle);
  return { method, at };
}

/**
 * A new grant after a correct code, replacing this browser's earlier one. A
 * failure to record it costs only convenience (the next command asks again),
 * never the command the code just confirmed.
 */
async function mintFor(req: FastifyRequest, reply: FastifyReply, account: users.UserRow,
  previous: string | null): Promise<void> {
  try {
    if (previous) await grants.revokeGrant(hashHandle(previous));
    const handle = randomBytes(32).toString("base64url");
    const grant = await grants.mintGrant(account.id, hashHandle(handle), GRANT_TTL_MS);
    if (grant) reply.header("set-cookie", cookie(handle, Math.floor(GRANT_TTL_MS / 1000)));
  } catch (err) {
    req.log.warn({ err: (err as Error).name, userId: account.id }, "could not record a step-up grant");
  }
}

// ── status, lock now, and the invalidation paths ────────────────────────────

export interface StepUpStatus {
  twoFactorEnabled: boolean;
  /** The credential a dialog would ask for: the code, the password (risk-reducing commands only), or none exists. */
  method: CredentialMethod | null;
  grant: { valid: boolean; expiresAt?: string };
}

/** What the dialogs need to know, and no secret. */
export async function stepUpStatus(req: FastifyRequest, account: users.UserRow): Promise<StepUpStatus> {
  const method: CredentialMethod | null = account.twoFactorEnabled ? "totp"
    : await hasPassword(account) ? "password" : null;
  const handle = handleOf(req);
  const grant = config.authEnabled && handle
    ? await grants.findValidGrant(account.id, hashHandle(handle), { requireAdmin: false })
    : null;
  return {
    twoFactorEnabled: account.twoFactorEnabled, method,
    grant: grant ? { valid: true, expiresAt: grant.expiresAt } : { valid: false },
  };
}

/**
 * "Lock now" and plain sign-out: this browser's handle stops working and its
 * cookie is cleared. Other browsers' grants are untouched.
 */
export async function revokeThisGrant(req: FastifyRequest): Promise<void> {
  const handle = handleOf(req);
  if (handle) await grants.revokeGrant(hashHandle(handle));
}

/**
 * Every grant of the account, gone. Called on sign-out everywhere, a password
 * change, two-factor on or off, new recovery codes, a reclaim and an
 * administrator's two-factor reset (account deletion cascades).
 */
export async function revokeAllGrants(userId: string, client?: PoolClient): Promise<void> {
  await grants.deleteAllGrants(userId, client);
}
