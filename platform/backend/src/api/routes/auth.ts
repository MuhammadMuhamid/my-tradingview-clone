/**
 * Accounts: sign up, sign in (password or Google), sign out, profile.
 *
 * ── The admin ──────────────────────────────────────────────────────────────
 *
 * The platform's original single sign-in (ADMIN_USERNAME / ADMIN_PASSWORD_HASH
 * from the environment) still works, unchanged, and signs in as the fixed
 * admin account that owns everything created before accounts existed. Its
 * password lives in the environment, so it is changed there, not here.
 *
 * ── Linking Google to an existing account ──────────────────────────────────
 *
 * A Google sign-in whose verified email matches an existing UNVERIFIED account
 * takes that account back for the Google user. Emails are not verified at
 * password sign-up, so someone could register a victim's address first and
 * wait; when the victim later signs in with Google, nothing the squatter set up
 * may survive: password, two-factor secret and recovery codes, BOTH provider
 * links (the squatter may have linked their own GitHub or Google), push
 * devices, the avatar, outstanding verification links and every session — in
 * one transaction (`users.joinProviderByEmail`). The owner sets a new password
 * from their profile if they want one.
 *
 * The admin is never joined by email: linking Google to it takes an explicit
 * "Link Google" from a signed-in admin session.
 *
 * GitHub follows the same rules. An account whose email is ALREADY verified has
 * no squatter to remove, so it keeps its password, its other links and its
 * two-factor setup, and still has to pass that second factor.
 *
 * ── "Link Google / GitHub" from the profile ────────────────────────────────
 *
 * The state carries the account AND the session version the link started
 * under, and the callback links only for that same live session at that same
 * version: a state held across a sign-out-everywhere, a password change or a
 * reclaim does nothing. Linking needs a verified email (the admin counts as
 * verified), except that an unverified account may link a provider identity
 * whose verified email is its own address, which then verifies it. Linking is
 * not a sign-in: it issues no session and skips nothing. A state works for one
 * callback only.
 *
 * ── Sessions ───────────────────────────────────────────────────────────────
 *
 * A 90-day signed cookie naming the account and its session version
 * (`security/session`). Every authenticated request slides the expiry, so an
 * actively used browser is never signed out; "sign out everywhere" bumps the
 * version and every other session ends at its next request.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config";
import { clientKey, loginLimiter, stepUpLimiter, twoFactorLimiter } from "../../security/rateLimit";
import {
  GithubSignInError, exchangeGithubCode, githubAuthorizeUrl, type GithubIdentity,
} from "../../security/github";
import {
  clearPendingCookie, pendingCookie, sealPendingSignIn, type SignInMethod,
} from "../../security/twoFactor";
import * as accountSecurity from "../../repositories/accountSecurity";
import { isEmailConfigured, sendVerificationEmail } from "../../email/mailer";
import {
  clearCookie, hashPassword, readCookie, safeEqual, sessionCookie,
  signUserSession, verifyPassword, verifySession, verifyUserSession,
} from "../../security/session";
import {
  GoogleSignInError, OAUTH_COOKIE, authorizeUrl, clearOauthCookie, exchangeCode,
  newOAuthState, oauthCookie, openState, safeNext, sealState, type OAuthState,
} from "../../security/google";
import {
  forgetUser, loadRequestUser, userIdOf, type RequestUser,
} from "../../security/requestUser";
import * as users from "../../repositories/users";
import * as watchlists from "../../repositories/watchlists";
import { cleanSymbols } from "./watchlists";
import {
  Refusal, clearStepUpCookie, hasPassword, resolveStepUp, revokeAllGrants, revokeThisGrant,
} from "../../security/stepUp";
import { deleteAccount, deletionBlocked } from "../../repositories/accountDeletion";

const MEMBERSHIP_ACTIVE = {
  code: "membership_active",
  error: "This account still has a seat in a package cohort that hasn't finished, or money there that hasn't "
    + "been settled. Withdraw or wait for the cohort to settle, then delete the account.",
} as const;

// Bound expensive checks across all client IPs without queueing passwords.
let activePasswordChecks = 0;
const MAX_PASSWORD_CHECKS = 4;

/** A real scrypt hash of a random string: wrong guesses cost the same as right ones. */
const DUMMY_HASH = hashPassword(`dummy-${Date.now()}-${Math.random()}`);

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;

/**
 * The cookie's account, if the cookie is good — and the renewed cookie to set.
 *
 * Exported for the session gate in `api/server.ts`, which runs it on every
 * request; this file's routes call it again only where they need the account.
 */
export async function authenticate(
  token: string | null,
): Promise<{ user: RequestUser; renewed: string } | null> {
  if (!token) return null;
  const claims = verifyUserSession(token, config.sessionSecret);
  if (claims) {
    const user = await loadRequestUser(claims.userId);
    if (!user || user.sessionVersion !== claims.version) return null;
    return { user, renewed: signUserSession(user.id, user.sessionVersion, config.sessionSecret) };
  }
  // A cookie from before accounts: the admin's, signed for the admin's name.
  const legacy = verifySession(token, config.sessionSecret, { expectedUsername: config.adminUsername });
  if (!legacy) return null;
  const admin = await loadRequestUser(users.ADMIN_USER_ID);
  if (!admin) return null;
  return { user: admin, renewed: signUserSession(admin.id, admin.sessionVersion, config.sessionSecret) };
}

/**
 * Replace the session cookie. The gate already set a renewed copy of the OLD
 * session on this reply, and Fastify appends Set-Cookie rather than replacing
 * it — so a sign-in, a password change or a sign-out must remove that first,
 * or the response would carry both.
 */
export function setSessionCookies(reply: FastifyReply, cookies: string | string[]): void {
  reply.removeHeader("set-cookie");
  reply.header("set-cookie", cookies);
}

export function startSession(reply: FastifyReply, user: { id: string; sessionVersion: number }): void {
  setSessionCookies(reply,
    sessionCookie(signUserSession(user.id, user.sessionVersion, config.sessionSecret), config.cookieSecure));
}

/** What the browser is told about an account — never the hash, never the Google id. */
export function publicUser(u: users.UserRow) {
  const emailVerified = u.role === "admin" || u.emailVerified;
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName || (u.email ? u.email.split("@")[0]! : "Admin"),
    avatarUrl: u.avatarUrl,
    role: u.role,
    onboarded: u.onboardedAt !== null,
    // The admin signs in with the server-configured password.
    hasPassword: u.role === "admin" || u.hasPassword,
    passwordManagedByServer: u.role === "admin",
    googleLinked: u.googleLinked,
    githubLinked: u.githubLinked,
    emailVerified,
    twoFactorEnabled: u.twoFactorEnabled,
    // What money features will ask for. Nothing checks it until packages exist.
    moneyFeaturesUnlocked: emailVerified && u.twoFactorEnabled,
    createdAt: u.createdAt,
  };
}

/**
 * The admin's account row — or, if it cannot be read, the row migration 050
 * creates. The admin's credentials live in the environment, so a verified
 * admin password is proof enough; a database that is momentarily unreadable
 * (or, in a test, not yet migrated) must not lock the owner out.
 */
async function adminAccount(): Promise<users.UserRow> {
  const row = await users.getUser(users.ADMIN_USER_ID).catch(() => null);
  return row ?? {
    id: users.ADMIN_USER_ID, email: null, displayName: "Admin", avatarUrl: null,
    hasPassword: false, googleLinked: false, githubLinked: false, emailVerified: false,
    twoFactorEnabled: false, role: "admin", sessionVersion: 1,
    onboardedAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(), lastLoginAt: null,
  };
}

const googleEnabled = (): boolean =>
  !!config.googleClientId && !!config.googleClientSecret && !!config.publicBaseUrl;

const redirectUri = (): string => `${config.publicBaseUrl}/api/auth/google/callback`;

const githubEnabled = (): boolean =>
  !!config.githubClientId && !!config.githubClientSecret && !!config.publicBaseUrl;

const githubRedirectUri = (): string => `${config.publicBaseUrl}/api/auth/github/callback`;
const GITHUB_COOKIE_PATH = "/api/auth/github";

export const requestAddress = (req: FastifyRequest): string =>
  clientKey(req.ip, req.headers["x-forwarded-for"], config.trustProxy);

/** History must never be why a correct sign-in fails. */
export async function noteSignIn(
  req: FastifyRequest, userId: string, method: SignInMethod, twoFactor: boolean,
): Promise<void> {
  await users.markLogin(userId).catch(() => undefined);
  const agent = req.headers["user-agent"];
  await accountSecurity.recordLogin({
    userId, method, twoFactor, ip: requestAddress(req), userAgent: typeof agent === "string" ? agent : null,
  }).catch((err: Error) => req.log.warn({ err: err.message }, "could not record sign-in"));
}

function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s+/g, " ").trim();
  if (v.length === 0 || v.length > 80) return null;
  return v;
}

export async function checkPassword(password: string, hash: string): Promise<boolean | "busy"> {
  if (activePasswordChecks >= MAX_PASSWORD_CHECKS) return "busy";
  activePasswordChecks++;
  try { return await verifyPassword(password, hash); }
  finally { activePasswordChecks--; }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Who is signed in, and which ways in this instance offers. */
  app.get("/api/auth/me", async (req) => {
    const providers = { google: googleEnabled(), github: githubEnabled(), signups: config.allowSignups,
      email: isEmailConfigured() };
    if (!config.authEnabled) {
      const admin = await users.getUser(users.ADMIN_USER_ID).catch(() => null);
      return {
        authenticated: true, authEnabled: false, username: null, providers,
        user: admin ? publicUser(admin) : null,
      };
    }
    const account = req.user ? await users.getUser(req.user.id) : null;
    return {
      authenticated: !!account,
      authEnabled: true,
      username: account?.email ?? (account?.role === "admin" ? config.adminUsername : null),
      providers,
      user: account ? publicUser(account) : null,
    };
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (!config.authEnabled) return { ok: true, authEnabled: false };
    const body = (req.body ?? {}) as { username?: unknown; email?: unknown; password?: unknown };
    const identifier = typeof body.email === "string" ? body.email : body.username;
    const password = body.password;
    if (typeof identifier !== "string" || typeof password !== "string"
      || !identifier || !password || identifier.length > 256 || password.length > MAX_PASSWORD) {
      return reply.code(400).send({ error: "email and password are required" });
    }

    let account: users.UserRow | null = null;
    let ok: boolean | "busy";
    if (!users.isEmailShaped(identifier)) {
      // The configured admin name. Both checks always run, and the message
      // never says which half failed.
      const nameOk = safeEqual(identifier, config.adminUsername);
      ok = await checkPassword(password, config.adminPasswordHash || DUMMY_HASH);
      if (ok === true && nameOk) account = await adminAccount();
      else if (ok !== "busy") ok = false;
    } else {
      const found = await users.getUserForPassword(identifier);
      ok = await checkPassword(password, found?.passwordHash ?? DUMMY_HASH);
      if (ok === true && found?.passwordHash) account = found.user;
      else if (ok !== "busy") ok = false;
    }
    if (ok === "busy") {
      reply.header("retry-after", "1");
      return reply.code(429).send({ error: "Sign-in is busy. Try again shortly." });
    }
    if (!account) {
      req.log.warn({ ip: req.ip }, "failed sign-in attempt");
      return reply.code(401).send({ error: "Incorrect email or password" });
    }
    // A user who signs in correctly should not be locked out by earlier typos.
    loginLimiter.reset(clientKey(req.ip, req.headers["x-forwarded-for"], config.trustProxy));
    if (account.twoFactorEnabled) {
      // The password was right, but this isn't a session yet.
      setSessionCookies(reply, pendingCookie(sealPendingSignIn(
        { userId: account.id, version: account.sessionVersion, method: "password" }, config.sessionSecret,
      ), config.cookieSecure));
      return { ok: true, twoFactorRequired: true };
    }
    await noteSignIn(req, account.id, "password", false);
    startSession(reply, account);
    return { ok: true, user: publicUser(account) };
  });

  app.post("/api/auth/signup", async (req, reply) => {
    if (!config.authEnabled) return reply.code(400).send({ error: "accounts are disabled on this instance" });
    if (!config.allowSignups) {
      return reply.code(403).send({ error: "New accounts are not being accepted right now." });
    }
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown; displayName?: unknown };
    if (typeof body.email !== "string" || !users.isEmailShaped(body.email)) {
      return reply.code(400).send({ error: "Enter a valid email address." });
    }
    if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD
      || body.password.length > MAX_PASSWORD) {
      return reply.code(400).send({ error: `Use a password of at least ${MIN_PASSWORD} characters.` });
    }
    const displayName = cleanDisplayName(body.displayName) ?? body.email.split("@")[0]!.slice(0, 80);
    try {
      const account = await users.createUser({
        email: body.email, displayName, passwordHash: hashPassword(body.password),
      });
      await noteSignIn(req, account.id, "password", false);
      startSession(reply, account);
      // Failing to send never loses the account: it can ask again from its profile.
      let verificationEmail: "sent" | "unavailable" = "unavailable";
      if (isEmailConfigured() && account.email) {
        try {
          await sendVerificationEmail(account.email, await accountSecurity.issueEmailToken(account.id, account.email));
          verificationEmail = "sent";
        } catch (err) {
          req.log.warn({ err: (err as Error).name }, "could not send the verification email");
        }
      }
      return reply.code(201).send({ ok: true, user: publicUser(account), verificationEmail });
    } catch (err) {
      if (err instanceof users.EmailTakenError) {
        return reply.code(409).send({ error: "An account with this email already exists. Sign in instead." });
      }
      throw err;
    }
  });

  /** This browser only: its session cookie and its step-up grant (OD-2). */
  app.post("/api/auth/logout", async (req, reply) => {
    await revokeThisGrant(req);
    setSessionCookies(reply, [clearCookie(config.cookieSecure), clearStepUpCookie()]);
    return { ok: true };
  });

  /** End every session of this account, this one included, and every step-up grant. */
  app.post("/api/auth/logout-all", async (req, reply) => {
    const id = userIdOf(req);
    await users.bumpSessionVersion(id);
    await revokeAllGrants(id);
    forgetUser(id);
    setSessionCookies(reply, [clearCookie(config.cookieSecure), clearStepUpCookie()]);
    return { ok: true };
  });

  app.patch("/api/auth/profile", async (req, reply) => {
    const body = (req.body ?? {}) as { displayName?: unknown; avatarUrl?: unknown };
    const patch: { displayName?: string; avatarUrl?: string | null } = {};
    if (body.displayName !== undefined) {
      const name = cleanDisplayName(body.displayName);
      if (!name) return reply.code(400).send({ error: "A display name is 1 to 80 characters." });
      patch.displayName = name;
    }
    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl === null || body.avatarUrl === "") patch.avatarUrl = null;
      else if (typeof body.avatarUrl === "string" && /^https:\/\/\S{1,2040}$/.test(body.avatarUrl)) {
        patch.avatarUrl = body.avatarUrl;
      } else {
        return reply.code(400).send({ error: "A picture must be an https:// address." });
      }
    }
    const updated = await users.updateProfile(userIdOf(req), patch);
    if (!updated) return reply.code(404).send({ error: "account not found" });
    return { ok: true, user: publicUser(updated) };
  });

  /** Set or change this account's password. */
  app.post("/api/auth/password", async (req, reply) => {
    const id = userIdOf(req);
    const account = await users.getUser(id);
    if (!account) return reply.code(404).send({ error: "account not found" });
    if (account.role === "admin") {
      return reply.code(400).send({
        error: "The administrator's password is set on the server (ADMIN_PASSWORD_HASH).",
      });
    }
    const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof body.newPassword !== "string" || body.newPassword.length < MIN_PASSWORD
      || body.newPassword.length > MAX_PASSWORD) {
      return reply.code(400).send({ error: `Use a password of at least ${MIN_PASSWORD} characters.` });
    }
    // The version this request's session was checked against by the gate.
    const sessionVersion = req.user?.sessionVersion;
    if (sessionVersion === undefined) return reply.code(401).send({ error: "not authenticated" });
    const current = await users.getPasswordHash(id);
    if (current) {
      if (typeof body.currentPassword !== "string") {
        return reply.code(400).send({ error: "Enter your current password." });
      }
      const ok = await checkPassword(body.currentPassword, current);
      if (ok === "busy") return reply.code(429).send({ error: "Busy. Try again shortly." });
      if (!ok) return reply.code(401).send({ error: "Your current password is not correct." });
    }
    // Compare-and-set: if a reclaim, a sign-out-everywhere or another change
    // landed while the password was being checked, this request is stale and
    // must neither set a password nor come away with a session.
    const version = await users.setPasswordIfCurrent(id, {
      expectedVersion: sessionVersion, expectedHash: current, newHash: hashPassword(body.newPassword),
    });
    forgetUser(id);
    if (version === null) {
      setSessionCookies(reply, clearCookie(config.cookieSecure));
      return reply.code(401).send({ error: "Your account changed while this was being saved. Sign in again." });
    }
    // Every other session ends, and every step-up grant; this session is
    // re-issued under the new version.
    await revokeAllGrants(id);
    setSessionCookies(reply, [
      sessionCookie(signUserSession(id, version, config.sessionSecret), config.cookieSecure),
      clearStepUpCookie(),
    ]);
    return { ok: true };
  });

  /**
   * First-run setup: a name, and a first watchlist of the coins they chose.
   * Idempotent — finishing it twice changes the name and the list, nothing else.
   */
  app.post("/api/auth/onboarding", async (req, reply) => {
    const id = userIdOf(req);
    const body = (req.body ?? {}) as { displayName?: unknown; symbols?: unknown; watchlistName?: unknown };
    if (body.displayName !== undefined) {
      const name = cleanDisplayName(body.displayName);
      if (!name) return reply.code(400).send({ error: "A display name is 1 to 80 characters." });
      await users.updateProfile(id, { displayName: name });
    }
    const symbols = cleanSymbols(body.symbols).slice(0, 200);
    if (symbols.length > 0) {
      const listName = typeof body.watchlistName === "string" && body.watchlistName.trim()
        ? body.watchlistName.trim().slice(0, 60) : "My watchlist";
      await watchlists.upsertByName(id, listName, symbols, 0);
    }
    const updated = await users.markOnboarded(id);
    if (!updated) return reply.code(404).send({ error: "account not found" });
    return { ok: true, user: publicUser(updated) };
  });

  /**
   * Delete this account and everything it owns (OD-6). The administrator
   * cannot be deleted, and nothing is deleted while sign-in is off.
   *
   * Body `{confirm: "DELETE", credential?}`. The credential is fresh every
   * time: the authenticator code when two-factor is on, otherwise the password
   * when the account has one. An account with neither (it only ever signed in
   * through Google or GitHub) confirms by typing DELETE alone: the signed-in
   * provider session is then the only factor there is (documented).
   *
   * Refused 409 `membership_active` while the account has a seat in a package
   * cohort that hasn't finished or money not yet settled (checked before the
   * credential, so a code is not spent, and again under lock). See
   * `repositories/accountDeletion.ts` for what is deleted and what is kept.
   */
  app.delete("/api/auth/account", async (req, reply) => {
    if (!config.authEnabled) {
      return reply.code(403).send({ code: "auth_disabled", error: "Accounts are off on this instance (AUTH_ENABLED)." });
    }
    const id = userIdOf(req);
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as { confirm?: unknown };
    if (body.confirm !== "DELETE") {
      return reply.code(400).send({ code: "confirmation_required", error: "Type DELETE to confirm." });
    }
    const account = await users.getUser(id);
    if (!account) return reply.code(404).send({ code: "not_found", error: "account not found" });
    if (account.role === "admin") {
      return reply.code(403).send({ code: "admin_account", error: "The administrator account cannot be deleted." });
    }
    if (await deletionBlocked(id)) return reply.code(409).send(MEMBERSHIP_ACTIVE);
    try {
      if (account.twoFactorEnabled || await hasPassword(account)) {
        await resolveStepUp(req, reply, account, { tier: "fresh", allowsPassword: true, requireAdmin: false });
      }
    } catch (error) {
      if (error instanceof Refusal) {
        return reply.code(error.status).send({ code: error.code, error: error.message, ...error.extra });
      }
      throw error;
    }
    const outcome = await deleteAccount(id);
    forgetUser(id);
    if (outcome === "membership_active") return reply.code(409).send(MEMBERSHIP_ACTIVE);
    if (outcome === "admin") return reply.code(403).send({ code: "admin_account", error: "The administrator account cannot be deleted." });
    if (outcome === "not_found") return reply.code(404).send({ code: "not_found", error: "account not found" });
    twoFactorLimiter.reset(id);
    stepUpLimiter.reset(id);
    setSessionCookies(reply, [clearCookie(config.cookieSecure), clearStepUpCookie()]);
    return { ok: true };
  });

  // ── Google ───────────────────────────────────────────────────────────────

  app.get("/api/auth/google/start", async (req, reply) => {
    if (!googleEnabled()) return reply.code(404).send({ error: "Google sign-in is not configured" });
    const q = req.query as { next?: string; mode?: string };
    // Linking needs the account it links to; signing in must not have one.
    const link = q.mode === "link" ? await linkTarget(req, "google") : null;
    if (typeof link === "string") return reply.redirect(`/login?error=${link}`);
    const state = newOAuthState(safeNext(q.next, link ? "/profile" : "/chart"), link);
    reply.header("set-cookie", oauthCookie(sealState(state, config.sessionSecret), config.cookieSecure));
    return reply.redirect(authorizeUrl({ clientId: config.googleClientId, redirectUri: redirectUri(), state }));
  });

  app.get("/api/auth/google/callback", async (req, reply) => {
    const fail = (code: string) => {
      reply.header("set-cookie", clearOauthCookie(config.cookieSecure));
      return reply.redirect(`/login?error=${encodeURIComponent(code)}`);
    };
    if (!googleEnabled()) return fail("google_disabled");
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return fail(q.error === "access_denied" ? "google_cancelled" : "google_failed");
    const state = openState(readCookie(req.headers.cookie, OAUTH_COOKIE), config.sessionSecret);
    if (!state || typeof q.state !== "string" || !safeEqual(q.state, state.state) || typeof q.code !== "string"
      || !claimState(state)) {
      return fail("google_expired");
    }

    let identity;
    try {
      identity = await exchangeCode({
        code: q.code, verifier: state.verifier, clientId: config.googleClientId,
        clientSecret: config.googleClientSecret, redirectUri: redirectUri(),
      });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "google sign-in failed");
      return fail(err instanceof GoogleSignInError ? "google_failed" : "google_unavailable");
    }

    return finishProviderSignIn(req, reply, "google", {
      id: identity.sub, email: identity.email, name: identity.name, picture: identity.picture,
    }, state);
  });

  // ── GitHub ───────────────────────────────────────────────────────────────

  app.get("/api/auth/github/start", async (req, reply) => {
    if (!githubEnabled()) return reply.code(404).send({ error: "GitHub sign-in is not configured" });
    const q = req.query as { next?: string; mode?: string };
    const link = q.mode === "link" ? await linkTarget(req, "github") : null;
    if (typeof link === "string") return reply.redirect(`/login?error=${link}`);
    const state = newOAuthState(safeNext(q.next, link ? "/profile" : "/chart"), link);
    reply.header("set-cookie", oauthCookie(sealState(state, config.sessionSecret), config.cookieSecure, GITHUB_COOKIE_PATH));
    return reply.redirect(githubAuthorizeUrl({ clientId: config.githubClientId, redirectUri: githubRedirectUri(), state }));
  });

  app.get("/api/auth/github/callback", async (req, reply) => {
    const fail = (code: string) => {
      reply.header("set-cookie", clearOauthCookie(config.cookieSecure, GITHUB_COOKIE_PATH));
      return reply.redirect(`/login?error=${encodeURIComponent(code)}`);
    };
    if (!githubEnabled()) return fail("github_disabled");
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return fail(q.error === "access_denied" ? "github_cancelled" : "github_failed");
    const state = openState(readCookie(req.headers.cookie, OAUTH_COOKIE), config.sessionSecret);
    if (!state || typeof q.state !== "string" || !safeEqual(q.state, state.state) || typeof q.code !== "string"
      || !claimState(state)) {
      return fail("github_expired");
    }
    let identity: GithubIdentity;
    try {
      identity = await exchangeGithubCode({
        code: q.code, verifier: state.verifier, clientId: config.githubClientId,
        clientSecret: config.githubClientSecret, redirectUri: githubRedirectUri(),
      });
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "github sign-in failed");
      return fail(err instanceof GithubSignInError ? "github_failed" : "github_unavailable");
    }
    return finishProviderSignIn(req, reply, "github", identity, state);
  });
}

/**
 * Who a "Link …" round trip is for, and the session version it starts under —
 * or the error code to send the browser back with.
 */
async function linkTarget(
  req: FastifyRequest, kind: "google" | "github",
): Promise<{ userId: string; version: number } | string> {
  if (!req.user) return "signin_required";
  const account = await users.getUser(req.user.id);
  if (!account || (config.authEnabled && account.sessionVersion !== req.user.sessionVersion)) return "signin_required";
  // Unverified: only a provider that proves this very address may be linked
  // (checked again at the callback), so an account without one can't start.
  if (account.role !== "admin" && !account.emailVerified && !account.email) return `${kind}_link_unverified`;
  return { userId: account.id, version: account.sessionVersion };
}

/*
 * States already used at a callback. Each works once: a duplicate or replayed
 * callback is refused before its code is exchanged. Per process, like the rate
 * limits (`security/rateLimit.ts`); an entry is needed only until its state's
 * `exp`, after which `openState` refuses the state anyway.
 */
const usedStates = new Map<string, number>();
const MAX_USED_STATES = 50_000;

function claimState(state: OAuthState, now = Date.now()): boolean {
  if (usedStates.has(state.state)) return false;
  if (usedStates.size >= MAX_USED_STATES) {
    for (const [key, exp] of usedStates) if (exp <= now) usedStates.delete(key);
    // Still full of live states: drop the oldest. Replaying one would still
    // need that browser's own cookie and a code the provider accepts twice.
    while (usedStates.size >= MAX_USED_STATES) usedStates.delete(usedStates.keys().next().value!);
  }
  usedStates.set(state.state, state.exp);
  return true;
}

/**
 * Who a provider's identity is, by its id, then by email. The email is one the
 * provider has verified, which is the only reason joining by it is safe.
 */
async function finishProviderSignIn(
  req: FastifyRequest, reply: FastifyReply, kind: "google" | "github",
  identity: { id: string; email: string; name: string; picture: string | null }, state: OAuthState,
) {
  const cookiePath = `/api/auth/${kind}`;
  const fail = (code: string) => {
    reply.header("set-cookie", clearOauthCookie(config.cookieSecure, cookiePath));
    return reply.redirect(`/login?error=${encodeURIComponent(code)}`);
  };
  const holder = () => kind === "google"
    ? users.getUserByGoogleSub(identity.id) : users.getUserByGithubId(identity.id);

  if (state.linkUserId) {
    // Explicit linking, for the live session that started it and only that.
    const live = req.user;
    if (!live || live.id !== state.linkUserId || state.linkVersion === null
      || (config.authEnabled && live.sessionVersion !== state.linkVersion)) {
      return fail("signin_required");
    }
    const current = await holder();
    if (current && current.id !== state.linkUserId) return fail(`${kind}_in_use`);
    if (!current) {
      let linked;
      try {
        linked = await users.linkProviderForSession(state.linkUserId, {
          kind, providerId: identity.id, sessionVersion: state.linkVersion,
          providerEmail: identity.email, avatarUrl: identity.picture,
        });
      } catch (err) {
        if (err instanceof users.ProviderInUseError) return fail(`${kind}_in_use`);
        throw err;
      }
      if (linked.status === "stale") return fail("signin_required");
      if (linked.status === "unverified") return fail(`${kind}_link_unverified`);
    }
    // Not a sign-in: the session that asked carries on (the gate has already
    // renewed it on this reply), and no new one is issued.
    reply.header("set-cookie", clearOauthCookie(config.cookieSecure, cookiePath));
    return reply.redirect(state.next);
  }

  let account = await holder();
  if (!account) {
    const byEmail = await users.getUserByEmail(identity.email);
    if (byEmail && byEmail.role === "admin") return fail(`${kind}_link_admin`);
    if (byEmail) {
      // See "Linking Google" at the top: an unverified account is taken back,
      // with nothing its registrant set up surviving; a verified one is joined.
      let joined;
      try {
        joined = await users.joinProviderByEmail(byEmail.id, {
          kind, providerId: identity.id, email: identity.email, avatarUrl: identity.picture,
        });
      } catch (err) {
        if (err instanceof users.ProviderInUseError) return fail(`${kind}_in_use`);
        throw err;
      }
      if (!joined) return fail(`${kind}_failed`);
      account = joined.user;
      forgetUser(account.id);
    } else {
      if (!config.allowSignups) return fail("signups_closed");
      try {
        account = await users.createUser({
          email: identity.email, displayName: identity.name || identity.email.split("@")[0]!,
          ...(kind === "google" ? { googleSub: identity.id } : { githubId: identity.id }),
          avatarUrl: identity.picture, emailVerified: true,
        });
      } catch (err) {
        // A simultaneous first sign-in got there first; trying again finds it.
        if (err instanceof users.EmailTakenError) return fail(`${kind}_failed`);
        throw err;
      }
    }
  }

  const fresh = await users.getUser(account.id);
  if (!fresh) return fail(`${kind}_failed`);
  if (fresh.twoFactorEnabled) {
    setSessionCookies(reply, [
      clearOauthCookie(config.cookieSecure, cookiePath),
      pendingCookie(sealPendingSignIn(
        { userId: fresh.id, version: fresh.sessionVersion, method: kind }, config.sessionSecret,
      ), config.cookieSecure),
    ]);
    return reply.redirect(`/login?step=2fa&next=${encodeURIComponent(state.next)}`);
  }
  await noteSignIn(req, fresh.id, kind, false);
  setSessionCookies(reply, [
    clearOauthCookie(config.cookieSecure, cookiePath),
    clearPendingCookie(config.cookieSecure),
    sessionCookie(signUserSession(fresh.id, fresh.sessionVersion, config.sessionSecret), config.cookieSecure),
  ]);
  return reply.redirect(fresh.onboardedAt ? state.next : `/onboarding?next=${encodeURIComponent(state.next)}`);
}

/** For tests: the shape `/api/auth/me` returns for an account. */
export const publicUserForTest = publicUser;
