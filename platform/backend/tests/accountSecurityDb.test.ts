/**
 * Email verification, two-factor sign-in and sign-in history, through the real
 * API and session gate against a real PostgreSQL, with email captured in memory.
 *
 * Runs in its OWN database, for the reason `accountsDb.test.ts` gives.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const base = new URL(process.env.DATABASE_URL ?? "postgres://platform:platform@127.0.0.1:5433/platform_test");
const target = `${base.pathname.replace(/^\//, "") || "platform_test"}_account_security`;
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

test("account security", async (t) => {
  const skip = await prepare();
  if (skip && !process.env.CI) { t.skip(skip); return; }
  assert.equal(skip, null, skip ?? "");

  const { migrate } = await import("../src/db/migrate");
  const { closePool, query } = await import("../src/db/pool");
  const { config } = await import("../src/config");
  const { buildServer } = await import("../src/api/server");
  const { useEmailTransportForTests } = await import("../src/email/mailer");
  const { loginLimiter, twoFactorLimiter, verificationEmailLimiter } = await import("../src/security/rateLimit");
  const { totpCode, totpStepAt } = await import("../src/security/twoFactor");
  const { hashPassword } = await import("../src/security/session");
  const { ADMIN_USER_ID } = await import("../src/repositories/users");
  after(() => closePool());
  await migrate();

  const previous = {
    authEnabled: config.authEnabled, sessionSecret: config.sessionSecret, allowSignups: config.allowSignups,
    emailFrom: config.emailFrom, publicBaseUrl: config.publicBaseUrl, adminUsername: config.adminUsername,
    adminPasswordHash: config.adminPasswordHash, githubClientId: config.githubClientId, githubClientSecret: config.githubClientSecret,
  };
  Object.assign(config, {
    authEnabled: true, sessionSecret: "account-security-test-secret-0000000000000", allowSignups: true,
    emailFrom: "no-reply@example.test", publicBaseUrl: "https://app.example.test",
    adminUsername: "owner", adminPasswordHash: hashPassword("owner password"),
  });
  t.after(() => { Object.assign(config, previous); useEmailTransportForTests(null); });

  const inbox: { to: string; text: string }[] = [];
  let mailFails = false;
  useEmailTransportForTests(async (message) => {
    if (mailFails) throw new Error("ses down");
    inbox.push({ to: message.to, text: message.text });
  });
  const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);

  const app = buildServer(() => ({} as never));
  t.after(() => app.close());

  const cookiesOf = (res: { headers: Record<string, unknown> }) => ([res.headers["set-cookie"]].flat().filter(Boolean) as string[]);
  const session = (res: { headers: Record<string, unknown> }) => {
    const found = cookiesOf(res).map((c) => /^srtrend_session=([^;]+)/.exec(c)?.[1]).find(Boolean);
    return found ? `srtrend_session=${found}` : null;
  };
  const pending = (res: { headers: Record<string, unknown> }) => {
    const found = cookiesOf(res).map((c) => /^srtrend_2fa=([^;]+)/.exec(c)?.[1]).find(Boolean);
    return found ? `srtrend_2fa=${found}` : null;
  };
  const call = (cookie: string | null, method: string, url: string, payload?: object) => {
    loginLimiter.reset("127.0.0.1");
    return app.inject({ method: method as "POST", url, ...(cookie ? { headers: { cookie } } : {}), ...(payload ? { payload } : {}) });
  };
  const signUp = async (email: string) => {
    const res = await call(null, "POST", "/api/auth/signup", { email, password: "correct horse battery" });
    assert.equal(res.statusCode, 201, res.body);
    return { cookie: session(res)!, body: res.json() as { verificationEmail: string; user: Record<string, unknown> } };
  };
  const verify = async (to: string) => {
    const mail = [...inbox].reverse().find((m) => m.to === to)!;
    assert.equal((await call(null, "POST", "/api/auth/email/verify", { token: tokenFrom(mail.text) })).statusCode, 200);
  };
  const me = async (cookie: string) => (await call(cookie, "GET", "/api/auth/me")).json().user as Record<string, unknown>;

  // Setup uses the current step, so the next code that can work is one step on.
  const nextCode = (secret: string) => totpCode(secret, totpStepAt(Date.now()) + 1);
  const enable2fa = async (cookie: string, password = "correct horse battery") => {
    const setup = await call(cookie, "POST", "/api/auth/2fa/setup", { password });
    assert.equal(setup.statusCode, 200, setup.body);
    const { secret, qrDataUrl } = setup.json() as { secret: string; qrDataUrl: string };
    assert.match(qrDataUrl, /^data:image\/png;base64,/);
    const enabled = await call(cookie, "POST", "/api/auth/2fa/enable", { code: totpCode(secret, totpStepAt(Date.now())) });
    assert.equal(enabled.statusCode, 200, enabled.body);
    // OD-2: turning it on ends every other session and re-issues this one.
    const renewed = session(enabled);
    assert.ok(renewed, "enabling two-factor re-issues this session");
    assert.equal((await call(cookie, "GET", "/api/watchlists")).statusCode, 401, "the session from before is over");
    return { secret, recoveryCodes: (enabled.json() as { recoveryCodes: string[] }).recoveryCodes, cookie: renewed };
  };

  await t.test("signing up sends a link, and using it verifies the account once", async () => {
    const { cookie, body } = await signUp("verify@example.com");
    assert.equal(body.verificationEmail, "sent");
    assert.equal(body.user.emailVerified, false);
    const mail = inbox.find((m) => m.to === "verify@example.com")!;
    assert.match(mail.text, /https:\/\/app\.example\.test\/verify-email\?token=/);
    const token = tokenFrom(mail.text);
    const stored = await query<{ token_hash: string }>("SELECT token_hash FROM email_verification_tokens");
    assert.ok(stored.rows.every((r) => r.token_hash !== token), "the raw token must not be stored");
    assert.equal((await call(null, "POST", "/api/auth/email/verify", { token })).statusCode, 200);
    assert.equal((await me(cookie)).emailVerified, true);
    assert.equal((await call(null, "POST", "/api/auth/email/verify", { token })).statusCode, 400, "single use");
  });

  await t.test("bad and expired links are refused", async () => {
    const { cookie } = await signUp("expired@example.com");
    assert.equal((await call(null, "POST", "/api/auth/email/verify", { token: "nope" })).statusCode, 400);
    assert.equal((await call(null, "POST", "/api/auth/email/verify", {})).statusCode, 400);
    await query("UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'");
    const mail = inbox.find((m) => m.to === "expired@example.com")!;
    assert.equal((await call(null, "POST", "/api/auth/email/verify", { token: tokenFrom(mail.text) })).statusCode, 400);
    assert.equal((await me(cookie)).emailVerified, false);
  });

  await t.test("resending replaces the old link and is limited", async () => {
    const { cookie } = await signUp("resend@example.com");
    const first = tokenFrom(inbox.find((m) => m.to === "resend@example.com")!.text);
    verificationEmailLimiter.reset((await me(cookie)).id as string);
    assert.equal((await call(cookie, "POST", "/api/auth/email/resend")).statusCode, 200);
    assert.equal((await call(null, "POST", "/api/auth/email/verify", { token: first })).statusCode, 400);
    await call(cookie, "POST", "/api/auth/email/resend");
    await call(cookie, "POST", "/api/auth/email/resend");
    assert.equal((await call(cookie, "POST", "/api/auth/email/resend")).statusCode, 429);
  });

  await t.test("email failing or unset never loses the sign-up, and says so", async () => {
    mailFails = true;
    const failed = await signUp("mailfail@example.com");
    mailFails = false;
    assert.equal(failed.body.verificationEmail, "unavailable");
    config.emailFrom = "";
    const unset = await signUp("nomail@example.com");
    assert.equal(unset.body.verificationEmail, "unavailable");
    assert.equal((await call(unset.cookie, "POST", "/api/auth/email/resend")).statusCode, 503);
    config.emailFrom = "no-reply@example.test";
  });

  await t.test("2FA needs a verified email and the password", async () => {
    const { cookie } = await signUp("need@example.com");
    assert.equal((await call(cookie, "POST", "/api/auth/2fa/setup", { password: "correct horse battery" })).statusCode, 403);
    await verify("need@example.com");
    assert.equal((await call(cookie, "POST", "/api/auth/2fa/setup", { password: "wrong" })).statusCode, 400);
    assert.equal((await call(cookie, "POST", "/api/auth/2fa/setup", {})).statusCode, 400);
  });

  await t.test("the secret is encrypted at rest, and a pending setup doesn't turn anything on", async () => {
    const { cookie } = await signUp("store@example.com");
    await verify("store@example.com");
    const setup = await call(cookie, "POST", "/api/auth/2fa/setup", { password: "correct horse battery" });
    const { secret } = setup.json() as { secret: string };
    const row = await query<{ totp_secret_enc: string }>("SELECT totp_secret_enc FROM users WHERE email = 'store@example.com'");
    assert.ok(row.rows[0]!.totp_secret_enc.startsWith("enc:"));
    assert.ok(!row.rows[0]!.totp_secret_enc.includes(secret));
    assert.equal((await me(cookie)).twoFactorEnabled, false);
    assert.equal(session(await call(null, "POST", "/api/auth/login", { email: "store@example.com", password: "correct horse battery" })) !== null, true);
    assert.equal((await call(cookie, "POST", "/api/auth/2fa/enable", { code: "000000" })).statusCode, 400);
  });

  await t.test("with 2FA on, a correct password gives no session until the code", async () => {
    let { cookie } = await signUp("two@example.com");
    await verify("two@example.com");
    const { secret, recoveryCodes, cookie: renewed } = await enable2fa(cookie);
    cookie = renewed;
    assert.equal(recoveryCodes.length, 10);
    const id = (await me(cookie)).id as string;
    assert.equal((await me(cookie)).moneyFeaturesUnlocked, true);

    const first = await call(null, "POST", "/api/auth/login", { email: "two@example.com", password: "correct horse battery" });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().twoFactorRequired, true);
    assert.equal(first.json().user, undefined, "no account details before the second factor");
    assert.equal(session(first), null);
    const proof = pending(first)!;
    assert.ok(proof);
    // The proof isn't a session.
    assert.equal((await call(proof, "GET", "/api/watchlists")).statusCode, 401);

    twoFactorLimiter.reset(id);
    assert.equal((await call(proof, "POST", "/api/auth/2fa/login", { code: "000000" })).statusCode, 401);
    assert.equal((await call(null, "POST", "/api/auth/2fa/login", { code: nextCode(secret) })).statusCode, 401, "no proof");

    const code = nextCode(secret);
    const passed = await call(proof, "POST", "/api/auth/2fa/login", { code });
    if (passed.statusCode !== 200) assert.fail(passed.body);
    const fresh = session(passed)!;
    assert.ok(fresh);
    assert.ok(cookiesOf(passed).some((c) => /^srtrend_2fa=;/.test(c)), "the proof is cleared");
    assert.equal((await me(fresh)).email, "two@example.com");
    assert.equal((await call(proof, "POST", "/api/auth/2fa/login", { code })).statusCode, 401, "a code works once");
  });

  await t.test("guessing is limited per account, whatever the address", async () => {
    let { cookie } = await signUp("guess@example.com");
    await verify("guess@example.com");
    const { secret, cookie: renewed } = await enable2fa(cookie);
    cookie = renewed;
    const id = (await me(cookie)).id as string;
    twoFactorLimiter.reset(id);
    const proof = pending(await call(null, "POST", "/api/auth/login", { email: "guess@example.com", password: "correct horse battery" }))!;
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await call(proof, "POST", "/api/auth/2fa/login", { code: "000000" })).statusCode, 401);
    }
    const blocked = await call(proof, "POST", "/api/auth/2fa/login", { code: nextCode(secret) });
    assert.equal(blocked.statusCode, 429);
  });

  await t.test("a recovery code signs in once", async () => {
    const { cookie } = await signUp("recover@example.com");
    await verify("recover@example.com");
    const { recoveryCodes } = await enable2fa(cookie);
    const login = () => call(null, "POST", "/api/auth/login", { email: "recover@example.com", password: "correct horse battery" });
    const ok = await call(pending(await login()), "POST", "/api/auth/2fa/login", { recoveryCode: recoveryCodes[0]!.toLowerCase() });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await call(pending(await login()), "POST", "/api/auth/2fa/login", { recoveryCode: recoveryCodes[0] })).statusCode, 401);
    const status = await call(session(ok), "GET", "/api/auth/2fa/status");
    assert.equal(status.json().recoveryCodesLeft, 9);
  });

  await t.test("another account's recovery code does nothing", async () => {
    const a = await signUp("codes-a@example.com"); await verify("codes-a@example.com");
    const b = await signUp("codes-b@example.com"); await verify("codes-b@example.com");
    const { recoveryCodes } = await enable2fa(a.cookie);
    await enable2fa(b.cookie);
    const proof = pending(await call(null, "POST", "/api/auth/login", { email: "codes-b@example.com", password: "correct horse battery" }));
    assert.equal((await call(proof, "POST", "/api/auth/2fa/login", { recoveryCode: recoveryCodes[1] })).statusCode, 401);
  });

  await t.test("turning 2FA off takes both factors and ends other sessions", async () => {
    let { cookie } = await signUp("off@example.com");
    await verify("off@example.com");
    const { secret, cookie: renewed } = await enable2fa(cookie);
    cookie = renewed;
    const code = () => nextCode(secret);
    assert.equal((await call(cookie, "POST", "/api/auth/2fa/disable", { password: "wrong", code: code() })).statusCode, 400);
    assert.equal((await call(cookie, "POST", "/api/auth/2fa/disable", { password: "correct horse battery", code: "000000" })).statusCode, 400);
    const off = await call(cookie, "POST", "/api/auth/2fa/disable", { password: "correct horse battery", code: code() });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal((await call(cookie, "GET", "/api/watchlists")).statusCode, 401, "the old session is over");
    assert.equal((await me(session(off)!)).twoFactorEnabled, false);
    const row = await query<{ totp_secret_enc: string | null }>("SELECT totp_secret_enc FROM users WHERE email = 'off@example.com'");
    assert.equal(row.rows[0]!.totp_secret_enc, null);
  });

  await t.test("a sign-out-everywhere voids a proof already issued", async () => {
    let { cookie } = await signUp("void@example.com");
    await verify("void@example.com");
    const { secret, cookie: renewed } = await enable2fa(cookie);
    cookie = renewed;
    const proof = pending(await call(null, "POST", "/api/auth/login", { email: "void@example.com", password: "correct horse battery" }));
    await call(cookie, "POST", "/api/auth/logout-all");
    const res = await call(proof, "POST", "/api/auth/2fa/login", { code: nextCode(secret) });
    assert.equal(res.statusCode, 401);
  });

  await t.test("the administrator can use 2FA without an email, with the server's password", async () => {
    const adminLogin = () => call(null, "POST", "/api/auth/login", { username: "owner", password: "owner password" });
    const cookie = session(await adminLogin())!;
    const { secret } = await enable2fa(cookie, "owner password");
    const res = await adminLogin();
    assert.equal(res.json().twoFactorRequired, true);
    assert.equal(session(res), null);
    const ok = await call(pending(res), "POST", "/api/auth/2fa/login", { code: nextCode(secret) });
    assert.equal(ok.statusCode, 200, ok.body);
    await query("UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1", [ADMIN_USER_ID]);
  });

  await t.test("history is each account's own, and capped", async () => {
    const a = await signUp("hist-a@example.com");
    const b = await signUp("hist-b@example.com");
    const listed = await call(a.cookie, "GET", "/api/auth/login-history");
    const logins = listed.json().logins as { method: string }[];
    assert.equal(logins.length, 1);
    assert.equal(logins[0]!.method, "password");
    assert.equal((await call(null, "GET", "/api/auth/login-history")).statusCode, 401);
    const before = (await call(b.cookie, "GET", "/api/auth/login-history")).json().logins.length;
    for (let i = 0; i < 3; i += 1) {
      await call(null, "POST", "/api/auth/login", { email: "hist-a@example.com", password: "correct horse battery" });
    }
    assert.equal((await call(b.cookie, "GET", "/api/auth/login-history")).json().logins.length, before);
    const id = (await me(a.cookie)).id as string;
    await query(`INSERT INTO login_events (user_id, method) SELECT $1, 'password' FROM generate_series(1, 60)`, [id]);
    await call(null, "POST", "/api/auth/login", { email: "hist-a@example.com", password: "correct horse battery" });
    const count = await query<{ n: string }>("SELECT count(*) AS n FROM login_events WHERE user_id = $1", [id]);
    assert.equal(Number(count.rows[0]!.n), 50);
  });

  await t.test("deleting an account deletes its security rows", async () => {
    let { cookie } = await signUp("gone@example.com");
    await verify("gone@example.com");
    cookie = (await enable2fa(cookie)).cookie;
    const id = (await me(cookie)).id as string;
    assert.equal((await call(cookie, "DELETE", "/api/auth/account", { confirm: "DELETE" })).statusCode, 200);
    for (const table of ["email_verification_tokens", "totp_recovery_codes", "login_events"]) {
      const { rows } = await query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [id]);
      assert.equal(Number(rows[0]!.n), 0, table);
    }
  });

  await t.test("GitHub: a verified account joins and keeps its second factor; an unverified one loses a squatter's", async () => {
    Object.assign(config, { githubClientId: "id", githubClientSecret: "secret" });
    const realFetch = globalThis.fetch;
    let identity = { id: 7, email: "" };
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("login/oauth/access_token")) return Response.json({ access_token: "t" });
      if (u.endsWith("/user")) return Response.json({ id: identity.id, login: "octo" });
      if (u.endsWith("/user/emails")) return Response.json([{ email: identity.email, primary: true, verified: true }]);
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = realFetch; });

    const signInWithGithub = async () => {
      const start = await call(null, "GET", "/api/auth/github/start?next=/chart");
      assert.equal(start.statusCode, 302);
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const oauth = /^srtrend_oauth=([^;]+)/.exec(cookiesOf(start)[0]!)![1]!;
      return call(`srtrend_oauth=${oauth}`, "GET", `/api/auth/github/callback?code=c&state=${state}`);
    };

    // A brand-new account arrives verified.
    identity = { id: 100, email: "new-gh@example.com" };
    const created = await signInWithGithub();
    assert.equal(created.statusCode, 302);
    assert.equal((await me(session(created)!)).emailVerified, true);
    assert.equal((await me(session(created)!)).githubLinked, true);

    // Someone who never proved the address: their password goes.
    const squatter = await signUp("victim@example.com");
    identity = { id: 101, email: "victim@example.com" };
    const joined = await signInWithGithub();
    assert.equal((await call(null, "POST", "/api/auth/login", { email: "victim@example.com", password: "correct horse battery" })).statusCode, 401);
    assert.equal((await call(squatter.cookie, "GET", "/api/watchlists")).statusCode, 401, "their session ends");
    assert.equal((await me(session(joined)!)).emailVerified, true);

    // A verified account keeps its password, and must pass its second factor.
    const owner = await signUp("owner-gh@example.com");
    await verify("owner-gh@example.com");
    const { secret } = await enable2fa(owner.cookie);
    identity = { id: 102, email: "owner-gh@example.com" };
    const second = await signInWithGithub();
    assert.match(second.headers.location as string, /^\/login\?step=2fa/);
    assert.equal(session(second), null);
    const proof = pending(second);
    const done = await call(proof, "POST", "/api/auth/2fa/login", { code: nextCode(secret) });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal((await call(null, "POST", "/api/auth/login", { email: "owner-gh@example.com", password: "correct horse battery" })).json().twoFactorRequired, true);

    // The administrator is never joined by email.
    await query("UPDATE users SET email = 'admin-gh@example.com' WHERE id = $1", [ADMIN_USER_ID]);
    identity = { id: 103, email: "admin-gh@example.com" };
    const refused = await signInWithGithub();
    assert.match(refused.headers.location as string, /error=github_link_admin/);
    await query("UPDATE users SET email = NULL WHERE id = $1", [ADMIN_USER_ID]);
  });
});
