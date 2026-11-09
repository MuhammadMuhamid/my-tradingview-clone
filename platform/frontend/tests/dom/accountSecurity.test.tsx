/** Two-factor sign-in, GitHub, the verification page and the profile's security cards. */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertAbsent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import LoginPage from "@/app/login/page";
import ProfilePage from "@/app/profile/page";
import VerifyEmailPage from "@/app/verify-email/page";
import { resetSessionForTests } from "@/lib/session";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const USER = {
  id: "22222222-2222-4222-8222-222222222222", email: "trader@example.test", displayName: "Trader",
  avatarUrl: null, role: "user", onboarded: true, hasPassword: true, passwordManagedByServer: false,
  googleLinked: false, githubLinked: false, emailVerified: true, twoFactorEnabled: false,
  moneyFeaturesUnlocked: false, createdAt: "2026-10-16T00:00:00.000Z",
};

function me(user: unknown = USER, providers: Record<string, boolean> = {}) {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: user !== null, authEnabled: true, user,
    providers: { google: false, github: false, signups: true, email: true, ...providers },
  }));
  server.routes.set("GET /api/auth/login-history", () => ({ logins: [] }));
  server.routes.set("GET /api/auth/2fa/status", () => ({ enabled: true, recoveryCodesLeft: 7 }));
}

const failing = (status: number, error: string) => () =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const text = () => document.body.textContent ?? "";
const openSecurity = async () => {
  render(<AppRoute path="/profile"><ProfilePage /></AppRoute>);
  await settle(6);
  click("Password & sign-in");
  await settle(4);
};

test("a correct password with 2FA on asks for the code, and a wrong code says so and clears", async () => {
  me(null);
  server.routes.set("POST /api/auth/login", () => ({ ok: true, twoFactorRequired: true }));
  let attempt: unknown = null;
  server.routes.set("POST /api/auth/2fa/login", (body) => { attempt = body; return failing(401, "That code isn't correct.")(); });
  render(<AppRoute path="/login"><LoginPage /></AppRoute>);
  await settle(4);
  type(/Email or username/, "trader@example.test");
  type("Password", "correct horse battery");
  click("Sign in");
  await settle(4);
  assert.ok(screen.getByRole("heading", { name: "Two-factor sign-in" }));
  assert.equal(screen.queryByLabelText("Password"), null);
  // The shared six-digit field submits on the sixth digit (OD-2).
  type("Code", "123456");
  await settle(4);
  assert.deepEqual(attempt, { code: "123456" });
  assert.match(screen.getByRole("alert").textContent ?? "", /isn't correct/);
  assert.equal((screen.getByLabelText("Code") as HTMLInputElement).value, "");
});

test("a recovery code can be used instead", async () => {
  me(null);
  let attempt: unknown = null;
  server.routes.set("POST /api/auth/2fa/login", (body) => { attempt = body; return failing(401, "That code isn't correct.")(); });
  render(<AppRoute path="/login" query="step=2fa"><LoginPage /></AppRoute>);
  await settle(4);
  click("Use a recovery code");
  type("Recovery code", "ABCDE-FGHIJ");
  click("Continue");
  await settle(4);
  assert.deepEqual(attempt, { recoveryCode: "ABCDE-FGHIJ" });
});

test("GitHub is offered only when the server is configured for it", async () => {
  me(null);
  render(<AppRoute path="/login"><LoginPage /></AppRoute>);
  await settle(4);
  assert.equal(text().includes("Continue with GitHub"), false);
});

test("GitHub's button starts its own round trip", async () => {
  me(null, { github: true });
  render(<AppRoute path="/login"><LoginPage /></AppRoute>);
  await settle(4);
  assert.match(screen.getByRole("link", { name: /Continue with GitHub/ }).getAttribute("href") ?? "", /^\/api\/auth\/github\/start/);
});

test("opening the verification link uses nothing until the person confirms, and takes the token out of the address", async () => {
  me(null);
  const calls: unknown[] = [];
  server.routes.set("POST /api/auth/email/verify", (body) => { calls.push(body); return { ok: true }; });
  render(<AppRoute path="/verify-email" query="token=abc123"><VerifyEmailPage /></AppRoute>);
  await settle(6);
  // A mail scanner that loads the page, script and all, verifies nothing.
  assert.deepEqual(calls, []);
  assert.equal(window.location.search, "");
  assert.ok(screen.getByRole("heading", { name: "Confirm your email address" }));
  assert.match(text(), /Only confirm if you created this Trading Scene account yourself/);
  click("Confirm my email address");
  await settle(6);
  assert.deepEqual(calls, [{ token: "abc123" }]);
  assert.ok(screen.getByRole("heading", { name: "Email verified" }));
  assertAbsent(screen.queryByRole("button", { name: "Confirm my email address" }), "the token works once");
});

test("a used or expired link says what to do", async () => {
  me(null);
  server.routes.set("POST /api/auth/email/verify", failing(400, "This link has expired or has already been used. Ask for a new one from your profile."));
  render(<AppRoute path="/verify-email" query="token=old"><VerifyEmailPage /></AppRoute>);
  await settle(6);
  click("Confirm my email address");
  await settle(6);
  assert.match(screen.getByRole("alert").textContent ?? "", /expired or has already been used/);
});

test("no token asks the server nothing", async () => {
  me(null);
  render(<AppRoute path="/verify-email"><VerifyEmailPage /></AppRoute>);
  await settle(6);
  assert.equal(server.callsTo("/api/auth/email/verify").length, 0);
  assert.ok(screen.getByRole("alert"));
});

test("a link refused for an unverified account says why on the sign-in page", async () => {
  for (const [code, provider] of [["google_link_unverified", "Google"], ["github_link_unverified", "GitHub"]]) {
    me(null);
    const { unmount } = render(<AppRoute path="/login" query={`error=${code}`}><LoginPage /></AppRoute>);
    await settle(4);
    assert.match(screen.getByRole("alert").textContent ?? "",
      new RegExp(`Verify your email first, or link a ${provider} account that uses the same address`));
    unmount();
  }
});

test("an unverified account is told which provider accounts it can link; a verified one isn't", async () => {
  me({ ...USER, emailVerified: false }, { google: true, github: true });
  await openSecurity();
  assert.ok(text().includes("Verify your email first, or link a Google account that uses this same address."));
  assert.ok(text().includes("Verify your email first, or link a GitHub account that uses this same address."));
  // The buttons stay: an identity with this same address can still be linked.
  assert.ok(screen.getByRole("button", { name: "Link Google account" }));
  assert.ok(screen.getByRole("button", { name: "Link GitHub account" }));
});

test("a verified account gets no link note", async () => {
  me(USER, { google: true, github: true });
  await openSecurity();
  assert.equal(text().includes("link a Google account that uses this same address"), false);
  assert.equal(text().includes("link a GitHub account that uses this same address"), false);
});

test("an unverified account can ask for the email again, and can't start 2FA", async () => {
  me({ ...USER, emailVerified: false });
  server.routes.set("POST /api/auth/email/resend", () => ({ ok: true }));
  await openSecurity();
  assert.ok(text().includes("isn't verified yet"));
  assert.equal(screen.queryByRole("button", { name: "Set up two-factor sign-in" }), null);
  assert.ok(text().includes("Verify your email address first"));
  click("Send verification email");
  await settle(4);
  assert.ok(text().includes("We sent a link to trader@example.test"));
});

test("email not set up says so instead of offering a button that would fail", async () => {
  me({ ...USER, emailVerified: false }, { email: false });
  await openSecurity();
  assert.equal(screen.queryByRole("button", { name: "Send verification email" }), null);
  assert.ok(text().includes("Email isn't set up on this server yet."));
});

test("setting up 2FA: password, QR and key, code, then recovery codes shown once", async () => {
  me();
  const seen: unknown[] = [];
  server.routes.set("POST /api/auth/2fa/setup", (body) => { seen.push(body); return { secret: "SECRETKEY234", otpauthUrl: "otpauth://x", qrDataUrl: "data:image/png;base64,AAAA" }; });
  server.routes.set("POST /api/auth/2fa/enable", (body) => { seen.push(body); return { ok: true, recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] }; });
  await openSecurity();
  type("Password", "correct horse battery");
  click("Set up two-factor sign-in");
  await settle(4);
  assert.ok(text().includes("SECR ETKE Y234"), "the setup key, grouped in fours (OD-2)");
  assert.ok(screen.getByAltText("QR code for your authenticator app"));
  type(/6-digit code/, "123456");
  click("Turn on");
  await settle(4);
  assert.deepEqual(seen, [{ password: "correct horse battery" }, { code: "123456" }]);
  assert.ok(text().includes("AAAAA-BBBBB"));
  assert.equal(text().includes("SECR ETKE Y234"), false, "the secret isn't left on screen");
  click("I've saved them");
  await settle(4);
  assert.equal(text().includes("AAAAA-BBBBB"), false);
});

test("with 2FA on, turning it off asks for both factors", async () => {
  me({ ...USER, twoFactorEnabled: true });
  let sent: unknown = null;
  server.routes.set("POST /api/auth/2fa/disable", (body) => { sent = body; return { ok: true }; });
  await openSecurity();
  assert.ok(text().includes("7 recovery codes left"));
  click("Turn off");
  await settle(2);
  const confirm = () => screen.getByRole("button", { name: "Turn off two-factor" }) as HTMLButtonElement;
  assert.equal(confirm().disabled, true);
  type("Password", "correct horse battery");
  type(/6-digit code/, "654321");
  click("Turn off two-factor");
  await settle(4);
  assert.deepEqual(sent, { password: "correct horse battery", code: "654321" });
});

test("a refusal from the server is shown in its own words", async () => {
  me();
  server.routes.set("POST /api/auth/2fa/setup", failing(400, "Your password isn't correct."));
  await openSecurity();
  type("Password", "wrong");
  click("Set up two-factor sign-in");
  await settle(4);
  assert.ok(text().includes("Your password isn't correct."));
});

test("recent sign-ins are listed, and a failed read says so", async () => {
  me();
  server.routes.set("GET /api/auth/login-history", () => ({ logins: [{
    method: "github", twoFactor: true, ip: "203.0.113.9", userAgent: "Test Browser", at: "2026-11-05T10:00:00.000Z",
  }] }));
  await openSecurity();
  assert.ok(text().includes("GitHub + code"));
  assert.ok(text().includes("203.0.113.9"));
  assert.ok(text().includes("Test Browser"));
});

test("the sign-in history failing leaves the rest of the page working", async () => {
  me();
  server.routes.set("GET /api/auth/login-history", failing(500, "boom"));
  await openSecurity();
  assert.match(screen.getByRole("alert").textContent ?? "", /history couldn't be read/);
  assert.ok(screen.getByRole("button", { name: "Set up two-factor sign-in" }));
});
