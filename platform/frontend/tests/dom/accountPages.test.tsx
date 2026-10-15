/**
 * The account screens: creating an account, Google when it is offered, the
 * reasons a Google round trip can come back with, first-run setup, and the
 * profile's password rules.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { render, closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import LoginPage from "@/app/login/page";
import OnboardingPage from "@/app/onboarding/page";
import ProfilePage from "@/app/profile/page";
import { resetSessionForTests } from "@/lib/session";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const USER = {
  id: "22222222-2222-4222-8222-222222222222", email: "trader@example.test", displayName: "Trader",
  avatarUrl: null, role: "user", onboarded: false, hasPassword: true, passwordManagedByServer: false,
  googleLinked: false, createdAt: "2026-10-16T00:00:00.000Z",
};

function me(over: { google?: boolean; user?: unknown } = {}) {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: over.user !== null, authEnabled: true,
    user: over.user === undefined ? USER : over.user,
    providers: { google: over.google ?? false, signups: true },
  }));
}

test("create an account: name, email and password reach the server", async () => {
  me({ user: null });
  let seen: unknown = null;
  server.routes.set("POST /api/auth/signup", (body) => { seen = body; return { ok: true, user: USER }; });
  render(<AppRoute path="/login" query="mode=signup"><LoginPage /></AppRoute>);
  await settle();

  assert.ok(screen.getByRole("heading", { name: "Create your account" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Trader" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "trader@example.test" } });
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  fireEvent.change(password, { target: { value: "short" } });
  await settle();
  const submit = screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement;
  assert.equal(submit.disabled, true, "a password under 8 characters cannot be submitted");
  fireEvent.change(password, { target: { value: "long enough pass" } });
  await settle();
  assert.equal(password.autocomplete, "new-password");
  fireEvent.click(submit);
  await settle();
  assert.deepEqual(seen, { email: "trader@example.test", password: "long enough pass", displayName: "Trader" });
});

test("Google is offered only when the server is configured for it", async () => {
  me({ user: null, google: false });
  const first = render(<AppRoute path="/login"><LoginPage /></AppRoute>);
  await settle();
  assert.equal(screen.queryByText("Continue with Google"), null);
  first.unmount();

  resetSessionForTests();
  me({ user: null, google: true });
  render(<AppRoute path="/login" query="next=%2Falerts"><LoginPage /></AppRoute>);
  await settle();
  const link = screen.getByText("Continue with Google").closest("a")!;
  assert.equal(link.getAttribute("href"), "/api/auth/google/start?next=%2Falerts");
});

test("a Google round trip that failed says why", async () => {
  me({ user: null });
  render(<AppRoute path="/login" query="error=google_cancelled"><LoginPage /></AppRoute>);
  await settle();
  assert.match(screen.getByRole("alert").textContent ?? "", /cancelled/);
});

test("first-run setup saves the name and the chosen coins as a watchlist", async () => {
  me();
  let seen: { displayName?: string; symbols?: string[] } | null = null;
  server.routes.set("POST /api/auth/onboarding", (body) => { seen = body as typeof seen; return { ok: true, user: USER }; });
  render(<AppRoute path="/onboarding"><OnboardingPage /></AppRoute>);
  await settle();
  const name = screen.getByLabelText("Display name") as HTMLInputElement;
  assert.equal(name.value, "Trader", "seeded from the account");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "NEAR" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Create watchlist with 4 coins/ }));
  await settle();
  assert.equal(seen!.displayName, "Trader");
  assert.deepEqual([...seen!.symbols!].sort(), ["BTCUSDT", "ETHUSDT", "NEARUSDT", "SOLUSDT"]);
});

test("the profile asks for the current password before changing it", async () => {
  me({ user: { ...USER, onboarded: true } });
  let seen: unknown = null;
  server.routes.set("POST /api/auth/password", (body) => { seen = body; return { ok: true }; });
  render(<AppRoute path="/profile"><ProfilePage /></AppRoute>);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Password & sign-in" }));
  await settle();
  const change = screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new password 1" } });
  await settle();
  assert.equal(change.disabled, true, "the current password is required");
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old password 1" } });
  await settle();
  fireEvent.click(change);
  await settle();
  assert.deepEqual(seen, { currentPassword: "old password 1", newPassword: "new password 1" });
  assert.match(screen.getByRole("status").textContent ?? "", /other devices have been signed out/);
});

test("the administrator's account cannot be deleted from the profile", async () => {
  me({ user: { ...USER, role: "admin", email: null, passwordManagedByServer: true, onboarded: true } });
  render(<AppRoute path="/profile"><ProfilePage /></AppRoute>);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Account" }));
  await settle();
  assert.ok(screen.getByText("The administrator account cannot be deleted."));
  assert.equal(screen.queryByRole("button", { name: "Delete my account" }), null);
});
