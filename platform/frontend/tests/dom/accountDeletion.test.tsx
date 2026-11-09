/**
 * Deleting an account from the profile (OD-6): the credential it asks for
 * depends on the account, the code field behaves like every code field, and
 * the browser forgets the account's cached state afterwards.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import ProfilePage from "@/app/profile/page";
import { resetSessionForTests } from "@/lib/session";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const USER = {
  id: "33333333-3333-4333-8333-333333333333", email: "leaver@example.test", displayName: "Leaver",
  avatarUrl: null, role: "user", onboarded: true, hasPassword: true, passwordManagedByServer: false,
  googleLinked: false, githubLinked: false, emailVerified: true, twoFactorEnabled: false,
  moneyFeaturesUnlocked: false, createdAt: "2026-10-16T00:00:00.000Z",
};

function me(user: Record<string, unknown>) {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true, user,
    providers: { google: false, github: false, signups: true, email: true },
  }));
  server.routes.set("GET /api/auth/login-history", () => ({ logins: [] }));
}

const openAccount = async () => {
  render(<AppRoute path="/profile"><ProfilePage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: "Account" }));
  await settle(3);
};
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const deleteButton = () => screen.getByRole("button", { name: /Delete my account|Deleting/ }) as HTMLButtonElement;

test("a password account confirms with its password; the browser forgets the account's cache, keeps the theme", async () => {
  me(USER);
  let sent: unknown = null;
  server.routes.set("DELETE /api/auth/account", (body) => { sent = body; return { ok: true }; });
  window.localStorage.setItem("ts.account.owner", USER.id);
  window.localStorage.setItem("tv.workspace.v2", "{\"panes\":1}");
  window.localStorage.setItem("srtrend.drawings.v2", "[]");
  window.localStorage.setItem("trading-scene-theme", "dark");
  await openAccount();
  assert.equal(screen.queryByLabelText(/code from your authenticator/), null);
  type("Type DELETE to confirm", "DELETE");
  await settle();
  assert.equal(deleteButton().disabled, true, "the password is required");
  const password = screen.getByLabelText("Your password") as HTMLInputElement;
  assert.equal(password.type, "password");
  assert.equal(password.autocomplete, "current-password");
  type("Your password", "correct horse battery");
  await settle();
  fireEvent.click(deleteButton());
  await settle(4);
  assert.deepEqual(sent, { confirm: "DELETE", credential: { password: "correct horse battery" } });
  assert.deepEqual(Object.keys(window.localStorage).sort(), ["trading-scene-theme"]);
});

test("with two-factor on it asks for the code: numeric, one-time-code, six digits, pasted spaces removed, sixth digit submits", async () => {
  me({ ...USER, twoFactorEnabled: true });
  const sent: unknown[] = [];
  server.routes.set("DELETE /api/auth/account", (body) => { sent.push(body); return { ok: true }; });
  await openAccount();
  assert.equal(screen.queryByLabelText("Your password"), null);
  const code = screen.getByLabelText("6-digit code from your authenticator app") as HTMLInputElement;
  assert.equal(code.inputMode, "numeric");
  assert.equal(code.autocomplete, "one-time-code");
  assert.equal(code.getAttribute("pattern"), "[0-9]*");
  assert.equal(code.maxLength, 6);
  assert.equal(code.getAttribute("enterkeyhint"), "done");
  // Without DELETE typed, a complete code does not submit.
  fireEvent.paste(code, { clipboardData: { getData: () => "123 456" } });
  await settle(3);
  assert.equal(code.value, "123456");
  assert.equal(sent.length, 0);
  type("Type DELETE to confirm", "DELETE");
  fireEvent.change(code, { target: { value: "12345" } });
  await settle();
  fireEvent.paste(code, { clipboardData: { getData: () => "654-321" } });
  await settle(4);
  assert.deepEqual(sent, [{ confirm: "DELETE", credential: { code: "654321" } }]);
});

test("a provider-only account is told typing DELETE is the only confirmation, and sends no credential", async () => {
  me({ ...USER, hasPassword: false, googleLinked: true });
  let sent: unknown = null;
  server.routes.set("DELETE /api/auth/account", (body) => { sent = body; return { ok: true }; });
  await openAccount();
  assert.match(document.body.textContent ?? "", /only through Google or GitHub/);
  type("Type DELETE to confirm", "DELETE");
  await settle();
  fireEvent.click(deleteButton());
  await settle(4);
  assert.deepEqual(sent, { confirm: "DELETE" });
});

test("a refusal (money still in a cohort) is shown and nothing is forgotten", async () => {
  me(USER);
  server.routes.set("DELETE /api/auth/account", () => new Response(JSON.stringify({
    code: "membership_active", error: "This account still has a seat in a package cohort that hasn't finished.",
  }), { status: 409, headers: { "content-type": "application/json" } }));
  window.localStorage.setItem("ts.account.owner", USER.id);
  window.localStorage.setItem("tv.workspace.v2", "{}");
  await openAccount();
  type("Type DELETE to confirm", "DELETE");
  type("Your password", "correct horse battery");
  await settle();
  fireEvent.click(deleteButton());
  await settle(4);
  assert.match(screen.getByRole("alert").textContent ?? "", /package cohort/);
  assert.equal(window.localStorage.getItem("tv.workspace.v2"), "{}");
});
