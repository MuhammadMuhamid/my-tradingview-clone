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
    const password = await passPassword(account, (req.body as { password?: unknown } | null)?.password);
    if (password === "busy") return reply.code(429).send({ error: "Busy. Try again shortly." });
    if (password === "wrong") return reply.code(400).send({ error: "Your password isn't correct." });
    const secret = generateTotpSecret();
    await accountSecurity.startTotpSetup(account.id, secret);
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
    return { ok: true, recoveryCodes };
  });

  /** Turning it off takes both factors, and ends every other session. */
  app.post("/api/auth/2fa/disable", async (req, reply) => {
    const account = await currentAccount(req, reply);
    if (!account) return reply;
    if (!account.twoFactorEnabled) return { ok: true };
    const body = (req.body ?? {}) as SecondFactor & { password?: unknown };
    const password = await passPassword(account, body.password);
    if (password === "busy") return reply.code(429).send({ error: "Busy. Try again shortly." });
    if (password === "wrong") return reply.code(400).send({ error: "Your password isn't correct." });
    const decision = twoFactorLimiter.hit(account.id);
    if (!decision.allowed) return tooManyGuesses(reply, decision.retryAfterSec);
    if (!await passSecondFactor(account.id, body)) return reply.code(400).send({ error: "That code isn't correct." });
    twoFactorLimiter.reset(account.id);
    await accountSecurity.clearTotp(account.id);
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
