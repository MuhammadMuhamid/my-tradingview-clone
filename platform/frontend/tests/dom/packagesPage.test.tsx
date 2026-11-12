/**
 * The administrator's Packages page: who can see it, creating a package, and
 * recording money only through the confirmation dialog, once per opened form.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import PackagesPage from "@/app/packages/page";
import { ADMIN_ONLY_PAGE_NOTICE } from "@/components/AdminOnlyPage";
import { resetSessionForTests } from "@/lib/session";
import { account, enterCode, failing } from "./botFixtures";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const COHORT_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER = {
  membershipId: "44444444-4444-4444-8444-444444444444", userId: "u1", email: "alice@example.com", displayName: "Alice",
  status: "approved", requestedAt: "2026-11-20T00:00:00.000Z", capitalIn: "0.00000000", value: "0.00000000", paidOut: "0.00000000",
};
const PACKAGE = {
  id: "55555555-5555-4555-8555-555555555555", name: "Trend 1M", description: "", term: "month", minAmount: "100.00000000",
  tradePercent: "25.00000000", joinInstructions: "", status: "paused", createdAt: "2026-11-13T00:00:00.000Z",
  deployments: [{ id: "d1", symbol: "BTCUSDT" }],
  cohorts: [{ id: COHORT_ID, status: "open", startsAt: "2099-11-30T19:00:00.000Z", endsAt: "2099-12-31T19:00:00.000Z",
    depositCutoffAt: "2099-11-30T19:00:00.000Z", openingCapital: null, closingValue: null, members: 1, requests: 1 }],
};
const DETAIL = {
  id: COHORT_ID, packageId: PACKAGE.id, status: "open", startsAt: "2099-11-30T19:00:00.000Z", endsAt: "2099-12-31T19:00:00.000Z",
  depositCutoffAt: "2099-11-30T19:00:00.000Z", openingCapital: null, closingValue: null, equity: "0.00000000",
  members: [MEMBER, { ...MEMBER, membershipId: "66666666-6666-4666-8666-666666666666", email: "bob@example.com", displayName: "Bob", status: "requested" }],
  entries: [], trades: [],
};

function fixtures(): void {
  server.routes.set("GET /api/admin/packages", () => ({ packages: [PACKAGE] }));
  server.routes.set("GET /api/deployments", () => [{ id: "d2", symbol: "ETHUSDT", timeframe: "15m", status: "active" }]);
  server.routes.set(`GET /api/admin/cohorts/${COHORT_ID}`, () => DETAIL);
}

const body = () => document.body.textContent ?? "";
const adminCalls = () => server.calls.filter((c) => c.path.startsWith("/api/admin"));

async function openCohort(): Promise<void> {
  render(<AppRoute path="/packages"><PackagesPage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: /1 Dec 2099/ }));
  await settle(6);
}

test("an ordinary account gets the notice, and nothing is fetched", async () => {
  account("user");
  fixtures();
  render(<AppRoute path="/packages"><PackagesPage /></AppRoute>);
  await settle(6);
  assert.equal(screen.getByRole("status").textContent, ADMIN_ONLY_PAGE_NOTICE);
  assert.deepEqual(adminCalls(), []);
});

test("the administrator sees packages, their coins and cohorts in Pakistan time", async () => {
  account("admin");
  fixtures();
  render(<AppRoute path="/packages"><PackagesPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getByRole("heading", { name: "Trend 1M" }));
  assert.ok(body().includes("BTCUSDT"));
  assert.ok(body().includes("1 waiting"));
  assert.ok(body().includes("1 Dec 2099"), "a cohort starting at 19:00 UTC on the 30th is the 1st in Karachi");
  assert.ok(body().includes("aren't connected to live trading yet"));
});

test("creating a package sends exactly what the form says", async () => {
  account("admin");
  fixtures();
  let sent: unknown = null;
  server.routes.set("POST /api/admin/packages", (b) => { sent = b; return { id: "new" }; });
  render(<AppRoute path="/packages"><PackagesPage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: "New package" }));
  await settle(2);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Swing 3M" } });
  fireEvent.change(screen.getByLabelText("Term"), { target: { value: "quarter" } });
  fireEvent.click(screen.getByRole("button", { name: "Create package" }));
  await settle(6);
  assert.deepEqual(sent, { name: "Swing 3M", term: "quarter", minAmount: "100", tradePercent: "25", description: "", joinInstructions: "" });
});

test("approving a request and adding a coin call the API, and a refusal is shown", async () => {
  account("admin");
  fixtures();
  const decisions: unknown[] = [];
  server.routes.set("POST /api/admin/memberships/66666666-6666-4666-8666-666666666666/decision", (b) => { decisions.push(b); return { ok: true }; });
  server.routes.set(`POST /api/admin/packages/${PACKAGE.id}/deployments`, failing(409, "That deployment already trades for a package."));
  await openCohort();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await settle(6);
  assert.deepEqual(decisions, [{ approve: true }]);
  fireEvent.change(screen.getByLabelText("Add a coin to Trend 1M"), { target: { value: "d2" } });
  fireEvent.click(screen.getByRole("button", { name: "Add coin" }));
  await settle(6);
  assert.ok(body().includes("That deployment already trades for a package."));
});

test("a deposit is recorded only with the code, and a retry reuses the same key", async () => {
  account("admin");
  fixtures();
  const sent: Record<string, unknown>[] = [];
  let fail = true;
  server.routes.set(`POST /api/admin/memberships/${MEMBER.membershipId}/deposits`, (b) => {
    sent.push(b as Record<string, unknown>);
    if (fail) { fail = false; return failing(400, "That code isn't correct.")(); }
    return { entryId: "1", created: true };
  });
  await openCohort();
  fireEvent.click(screen.getByRole("button", { name: "Record deposit" }));
  await settle(3);
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Amount (USDT)"), { target: { value: "500" } });
  fireEvent.change(within(dialog).getByLabelText(/^Transaction reference/), { target: { value: "trc20-tx-1" } });
  await enterCode(dialog, "Record deposit", "111111");
  assert.ok(within(screen.getByRole("dialog")).getByText(/isn't correct/), "the refusal keeps the dialog open");
  await enterCode(screen.getByRole("dialog"), "Record deposit", "222222");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.code, "111111");
  assert.equal(sent[1]!.code, "222222");
  assert.equal(sent[0]!.amount, "500");
  assert.equal(sent[0]!.reference, "trc20-tx-1");
  assert.equal(sent[0]!.idempotencyKey, sent[1]!.idempotencyKey, "a retry of the same form is the same deposit");
  assert.equal(screen.queryByRole("dialog"), null);
});
