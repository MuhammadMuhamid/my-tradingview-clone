/**
 * The chart workstation offers an ordinary account only what it can use.
 *
 * Positions & Orders, the Strategy Tester, the Trade ticket and the strategy
 * list are the administrator's: the server refuses everyone else with "This
 * part of the platform is available to the administrator only." The
 * navigation already hid the admin pages; the chart drew both bottom tabs and
 * the Trade pill for everyone, so an ordinary user met two tabs that could
 * only ever show that refusal. An admin, and a session not yet read, keep all
 * of it.
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

/** Sign in as `role` and let the session be read, as a page navigated to would find it. */
async function signIn(role: "admin" | "user"): Promise<void> {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: true, providers: { google: false, signups: true },
    user: {
      id: role === "admin" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
      email: `${role}@example.test`, displayName: role, avatarUrl: null, role, onboarded: true,
      hasPassword: true, passwordManagedByServer: false, googleLinked: false,
      createdAt: "2026-10-16T00:00:00.000Z",
    },
  }));
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
