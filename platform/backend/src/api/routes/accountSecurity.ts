/**
 * Email verification, two-factor sign-in and sign-in history.
 *
 * Nothing here gates a feature yet. `moneyFeaturesUnlocked` on the account says
 * whether both are done, for the packages work to require.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { config } from "../../config";
import { twoFactorLimiter, verificationEmailLimiter } from "../../security/rateLimit";
import { forgetUser, userIdOf } from "../../security/requestUser";
import { readCookie, sessionCookie, signUserSession } from "../../security/session";
import {
  PENDING_COOKIE, clearPendingCookie, generateRecoveryCodes, generateTotpSecret, matchTotpStep,
  openPendingSignIn, totpUrl,
} from "../../security/twoFactor";
import * as accountSecurity from "../../repositories/accountSecurity";
import * as users from "../../repositories/users";
import { isEmailConfigured, sendVerificationEmail } from "../../email/mailer";
import { checkPassword, noteSignIn, publicUser, setSessionCookies, startSession } from "./auth";
import { appendAdminAudit } from "../../repositories/adminAudit";

type SecondFactor = { code?: unknown; recoveryCode?: unknown };

function tooManyGuesses(reply: FastifyReply, retryAfterSec: number) {
  reply.header("retry-after", String(retryAfterSec));
  return reply.code(429).send({ error: "Too many attempts. Try again in a few minutes." });
}

/** A code from the app, or an unused recovery code. Each works once. */
async function passSecondFactor(userId: string, body: SecondFactor, allowRecovery = true): Promise<boolean> {
  if (allowRecovery && typeof body.recoveryCode === "string" && body.recoveryCode.length <= 64) {
    return accountSecurity.consumeRecoveryCode(userId, body.recoveryCode);
  }
  if (typeof body.code !== "string") return false;
  const totp = await accountSecurity.readTotp(userId);
  if (!totp) return false;
  const step = matchTotpStep(totp.secret, body.code.replace(/\s/g, ""), totp.lastStep);
  return step !== null && accountSecurity.recordTotpStep(userId, step);
}

/**
 * The account's password, where it has one. A stolen session must not be able
 * to change who can sign in. An account that only signs in through a provider has
 * no password to ask for.
 */
async function passPassword(account: users.UserRow, raw: unknown): Promise<"ok" | "wrong" | "busy"> {
  const hash = account.role === "admin" ? config.adminPasswordHash : await users.getPasswordHash(account.id);
  if (!hash) return "ok";
  if (typeof raw !== "string" || raw.length > 1024) return "wrong";
  const result = await checkPassword(raw, hash);
  if (result === "busy") return "busy";
  return result ? "ok" : "wrong";
}

/**
 * Re-entering a credential before a sensitive action: the code from the app when
 * two-factor is on, otherwise the password. Guesses count against the account.
 */
export async function confirmIdentity(account: users.UserRow, body: { password?: unknown; code?: unknown }):
  Promise<"ok" | "wrong" | "busy" | { retryAfterSec: number }> {
  const decision = twoFactorLimiter.hit(account.id);
  if (!decision.allowed) return { retryAfterSec: decision.retryAfterSec };
  const result = account.twoFactorEnabled
    ? (await passSecondFactor(account.id, { code: body.code }, false) ? "ok" : "wrong")
    : await passPassword(account, body.password);
  if (result === "ok") twoFactorLimiter.reset(account.id);
  return result;
}

/**
 * A two-factor change, recorded for detection (contract F1).
 *
 * Bot controls trust two-factor as the second factor. An attacker holding a
 * session and a password could otherwise enrol their own authenticator and
 * leave no trace, so each step lands in the append-only `admin_audit`. It is
 * recorded after the change has happened, and a failure to record is logged,
 * not turned into a failed enrolment: the database write the change itself
 * needed has already succeeded by then.
 *
 * Administrator accounts only. They are the accounts whose second factor
 * guards the Bot, and they are the only ones `admin_audit` may name:
 * `admin_audit.actor` is `ON DELETE SET NULL`, and the table's append-only
 * trigger refuses that UPDATE, so a row naming an ordinary account would make
 * that account impossible to delete. `deleteUser` never deletes an admin.
 */
async function auditTwoFactor(req: FastifyRequest, account: users.UserRow,
  action: "auth.2fa.setup_started" | "auth.2fa.enabled" | "auth.2fa.disabled"): Promise<void> {
  if (account.role !== "admin") return;
  try {
    await appendAdminAudit(account.id, action, `user:${account.id}`, { role: account.role });
  } catch (err) {
    req.log.error({ err: (err as Error).name, action, userId: account.id }, "could not record a two-factor change");
  }
}

async function currentAccount(req: FastifyRequest, reply: FastifyReply): Promise<users.UserRow | null> {
  const account = await users.getUser(userIdOf(req));
  if (!account) reply.code(404).send({ error: "account not found" });
  return account;
}

export async function accountSecurityRoutes(app: FastifyInstance): Promise<void> {
  // ── email ────────────────────────────────────────────────────────────────

  app.post("/api/auth/email/verify", async (req, reply) => {
    const token = (req.body as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.length > 128) {
      return reply.code(400).send({ error: "This link isn't valid. Ask for a new one from your profile." });
    }
    const id = await accountSecurity.consumeEmailToken(token);
    if (!id) return reply.code(400).send({ error: "This link has expired or has already been used. Ask for a new one from your profile." });
    forgetUser(id);
    return { ok: true };
  });

  app.post("/api/auth/email/resend", async (req, reply) => {
    const account = await currentAccount(req, reply);
    if (!account) return reply;
    if (!account.email) return reply.code(400).send({ error: "This account has no email address." });
    if (account.emailVerified) return { ok: true, alreadyVerified: true };
    if (!isEmailConfigured()) return reply.code(503).send({ error: "Email isn't set up on this server yet." });
    const decision = verificationEmailLimiter.hit(account.id);
    if (!decision.allowed) return tooManyGuesses(reply, decision.retryAfterSec);
    try {
      await sendVerificationEmail(account.email, await accountSecurity.issueEmailToken(account.id, account.email));
    } catch (err) {
      req.log.warn({ err: (err as Error).name }, "could not send the verification email");
      return reply.code(502).send({ error: "The email couldn't be sent. Try again shortly." });
    }
    return { ok: true };
  });

  // ── second step of a sign-in ─────────────────────────────────────────────

  app.post("/api/auth/2fa/login", async (req, reply) => {
    const pending = openPendingSignIn(readCookie(req.headers.cookie, PENDING_COOKIE), config.sessionSecret);
    if (!pending) return reply.code(401).send({ error: "That sign-in took too long. Start again." });
    const account = await users.getUser(pending.userId);
    if (!account || account.sessionVersion !== pending.version || !account.twoFactorEnabled) {
      return reply.code(401).send({ error: "That sign-in took too long. Start again." });
    }
    const decision = twoFactorLimiter.hit(account.id);
    if (!decision.allowed) return tooManyGuesses(reply, decision.retryAfterSec);
    if (!await passSecondFactor(account.id, (req.body ?? {}) as SecondFactor)) {
      req.log.warn({ userId: account.id }, "failed second factor");
      return reply.code(401).send({ error: "That code isn't correct." });
    }
    twoFactorLimiter.reset(account.id);
    await noteSignIn(req, account.id, pending.method, true);
    setSessionCookies(reply, [
      sessionCookie(signUserSession(account.id, account.sessionVersion, config.sessionSecret), config.cookieSecure),
      clearPendingCookie(config.cookieSecure),
    ]);
    return { ok: true, user: publicUser(account) };
  });

  // ── managing it ──────────────────────────────────────────────────────────

  app.get("/api/auth/2fa/status", async (req, reply) => {
    const account = await currentAccount(req, reply);
    if (!account) return reply;
    return { enabled: account.twoFactorEnabled, recoveryCodesLeft: await accountSecurity.countRecoveryCodes(account.id) };
  });

  app.post("/api/auth/2fa/setup", async (req, reply) => {
    const account = await currentAccount(req, reply);
    if (!account) return reply;
    if (account.twoFactorEnabled) return reply.code(409).send({ error: "Two-factor sign-in is already on." });
    // Otherwise someone squatting an address could lock its real owner out.
    if (account.role !== "admin" && !account.emailVerified) {
      return reply.code(403).send({ error: "Verify your email address first." });
    }
    const guesses = twoFactorLimiter.hit(account.id);
    if (!guesses.allowed) return tooManyGuesses(reply, guesses.retryAfterSec);
    const password = await passPassword(account, (req.body as { password?: unknown } | null)?.password);
    if (password === "busy") return reply.code(429).send({ error: "Busy. Try again shortly." });
    if (password === "wrong") return reply.code(400).send({ error: "Your password isn't correct." });
    twoFactorLimiter.reset(account.id);
    const secret = generateTotpSecret();
    await accountSecurity.startTotpSetup(account.id, secret);
    await auditTwoFactor(req, account, "auth.2fa.setup_started");
    const url = totpUrl(secret, account.email ?? config.adminUsername, "Trading Scene");
    return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  });

  app.post("/api/auth/2fa/enable", async (req, reply) => {
    const account = await currentAccount(req, reply);
    if (!account) return reply;
    if (account.twoFactorEnabled) return reply.code(409).send({ error: "Two-factor sign-in is already on." });
    const decision = twoFactorLimiter.hit(account.id);
    if (!decision.allowed) return tooManyGuesses(reply, decision.retryAfterSec);
    if (!await passSecondFactor(account.id, (req.body ?? {}) as SecondFactor, false)) {
      return reply.code(400).send({ error: "That code isn't correct. Check your phone's clock and try again." });
    }
    twoFactorLimiter.reset(account.id);
    const recoveryCodes = generateRecoveryCodes();
    await accountSecurity.replaceRecoveryCodes(account.id, recoveryCodes);
    await accountSecurity.enableTotp(account.id);
    await auditTwoFactor(req, account, "auth.2fa.enabled");
    return { ok: true, recoveryCodes };
  });

  /** Turning it off takes both factors, and ends every other session. */
  app.post("/api/auth/2fa/disable", async (req, reply) => {
    const account = await currentAccount(req, reply);
    if (!account) return reply;
    if (!account.twoFactorEnabled) return { ok: true };
    const body = (req.body ?? {}) as SecondFactor & { password?: unknown };
    const decision = twoFactorLimiter.hit(account.id);
    if (!decision.allowed) return tooManyGuesses(reply, decision.retryAfterSec);
    const password = await passPassword(account, body.password);
    if (password === "busy") return reply.code(429).send({ error: "Busy. Try again shortly." });
    if (password === "wrong") return reply.code(400).send({ error: "Your password isn't correct." });
    if (!await passSecondFactor(account.id, body)) return reply.code(400).send({ error: "That code isn't correct." });
    twoFactorLimiter.reset(account.id);
    await accountSecurity.clearTotp(account.id);
    await auditTwoFactor(req, account, "auth.2fa.disabled");
    const version = await users.bumpSessionVersion(account.id);
    forgetUser(account.id);
    startSession(reply, { id: account.id, sessionVersion: version });
    return { ok: true };
  });

  app.post("/api/auth/2fa/recovery-codes", async (req, reply) => {
    const account = await currentAccount(req, reply);
    if (!account) return reply;
    if (!account.twoFactorEnabled) return reply.code(409).send({ error: "Two-factor sign-in is off." });
    const decision = twoFactorLimiter.hit(account.id);
    if (!decision.allowed) return tooManyGuesses(reply, decision.retryAfterSec);
    if (!await passSecondFactor(account.id, (req.body ?? {}) as SecondFactor, false)) {
      return reply.code(400).send({ error: "That code isn't correct." });
    }
    twoFactorLimiter.reset(account.id);
    const recoveryCodes = generateRecoveryCodes();
    await accountSecurity.replaceRecoveryCodes(account.id, recoveryCodes);
    return { ok: true, recoveryCodes };
  });

  // ── history ──────────────────────────────────────────────────────────────

  app.get("/api/auth/login-history", async (req) => ({
    logins: await accountSecurity.listLogins(userIdOf(req)),
  }));

}
