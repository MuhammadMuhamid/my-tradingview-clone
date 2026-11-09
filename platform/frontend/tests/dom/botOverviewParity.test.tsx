/**
 * /bot overview parity with the Classic dashboard (2026-11-09): the pause
 * card's two halves, capability gating, the 2FA banner, the bots table with
 * its chips and empty state, the start summary, trade columns, the history
 * summary ("Worst trade", over the loaded rows), the partial-close presets
 * and preview, Close on paused/delisted/twin trades, the race-fill label and
 * the silent 15 s refresh that stops while the tab is hidden.
 */
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { advance, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import BotPage from "@/app/bot/page";
import { resetSessionForTests } from "@/lib/session";
import { setCommandPollingForTests } from "@/components/bot/commandRunner";
import { setBotPollMsForTests } from "@/components/bot/polling";
import { RACE_FILL_LABEL } from "@/components/bot/BotTrades";
import type { BotControlPanel } from "@/lib/api";
import { account, BOT, botFixtures, facts, json, MANUAL_TRADE, page, panel, TRADE, TRADE_ID } from "./botFixtures";

const ALL_CAPS = ["entries.v1", "operatorExit.v1", "manualPositionFull.v1", "bots.v1", "accounts.v1", "enroll.v1"];

function capPanel(capabilities: string[] | undefined, extra: Partial<NonNullable<BotControlPanel["facts"]>> = {},
  over: Partial<BotControlPanel> = {}): BotControlPanel {
  const base = panel(over);
  return { ...base, platformEntries: { paused: false, pausedAt: null, pausedBy: null, reason: null },
    facts: { ...facts(), ...(capabilities ? { capabilities } : {}),
      entries: { paused: false, pausedAt: null, pausedBy: null, reason: null, workingEntryLimits: 2, unresolvedBuyIntents: 0 },
      ...extra },
    ...over };
}

beforeEach(() => {
  resetBrowser(); resetSessionForTests(); setCommandPollingForTests({ intervalMs: 25, windowMs: 2_000 });
});
afterEach(() => { setCommandPollingForTests(null); setBotPollMsForTests(null); });
after(closeBrowser);

const body = () => document.body.textContent ?? "";

async function open(opts: Parameters<typeof botFixtures>[0] = {}, twoFactorEnabled = true) {
  account("admin", { twoFactorEnabled });
  botFixtures(opts);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
}

async function codeAndConfirm(dialog: HTMLElement, button: string) {
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  fireEvent.click(within(dialog).getByRole("button", { name: button }));
  await settle(6);
}

test("pause card: the two halves are shown separately, and cancelling working entries is an explicit opt-in", async () => {
  await open({ panel: capPanel(ALL_CAPS) });
  const platformHalf = document.querySelector('[data-entries-half="platform"]')!;
  const botHalf = document.querySelector('[data-entries-half="bot"]')!;
  assert.match(platformHalf.textContent ?? "", /Platform half · not paused/);
  assert.match(botHalf.textContent ?? "", /Bot half · not paused/);
  assert.match(botHalf.textContent ?? "", /2 working entry orders/);

  const sent: Record<string, unknown>[] = [];
  server.routes.set("POST /api/bot/control/entries", (payload) => {
    sent.push(payload as Record<string, unknown>);
    return json(200, { platform: { paused: true, at: "2026-11-09T12:00:00.000Z", by: "u", reason: "news", changed: true },
      bot: { httpStatus: 200, status: "succeeded", requestId: (payload as { requestId: string }).requestId,
        result: { entries: { paused: true }, changed: true,
          canceledEntries: [{ orderId: "o-1", symbol: "BTCUSDT", outcome: "canceled" }, { orderId: "o-2", symbol: "ETHUSDT", outcome: "unknown" }] } } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Pause new entries…" }));
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Pause new entries" });
  const box = within(dialog).getByRole("checkbox", { name: "Also cancel 2 working entry orders" }) as HTMLInputElement;
  assert.equal(box.checked, false, "off by default");
  const confirm = within(dialog).getByRole("button", { name: "Pause entries" }) as HTMLButtonElement;
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  assert.equal(confirm.disabled, true, "a reason is required");
  fireEvent.change(within(dialog).getByLabelText(/Reason for pausing/), { target: { value: "news" } });
  fireEvent.click(box);
  fireEvent.click(confirm);
  await settle(6);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.paused, sent[0]!.reason, sent[0]!.cancelWorkingEntries], [true, "news", true]);
  const outcome = screen.getByRole("region", { name: "Pause outcome" });
  assert.match(outcome.textContent ?? "", /Platform half: paused\./);
  assert.match(outcome.textContent ?? "", /Bot half: paused\./);
  assert.match(outcome.textContent ?? "", /BTCUSDT order o-1: cancelled/);
  assert.match(outcome.textContent ?? "", /ETHUSDT order o-2: outcome unknown/);
});

test("pause card: an uncertain Bot half is shown as unknown and checked, never as paused", async () => {
  await open({ panel: capPanel(ALL_CAPS) });
  let requestId = "";
  server.routes.set("POST /api/bot/control/entries", (payload) => {
    requestId = (payload as { requestId: string }).requestId;
    // C8 keeps saying "processing" for the whole window: the half stays unknown.
    server.routes.set(`GET /api/bot/control/commands/${requestId}`,
      () => json(200, { requestId, kind: "entries", status: "processing" }));
    return json(200, { platform: { paused: true, at: "2026-11-09T12:00:00.000Z", changed: true },
      bot: { httpStatus: 202, status: "uncertain", requestId } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Pause new entries…" }));
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Pause new entries" });
  fireEvent.change(within(dialog).getByLabelText(/Reason for pausing/), { target: { value: "maintenance" } });
  await codeAndConfirm(dialog, "Pause entries");
  let outcome = screen.getByRole("region", { name: "Pause outcome" });
  assert.match(outcome.textContent ?? "", /Platform half: paused\./);
  assert.match(outcome.textContent ?? "", /Bot half: outcome unknown, checking/);
  assert.doesNotMatch(outcome.textContent ?? "", /Bot half: paused/);
  await advance(2_200);
  outcome = screen.getByRole("region", { name: "Pause outcome" });
  assert.match(outcome.textContent ?? "", /Bot half: outcome still unknown/);
  assert.ok(server.calls.some((c) => c.path === `/api/bot/control/commands/${requestId}`), "C8 asked with the same id");
});

test("pause card: a Bot without entries.v1 disables pausing and says why", async () => {
  await open({ panel: capPanel(["bots.v1"]) });
  const pause = screen.getByRole("button", { name: "Pause new entries…" }) as HTMLButtonElement;
  assert.equal(pause.disabled, true);
  assert.ok(body().includes("Pausing new entries needs a newer Bot"));
});

test("pause card: shows the daily-loss latch while paused", async () => {
  const p = capPanel(ALL_CAPS, { entries: { paused: true, pausedAt: "2026-11-09T11:00:00.000Z", pausedBy: "u", reason: "news" } });
  p.facts!.risk = { ...p.facts!.risk, latched: true };
  await open({ panel: p });
  assert.match(document.querySelector('[data-entries-half="bot"]')!.textContent ?? "", /Bot half · paused/);
  assert.ok(body().includes("The daily-loss limit is latched"));
  assert.ok(screen.getByRole("button", { name: "Resume new entries…" }));
});

test("the two-factor banner appears only while two-factor is off", async () => {
  await open({ panel: capPanel(ALL_CAPS) }, false);
  assert.ok(body().includes("Turn on two-factor to operate the Bot."));
  assert.equal(screen.getAllByRole("link", { name: /Turn it on in your profile/ })[0]!.getAttribute("href"), "/profile");
  resetBrowser(); resetSessionForTests();
  await open({ panel: capPanel(ALL_CAPS) }, true);
  assert.equal(body().includes("Turn on two-factor to operate the Bot."), false);
});

test("bots: columns, the open-trade cap, filter chips, and Edit only with bots.v1", async () => {
  const stopped = { ...BOT, id: "55555555-5555-4555-8555-555555555555", name: "Range bot", status: "paused",
    maxActiveSmartTrades: 3, activeTrades: 1, account: null };
  account("admin");
  botFixtures({ panel: capPanel(ALL_CAPS) });
  server.routes.set("GET /api/bot/bots", () => [BOT, stopped]);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const table = document.querySelector('[data-bots-layout="desktop"]') as HTMLElement;
  const row = table.querySelector(`[data-bot-row="${stopped.id}"]`) as HTMLElement;
  assert.match(row.textContent ?? "", /1 \/ 3 open/);
  assert.match(row.textContent ?? "", /No account/);
  assert.match(row.textContent ?? "", /5% of balance/);
  assert.ok(within(table).getByRole("link", { name: "Edit Range bot" }).getAttribute("href")!.endsWith(stopped.id));
  fireEvent.click(screen.getByRole("button", { name: "Show stopped bots (1)" }));
  await settle(2);
  assert.equal(table.querySelector(`[data-bot-row="${BOT.id}"]`), null, "the active bot is filtered out");
  assert.ok(table.querySelector(`[data-bot-row="${stopped.id}"]`));
  assert.ok(screen.getAllByRole("link", { name: "Create bot" }).length >= 1);
});

test("bots: an older Bot (no bots.v1) offers no Create or Edit, and says why", async () => {
  account("admin");
  botFixtures({ panel: capPanel(["entries.v1"]) });
  server.routes.set("GET /api/bot/bots", () => []);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(body().includes("No bots yet."));
  assert.equal(screen.queryByRole("link", { name: /Create/ }), null);
  assert.ok(body().includes("Creating and editing bots from Trading Scene needs a newer Bot"));
});

test("bots: with bots.v1 the empty state offers Create", async () => {
  account("admin");
  botFixtures({ panel: capPanel(ALL_CAPS) });
  server.routes.set("GET /api/bot/bots", () => []);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.equal(screen.getByRole("link", { name: "Create a signal bot" }).getAttribute("href"), "/bot/bots/new");
});

test("Start shows the pairs, the size and the guards, NO STOP LOSS in capitals", async () => {
  account("admin");
  botFixtures({ panel: capPanel(ALL_CAPS) });
  server.routes.set("GET /api/bot/bots", () => [{ ...BOT, status: "paused", stopLossPct: null, exitEnabled: false }]);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getAllByRole("button", { name: "Start Trend bot" })[0]!);
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Start Trend bot" });
  const text = dialog.textContent ?? "";
  assert.match(text, /BTCUSDT, ETHUSDT/);
  assert.match(text, /5% of balance per entry/);
  assert.match(text, /NO STOP LOSS/);
  assert.match(text, /EXITS DISABLED/);
  assert.match(text, /dry run/);
});

test("trades: account, age, partial count, reason badges, and a history summary of the loaded rows", async () => {
  const closedRows = [
    { ...TRADE, id: "c1", status: "closed", closedAt: "2026-10-21T00:00:00.000Z", closedReason: "stop_loss", pnlUsdt: -6, pnlPct: -6, partialCloses: 2 },
    { ...TRADE, id: "c2", status: "closed", closedAt: "2026-10-22T00:00:00.000Z", closedReason: "take_profit", pnlUsdt: 9, pnlPct: 9, pair: "ETHUSDT" },
    { ...TRADE, id: "c3", status: "closed", closedAt: "2026-10-23T00:00:00.000Z", closedReason: "signal_exit", pnlUsdt: -2, pnlPct: -2, pair: "SOLUSDT" },
  ];
  await open({ panel: capPanel(ALL_CAPS), trades: (url) => url.searchParams.get("status") === "closed" ? page(closedRows, 120) : page([TRADE]) });
  const desktop = document.querySelector('[data-layout="desktop"]') as HTMLElement;
  assert.match(desktop.textContent ?? "", /Testnet account \(testnet\)/);
  assert.match(desktop.textContent ?? "", /open \d+d/);
  fireEvent.click(screen.getByRole("button", { name: "Trade history" }));
  await settle(6);
  const summary = screen.getByRole("region", { name: "History summary" });
  assert.match(summary.textContent ?? "", /Summary of the 3 trades on this page \(of 120\)/);
  assert.match(summary.textContent ?? "", /Worst trade/);
  assert.match(summary.textContent ?? "", /−6\.0000 USDT/);
  assert.match(summary.textContent ?? "", /Net P&L\+1\.0000 USDT/);
  assert.equal(/drawdown/i.test(body()), false, "never called a drawdown");
  const table = document.querySelector('[data-layout="desktop"]') as HTMLElement;
  for (const label of ["Stop loss", "Take profit", "Signal exit"]) assert.ok(within(table).getByText(label), label);
  assert.match(table.textContent ?? "", /2 partial closes/);
  assert.match(table.textContent ?? "", /held 1d/);
  fireEvent.click(within(summary).getByRole("button", { name: "Hide" }));
  await settle(1);
  assert.equal(within(summary).queryByText("Worst trade"), null);
});

test("partial close: presets, slider and an estimated preview; the chosen whole percentage is sent", async () => {
  await open({ panel: capPanel(ALL_CAPS) });
  let sent: Record<string, unknown> | null = null;
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/partial-close`, (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId, result: { requestedQty: 0.75, executedQty: 0.75 } });
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Partial close BTCUSDT" })[0]!);
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Partial close BTCUSDT" });
  assert.equal(within(dialog).getByRole("button", { name: "50%" }).getAttribute("aria-pressed"), "true", "50% to start");
  fireEvent.click(within(dialog).getByRole("button", { name: "75%" }));
  await settle(1);
  const preview = within(dialog).getByLabelText("Preview");
  assert.match(preview.textContent ?? "", /Selling0\.75/);
  assert.match(dialog.textContent ?? "", /An estimate at the last price/);
  const slider = within(dialog).getByRole("slider") as HTMLInputElement;
  assert.equal(slider.value, "75");
  fireEvent.change(slider, { target: { value: "33" } });
  await settle(1);
  assert.equal(slider.getAttribute("aria-valuetext"), "33 percent");
  await codeAndConfirm(dialog, "Sell 33%");
  assert.equal((sent as unknown as Record<string, unknown>).pct, 33);
});

test("Close: an older Bot cannot close a stopped bot's trade, and the button says why; operatorExit.v1 can", async () => {
  account("admin");
  botFixtures({ panel: capPanel(["entries.v1", "bots.v1"]) });
  server.routes.set("GET /api/bot/bots", () => [{ ...BOT, status: "paused" }]);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const close = screen.getAllByRole("button", { name: "Close BTCUSDT" })[0] as HTMLButtonElement;
  assert.equal(close.disabled, true);
  assert.ok(body().includes("This bot is stopped. This Bot version closes a trade only while its bot runs"));
  assert.equal((screen.getAllByRole("button", { name: "Partial close BTCUSDT" })[0] as HTMLButtonElement).disabled, false);

  resetBrowser(); resetSessionForTests();
  account("admin");
  botFixtures({ panel: capPanel(ALL_CAPS), trades: () => page([TRADE, { ...TRADE, id: "twin" }]) });
  server.routes.set("GET /api/bot/bots", () => [{ ...BOT, status: "paused", pairs: ["ETHUSDT"] }]);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  for (const button of screen.getAllByRole("button", { name: "Close BTCUSDT" })) {
    assert.equal((button as HTMLButtonElement).disabled, false, "paused, delisted and twin trades close by id");
  }
});

test("a manual race-fill row is labelled and points to the Trade panel", async () => {
  await open({ panel: capPanel(ALL_CAPS), trades: () => page([{ ...MANUAL_TRADE, protectionState: "race_fill_sweep" }]) });
  assert.ok(screen.getAllByText(RACE_FILL_LABEL).length >= 1);
  assert.ok(screen.getAllByRole("link", { name: "Close from the Trade panel" }).length >= 1);
});

test("silent auto-refresh: reads again on the interval, never shows Loading, and stops while the tab is hidden", async () => {
  setBotPollMsForTests(60);
  await open({ panel: capPanel(ALL_CAPS) });
  const reads = () => server.calls.filter((c) => c.path === "/api/bot/control/status").length;
  const first = reads();
  await advance(200);
  assert.ok(reads() > first, "it refreshed");
  assert.equal((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).textContent, "Refresh", "silently");
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new window.Event("visibilitychange"));
  await settle(2);
  const hidden = reads();
  await advance(250);
  assert.equal(reads(), hidden, "no reads while hidden");
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new window.Event("visibilitychange"));
  await settle(4);
  assert.ok(reads() > hidden, "one read at once when visible again");
});
