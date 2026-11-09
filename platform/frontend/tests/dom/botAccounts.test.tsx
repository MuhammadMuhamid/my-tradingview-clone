/**
 * /bot/accounts: the list (C15) with balances (C19), the security notice,
 * add/replace through the Bot's own page (C17 → window.location), the typed
 * MAINNET confirmation before a mainnet ticket is minted, remove (C16) with
 * corrected copy and the Bot's refusal, the return landing (C18, then the
 * query is stripped), and capability gating.
 */
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import AccountsPage from "@/app/bot/accounts/page";
import { resetSessionForTests } from "@/lib/session";
import { setCommandPollingForTests } from "@/components/bot/commandRunner";
import { setNavigateForTests } from "@/components/bot/navigate";
import { SECURITY_NOTICE } from "@/components/bot/accountsCopy";
import { account, enterCode, facts, json, panel } from "./botFixtures";

const TESTNET_ID = "77777777-7777-4777-8777-777777777777";
const MAINNET_ID = "78777777-7777-4777-8777-777777777777";
const ENROLLMENT_ID = "79777777-7777-4777-8777-777777777777";
const ALL = ["entries.v1", "bots.v1", "accounts.v1", "enroll.v1"];
const LINK = "https://bot.example.test/enroll#t=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

const ACCOUNTS = [
  { id: TESTNET_ID, name: "Testnet account", exchange: "binance", marketType: "spot", testnet: true,
    createdAt: "2026-11-01T00:00:00.000Z", keyHint: "…a1b2", botsUsing: 1, openTrades: 0 },
  { id: MAINNET_ID, name: "Real money", exchange: "binance", marketType: "spot", testnet: false,
    createdAt: "2026-11-02T00:00:00.000Z", keyHint: null, botsUsing: 0, openTrades: 0 },
];

function fixtures(capabilities: string[] = ALL) {
  server.routes.set("GET /api/bot/control/status", () => ({ ...panel(), facts: { ...facts(), capabilities } }));
  server.routes.set("GET /api/bot/manage/accounts", () => ({ accounts: ACCOUNTS }));
  server.routes.set(`GET /api/bot/manage/accounts/${TESTNET_ID}/balance`, () => ({ usdtFree: 812.5, totalUsdt: 1234.56,
    breakdown: [], cachedAt: "2026-11-09T12:00:00.000Z" }));
  server.routes.set(`GET /api/bot/manage/accounts/${MAINNET_ID}/balance`, () => json(502, { code: "exchange_unavailable",
    error: "The exchange could not be reached." }));
}

let went: string[] = [];
beforeEach(() => {
  resetBrowser(); resetSessionForTests(); went = [];
  setNavigateForTests((url) => went.push(url));
  setCommandPollingForTests({ intervalMs: 25, windowMs: 1_000 });
});
afterEach(() => { setNavigateForTests(null); setCommandPollingForTests(null); });
after(closeBrowser);

const body = () => document.body.textContent ?? "";

async function open(opts: { capabilities?: string[]; query?: string } = {}) {
  account("admin");
  fixtures(opts.capabilities);
  render(<AppRoute path="/bot/accounts" query={opts.query ?? ""}><AccountsPage /></AppRoute>);
  await settle(10);
}

test("the list, balances, the security notice; an exchange failure is said, never a zero", async () => {
  await open();
  assert.ok(body().includes(SECURITY_NOTICE));
  const testnet = document.querySelector(`[data-account="${TESTNET_ID}"]`) as HTMLElement;
  const mainnet = document.querySelector(`[data-account="${MAINNET_ID}"]`) as HTMLElement;
  assert.match(testnet.textContent ?? "", /Testnet/);
  assert.match(testnet.textContent ?? "", /1,234\.56 USDT/);
  assert.match(testnet.textContent ?? "", /812\.50 USDT free/);
  assert.match(testnet.textContent ?? "", /key …a1b2/);
  assert.match(mainnet.textContent ?? "", /Mainnet/);
  assert.match(mainnet.textContent ?? "", /Exchange unavailable/);
  assert.doesNotMatch(mainnet.textContent ?? "", /0\.00 USDT/);
  assert.equal(document.querySelectorAll('input[type="password"]').length, 0, "no key is ever typed here");
});

test("add (testnet): a fresh-code ticket, then the browser goes to the Bot's page; nothing is stored", async () => {
  await open();
  let mint: Record<string, unknown> | null = null;
  server.routes.set("POST /api/bot/manage/enrollments", (payload) => {
    mint = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: mint.requestId,
      result: { enrollmentId: ENROLLMENT_ID, expiresAt: "2026-11-09T12:05:00.000Z", enrollUrl: LINK } });
  });
  fireEvent.change(screen.getByLabelText(/Account name/), { target: { value: "Spare" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue on the Bot…" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog", { name: "Add an exchange account" }), "Open the Bot's page");
  const m = mint as unknown as Record<string, unknown>;
  assert.deepEqual([m.purpose, m.name, m.testnet, "mainnetConfirmation" in m], ["create", "Spare", true, false]);
  assert.deepEqual(went, [LINK]);
});

test("add (mainnet): no ticket until MAINNET is typed exactly", async () => {
  await open();
  fireEvent.click(screen.getByRole("checkbox", { name: "Use Binance testnet" }));
  await settle(1);
  const go = screen.getByRole("button", { name: "Continue on the Bot…" }) as HTMLButtonElement;
  assert.equal(go.disabled, true);
  fireEvent.change(screen.getByLabelText(/Type MAINNET to confirm/), { target: { value: "mainnet" } });
  await settle(1);
  assert.equal(go.disabled, true, "case-sensitive");
  fireEvent.change(screen.getByLabelText(/Type MAINNET to confirm/), { target: { value: "MAINNET" } });
  await settle(1);
  assert.equal(go.disabled, false);
  let mint: Record<string, unknown> | null = null;
  server.routes.set("POST /api/bot/manage/enrollments", (payload) => {
    mint = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: mint.requestId,
      result: { enrollmentId: ENROLLMENT_ID, expiresAt: "2026-11-09T12:05:00.000Z", enrollUrl: LINK } });
  });
  fireEvent.click(go);
  await settle(2);
  assert.match(screen.getByRole("dialog").textContent ?? "", /MAINNET \(real money\)/);
  await enterCode(screen.getByRole("dialog"), "Open the Bot's page");
  assert.deepEqual([(mint as unknown as Record<string, unknown>).testnet, (mint as unknown as Record<string, unknown>).mainnetConfirmation], [false, "MAINNET"]);
});

test("replace keys on a mainnet account asks for MAINNET in the dialog", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Replace keys for Real money" }));
  await settle(3);
  const dialog = screen.getByRole("dialog", { name: "Replace keys for Real money" });
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  await settle(3);
  assert.equal(server.calls.filter((c) => c.path === "/api/bot/manage/enrollments").length, 0, "no ticket without MAINNET");
  let mint: Record<string, unknown> | null = null;
  server.routes.set("POST /api/bot/manage/enrollments", (payload) => {
    mint = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: mint.requestId,
      result: { enrollmentId: ENROLLMENT_ID, expiresAt: "2026-11-09T12:05:00.000Z", enrollUrl: LINK } });
  });
  fireEvent.change(within(dialog).getByLabelText(/Type MAINNET to confirm/), { target: { value: "MAINNET" } });
  await enterCode(dialog, "Open the Bot's page");
  const m = mint as unknown as Record<string, unknown>;
  assert.deepEqual([m.purpose, m.accountId, m.mainnetConfirmation], ["replace", MAINNET_ID, "MAINNET"]);
  assert.deepEqual(went, [LINK]);
});

test("remove: grant tier, corrected copy, and the Bot's refusal explained", async () => {
  await open();
  server.routes.set(`POST /api/bot/manage/accounts/${TESTNET_ID}/delete`, () => json(409, { code: "account_in_use",
    error: "This account is used by 1 bot(s); nothing was removed." }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Testnet account" }));
  await settle(3);
  const dialog = screen.getByRole("dialog", { name: "Remove Testnet account" });
  assert.match(dialog.textContent ?? "", /refuses while any bot, order or open trade still uses/);
  assert.equal(/lose their credentials/.test(dialog.textContent ?? ""), false, "the stale Classic copy is gone");
  await enterCode(dialog, "Remove account");
  assert.ok(body().includes("This exchange account is still in use"));
  const sent = server.calls.find((c) => c.path === `/api/bot/manage/accounts/${TESTNET_ID}/delete`)!;
  assert.equal((sent.body as Record<string, unknown>).confirmation, "REMOVE_ACCOUNT");
});

test("return landing: reads the enrollment from the Bot, says what happened, then strips the query", async () => {
  const replaced: string[] = [];
  const original = window.history.replaceState.bind(window.history);
  window.history.replaceState = ((state: unknown, title: string, url?: string | URL | null) => {
    replaced.push(String(url));
    original(state, title, url);
  }) as typeof window.history.replaceState;
  try {
    server.routes.set(`GET /api/bot/manage/enrollments/${ENROLLMENT_ID}`, () => ({ status: "completed", purpose: "replace",
      accountId: TESTNET_ID, keyHint: "…z9y8", outcome: "ok" }));
    await open({ query: `enrollment=${ENROLLMENT_ID}&status=ok` });
    assert.ok(body().includes("New keys saved for Testnet account (key …z9y8)."));
    assert.equal(replaced.length, 1);
    assert.ok(!replaced[0]!.includes("enrollment="), "the query is gone");

    resetBrowser(); resetSessionForTests(); replaced.length = 0;
    // The status in the URL is never trusted: the Bot's record says it failed.
    server.routes.set(`GET /api/bot/manage/enrollments/${ENROLLMENT_ID}`, () => ({ status: "failed", purpose: "create",
      outcome: "refused:withdrawals_enabled" }));
    await open({ query: `enrollment=${ENROLLMENT_ID}&status=ok` });
    assert.ok(body().includes("The Bot did not save the keys (withdrawals enabled)."));
    assert.equal(replaced.length, 1);

    resetBrowser(); resetSessionForTests(); replaced.length = 0;
    await open({ query: "enrollment=not-an-id&status=ok" });
    assert.ok(body().includes("That return link is not one the Bot issues."));
    assert.equal(server.calls.filter((c) => c.path.startsWith("/api/bot/manage/enrollments/")).length, 0);
  } finally {
    window.history.replaceState = original;
  }
});

test("without accounts.v1 / enroll.v1 the actions are off and say why", async () => {
  await open({ capabilities: ["entries.v1", "bots.v1"] });
  assert.ok(body().includes("Listing exchange accounts from Trading Scene needs a newer Bot"));
  assert.ok(body().includes("Adding an account through the Bot's page needs a newer Bot"));
  assert.equal((screen.getByRole("button", { name: "Continue on the Bot…" }) as HTMLButtonElement).disabled, true);
  assert.equal(server.calls.filter((c) => c.path === "/api/bot/manage/accounts").length, 0, "no read the Bot cannot answer");
});
