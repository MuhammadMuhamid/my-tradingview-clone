/**
 * The chart workstation offers an ordinary account only what it can use.
 *
 * Positions & Orders, the Strategy Tester, the Trade ticket and the strategy
 * list are the administrator's: the server refuses everyone else with "This
 * part of the platform is available to the administrator only." The
 * navigation already hid the admin pages; the chart drew both bottom tabs and
 * the Trade pill for everyone, so an ordinary user met two tabs that could
 * only ever show that refusal. An admin (and an instance without accounts)
 * keeps all of it. A session that could not be read is not assumed to be the
 * administrator's: like one still being read, it is offered nothing
 * admin-only. While the session is still being READ the chart offers none
 * of it — nothing admin-only flashes for an ordinary account — and nothing it
 * hides is forgotten: the administrator's stored tab is still theirs once the
 * answer is in.
 */
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { api } from "@/lib/api";
import { loadSession, resetSessionForTests } from "@/lib/session";

const realManualState = api.manualState;
const realListStrategies = api.listStrategies;
let reads: string[] = [];

beforeEach(() => {
  resetBrowser();
  resetSessionForTests();
  reads = [];
  // Counted at the client, because the refusal is local: an ordinary
  // account's admin-only read never reaches the network to be seen there.
  api.manualState = (...args) => { reads.push("manualState"); return realManualState(...args); };
  api.listStrategies = () => { reads.push("listStrategies"); return realListStrategies(); };
});
afterEach(() => {
  api.manualState = realManualState;
  api.listStrategies = realListStrategies;
});
after(closeBrowser);

/** Answer the session read as `role` — without reading it yet. */
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

/** Sign in as `role` and let the session be read, as a page navigated to would find it. */
async function signIn(role: "admin" | "user"): Promise<void> {
  account(role);
  // Before anything is stored: a first sign-in clears another account's cache.
  await loadSession();
}

async function openBottomPanel(container: HTMLElement): Promise<HTMLElement> {
  fireEvent.keyDown(document, { key: "p", altKey: true, shiftKey: true });
  await settle();
  const strip = container.querySelector<HTMLElement>('[role="tablist"][aria-label="Bottom workstation"]');
  assert.ok(strip, "setup: the bottom panel would not open");
  return strip;
}

const tabs = (strip: HTMLElement): string[] =>
  [...strip.querySelectorAll('[role="tab"]')].map((t) => (t.textContent ?? "").trim());
const selected = (strip: HTMLElement): string[] =>
  [...strip.querySelectorAll('[role="tab"][aria-selected="true"]')].map((t) => (t.textContent ?? "").trim());
const tradePill = (container: HTMLElement): Element | null =>
  container.querySelector('[data-toolbar-control="trade"]');
/** The right rail's Automations and order-ticket cells (`ChartSidePanel`). */
const automationsCell = (container: HTMLElement): Element | null =>
  container.querySelector('button[aria-label="Automations"]');
const ticketCell = (container: HTMLElement): Element | null =>
  container.querySelector('button[aria-label="Paper / demo / testnet order ticket"]');

test("an ordinary account sees the Pine Editor alone, and nothing it would be refused", async () => {
  await signIn("user");
  const chart = await mountChart();
  await settle();
  const strip = await openBottomPanel(chart.container);

  assert.deepEqual(tabs(strip), ["Pine Editor"]);
  assert.deepEqual(selected(strip), ["Pine Editor"]);
  assert.doesNotMatch(chart.container.textContent ?? "", /administrator only/,
    "the refusal is still reaching the screen");
  assert.equal(tradePill(chart.container), null, "the Trade ticket is still offered");
  assert.deepEqual(reads, [], "admin-only reads still start for an ordinary account");
});

test("a stored admin-only tab falls back to the editor for an ordinary account", async () => {
  await signIn("user");
  window.localStorage.setItem("tv.bottomTab", "tester");
  const chart = await mountChart();
  await settle();
  const strip = await openBottomPanel(chart.container);

  assert.deepEqual(tabs(strip), ["Pine Editor"]);
  assert.deepEqual(selected(strip), ["Pine Editor"]);
});

test("the administrator keeps all three tabs, the stored one, and Trade", async () => {
  await signIn("admin");
  window.localStorage.setItem("tv.bottomTab", "tester");
  const chart = await mountChart();
  await settle();
  const strip = await openBottomPanel(chart.container);

  assert.deepEqual(tabs(strip), ["Positions & Orders", "Strategy Tester", "Pine Editor"]);
  assert.deepEqual(selected(strip), ["Strategy Tester"]);
  assert.ok(tradePill(chart.container), "the administrator lost the Trade ticket");
  assert.ok(reads.includes("manualState") && reads.includes("listStrategies"),
    "the administrator's reads did not start");
});

/** The ⋯ dropdown's row that opens the secondary strip, by what it says. */
async function stripToggleLabel(container: HTMLElement): Promise<string> {
  const more = container.querySelector<HTMLElement>('button[aria-label="More controls"]');
  assert.ok(more, "setup: the ⋯ cell is missing");
  fireEvent.click(more);
  await settle();
  const toggle = container.querySelector<HTMLElement>('#chart-toolbar-overflow button[aria-controls="chart-toolbar-more"]');
  assert.ok(toggle, "setup: the ⋯ dropdown has no row for the secondary strip");
  const label = (toggle.textContent ?? "").trim();
  fireEvent.click(more);
  await settle();
  return label;
}

test("an unknown session offers nothing admin-only, then the administrator gets it all back", async () => {
  account("admin");
  window.localStorage.setItem("tv.bottomTab", "tester");
  const release = server.hold("/api/auth/me");
  const chart = await mountChart();
  await settle();
  const strip = await openBottomPanel(chart.container);

  assert.deepEqual(tabs(strip), ["Pine Editor"], "an admin-only tab was offered before the role was known");
  assert.equal(tradePill(chart.container), null, "the Trade ticket flashed before the role was known");
  assert.equal(automationsCell(chart.container), null, "the rail's Automations flashed before the role was known");
  assert.equal(ticketCell(chart.container), null, "the rail's order ticket flashed before the role was known");
  assert.equal(await stripToggleLabel(chart.container), "History depth");
  assert.doesNotMatch(chart.container.textContent ?? "", /administrator only/,
    "a refusal was shown for a question still being answered");
  // A copy: `deepEqual` narrows its argument, and `reads` is read again below.
  assert.deepEqual([...reads], [], "admin-only reads started before the role was known");

  release();
  await settle(6);
  assert.deepEqual(tabs(strip), ["Positions & Orders", "Strategy Tester", "Pine Editor"]);
  assert.deepEqual(selected(strip), ["Strategy Tester"], "the administrator's stored tab was lost");
  assert.ok(tradePill(chart.container), "the Trade ticket did not appear once the role was known");
  assert.ok(automationsCell(chart.container), "the rail's Automations did not appear once the role was known");
  assert.ok(ticketCell(chart.container), "the rail's order ticket did not appear once the role was known");
  assert.equal(await stripToggleLabel(chart.container), "History, overlays & automation");
  assert.ok(reads.includes("manualState") && reads.includes("listStrategies"),
    "the administrator's reads did not start once the role was known");
});

test("an unknown session that resolves to an ordinary account stays without admin-only controls", async () => {
  account("user");
  const release = server.hold("/api/auth/me");
  const chart = await mountChart();
  await settle();
  const strip = await openBottomPanel(chart.container);
  assert.deepEqual(tabs(strip), ["Pine Editor"], "an admin-only tab was offered before the role was known");
  assert.equal(tradePill(chart.container), null);
  assert.equal(automationsCell(chart.container), null, "the rail's Automations flashed before the role was known");
  assert.equal(ticketCell(chart.container), null, "the rail's order ticket flashed before the role was known");

  release();
  await settle(6);
  assert.deepEqual(tabs(strip), ["Pine Editor"]);
  assert.equal(tradePill(chart.container), null);
  assert.equal(automationsCell(chart.container), null, "Automations for a known user");
  assert.equal(ticketCell(chart.container), null, "the order ticket for a known user");
  assert.doesNotMatch(chart.container.textContent ?? "", /administrator only/);
  assert.deepEqual(reads, [], "admin-only reads started for a user");
});

test("the ⋯ row names what an ordinary account's strip holds: the history depth alone", async () => {
  await signIn("user");
  const chart = await mountChart();
  await settle();
  assert.equal(await stripToggleLabel(chart.container), "History depth");
});

/*
 * A session read that FAILED is not the administrator's. It used to be: a 500
 * or a dropped request resolved to "admin", and an ordinary account was drawn
 * the Trade ticket, the Automations and order-ticket rail cells and the
 * administrator's bottom tabs. Not knowing who is signed in offers nothing
 * admin-only — the same neutral set as a read still in flight.
 */
async function assertNothingAdminOnly(container: HTMLElement, why: string): Promise<void> {
  const strip = await openBottomPanel(container);
  assert.deepEqual(tabs(strip), ["Pine Editor"], `an admin-only tab was offered ${why}`);
  assert.equal(tradePill(container), null, `the Trade ticket was offered ${why}`);
  assert.equal(automationsCell(container), null, `the rail's Automations was offered ${why}`);
  assert.equal(ticketCell(container), null, `the rail's order ticket was offered ${why}`);
  assert.equal(await stripToggleLabel(container), "History depth");
  assert.deepEqual([...reads], [], `admin-only reads started ${why}`);
}

test("a session read that answered 500 offers no Trade, no admin tabs and no admin rail cells", async () => {
  server.routes.set("GET /api/auth/me", () => new Response("upstream down", { status: 500 }));
  await loadSession();
  const chart = await mountChart();
  await settle(6);
  await assertNothingAdminOnly(chart.container, "for a session that answered 500");
});

test("a session read that never reached the server offers no Trade and no admin tabs either", async () => {
  server.offline = true;
  await loadSession();
  server.offline = false;
  const chart = await mountChart();
  await settle(6);
  await assertNothingAdminOnly(chart.container, "for a session read that failed on the network");
});

test("an instance without accounts is the administrator's: Trade and all three tabs", async () => {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: false, authEnabled: false, user: null, providers: { google: false, signups: true },
  }));
  await loadSession();
  const chart = await mountChart();
  await settle(6);
  const strip = await openBottomPanel(chart.container);
  assert.deepEqual(tabs(strip), ["Positions & Orders", "Strategy Tester", "Pine Editor"]);
  assert.ok(tradePill(chart.container), "an instance without accounts lost the Trade ticket");
});
