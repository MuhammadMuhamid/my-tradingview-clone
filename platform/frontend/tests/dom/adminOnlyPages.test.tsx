/**
 * The administrator's pages, opened by URL from an ordinary account.
 *
 * The navigation hides /trading, /journal, /research, /stress, /optimizers and
 * /operations from an ordinary account, but typing the address still drew the
 * whole page: the Journal's filter form, then "Could not load the Journal
 * evidence. Hover for the reason reported." — the reason ("available to the
 * administrator only") was a tooltip. The contract (§1.3) says an entitlement
 * limit is stated, never hidden behind a control that appears to work.
 *
 * Now the page says so in its copy, offers the chart, and is not mounted at
 * all — so nothing on it asks the server for anything. The administrator, and
 * a session that could not be read, get the page exactly as before.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import JournalPage from "@/app/journal/page";
import DeploymentsPage from "@/app/trading/page";
import { ADMIN_ONLY_PAGE_NOTICE } from "@/components/AdminOnlyPage";
import { resetSessionForTests } from "@/lib/session";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const NOTICE = "This page is for the administrator. It acts on the platform owner's exchange account, "
  + "bots or research jobs. Your account can use the chart, Screener, alerts, watchlists, layouts, "
  + "Pine scripts and the Shariah screen.";

function account(role: "admin" | "user"): void {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true,
    user: {
      id: "22222222-2222-4222-8222-222222222222", email: "trader@example.test", displayName: "Trader",
      avatarUrl: null, role, onboarded: true, hasPassword: true, passwordManagedByServer: false,
      googleLinked: false, createdAt: "2026-10-16T00:00:00.000Z",
    },
    providers: { google: false, signups: true },
  }));
}

function tradingFixtures(): void {
  server.routes.set("GET /api/deployments", () => []);
  server.routes.set("/api/alerts", () => []);
}

/** Every request the page made, other than the one shared session read. */
const pageCalls = () => server.calls.filter((c) => !c.path.startsWith("/api/auth/me"));
const body = () => document.body.textContent ?? "";

test("the exact notice copy", () => {
  assert.equal(ADMIN_ONLY_PAGE_NOTICE, NOTICE);
});

test("an ordinary account opening /journal is told it is the administrator's page, and nothing is fetched", async () => {
  account("user");
  render(<AppRoute path="/journal"><JournalPage /></AppRoute>);
  await settle(6);

  assert.ok(screen.getByRole("heading", { level: 1, name: "Journal" }), "the page keeps its own title");
  assert.equal(screen.getByRole("status").textContent, NOTICE);
  assert.equal(document.querySelector("form"), null, "the filter form must not be drawn");
  assert.equal(screen.queryByLabelText("From"), null);
  assert.equal(screen.queryByRole("alert"), null, "no 'Could not load' failure for a limit that is known");
  assert.equal(body().includes("Could not load"), false);
  assert.deepEqual(pageCalls(), [], "the page asked the server for something");
  const chart = screen.getByRole("button", { name: "Open the chart" }).closest("a");
  assert.equal(chart?.getAttribute("href"), "/chart");
});

test("an ordinary account opening /trading is told the same, and nothing is fetched", async () => {
  account("user");
  tradingFixtures();
  render(<AppRoute path="/trading"><DeploymentsPage /></AppRoute>);
  await settle(6);

  assert.ok(screen.getByRole("heading", { level: 1, name: "Automations" }));
  assert.equal(screen.getByRole("status").textContent, NOTICE);
  assert.equal(screen.queryByRole("button", { name: "+ New automation" }), null,
    "a control that would only be refused must not be offered");
  assert.equal(document.querySelector("form"), null);
  assert.deepEqual(pageCalls(), [], "the page asked the server for something");
  assert.equal(server.callsTo("/api/deployments").length, 0);
  assert.equal(server.callsTo("/api/ops/runner").length, 0);
  const chart = screen.getByRole("button", { name: "Open the chart" }).closest("a");
  assert.equal(chart?.getAttribute("href"), "/chart");
});

test("the administrator gets /journal as before", async () => {
  account("admin");
  render(<AppRoute path="/journal"><JournalPage /></AppRoute>);
  await settle(6);

  assert.ok(screen.getByRole("heading", { level: 1, name: "Journal" }));
  assert.ok(document.querySelector("form"), "the filter form is drawn");
  assert.ok(screen.getByLabelText("From"));
  assert.equal(body().includes(NOTICE), false);
  assert.ok(server.callsTo("/api/journal").length >= 1, "the journal was not read");
});

test("the administrator gets /trading as before", async () => {
  account("admin");
  tradingFixtures();
  render(<AppRoute path="/trading"><DeploymentsPage /></AppRoute>);
  await settle(6);

  assert.ok(screen.getByRole("heading", { level: 1, name: "Automations" }));
  assert.ok(screen.getByRole("button", { name: "+ New automation" }));
  assert.equal(body().includes(NOTICE), false);
  assert.ok(server.callsTo("/api/deployments").length >= 1, "the automations were not read");
});

test("a session that could not be read keeps the page (the backend enforces reach)", async () => {
  // No /api/auth/me route: the fixture answers 404, which reads as an unknown session.
  render(<AppRoute path="/journal"><JournalPage /></AppRoute>);
  await settle(6);

  assert.ok(document.querySelector("form"), "an unknown session must not lock the administrator out");
  assert.equal(body().includes(NOTICE), false);
  assert.ok(server.callsTo("/api/journal").length >= 1);
});
