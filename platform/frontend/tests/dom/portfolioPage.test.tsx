/**
 * A member's portfolio: their own holdings in plain figures, joining only once
 * the account is secured, and nothing that looks like a promise of returns.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import PortfolioPage from "@/app/portfolio/page";
import { Nav } from "@/components/Nav";
import { resetSessionForTests } from "@/lib/session";
import { failing } from "./botFixtures";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const COHORT = "33333333-3333-4333-8333-333333333333";
const NEXT = "77777777-7777-4777-8777-777777777777";

function member(unlocked: boolean): void {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true,
    user: { id: "22222222-2222-4222-8222-222222222222", email: "alice@example.test", displayName: "Alice",
      avatarUrl: null, role: "user", onboarded: true, hasPassword: true, passwordManagedByServer: false,
      googleLinked: false, githubLinked: false, emailVerified: unlocked, twoFactorEnabled: unlocked,
      moneyFeaturesUnlocked: unlocked, createdAt: "2026-10-16T00:00:00.000Z" },
    providers: { google: false, github: false, signups: true, email: true },
  }));
}

const HOLDING = { packageName: "Trend 1M", cohortId: COHORT, status: "running", startsAt: "2026-11-15T19:00:00.000Z",
  endsAt: "2026-11-30T19:00:00.000Z", capitalIn: "600.00000000", value: "630.00000000", paidOut: "0.00000000" };
const OFFER = { id: "p1", name: "Swing 3M", description: "Slower trend following.", term: "quarter", minAmount: "250.00000000",
  joinInstructions: "Send USDT on TRC20 to the address in your welcome email.",
  nextCohort: { id: NEXT, startsAt: "2099-11-30T19:00:00.000Z", endsAt: "2100-02-28T19:00:00.000Z", depositCutoffAt: "2099-11-30T19:00:00.000Z" } };

function fixtures(over: { holdings?: unknown[]; pending?: unknown[]; packages?: unknown[] } = {}): void {
  server.routes.set("GET /api/portfolio", () => ({ holdings: over.holdings ?? [HOLDING], pending: over.pending ?? [] }));
  server.routes.set("GET /api/packages", () => ({ packages: over.packages ?? [OFFER] }));
}

const body = () => document.body.textContent ?? "";
const open = async () => { render(<AppRoute path="/portfolio"><PortfolioPage /></AppRoute>); await settle(6); };

test("a member sees their holding in the ledger's own figures, with the realized change", async () => {
  member(true);
  fixtures();
  await open();
  assert.ok(screen.getByRole("heading", { name: "Trend 1M" }));
  assert.ok(body().includes("600 USDT"));
  assert.ok(body().includes("630 USDT"));
  assert.ok(body().includes("+5.00%"));
  assert.ok(body().includes("16 Nov 2026 – 30 Nov 2026"), "dates are Karachi calendar dates");
  assert.ok(body().includes("Past performance is not a guarantee"));
  assert.equal(/projected|expected return|guaranteed/i.test(body()), false);
});

test("an approved member with no deposit recorded yet is told so, not shown zeros", async () => {
  member(true);
  fixtures({ holdings: [{ ...HOLDING, status: "open", capitalIn: "0.00000000", value: "0.00000000" }] });
  await open();
  assert.ok(body().includes("Your deposit appears here once the administrator has recorded it"));
  assert.equal(body().includes("You put in"), false, "no figures before money is recorded");
});

test("settling and settled say what's happening", async () => {
  member(true);
  fixtures({ holdings: [{ ...HOLDING, status: "settling" }, { ...HOLDING, cohortId: "x", packageName: "Old", status: "settled" }] });
  await open();
  assert.ok(body().includes("waiting for its open trades to close"));
  assert.ok(body().includes("your payout can be arranged"));
  assert.ok(body().includes("Final value"));
});

test("an account without email verification and two-factor can't ask to join, and is told where to fix it", async () => {
  member(false);
  fixtures();
  await open();
  assert.ok(body().includes("verify your email and turn on two-factor"));
  assert.equal((screen.getByRole("button", { name: "Ask to join" }) as HTMLButtonElement).disabled, true);
  assert.equal(screen.getByRole("link", { name: "Open your profile" }).getAttribute("href"), "/profile");
});

test("asking to join shows the deadline and instructions, sends one request, and then says it's waiting", async () => {
  member(true);
  let joined = 0;
  fixtures();
  server.routes.set(`POST /api/packages/cohorts/${NEXT}/join`, () => { joined++; return { membershipId: "m1" }; });
  await open();
  assert.ok(body().includes("Send USDT on TRC20"));
  assert.ok(body().includes("30 Nov 2099, 23:59 PKT"), "the deadline is the last minute that counts");
  fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
  fixtures({ pending: [{ membershipId: "m1", status: "requested", cohortId: NEXT, packageName: "Swing 3M" }] });
  await settle(6);
  assert.equal(joined, 1);
  assert.ok(body().includes("You've asked to join"));
  assert.equal(screen.queryByRole("button", { name: "Ask to join" }), null);
});

test("a refused request says why", async () => {
  member(true);
  fixtures();
  server.routes.set(`POST /api/packages/cohorts/${NEXT}/join`, failing(409, "This cohort isn't taking new members. Choose the next one."));
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Ask to join" }));
  await settle(6);
  assert.match(screen.getByRole("alert").textContent ?? "", /isn't taking new members/);
});

test("nothing open, nothing held, each says so", async () => {
  member(true);
  fixtures({ holdings: [], packages: [] });
  await open();
  assert.ok(body().includes("You haven't joined a package yet."));
  assert.ok(body().includes("No packages are open right now."));
});

test("every signed-in account reaches it from the account menu", async () => {
  member(false);
  render(<AppRoute path="/alerts"><Nav /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: /go to another part of the application/ }));
  await settle(3);
  const link = within(screen.getByRole("menu")).getByRole("menuitem", { name: "My portfolio" });
  assert.equal(link.getAttribute("href"), "/portfolio");
});
