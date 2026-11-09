/**
 * /bot after the browser acceptance walkthrough (2026-11-09):
 *
 * - D-1: under React StrictMode (what `next dev` runs) every command outcome
 *   was dropped, because a ref only ever cleared in an effect cleanup stayed
 *   false after StrictMode's mount → unmount → mount.
 * - D-2: a profitable window was shown as "Daily loss 1.29 USDT". The limit
 *   counts the net realised LOSS (a profit counts as 0); signed P&L is shown
 *   separately and labelled as such.
 * - D-5: an `sr-only` header with no positioned ancestor escaped its scroll
 *   container and lengthened the document.
 * - The classic appearance says, in the light theme, that it does nothing there.
 * - H2: the /bot server HTML hydrates without a mismatch, even with the
 *   classic preference stored.
 */
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { advance, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import BotPage from "@/app/bot/page";
import OperationsPage from "@/app/operations/page";
import { resetSessionForTests } from "@/lib/session";
import { setCommandPollingForTests } from "@/components/bot/commandRunner";
import { BOT_APPEARANCE_KEY } from "@/components/bot/classicAppearance";
import { account, botFixtures, enterCode, json, page, panel, TRADE, TRADE_ID } from "./botFixtures";

beforeEach(() => {
  resetBrowser(); resetSessionForTests(); server.interpose(null);
  setCommandPollingForTests({ intervalMs: 25, windowMs: 2_000 });
});
afterEach(() => {
  setCommandPollingForTests(null);
  delete document.documentElement.dataset.theme;
});
after(closeBrowser);

const body = () => document.body.textContent ?? "";

async function confirmClose() {
  fireEvent.click(screen.getAllByRole("button", { name: "Close BTCUSDT" })[0]!);
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Close BTCUSDT" });
  await enterCode(dialog, "Close trade");
}

test("D-1: under StrictMode a refusal and an unknown outcome are still shown, and C8 is still polled", async () => {
  account("admin");
  botFixtures();
  let answer: "refused" | "uncertain" = "refused";
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`, (payload) => {
    const requestId = (payload as { requestId: string }).requestId;
    return answer === "refused"
      ? json(422, { code: "bot_paused", error: "The bot is paused." })
      : json(202, { status: "uncertain", requestId });
  });
  let asked = 0;
  server.interpose((call) => {
    if (call.path.startsWith("/api/bot/control/commands/")) {
      asked += 1;
      server.routes.set(`GET ${call.path}`, () => json(200, { requestId: "x", kind: "trade_close", status: "succeeded",
        result: { status: "ok" } }));
    }
  });
  render(<StrictMode><AppRoute path="/bot"><BotPage /></AppRoute></StrictMode>);
  await settle(6);

  await confirmClose();
  assert.match(screen.getByRole("alert").textContent ?? "", /This trade's bot is stopped/);

  answer = "uncertain";
  await confirmClose();
  await advance(200);
  assert.ok(asked >= 1, "C8 was asked");
  assert.ok(body().includes("The close went through the Bot's exit path."));
});

test("D-2: a profitable window counts 0 loss, and the signed P&L is labelled as P&L", async () => {
  account("admin");
  botFixtures({ panel: panel({}, { realisedPnlInWindow: 1.29 }) });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const text = body();
  assert.ok(text.includes("Daily loss 0 USDT of 50 USDT over 24h (realised P&L +1.29 USDT)"), "the strip");
  assert.ok(!/Daily loss \+?1\.29/.test(text), "a profit is never shown as a loss");
  const card = screen.getByRole("heading", { name: "Risk limits" }).closest(".rounded-md") as HTMLElement;
  assert.ok(within(card).getByText(/Daily loss counted by the limit/));
  assert.ok((card.textContent ?? "").includes("0 USDT of 50 USDT"));
  assert.ok(within(card).getByText(/Realised P&L \(rolling 24 h, signed\)/));
  assert.ok((card.textContent ?? "").includes("+1.29 USDT"));
});

test("D-2: a losing window counts the loss as a positive amount, and the P&L is negative", async () => {
  account("admin");
  botFixtures({ panel: panel({}, { realisedPnlInWindow: -5 }) });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(body().includes("Daily loss 5 USDT of 50 USDT over 24h (realised P&L −5.00 USDT)"));
  const card = screen.getByRole("heading", { name: "Risk limits" }).closest(".rounded-md") as HTMLElement;
  assert.ok((card.textContent ?? "").includes("5 USDT of 50 USDT"));
  assert.ok((card.textContent ?? "").includes("−5.00 USDT"));
});

test("A3: open trades and exposure say they include pending entries", async () => {
  account("admin");
  botFixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(body().includes("Open trades incl. pending entries 1 / 3"));
  assert.ok(body().includes("Exposure incl. pending entries 100 USDT"));
  assert.ok(body().includes("the trades list shows booked trades only"));
});

/**
 * An `sr-only` element is `position: absolute`. Every one on these pages must
 * have a positioned ancestor at or inside its nearest scroll container, or it
 * is placed against the page and can lengthen the document (D-5). jsdom lays
 * nothing out, so the rule is checked on the classes that decide it.
 */
function unanchoredSrOnly(root: Element): string[] {
  const problems: string[] = [];
  for (const el of root.querySelectorAll(".sr-only")) {
    let anchored = false;
    for (let node = el.parentElement; node && node !== root.parentElement; node = node.parentElement) {
      const cls = node.classList;
      if (["relative", "absolute", "fixed", "sticky"].some((c) => cls.contains(c))) { anchored = true; break; }
      if ([...cls].some((c) => /^overflow(-[xy])?-(auto|scroll|hidden)$/.test(c))) break;
    }
    if (!anchored) problems.push(el.outerHTML.slice(0, 80));
  }
  return problems;
}

test("D-5: no sr-only element on /bot can escape its scroll container", async () => {
  account("admin");
  botFixtures({ trades: () => page([TRADE]) });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(document.querySelectorAll(".sr-only").length >= 1, "the trades table has its sr-only Actions header");
  assert.deepEqual(unanchoredSrOnly(document.body), []);
});

test("D-5: nor in the Operations Bot panel", async () => {
  account("admin");
  server.routes.set("GET /api/ops/status", () => ({
    mode: "DISABLED", emitter: { thisProcess: "p", liveRunnerEnabled: false, holdsLease: false, lease: null },
    risk: { tradingHalted: false, haltedReason: null, haltedBy: null, haltedAt: null, maxTotalExposureQuote: null,
      maxConcurrentPositions: null, maxDailyLossQuote: null, dailyLossWindowHours: 24,
      snapshot: { currentExposureQuote: 0, openPositions: 0, realisedPnlInWindow: null }, summary: "",
      dailyLossControl: { state: "DISABLED_UNFED", authority: "BOT", note: "" } },
    bot: { state: "CONNECTED", configuredEndpoints: 1, status: panel().facts!.operational },
    botControl: panel(),
    database: { ready: true, checks: { database: "ok", schema: "current" }, schema: { expected: 1, applied: 1, missing: [] },
      time: "2026-11-09T12:00:00.000Z" },
    alertRunner: { state: "disabled", active: 0, recent: 0, stale: 0, withoutEvidence: 0, lastEvaluatedAt: null, reason: "" },
    deployments: { total: 0, active: 0, long: 0, paused: 0, paper: 0, automated: 0, signalOnly: 0 },
    delivery: { state: "idle", summary: "", windowHours: 24, counts: { pending: 0, sent: 0, failed: 0, skipped: 0, blocked: 0 },
      total: 0, lastSentAt: null, lastFailureAt: null, stuckPending: 0, retried: 0 },
    exchange: { testnetConfigured: true, note: "" }, feeds: { worst: "live", rows: [] }, time: "2026-11-09T12:00:00.000Z",
  }));
  render(<AppRoute path="/operations"><OperationsPage /></AppRoute>);
  await settle(8);
  const card = screen.getByRole("heading", { name: /Execution bot — authoritative/ }).closest(".rounded-md") as HTMLElement;
  assert.deepEqual(unanchoredSrOnly(card), []);
});

test("classic appearance in the light theme: says it does nothing there, and keeps the stored choice", async () => {
  window.localStorage.setItem(BOT_APPEARANCE_KEY, "classic");
  document.documentElement.dataset.theme = "light";
  account("admin");
  botFixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const box = screen.getByRole("checkbox", { name: "Classic Bot appearance" }) as HTMLInputElement;
  assert.equal(box.disabled, true);
  assert.equal(box.checked, true, "the choice is kept");
  assert.ok(body().includes("Dark theme only: no effect in the light theme. Your choice is kept."));
  assert.equal(window.localStorage.getItem(BOT_APPEARANCE_KEY), "classic");

  document.documentElement.dataset.theme = "dark";
  await settle(2);
  assert.equal((screen.getByRole("checkbox", { name: "Classic Bot appearance" }) as HTMLInputElement).disabled, false);
});

test("H2: the /bot server HTML hydrates without a mismatch, even with the classic preference stored", async () => {
  window.localStorage.setItem(BOT_APPEARANCE_KEY, "classic");
  account("admin");
  botFixtures();
  const tree = <AppRoute path="/bot"><BotPage /></AppRoute>;
  const html = renderToString(tree);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: string[] = [];
  let root: ReturnType<typeof hydrateRoot> | null = null;
  await act(async () => {
    root = hydrateRoot(container, tree, { onRecoverableError: (error) => errors.push(String((error as Error).message ?? error)) });
  });
  await settle(8);
  assert.deepEqual(errors, [], "no hydration mismatch");
  assert.ok(container.querySelector('[data-bot-appearance="classic"]'), "the stored preference applies after hydration");
  await act(async () => { root?.unmount(); });
  container.remove();
});
