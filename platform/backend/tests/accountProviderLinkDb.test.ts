/**
 * Provider links (Google, GitHub) against the account-takeover defect A1, through
 * the real API and session gate against a real PostgreSQL. Both providers are
 * faked by replacing global fetch, as `accountSecurityDb.test.ts` does.
 *
 * A1: an unverified squatter linked their OWN GitHub from the squatted account;
 * the real owner's Google sign-in reclaimed the account but kept that GitHub id,
 * so the squatter could sign straight back in.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_provider_link`;
const ownUrl = new URL(base.toString());
ownUrl.pathname = `/${target}`;
process.env.DATABASE_URL = ownUrl.toString();

async function prepare(): Promise<string | null> {
  const maintenance = new URL(base.toString());
  maintenance.pathname = "/postgres";
  const admin = new Pool({ connectionString: maintenance.toString(), connectionTimeoutMillis: 2_000, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(target)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${JSON.stringify(target)}`);
    return null;
  } catch (error) {
    return `no local PostgreSQL (${(error as Error).message})`;
  } finally {
    await admin.end();
  }
}

type Res = { statusCode: number; body: string; headers: Record<string, unknown>; json: () => unknown };

test("provider links and the unverified-account reclaim", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { useEmailTransportForTests } = await import("../src/email/mailer");
  const { loginLimiter, twoFactorLimiter } = await import("../src/security/rateLimit");
  const { totpCode, totpStepAt } = await import("../src/security/twoFactor");
  const { hashPassword } = await import("../src/security/session");
  const { saveSubscription } = await import("../src/repositories/pushSubscriptions");
  const users = await import("../src/repositories/users");
  after(() => closePool());
  await migrate();

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    emailFrom: config.emailFrom, publicBaseUrl: config.publicBaseUrl, adminUsername: config.adminUsername,
    adminPasswordHash: config.adminPasswordHash, githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret, googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "provider-link-test-secret-0000000000000000", allowSignups: true,
    emailFrom: "no-reply@example.test", publicBaseUrl: "https://app.example.test",
    adminUsername: "owner", adminPasswordHash: hashPassword("owner password"),
    githubClientId: "gh-id", githubClientSecret: "gh-secret",
    googleClientId: "google-id", googleClientSecret: "google-secret",
  });
  t.after(() => { Object.assign(config, previous); useEmailTransportForTests(null); });

  const inbox: { to: string; text: string }[] = [];
  useEmailTransportForTests(async (message) => { inbox.push({ to: message.to, text: message.text }); });
  const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);

  // ── fake providers ─────────────────────────────────────────────────────────
  let github: { id: number; email: string; avatar?: string } = { id: 0, email: "" };
  let google: { sub: string; email: string; picture?: string } = { sub: "", email: "" };
  let tokenExchanges = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("github.com/login/oauth/access_token")) { tokenExchanges += 1; return Response.json({ access_token: "t" }); }
    if (u.endsWith("api.github.com/user")) return Response.json({ id: github.id, login: "octo", avatar_url: github.avatar });
    if (u.endsWith("api.github.com/user/emails")) return Response.json([{ email: github.email, primary: true, verified: true }]);
    if (u.includes("oauth2.googleapis.com/token")) {
      tokenExchanges += 1;
      const claims = { iss: "https://accounts.google.com", aud: "google-id", exp: Math.floor(Date.now() / 1000) + 600,
        sub: google.sub, email: google.email, email_verified: true, name: "Owner", picture: google.picture };
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return Response.json({ id_token: `${b64({ alg: "none" })}.${b64(claims)}.sig` });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  // ── helpers ────────────────────────────────────────────────────────────────
  const cookiesOf = (res: { headers: Record<string, unknown> }) => ([res.headers["set-cookie"]].flat().filter(Boolean) as string[]);
  const session = (res: { headers: Record<string, unknown> }) => {
    const found = cookiesOf(res).map((c) => /^srtrend_session=([^;]+)/.exec(c)?.[1]).find(Boolean);
    return found ? `srtrend_session=${found}` : null;
  };
  const pending = (res: { headers: Record<string, unknown> }) => {
    const found = cookiesOf(res).map((c) => /^srtrend_2fa=([^;]+)/.exec(c)?.[1]).find(Boolean);
    return found ? `srtrend_2fa=${found}` : null;
  };
  /** Who and which version a session cookie is for: `u2.<id>.<version>.<expiry>.<mac>`. */
  const claims = (cookie: string | null) => {
    if (!cookie) return null;
    const parts = cookie.replace(/^srtrend_session=/, "").split(".");
    return parts[0] === "u2" ? { id: parts[1]!, version: Number(parts[2]) } : null;
  };
  const call = (cookie: string | null, method: string, url: string, payload?: object): Promise<Res> => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: method as "POST", url, ...(cookie ? { headers: { cookie } } : {}), ...(payload ? { payload } : {}) }) as unknown as Promise<Res>;
  };
  const me = async (cookie: string) => (await call(cookie, "GET", "/api/auth/me")).json() as {
    authenticated: boolean; user: Record<string, unknown> | null };
  const signUp = async (email: string) => {
    const res = await call(null, "POST", "/api/auth/signup", { email, password: "correct horse battery" });
    assert.equal(res.statusCode, 201, res.body);
    return { cookie: session(res)!, id: (res.json() as { user: { id: string } }).user.id };
  };
  const verify = async (to: string) => {
    const mail = [...inbox].reverse().find((m) => m.to === to)!;
    const res = await call(null, "POST", "/api/auth/email/verify", { token: tokenFrom(mail.text) });
    assert.equal(res.statusCode, 200, res.body);
  };
  const verifiedUser = async (email: string) => { const u = await signUp(email); await verify(email); return u; };
  const row = async (id: string) => (await query<{
    password_hash: string | null; google_sub: string | null; github_id: string | null; avatar_url: string | null;
    email_verified_at: Date | null; totp_secret_enc: string | null; totp_enabled_at: Date | null;
    totp_last_step: number; session_version: number; email: string | null;
  }>("SELECT * FROM users WHERE id = $1", [id])).rows[0]!;
  const count = async (table: string, id: string) =>
    Number((await query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [id])).rows[0]!.n);

  type Provider = "github" | "google";
  const begin = async (provider: Provider, cookie: string | null, mode?: "link") => {
    const res = await call(cookie, "GET", `/api/auth/${provider}/start?next=/chart${mode ? "&mode=link" : ""}`);
    assert.equal(res.statusCode, 302, res.body);
    const location = String(res.headers.location);
    const oauth = cookiesOf(res).map((c) => /^srtrend_oauth=([^;]+)/.exec(c)?.[1]).find(Boolean);
    return {
      res, location,
      state: location.startsWith("https://") ? new URL(location).searchParams.get("state") : null,
      oauth: oauth ? `srtrend_oauth=${oauth}` : null,
    };
  };
  const finish = (provider: Provider, started: { state: string | null; oauth: string | null }, cookie: string | null) => {
    assert.ok(started.state && started.oauth, "the start must have issued a state");
    const jar = [started.oauth, ...(cookie ? [cookie] : [])].join("; ");
    return call(jar, "GET", `/api/auth/${provider}/callback?code=c&state=${started.state}`);
  };
  /** A whole round trip. Link mode carries the session cookie both ways, as a browser would. */
  const oauth = async (provider: Provider, cookie: string | null, mode?: "link") =>
    finish(provider, await begin(provider, cookie, mode), mode ? cookie : null);
  const withSignupsClosed = async <T>(work: () => Promise<T>): Promise<T> => {
    config.allowSignups = false;
    try { return await work(); } finally { config.allowSignups = true; }
  };

  const nextCode = (secret: string) => totpCode(secret, totpStepAt(Date.now()) + 1);
  const enable2fa = async (cookie: string, id: string) => {
    twoFactorLimiter.reset(id);
    const setup = await call(cookie, "POST", "/api/auth/2fa/setup", { password: "correct horse battery" });
    assert.equal(setup.statusCode, 200, setup.body);
    const { secret } = setup.json() as { secret: string };
    const enabled = await call(cookie, "POST", "/api/auth/2fa/enable", { code: totpCode(secret, totpStepAt(Date.now())) });
    assert.equal(enabled.statusCode, 200, enabled.body);
    return secret;
  };

  // ── 1. A1 exactly, and its mirror ──────────────────────────────────────────

  await t.test("A1: a GitHub link made by an unverified squatter does not survive the owner's Google sign-in", async () => {
    const squatter = await signUp("victim1@example.com");
    github = { id: 900, email: "attacker@evil.test" };
    await oauth("github", squatter.cookie, "link");
    // An account poisoned before the fix already carries the link: make sure it does either way.
    await query("UPDATE users SET github_id = '900' WHERE id = $1", [squatter.id]);

    google = { sub: "google-sub-victim1", email: "victim1@example.com" };
    const owner = await oauth("google", null);
    const ownerCookie = session(owner);
    assert.ok(ownerCookie, owner.headers.location as string);
    assert.equal((await me(ownerCookie)).user?.id, squatter.id, "the owner has the account");
    const after = await row(squatter.id);
    assert.equal(after.github_id, null, "the squatter's GitHub id is gone");
    assert.equal(after.google_sub, "google-sub-victim1");
    assert.equal((await me(ownerCookie)).user?.githubLinked, false);

    github = { id: 900, email: "attacker@evil.test" };
    const back = await withSignupsClosed(() => oauth("github", null));
    assert.equal(session(back), null, "the attacker gets no session");
    assert.match(String(back.headers.location), /error=/);
    assert.equal((await row(squatter.id)).github_id, null);
  });

  await t.test("A1 mirror: a Google link made by an unverified squatter does not survive the owner's GitHub sign-in", async () => {
    const squatter = await signUp("victim1b@example.com");
    google = { sub: "google-sub-attacker", email: "attacker@evil.test" };
    await oauth("google", squatter.cookie, "link");
    await query("UPDATE users SET google_sub = 'google-sub-attacker' WHERE id = $1", [squatter.id]);

    github = { id: 911, email: "victim1b@example.com" };
    const owner = await oauth("github", null);
    const ownerCookie = session(owner);
    assert.ok(ownerCookie, owner.headers.location as string);
    assert.equal((await me(ownerCookie)).user?.id, squatter.id);
    const after = await row(squatter.id);
    assert.equal(after.google_sub, null, "the squatter's Google id is gone");
    assert.equal(after.github_id, "911");

    google = { sub: "google-sub-attacker", email: "attacker@evil.test" };
    const back = await withSignupsClosed(() => oauth("google", null));
    assert.equal(session(back), null, "the attacker gets no session");
    assert.equal((await row(squatter.id)).google_sub, null);
  });

  // ── 2. Everything the squatter set up goes ─────────────────────────────────

  await t.test("a reclaim clears password, 2FA, recovery codes, both providers, devices, links and avatar", async () => {
    const squatter = await signUp("victim2@example.com");
    const verificationMail = [...inbox].reverse().find((m) => m.to === "victim2@example.com")!;
    assert.equal((await call(squatter.cookie, "PATCH", "/api/auth/profile", { avatarUrl: "https://evil.test/track.png" })).statusCode, 200);
    await saveSubscription(squatter.id, { endpoint: "https://fcm.googleapis.com/fcm/send/squatter-phone", p256dh: "p", auth: "a" });
    await query(`UPDATE users SET google_sub = 'google-sub-squatter2', totp_secret_enc = 'enc:fake',
                   totp_enabled_at = now(), totp_last_step = 42 WHERE id = $1`, [squatter.id]);
    await query("INSERT INTO totp_recovery_codes (code_hash, user_id) VALUES ('rc-a', $1), ('rc-b', $1)", [squatter.id]);
    // With 2FA on, the squatter's password gives a pending proof; it must die too.
    const proofRes = await call(null, "POST", "/api/auth/login", { email: "victim2@example.com", password: "correct horse battery" });
    assert.equal((proofRes.json() as { twoFactorRequired?: boolean }).twoFactorRequired, true);
    const proof = pending(proofRes)!;
    const before = await row(squatter.id);

    github = { id: 501, email: "victim2@example.com", avatar: "https://avatars.githubusercontent.com/u/501" };
    const owner = await oauth("github", null);
    const ownerCookie = session(owner);
    assert.ok(ownerCookie, owner.headers.location as string);

    const after = await row(squatter.id);
    assert.equal(after.password_hash, null, "password");
    assert.equal(after.totp_secret_enc, null, "TOTP secret");
    assert.equal(after.totp_enabled_at, null, "TOTP enabled");
    assert.equal(Number(after.totp_last_step), 0, "TOTP step");
    assert.equal(after.google_sub, null, "the other provider");
    assert.equal(after.github_id, "501", "the provider in use");
    assert.equal(after.avatar_url, "https://avatars.githubusercontent.com/u/501", "the squatter's avatar");
    assert.ok(after.email_verified_at, "verified");
    assert.ok(after.session_version > before.session_version, "sessions revoked");
    assert.equal(await count("totp_recovery_codes", squatter.id), 0, "recovery codes");
    assert.equal(await count("push_subscriptions", squatter.id), 0, "push devices");
    assert.equal(await count("email_verification_tokens", squatter.id), 0, "verification links");

    assert.equal((await call(squatter.cookie, "GET", "/api/watchlists")).statusCode, 401, "the squatter's session");
    assert.equal((await call(proof, "POST", "/api/auth/2fa/login", { code: "123456" })).statusCode, 401, "the pending proof");
    assert.equal((await call(null, "POST", "/api/auth/login", { email: "victim2@example.com", password: "correct horse battery" })).statusCode, 401);
    assert.equal((await call(null, "POST", "/api/auth/email/verify", { token: tokenFrom(verificationMail.text) })).statusCode, 400,
      "the squatter's verification link is dead");
    assert.equal((await me(ownerCookie)).user?.id, squatter.id);
  });

  // ── 3. Link mode needs a verified email ────────────────────────────────────

  await t.test("link mode is refused for an unverified account unless the provider proves the same address", async () => {
    const u = await signUp("unverified3@example.com");
    const logins = await count("login_events", u.id);

    github = { id: 300, email: "someone-else@example.com" };
    const refused = await oauth("github", u.cookie, "link");
    assert.equal(refused.statusCode, 302);
    assert.match(String(refused.headers.location), /^\/login\?error=github_link_unverified/);
    assert.equal((await row(u.id)).github_id, null, "not linked");
    assert.equal(await count("login_events", u.id), logins, "no sign-in was recorded");
    assert.equal((await row(u.id)).email_verified_at, null, "still unverified");

    google = { sub: "google-sub-other3", email: "someone-else@example.com" };
    const refusedGoogle = await oauth("google", u.cookie, "link");
    assert.match(String(refusedGoogle.headers.location), /^\/login\?error=google_link_unverified/);
    assert.equal((await row(u.id)).google_sub, null, "not linked");

    // The provider proves this very address: linking works and verifies it.
    github = { id: 301, email: "unverified3@example.com" };
    const linked = await oauth("github", u.cookie, "link");
    assert.equal(linked.statusCode, 302);
    assert.doesNotMatch(String(linked.headers.location), /error=/);
    const after = await row(u.id);
    assert.equal(after.github_id, "301");
    assert.ok(after.email_verified_at, "the matching provider email verifies the account");
    assert.equal(await count("login_events", u.id), logins, "linking is not a sign-in");
    assert.equal((await me(u.cookie)).user?.githubLinked, true, "the existing session carries on");

    // The administrator has no email and links as before.
    const adminCookie = session(await call(null, "POST", "/api/auth/login", { username: "owner", password: "owner password" }))!;
    github = { id: 777, email: "admin-gh@example.com" };
    const adminLinked = await oauth("github", adminCookie, "link");
    assert.doesNotMatch(String(adminLinked.headers.location), /error=/);
    assert.equal((await row(users.ADMIN_USER_ID)).github_id, "777");
    await query("UPDATE users SET github_id = NULL WHERE id = $1", [users.ADMIN_USER_ID]);
  });

  // ── 4. A held link state needs the same live session ───────────────────────

  await t.test("a held link state is refused without the same live session at the same version", async () => {
    const v = await verifiedUser("holder4@example.com");
    const w = await verifiedUser("other4@example.com");
    github = { id: 400, email: "holder4-gh@example.com" };

    // No session at all.
    const noSession = await finish("github", await begin("github", v.cookie, "link"), null);
    assert.match(String(noSession.headers.location), /error=/);
    assert.equal(session(noSession), null, "no session");
    assert.equal((await row(v.id)).github_id, null);

    // Somebody else's session.
    const otherSession = await finish("github", await begin("github", v.cookie, "link"), w.cookie);
    assert.match(String(otherSession.headers.location), /error=/);
    assert.notEqual(claims(session(otherSession))?.id, v.id, "no session for the account in the state");
    assert.equal((await row(v.id)).github_id, null);
    assert.equal((await row(w.id)).github_id, null);

    // A session that has since changed version (here: a password change).
    const held = await begin("github", v.cookie, "link");
    const changed = await call(v.cookie, "POST", "/api/auth/password",
      { currentPassword: "correct horse battery", newPassword: "another horse battery" });
    assert.equal(changed.statusCode, 200, changed.body);
    const newCookie = session(changed)!;
    const stale = await finish("github", held, newCookie);
    assert.match(String(stale.headers.location), /error=/);
    assert.equal((await row(v.id)).github_id, null, "a state from an older session version is refused");

    // After signing out everywhere.
    const heldAgain = await begin("github", newCookie, "link");
    assert.equal((await call(newCookie, "POST", "/api/auth/logout-all")).statusCode, 200);
    const afterLogout = await finish("github", heldAgain, newCookie);
    assert.match(String(afterLogout.headers.location), /error=/);
    assert.equal(session(afterLogout), null, "no session after sign-out-everywhere");
    assert.equal((await row(v.id)).github_id, null);

    // The same live session works, and keeps that session rather than minting one.
    const fresh = session(await call(null, "POST", "/api/auth/login", { email: "holder4@example.com", password: "another horse battery" }))!;
    const before = claims(fresh)!;
    const ok = await oauth("github", fresh, "link");
    assert.doesNotMatch(String(ok.headers.location), /error=/);
    assert.equal((await row(v.id)).github_id, "400");
    const issued = claims(session(ok));
    if (issued) assert.deepEqual(issued, before, "only the existing session, renewed");
    assert.equal((await me(fresh)).user?.githubLinked, true);
  });

  // ── 5. A verified user keeps both links ────────────────────────────────────

  await t.test("a verified user who linked GitHub keeps both links when signing in with Google", async () => {
    const k = await verifiedUser("keeper5@example.com");
    github = { id: 500, email: "keeper5-gh@example.com" };
    await oauth("github", k.cookie, "link");
    assert.equal((await row(k.id)).github_id, "500");

    google = { sub: "google-sub-keeper5", email: "keeper5@example.com" };
    const g = await oauth("google", null);
    assert.equal((await me(session(g)!)).user?.id, k.id);
    const after = await row(k.id);
    assert.equal(after.github_id, "500");
    assert.equal(after.google_sub, "google-sub-keeper5");
    assert.ok(after.password_hash, "a verified account keeps its password");
    assert.equal((await call(null, "POST", "/api/auth/login", { email: "keeper5@example.com", password: "correct horse battery" })).statusCode, 200);
    github = { id: 500, email: "keeper5-gh@example.com" };
    assert.equal((await me(session(await oauth("github", null))!)).user?.id, k.id);
  });

  // ── 6. Never merge two people ──────────────────────────────────────────────

  await t.test("two unrelated verified people are never merged, a case-variant email included", async () => {
    const alice = await verifiedUser("alice6@example.com");
    const bob = await verifiedUser("bob6@example.com");

    // A case variant of an existing address is the same address: no second account.
    assert.equal((await call(null, "POST", "/api/auth/signup", { email: "Alice6@EXAMPLE.com", password: "correct horse battery" })).statusCode, 409);
    // A different address (a dot) is a different person.
    github = { id: 600, email: "alice.6@example.com" };
    const other = await oauth("github", null);
    const otherId = (await me(session(other)!)).user?.id;
    assert.ok(otherId);
    assert.notEqual(otherId, alice.id);
    assert.notEqual(otherId, bob.id);

    // Alice links a GitHub account whose email is Bob's: only Alice gets it.
    github = { id: 601, email: "BOB6@example.com" };
    await oauth("github", alice.cookie, "link");
    assert.equal((await row(alice.id)).github_id, "601");
    assert.equal((await row(bob.id)).github_id, null);
    assert.equal((await me(session(await oauth("github", null))!)).user?.id, alice.id);

    // Bob can't take that GitHub id.
    const taken = await oauth("github", bob.cookie, "link");
    assert.match(String(taken.headers.location), /error=github_in_use/);
    assert.equal((await row(bob.id)).github_id, null);
    assert.equal((await row(alice.id)).github_id, "601");
  });

  // ── 7. Replays ─────────────────────────────────────────────────────────────

  await t.test("a duplicate callback or a replayed state is refused", async () => {
    const r = await verifiedUser("replay7@example.com");
    github = { id: 700, email: "replay7@example.com" };
    const started = await begin("github", null);
    const first = await finish("github", started, null);
    assert.ok(session(first), first.headers.location as string);
    const exchanges = tokenExchanges;
    const second = await finish("github", started, null);
    assert.equal(session(second), null, "a replayed sign-in gets no session");
    assert.match(String(second.headers.location), /error=github_expired/);
    assert.equal(tokenExchanges, exchanges, "the replay never reaches the provider");

    google = { sub: "google-sub-replay7", email: "replay7-google@example.com" };
    const link = await begin("google", r.cookie, "link");
    await finish("google", link, r.cookie);
    assert.equal((await row(r.id)).google_sub, "google-sub-replay7");
    await query("UPDATE users SET google_sub = NULL WHERE id = $1", [r.id]);
    const replayedLink = await finish("google", link, r.cookie);
    assert.match(String(replayedLink.headers.location), /error=google_expired/);
    assert.equal((await row(r.id)).google_sub, null, "a replayed link does nothing");
  });

  // ── 8. Two-factor ──────────────────────────────────────────────────────────

  await t.test("a provider sign-in to a 2FA account still asks for the code; linking mints no session", async () => {
    const f = await verifiedUser("factor8@example.com");
    const secret = await enable2fa(f.cookie, f.id);

    github = { id: 800, email: "factor8-gh@example.com" };
    const logins = await count("login_events", f.id);
    const linked = await oauth("github", f.cookie, "link");
    assert.doesNotMatch(String(linked.headers.location), /error=/);
    assert.equal((await row(f.id)).github_id, "800");
    const issued = claims(session(linked));
    if (issued) assert.deepEqual(issued, claims(f.cookie), "only the existing session, renewed");
    assert.equal(await count("login_events", f.id), logins, "linking is not a sign-in");

    const byId = await oauth("github", null);
    assert.match(String(byId.headers.location), /^\/login\?step=2fa/);
    assert.equal(session(byId), null);

    google = { sub: "google-sub-factor8", email: "factor8@example.com" };
    const byEmail = await oauth("google", null);
    assert.match(String(byEmail.headers.location), /^\/login\?step=2fa/);
    assert.equal(session(byEmail), null);
    twoFactorLimiter.reset(f.id);
    const done = await call(pending(byEmail), "POST", "/api/auth/2fa/login", { code: nextCode(secret) });
    assert.equal(done.statusCode, 200, done.body);
  });

  // ── 9. Atomic reclaim ──────────────────────────────────────────────────────

  await t.test("a reclaim that hits a unique conflict rolls back completely", async () => {
    const x = await verifiedUser("holder9@example.com");
    await query("UPDATE users SET github_id = 'gh-900-taken' WHERE id = $1", [x.id]);
    const y = await signUp("victim9@example.com");
    await query("UPDATE users SET google_sub = 'google-sub-y9', totp_secret_enc = 'enc:y', totp_enabled_at = now() WHERE id = $1", [y.id]);
    await saveSubscription(y.id, { endpoint: "https://fcm.googleapis.com/fcm/send/y9", p256dh: "p", auth: "a" });
    const before = await row(y.id);

    const join = (users as unknown as Record<string, unknown>).joinProviderByEmail as
      ((id: string, input: object) => Promise<unknown>) | undefined;
    assert.equal(typeof join, "function", "users.joinProviderByEmail exists");
    await assert.rejects(join!(y.id, { kind: "github", providerId: "gh-900-taken", email: "victim9@example.com", avatarUrl: null }),
      (err: Error) => err.name === "ProviderInUseError" || err.constructor.name === "ProviderInUseError");
    assert.deepEqual(await row(y.id), before, "nothing changed on the account");
    assert.equal(await count("push_subscriptions", y.id), 1);
    assert.equal((await row(x.id)).github_id, "gh-900-taken");
  });

  // ── 10. Password change is compare-and-set ─────────────────────────────────

  await t.test("a password change under a session version that has moved on is refused with 401", async () => {
    const p = await signUp("stale10@example.com");
    // Warm the gate's short cache, then move the version on underneath it: the
    // window a concurrent reclaim or sign-out-everywhere lands in mid-request.
    assert.equal((await me(p.cookie)).authenticated, true);
    await query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [p.id]);
    const before = await row(p.id);
    const res = await call(p.cookie, "POST", "/api/auth/password",
      { currentPassword: "correct horse battery", newPassword: "squatter keeps this" });
    assert.equal(res.statusCode, 401, res.body);
    const issued = claims(session(res));
    assert.ok(!issued || issued.version < before.session_version, "no session at the current version");
    const after = await row(p.id);
    assert.equal(after.password_hash, before.password_hash, "the password is unchanged");
    assert.equal(after.session_version, before.session_version);

    const cas = (users as unknown as Record<string, unknown>).setPasswordIfCurrent as
      ((id: string, input: object) => Promise<number | null>) | undefined;
    assert.equal(typeof cas, "function", "users.setPasswordIfCurrent exists");
    assert.equal(await cas!(p.id, { expectedVersion: after.session_version, expectedHash: "scrypt$00$00", newHash: hashPassword("x".repeat(9)) }), null,
      "a hash that changed underneath is refused");
    assert.equal((await row(p.id)).password_hash, before.password_hash);
  });

  // ── 11. The owner after a reclaim ──────────────────────────────────────────

  await t.test("the legitimate owner can sign in and use the account after a reclaim", async () => {
    const squatter = await signUp("victim11@example.com");
    await query("UPDATE users SET github_id = '1100' WHERE id = $1", [squatter.id]);
    google = { sub: "google-sub-victim11", email: "victim11@example.com" };
    const owner = session(await oauth("google", null))!;
    assert.ok(owner);
    assert.equal((await call(owner, "GET", "/api/watchlists")).statusCode, 200);
    const pw = await call(owner, "POST", "/api/auth/password", { newPassword: "owner's own password" });
    assert.equal(pw.statusCode, 200, pw.body);
    const afterPw = session(pw)!;
    assert.equal((await me(afterPw)).user?.hasPassword, true);
    assert.equal((await call(null, "POST", "/api/auth/login", { email: "victim11@example.com", password: "owner's own password" })).statusCode, 200);
    const again = await oauth("google", null);
    assert.equal((await me(session(again)!)).user?.id, squatter.id);
    // Verified now, so the owner can protect the account with two-factor.
    twoFactorLimiter.reset(squatter.id);
    const setup = await call(afterPw, "POST", "/api/auth/2fa/setup", { password: "owner's own password" });
    assert.equal(setup.statusCode, 200, setup.body);
  });
});
