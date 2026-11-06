/**
 * A session that could not be read is not the administrator's.
 *
 * `/api/auth/me` answering 500, or not answering at all, used to resolve to
 * "admin" (`lib/session` `roleOf`), so an ordinary account whose read failed
 * was drawn the operator's surface: on Shariah the "published deliberately by
 * you" header with Turn on, Sync universe and Select due assets enabled; in the
 * product menu every administrator destination. The backend still refused the
 * writes — this was a UI that claimed an authority the reader did not have.
 *
 * Now an unreadable session is offered what an unknown one is: nothing
 * admin-only. (The Shariah header's role-free wording for this state belongs
 * to that page; here only the absence of the operator's controls and of its
 * first-person copy is asserted.)
 *
 * And it is TOLD. V4 measured the product menu in this state: no account row,
 * no Sign out, no explanation and no Retry — an administrator whose read
 * failed recovered only by reloading. The menu now carries the same sentence
 * the admin-only pages show (`SESSION_UNREADABLE_NOTICE`), a Retry that
 * re-reads in place, and Sign out; an auth-off instance shows none of it.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { assertAbsent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import ShariahPage from "@/app/shariah/page";
import { Nav } from "@/components/Nav";
import { SESSION_UNREADABLE_NOTICE } from "@/components/AdminOnlyPage";
import { ADMIN_ONLY_HREFS, PRODUCT_NAME } from "@/lib/navigation";
import { loadSession, refreshSession, resetSessionForTests, roleOf } from "@/lib/session";
import { CHART_SESSION_NOTICE, SessionCheckBanner } from "@/components/tv/SessionCheckBanner";
import { api, ApiError } from "@/lib/api";

beforeEach(() => {
  resetBrowser();
  resetSessionForTests();
  server.routes.set("GET /api/shariah/universe", () => ({
    policyVersion: "TS_SHARIAH_V1", prohibitedCategories: ["LENDING"], reviewPolicy: { reviewMaxAgeDays: 365 },
    counts: { total: 0, active: 0, eligible: 0, review: 0, excluded: 0, dueForReReview: 0 },
    assets: [],
  }));
  server.routes.set("GET /api/shariah/snapshots", () => ({ snapshots: [] }));
  server.routes.set("GET /api/shariah/mode", () => ({ mode: "off", policyVersion: "TS_SHARIAH_V1" }));
  server.routes.set("GET /api/shariah/mode/history", () => ({ changes: [] }));
});
after(closeBrowser);

const failures: { name: string; arrange: () => void }[] = [
  { name: "answers 500", arrange: () => {
    server.routes.set("GET /api/auth/me", () => new Response("upstream down", { status: 500 }));
  } },
  { name: "never answers (network failure)", arrange: () => {
    server.routes.set("GET /api/auth/me", () => { throw new TypeError("fetch failed"); });
  } },
];

/** Opens the product menu from the header and returns the menu element. */
async function openProductMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /go to another part of the application/ }));
  await settle();
  return screen.getByRole("menu", { name: PRODUCT_NAME });
}

const adminHrefs = (menu: HTMLElement): string[] => within(menu).getAllByRole("menuitem")
  .map((item) => item.getAttribute("href"))
  .filter((href): href is string => href !== null && ADMIN_ONLY_HREFS.has(href));

const standardReader = () => ({
  authenticated: true, authEnabled: true,
  user: {
    id: "u1", email: "std@example.test", displayName: "Standard Reader", avatarUrl: null, role: "user",
    onboarded: true, hasPassword: true, passwordManagedByServer: false, googleLinked: false,
    createdAt: "2026-01-01T00:00:00Z",
  },
  providers: { google: false, github: false, signups: true, email: false },
});

for (const { name, arrange } of failures) {
  test(`Shariah, when the session read ${name}: no operator controls and no "by you"`, async () => {
    arrange();
    render(<AppRoute path="/shariah"><ShariahPage /></AppRoute>);
    await settle(6);

    for (const control of [/^Turn on$/, /^Turn off$/, /Sync universe/, /Create universe snapshot/,
      /needing review/]) {
      assertAbsent(screen.queryByRole("button", { name: control }), `the write control ${control}`);
    }
    assertAbsent(screen.queryByText(/by you/), "the operator's first-person header");
    assertAbsent(screen.queryByText(/^You publish evidence-backed/), "the operator's first-person explanation");
  });

  test(`the header's product menu, when the session read ${name}: no administrator destination`, async () => {
    arrange();
    render(<AppRoute path="/shariah"><Nav /></AppRoute>);
    await settle(6);
    fireEvent.click(screen.getByRole("button", { name: /go to another part of the application/ }));
    await settle();

    const hrefs = screen.getAllByRole("menuitem")
      .map((item) => item.getAttribute("href"))
      .filter((href): href is string => href !== null);
    assert.ok(hrefs.includes("/chart"), "setup: the menu did not open");
    const offered = hrefs.filter((href) => ADMIN_ONLY_HREFS.has(href));
    assert.deepEqual(offered, [], "administrator destinations offered to an account nobody could check");
  });

  test(`the header's product menu, when the session read ${name}: says so, and offers Retry and Sign out`, async () => {
    arrange();
    render(<AppRoute path="/shariah"><Nav /></AppRoute>);
    await settle(6);
    const menu = await openProductMenu();

    assert.ok(within(menu).getByText(SESSION_UNREADABLE_NOTICE), "the menu did not say the read failed");
    assert.ok(within(menu).getByRole("menuitem", { name: "Retry" }), "no Retry in the menu");
    assert.ok(within(menu).getByRole("menuitem", { name: "Sign out" }), "no Sign out in the menu");
    assert.deepEqual(adminHrefs(menu), [], "administrator destinations offered to an account nobody could check");
  });
}

test("the product menu's Retry re-reads the session in place: the notice goes, the account row appears", async () => {
  server.routes.set("GET /api/auth/me", () => new Response("upstream down", { status: 500 }));
  render(<AppRoute path="/shariah"><Nav /></AppRoute>);
  await settle(6);
  const menu = await openProductMenu();
  assert.ok(within(menu).getByText(SESSION_UNREADABLE_NOTICE), "setup: the menu did not say the read failed");

  server.routes.set("GET /api/auth/me", standardReader);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Retry" }));
  await settle(6);

  const reread = screen.getByRole("menu", { name: PRODUCT_NAME });
  assertAbsent(within(reread).queryByText(SESSION_UNREADABLE_NOTICE), "the notice, after a read that answered");
  assertAbsent(within(reread).queryByRole("menuitem", { name: "Retry" }), "Retry, after a read that answered");
  assert.ok(within(reread).getByText("Standard Reader"), "the account row did not appear after the re-read");
  assert.ok(within(reread).getByRole("menuitem", { name: "Sign out" }), "Sign out stays once the account is known");
  assert.equal(document.activeElement, within(reread).getAllByRole("menuitem")[0], "focus left the menu after Retry");
  assert.deepEqual(adminHrefs(reread), [], "administrator destinations offered to a Standard account");
});

test("an auth-off instance's product menu carries no unreadable notice and no Retry", async () => {
  render(<AppRoute path="/shariah"><Nav /></AppRoute>);
  await settle(6);
  const menu = await openProductMenu();

  assertAbsent(within(menu).queryByText(SESSION_UNREADABLE_NOTICE), "the unreadable notice on the owner's menu");
  assertAbsent(within(menu).queryByRole("menuitem", { name: "Retry" }), "Retry on the owner's menu");
  assertAbsent(within(menu).queryByRole("menuitem", { name: "Sign out" }), "Sign out on an instance with no accounts");
});

test("roleOf: a failed read and a signed-out answer are unreadable; no accounts is the administrator", () => {
  const base = { providers: { google: false, github: false, signups: true, email: false } };
  assert.equal(roleOf(null), "unknown");
  assert.equal(roleOf({ ...base, authenticated: false, authEnabled: true, user: null, readFailed: true }), "unreadable");
  assert.equal(roleOf({ ...base, authenticated: false, authEnabled: true, user: null }), "unreadable");
  assert.equal(roleOf({ ...base, authenticated: false, authEnabled: false, user: null }), "admin");
});

test("a failed read recovers by itself once the server answers, and the chart's notice goes", async () => {
  server.routes.set("GET /api/auth/me", () => new Response("upstream down", { status: 502 }));
  render(<SessionCheckBanner />);
  await settle();
  screen.getByText(CHART_SESSION_NOTICE);

  // The server comes back; nobody presses anything.
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true, providers: { google: false, github: false, signups: true, email: false },
    user: { id: "a1", email: "a@example.test", displayName: "Admin", avatarUrl: null, role: "admin" },
  }));
  const deadline = Date.now() + 4_000;
  while (screen.queryByText(CHART_SESSION_NOTICE) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    await settle();
  }
  assertAbsent(screen.queryByText(CHART_SESSION_NOTICE), "the notice ends when the read answers");
  assert.equal(roleOf(await loadSession()), "admin");
});

test("the chart's notice offers Retry now, and says nothing for a read that answered", async () => {
  let answers = false;
  server.routes.set("GET /api/auth/me", () => answers
    ? { authenticated: true, authEnabled: false, providers: { google: false, github: false, signups: true, email: false }, user: null }
    : new Response("upstream down", { status: 500 }));
  render(<SessionCheckBanner />);
  await settle();
  answers = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  await settle();
  assertAbsent(screen.queryByText(CHART_SESSION_NOTICE), "the notice, after Retry now");
  await refreshSession();
});

test("a history request told to wait waits, then succeeds; anything else's 429 is reported at once", async () => {
  let asked = 0;
  server.routes.set("POST /api/data/backfill", () => {
    asked += 1;
    return asked < 3
      ? new Response(JSON.stringify({ error: "wait" }), { status: 429, headers: { "retry-after": "0" } })
      : { fetched: 5, interval: "1m", source: "1m" };
  });
  const done = await api.backfill("BTCUSDT", "1m", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");
  assert.equal(done.fetched, 5);
  assert.equal(asked, 3);

  let other = 0;
  server.routes.set("GET /api/symbols", () => {
    other += 1;
    return new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "retry-after": "0" } });
  });
  await assert.rejects(api.listSymbols(), (e: unknown) => e instanceof ApiError && e.status === 429);
  assert.equal(other, 1);
});

test("an aborted history request stops waiting for its turn", async () => {
  server.routes.set("POST /api/data/backfill", () =>
    new Response(JSON.stringify({ error: "wait" }), { status: 429, headers: { "retry-after": "60" } }));
  const controller = new AbortController();
  const waiting = api.backfill("BTCUSDT", "1m", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, (e: unknown) => (e as { name?: string }).name === "AbortError");
});
