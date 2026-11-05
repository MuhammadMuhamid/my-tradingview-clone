/**
 * Links an account cannot follow are not drawn as links.
 *
 * Two places drew the administrator's destinations for everyone:
 *  - the header's section tabs — a Standard account that typed /journal saw
 *    "Trading · Automations · Journal" above the refusal, two live-looking
 *    tabs that each led to another refusal;
 *  - the Manual — eighteen links into /trading, /journal, /research, /stress,
 *    /optimizers and /operations, beside a menu that correctly hid them.
 * Both now filter by the same role rule and the same `ADMIN_ONLY_HREFS` the
 * menu uses. The Manual keeps every sentence; the destination is marked
 * "(administrator)" instead of linked.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import GettingStarted from "@/app/getting-started/page";
import { Nav } from "@/components/Nav";
import { ADMINISTRATOR_MARK } from "@/components/ManualLink";
import { ADMIN_ONLY_HREFS } from "@/lib/navigation";
import { resetSessionForTests } from "@/lib/session";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

function account(role: "admin" | "user"): void {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true, providers: { google: false, signups: true },
    user: {
      id: role === "admin" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
      email: `${role}@example.test`, displayName: role, avatarUrl: null, role, onboarded: true,
      hasPassword: true, passwordManagedByServer: false, googleLinked: false,
      createdAt: "2026-10-16T00:00:00.000Z",
    },
  }));
}

const strip = (): HTMLElement => screen.getByRole("navigation", { name: "This page" });
const tabHrefs = (): string[] =>
  [...strip().querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");

// ── Section tabs ────────────────────────────────────────────────────────────

test("a Standard account on /journal sees no section tabs into the administrator's pages", async () => {
  account("user");
  render(<AppRoute path="/journal"><Nav /></AppRoute>);
  await settle(6);
  assert.deepEqual(tabHrefs(), [], "admin-only section tabs were drawn for a Standard account");
});

test("a Standard account on /research sees no section tabs either", async () => {
  account("user");
  render(<AppRoute path="/research"><Nav /></AppRoute>);
  await settle(6);
  assert.deepEqual(tabHrefs(), []);
});

test("a session that could not be read draws no admin-only tabs", async () => {
  server.routes.set("GET /api/auth/me", () => new Response("down", { status: 500 }));
  render(<AppRoute path="/journal"><Nav /></AppRoute>);
  await settle(6);
  assert.deepEqual(tabHrefs(), []);
});

test("the administrator keeps the tabs, with the page's own tab current", async () => {
  account("admin");
  render(<AppRoute path="/journal"><Nav /></AppRoute>);
  await settle(6);
  assert.deepEqual(tabHrefs(), ["/trading", "/journal", "/bot"]);
  const journal = strip().querySelector('a[href="/journal"]');
  assert.equal(journal?.getAttribute("aria-current"), "page");
});

// ── The product menu's nested rows (B11) ────────────────────────────────────

test("the menu indents a section tab under its destination", async () => {
  account("admin");
  render(<AppRoute path="/alerts"><Nav /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: /go to another part of the application/ }));
  await settle();
  const row = (href: string): Element | null => document.querySelector(`a[role="menuitem"][href="${href}"]`);
  for (const nested of ["/journal", "/bot", "/stress", "/optimizers"]) {
    assert.equal(row(nested)?.getAttribute("data-nested"), "true", `${nested} is not marked nested`);
    assert.match(row(nested)?.className ?? "", /\bpl-5\b/, `${nested} is drawn flush`);
  }
  for (const top of ["/chart", "/trading", "/research"]) {
    assert.equal(row(top)?.getAttribute("data-nested"), null, `${top} is a destination, not a tab`);
    assert.match(row(top)?.className ?? "", /\bpl-1\b/);
  }
});

// ── The Manual ──────────────────────────────────────────────────────────────

const links = (): string[] => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
const adminOnly = (hrefs: string[]): string[] => hrefs.filter((h) => ADMIN_ONLY_HREFS.has(h));

test("the Manual, for a Standard account, links nothing it would be refused and marks it instead", async () => {
  account("user");
  render(<AppRoute path="/getting-started"><GettingStarted /></AppRoute>);
  await settle(6);

  assert.deepEqual(adminOnly(links()), [], "the Manual links a Standard account into a refusal");
  const marked = document.querySelectorAll("[data-admin-only-link]");
  assert.ok(marked.length >= 15, `only ${marked.length} administrator destinations are marked`);
  for (const el of marked) {
    assert.ok((el.textContent ?? "").includes(ADMINISTRATOR_MARK), "a marked destination does not say why");
    assert.match(el.querySelector("span")?.className ?? "", /text-ink-faint/);
  }
  // The step still reads, with its marker; only the link is gone.
  assert.ok(document.body.textContent?.includes(`Paper first ${ADMINISTRATOR_MARK}`));
  // Everything this account can use is still a link.
  for (const href of ["/chart", "/alerts", "/screener", "/shariah"]) {
    assert.ok(links().includes(href), `the Manual lost its link to ${href}`);
  }
});

test("the Manual, for the administrator, links every destination as before", async () => {
  account("admin");
  render(<AppRoute path="/getting-started"><GettingStarted /></AppRoute>);
  await settle(6);

  const hrefs = links();
  for (const href of ["/trading", "/journal", "/research", "/stress", "/optimizers", "/operations"]) {
    assert.ok(hrefs.includes(href), `the administrator's Manual lost its link to ${href}`);
  }
  assert.equal(document.querySelectorAll("[data-admin-only-link]").length, 0);
  assert.equal(document.body.textContent?.includes(ADMINISTRATOR_MARK), false);
});

test("the Manual, while the account is unreadable, marks rather than links", async () => {
  server.routes.set("GET /api/auth/me", () => new Response("down", { status: 500 }));
  render(<AppRoute path="/getting-started"><GettingStarted /></AppRoute>);
  await settle(6);
  assert.deepEqual(adminOnly(links()), []);
});
