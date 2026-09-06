/**
 * Signing in, and the gate in front of every page.
 *
 * ── Two halves that have to agree ──────────────────────────────────────────
 *
 * `proxy.ts` decides that an unauthenticated request goes to
 * `/login?next=<where they were going>`, and the login form decides where to
 * send the user afterwards by running that `next` through `safeNextPath`.
 * Both halves were tested — the parse rule and the validator — and the JOIN
 * between them was not tested at all, in either direction: nothing checked
 * that the gate produces a `next` the validator accepts, and nothing ran the
 * gate at all.
 *
 * This runs the real proxy against real `NextRequest`s, and renders the real
 * login form against the fixture origin.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextRequest } from "next/server";
import { closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { proxy } from "@/proxy";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/lib/safeRedirect";
import LoginPage from "@/app/login/page";
import { AppRoute } from "./harness/routing";

const SESSION_COOKIE = "srtrend_session";

beforeEach(resetBrowser);
after(closeBrowser);

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, "http://127.0.0.1"), {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

test("an unauthenticated page request is sent to the login page, remembering where it was going", () => {
  const response = proxy(request("/chart?symbol=SOLUSDT&interval=4h"));
  assert.equal(response.status, 307);

  const location = new URL(response.headers.get("location")!);
  assert.equal(location.pathname, "/login");

  const next = location.searchParams.get("next");
  assert.equal(next, "/chart?symbol=SOLUSDT&interval=4h");

  // The join: whatever the gate writes, the form must be willing to use. A
  // `next` the validator rejects sends every signed-in user to the default
  // page instead of the one they asked for, silently.
  assert.equal(safeNextPath(next), "/chart?symbol=SOLUSDT&interval=4h");
});

test("a request carrying a session cookie is let through", () => {
  const response = proxy(request("/chart", "anything"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null,
    "the cookie's SIGNATURE is the backend's business; presence is all the edge may check");
});

test("the gate is opt-out, and off means off", () => {
  const before = process.env.AUTH_ENABLED;
  try {
    process.env.AUTH_ENABLED = "false";
    assert.equal(proxy(request("/chart")).status, 200);
    // Every other value leaves it on, including the ones that used to disable it.
    for (const value of ["1", "yes", "off", "true", ""]) {
      process.env.AUTH_ENABLED = value;
      assert.equal(proxy(request("/chart")).status, 307, `AUTH_ENABLED=${value}`);
    }
  } finally {
    if (before === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = before;
  }
});

test("a hostile next never becomes a place the form would send anyone", () => {
  // The gate cannot produce these, but the URL bar can, and the form is what
  // reads it. Each one is rejected in favour of the default rather than
  // sanitised into something that looks close enough.
  for (const hostile of [
    "//evil.example", "https://evil.example/x", "javascript:alert(1)",
    "/\\evil.example", "\\/evil.example", "%2f%2fevil.example",
    "/login", "/login/again", " /chart", "java\tscript:alert(1)",
  ]) {
    assert.equal(safeNextPath(hostile), DEFAULT_AFTER_LOGIN, hostile);
  }
});

test("the sign-in form sends what was typed and shows what the server said", async () => {
  let seen: unknown = null;
  server.routes.set("POST /api/auth/login", (body) => { seen = body; return { ok: true }; });

  render(<AppRoute path="/login" query="next=%2Fchart%3Fsymbol%3DSOLUSDT"><LoginPage /></AppRoute>);
  await settle();

  const username = screen.getByLabelText("Username") as HTMLInputElement;
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  const submit = screen.getByRole("button", { name: /Sign in/ }) as HTMLButtonElement;

  assert.equal(submit.disabled, true, "an empty form cannot be submitted");

  fireEvent.change(username, { target: { value: "operator" } });
  fireEvent.change(password, { target: { value: "hunter2" } });
  await settle();
  assert.equal(submit.disabled, false);

  fireEvent.click(submit);
  await settle();

  assert.deepEqual(seen, { username: "operator", password: "hunter2" });
  assert.equal(password.type, "password", "the password field must not be a text field");
  assert.equal(password.autocomplete, "current-password");
});

test("a refused sign-in says why, and lets the user try again", async () => {
  server.routes.delete("POST /api/auth/login");
  render(<AppRoute path="/login"><LoginPage /></AppRoute>);
  await settle();

  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "operator" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
  await settle();

  const alert = screen.getByRole("alert");
  assert.match(alert.textContent ?? "", /fixture server has no route/,
    "the server's own reason must reach the user rather than a generic failure");
  assert.equal((screen.getByRole("button", { name: /Sign in/ }) as HTMLButtonElement).disabled,
    false, "a failed attempt must not leave the form stuck");
});
