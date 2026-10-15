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
 * A Google sign-in whose verified email matches an existing PASSWORD account
 * joins that account — and drops its password. Emails are not verified at
 * password sign-up, so someone could register a victim's address first and
 * wait; when the victim later signs in with Google, the password the squatter
 * knows must stop working, and every session issued under it is revoked. The
 * owner sets a new password from their profile if they want one.
 *
 * The admin is never joined by email: linking Google to it takes an explicit
 * "Link Google" from a signed-in admin session.
 *
 * ── Sessions ───────────────────────────────────────────────────────────────
 *
 * A 90-day signed cookie naming the account and its session version
 * (`security/session`). Every authenticated request slides the expiry, so an
 * actively used browser is never signed out; "sign out everywhere" bumps the
 * version and every other session ends at its next request.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config";
import { clientKey, loginLimiter } from "../../security/rateLimit";
import {
  clearCookie, hashPassword, readCookie, safeEqual, sessionCookie,
  signUserSession, verifyPassword, verifySession, verifyUserSession,
} from "../../security/session";
import {
  GoogleSignInError, OAUTH_COOKIE, authorizeUrl, clearOauthCookie, exchangeCode,
  newOAuthState, oauthCookie, openState, safeNext, sealState,
} from "../../security/google";
import {
  forgetUser, loadRequestUser, userIdOf, type RequestUser,
} from "../../security/requestUser";
import * as users from "../../repositories/users";
import * as watchlists from "../../repositories/watchlists";
import { cleanSymbols } from "./watchlists";

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
function setSessionCookies(reply: FastifyReply, cookies: string | string[]): void {
  reply.removeHeader("set-cookie");
  reply.header("set-cookie", cookies);
}

function startSession(reply: FastifyReply, user: { id: string; sessionVersion: number }): void {
  setSessionCookies(reply,
    sessionCookie(signUserSession(user.id, user.sessionVersion, config.sessionSecret), config.cookieSecure));
}

/** What the browser is told about an account — never the hash, never the Google id. */
function publicUser(u: users.UserRow) {
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
    createdAt: u.createdAt,
  };
}

const googleEnabled = (): boolean =>
  !!config.googleClientId && !!config.googleClientSecret && !!config.publicBaseUrl;

const redirectUri = (): string => `${config.publicBaseUrl}/api/auth/google/callback`;

function cleanDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s+/g, " ").trim();
  if (v.length === 0 || v.length > 80) return null;
  return v;
}

async function checkPassword(password: string, hash: string): Promise<boolean | "busy"> {
  if (activePasswordChecks >= MAX_PASSWORD_CHECKS) return "busy";
  activePasswordChecks++;
  try { return await verifyPassword(password, hash); }
  finally { activePasswordChecks--; }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Who is signed in, and which ways in this instance offers. */
  app.get("/api/auth/me", async (req) => {
    const providers = { google: googleEnabled(), signups: config.allowSignups };
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
      if (ok === true && nameOk) account = await users.getUser(users.ADMIN_USER_ID);
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
    await users.markLogin(account.id);
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
      startSession(reply, account);
      return reply.code(201).send({ ok: true, user: publicUser(account) });
    } catch (err) {
      if (err instanceof users.EmailTakenError) {
        return reply.code(409).send({ error: "An account with this email already exists. Sign in instead." });
      }
      throw err;
    }
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    setSessionCookies(reply, clearCookie(config.cookieSecure));
    return { ok: true };
  });

  /** End every session of this account, this one included. */
  app.post("/api/auth/logout-all", async (req, reply) => {
    const id = userIdOf(req);
    await users.bumpSessionVersion(id);
    forgetUser(id);
    setSessionCookies(reply, clearCookie(config.cookieSecure));
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
    const current = await users.getPasswordHash(id);
    if (current) {
      if (typeof body.currentPassword !== "string") {
        return reply.code(400).send({ error: "Enter your current password." });
      }
      const ok = await checkPassword(body.currentPassword, current);
      if (ok === "busy") return reply.code(429).send({ error: "Busy. Try again shortly." });
      if (!ok) return reply.code(401).send({ error: "Your current password is not correct." });
    }
    await users.setPasswordHash(id, hashPassword(body.newPassword));
    // Every other session ends; this one is re-issued under the new version.
    const version = await users.bumpSessionVersion(id);
    forgetUser(id);
    startSession(reply, { id, sessionVersion: version });
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

  /** Delete this account and everything it owns. The admin cannot be deleted. */
  app.delete("/api/auth/account", async (req, reply) => {
    const id = userIdOf(req);
    const body = (req.body ?? {}) as { confirm?: unknown };
    if (body.confirm !== "DELETE") {
      return reply.code(400).send({ error: 'Type DELETE to confirm.' });
    }
    if (id === users.ADMIN_USER_ID) {
      return reply.code(400).send({ error: "The administrator account cannot be deleted." });
    }
    const ok = await users.deleteUser(id);
    forgetUser(id);
    if (!ok) return reply.code(404).send({ error: "account not found" });
    setSessionCookies(reply, clearCookie(config.cookieSecure));
    return { ok: true };
  });

  // ── Google ───────────────────────────────────────────────────────────────

  app.get("/api/auth/google/start", async (req, reply) => {
    if (!googleEnabled()) return reply.code(404).send({ error: "Google sign-in is not configured" });
    const q = req.query as { next?: string; mode?: string };
    // Linking needs the account it links to; signing in must not have one.
    const linkUserId = q.mode === "link" ? req.user?.id ?? null : null;
    if (q.mode === "link" && !linkUserId) return reply.redirect("/login?error=signin_required");
    const state = newOAuthState(safeNext(q.next, linkUserId ? "/profile" : "/chart"), linkUserId);
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
    if (!state || typeof q.state !== "string" || !safeEqual(q.state, state.state) || typeof q.code !== "string") {
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

    let account = await users.getUserByGoogleSub(identity.sub);

    if (state.linkUserId) {
      // Explicit linking from a signed-in session.
      if (account && account.id !== state.linkUserId) return fail("google_in_use");
      if (!account) account = await users.linkGoogle(state.linkUserId, identity.sub, identity.picture);
      forgetUser(account.id);
    } else if (!account) {
      const byEmail = await users.getUserByEmail(identity.email);
      if (byEmail && byEmail.role === "admin") return fail("google_link_admin");
      if (byEmail) {
        // See "Linking Google" at the top: the unverified password goes.
        await users.setPasswordHash(byEmail.id, null);
        await users.bumpSessionVersion(byEmail.id);
        account = await users.linkGoogle(byEmail.id, identity.sub, identity.picture);
        forgetUser(account.id);
      } else {
        if (!config.allowSignups) return fail("signups_closed");
        account = await users.createUser({
          email: identity.email, displayName: identity.name || identity.email.split("@")[0]!,
          googleSub: identity.sub, avatarUrl: identity.picture,
        });
      }
    }

    await users.markLogin(account.id);
    const fresh = await users.getUser(account.id);
    if (!fresh) return fail("google_failed");
    setSessionCookies(reply, [
      clearOauthCookie(config.cookieSecure),
      sessionCookie(signUserSession(fresh.id, fresh.sessionVersion, config.sessionSecret), config.cookieSecure),
    ]);
    return reply.redirect(fresh.onboardedAt ? state.next : `/onboarding?next=${encodeURIComponent(state.next)}`);
  });
}

/** For tests: the shape `/api/auth/me` returns for an account. */
export const publicUserForTest = publicUser;
