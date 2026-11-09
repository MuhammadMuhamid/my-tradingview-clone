/**
 * Operating the Bot from /bot: the step-up dialog, what each answer is shown
 * as, request-id reuse, refusals, the classic appearance and the phone layout.
 *
 * The truth rules under test (BOT_CONTROL_CONTRACT §0.7, F6e, F8):
 *   - a 202 "uncertain" is "Outcome unknown, checking…", polled through C8
 *     with the same request id, and never shown as a success C8 did not report;
 *   - "Nothing was changed" appears only when C8 says the Bot has no record;
 *   - the id is reused only while the outcome is unknown.
 */
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { advance, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import BotPage from "@/app/bot/page";
import { resetSessionForTests } from "@/lib/session";
import { setCommandPollingForTests } from "@/components/bot/commandRunner";
import { BOT_APPEARANCE_KEY } from "@/components/bot/classicAppearance";
import { HALT_SCOPE_TEXT, LOSS_LIMIT_WARNING } from "@/components/bot/botCopy";
import {
  account, BOT, botFixtures, json, MANUAL_TRADE, MANUAL_TRADE_ID, page, panel, TRADE, TRADE_ID,
} from "./botFixtures";

beforeEach(() => {
  resetBrowser(); resetSessionForTests(); server.interpose(null);
  setCommandPollingForTests({ intervalMs: 25, windowMs: 2_000 });
});
afterEach(() => { setCommandPollingForTests(null); server.interpose(null); });
after(closeBrowser);

const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const body = () => document.body.textContent ?? "";
const posts = (path: string) => server.calls.filter((c) => c.method !== "GET" && c.path === path);
const c8Calls = () => server.calls.filter((c) => c.path.startsWith("/api/bot/control/commands/"));

async function open(opts: Parameters<typeof botFixtures>[0] = {}, twoFactorEnabled = true) {
  account("admin", { twoFactorEnabled });
  botFixtures(opts);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
}

/** Opens the Close dialog for the strategy trade and confirms it with a code. */
async function confirmClose(code = "123456") {
  fireEvent.click(screen.getAllByRole("button", { name: "Close BTCUSDT" })[0]!);
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Close BTCUSDT" });
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close trade" }));
  await settle(4);
}

test("a manual trade offers the Trade panel, never Close; a strategy trade offers Close and Partial", async () => {
  await open({ trades: () => page([TRADE, MANUAL_TRADE]) });
  for (const card of [document.querySelector(`[data-trade-card="${MANUAL_TRADE_ID}"]`)!]) {
    const link = within(card as HTMLElement).getByRole("link", { name: "Close from the Trade panel" });
    assert.equal(link.getAttribute("href"), "/chart?source=scanner&symbol=ETHUSDT&panel=manual");
    assert.ok(within(card as HTMLElement).queryByRole("button") === null);
  }
  const strategy = document.querySelector(`[data-trade-card="${TRADE_ID}"]`) as HTMLElement;
  assert.ok(within(strategy).getByRole("button", { name: "Close BTCUSDT" }));
  assert.ok(within(strategy).getByRole("button", { name: "Partial close BTCUSDT" }));
  assert.ok(screen.queryByRole("button", { name: "Close ETHUSDT" }) === null, "nowhere on the page");
});

test("halt: the dialog states the scope, asks for the code, and sends the command once", async () => {
  await open();
  let sent: Record<string, unknown> | null = null;
  server.routes.set("POST /api/bot/control/halt", (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId, result: { halted: true, alreadyHalted: false } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Halt Bot…" }));
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Halt the Bot" });
  assert.ok(document.activeElement === dialog, "the dialog panel takes focus");
  assert.ok((dialog.textContent ?? "").includes(HALT_SCOPE_TEXT));
  const confirm = within(dialog).getByRole("button", { name: "Halt Bot" }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);
  fireEvent.change(within(dialog).getByLabelText(/Reason for halting/), { target: { value: "maintenance window" } });
  assert.equal(confirm.disabled, true, "a reason alone is not enough");
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123 456" } });
  assert.equal(confirm.disabled, false);
  fireEvent.click(confirm);
  await settle(6);
  assert.ok(sent);
  const s = sent as Record<string, unknown>;
  assert.match(String(s.requestId), REQUEST_ID);
  assert.deepEqual({ ...s, requestId: "x" }, { requestId: "x", confirmation: "HALT_TRADING", reason: "maintenance window",
    credential: { code: "123456" } });
  assert.equal(posts("/api/bot/control/halt").length, 1);
  assert.ok(screen.queryByRole("dialog") === null);
  assert.ok(body().includes("The Bot is halted. TP/SL protection is not being checked until you resume."));
});

test("Escape closes the dialog and nothing is sent", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Halt Bot…" }));
  await settle(2);
  fireEvent.keyDown(document, { key: "Escape" });
  await settle(2);
  assert.ok(screen.queryByRole("dialog") === null);
  assert.equal(server.calls.filter((c) => c.method !== "GET").length, 0);
});

test("two-factor off: Halt asks for the password; Close offers no confirm and says to turn it on", async () => {
  await open({}, false);
  fireEvent.click(screen.getByRole("button", { name: "Halt Bot…" }));
  await settle(2);
  let dialog = screen.getByRole("dialog", { name: "Halt the Bot" });
  assert.ok(within(dialog).getByLabelText(/Your password/));
  assert.ok(within(dialog).queryByLabelText(/authenticator/) === null);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await settle(2);

  fireEvent.click(screen.getAllByRole("button", { name: "Close BTCUSDT" })[0]!);
  await settle(2);
  dialog = screen.getByRole("dialog", { name: "Close BTCUSDT" });
  assert.match(dialog.textContent ?? "", /Turn on two-factor sign-in/);
  assert.ok(within(dialog).queryByRole("button", { name: "Close trade" }) === null, "no way to confirm, never a bypass");
  assert.equal(within(dialog).getByRole("link", { name: "profile" }).getAttribute("href"), "/profile");
});

test("a wrong code keeps the dialog open, says so, and clears the code", async () => {
  await open();
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`,
    () => json(400, { code: "step_up_failed", error: "That code isn't correct. Each code works once; wait for the next one.", method: "totp" }));
  await confirmClose("000000");
  const dialog = screen.getByRole("dialog", { name: "Close BTCUSDT" });
  assert.match(within(dialog).getByRole("alert").textContent ?? "", /code isn't correct/);
  assert.equal((within(dialog).getByLabelText(/Code from your authenticator app/) as HTMLInputElement).value, "");
});

test("an uncertain close polls C8 with the same id and claims nothing until C8 does", async () => {
  await open();
  let requestId = "";
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`, (payload) => {
    requestId = (payload as { requestId: string }).requestId;
    return json(202, { status: "uncertain", requestId });
  });
  let asked = 0;
  const c8 = () => {
    asked += 1;
    return asked < 3
      ? json(200, { requestId, kind: "trade_close", status: "processing" })
      : json(200, { requestId, kind: "trade_close", status: "succeeded", result: { status: "ok", detail: "closed" } });
  };
  server.interpose((call) => {
    if (call.path.startsWith("/api/bot/control/commands/")) server.routes.set(`GET ${call.path}`, c8);
  });
  await confirmClose();
  assert.ok(body().includes("Outcome unknown, checking…"));
  assert.equal(body().includes("went through"), false, "no success before C8 reports one");
  await advance(400);
  assert.ok(body().includes("The close went through the Bot's exit path."));
  assert.equal(body().includes("Outcome unknown, checking…"), false);
  assert.ok(c8Calls().length >= 3);
  assert.ok(c8Calls().every((c) => c.path === `/api/bot/control/commands/${requestId}`), "always the same request id");
  assert.equal(posts(`/api/bot/control/trades/${TRADE_ID}/close`).length, 1, "the command itself was not re-sent");
});

test("only C8's 'no such command' is shown as 'Nothing was changed'", async () => {
  await open();
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`,
    (payload) => json(202, { status: "uncertain", requestId: (payload as { requestId: string }).requestId }));
  server.interpose((call) => {
    if (call.path.startsWith("/api/bot/control/commands/")) {
      server.routes.set(`GET ${call.path}`, () => json(404, { code: "command_not_found", error: "The execution bot has no record of this command." }));
    }
  });
  await confirmClose();
  await advance(200);
  assert.ok(body().includes("Nothing was changed. The Bot has no record of this command."));
});

test("still unknown after the window: said plainly, and the same intent reuses the id until a definitive answer", async () => {
  setCommandPollingForTests({ intervalMs: 20, windowMs: 120 });
  await open();
  const ids: string[] = [];
  let answer: "uncertain" | "succeeded" = "uncertain";
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`, (payload) => {
    const requestId = (payload as { requestId: string }).requestId;
    ids.push(requestId);
    return answer === "uncertain"
      ? json(202, { status: "uncertain", requestId })
      : json(200, { status: "succeeded", requestId, result: { status: "ok" } });
  });
  server.interpose((call) => {
    if (call.path.startsWith("/api/bot/control/commands/")) {
      server.routes.set(`GET ${call.path}`, () => json(200, { requestId: "x", kind: "trade_close", status: "processing" }));
    }
  });
  await confirmClose("111111");
  await advance(400);
  assert.ok(body().includes("Outcome still unknown."));
  assert.equal(body().includes("Nothing was changed"), false);
  assert.equal(body().includes("went through"), false);
  assert.ok(screen.getByRole("button", { name: "Check again" }));

  answer = "succeeded";
  await confirmClose("222222");
  assert.equal(ids[1], ids[0], "the same intent while unknown reuses the id");
  await confirmClose("333333");
  assert.notEqual(ids[2], ids[1], "after a definitive answer, a new intent gets a new id");
  assert.ok(ids.every((id) => REQUEST_ID.test(id)));
});

test("the Bot still running the command keeps the same id: a second click never mints a new one", async () => {
  // A long window: every click below lands while the first outcome is still being checked.
  setCommandPollingForTests({ intervalMs: 20, windowMs: 5_000 });
  await open();
  const ids: string[] = [];
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`, (payload) => {
    const requestId = (payload as { requestId: string }).requestId;
    ids.push(requestId);
    // The first send timed out; every later one meets the Bot's 409 command_in_progress,
    // which the Platform relays as 202 uncertain.
    return ids.length === 1
      ? json(202, { status: "uncertain", requestId })
      : json(202, { status: "uncertain", requestId, code: "command_in_progress" });
  });
  server.interpose((call) => {
    if (call.path.startsWith("/api/bot/control/commands/")) {
      server.routes.set(`GET ${call.path}`, () => json(200, { requestId: "x", kind: "trade_close", status: "processing" }));
    }
  });
  await confirmClose("111111");
  await confirmClose("222222");
  await advance(100);
  await confirmClose("333333");
  assert.ok(body().includes("Outcome unknown, checking…"), "still unknown, still checking");
  assert.equal(ids.length, 3);
  assert.ok(ids.every((id) => id === ids[0]), "one intent, one request id, while the Bot is still on it");
  assert.ok(screen.queryByRole("alert") === null, "in progress is never shown as a refusal");
});

test("a request that never got an answer is uncertain, not a failure", async () => {
  await open();
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`, () => Promise.reject(new TypeError("network down")));
  await confirmClose();
  assert.ok(body().includes("Outcome unknown, checking…"));
  assert.ok(screen.queryByRole("alert") === null, "not reported as a refusal or a failure");
});

test("a Bot refusal is explained in plain words and points to the right path", async () => {
  await open();
  server.routes.set(`POST /api/bot/control/trades/${TRADE_ID}/close`,
    () => json(409, { code: "trade_manual", error: "This position was opened from Trading Scene." }));
  await confirmClose();
  const alert = screen.getByRole("alert");
  assert.match(alert.textContent ?? "", /Close it from the Trade panel on the chart/);
  assert.equal(within(alert).getByRole("link", { name: "Open the Trade panel" }).getAttribute("href"),
    "/chart?source=scanner&symbol=BTCUSDT&panel=manual");
  assert.equal(body().includes("Nothing was changed"), false);
});

test("Start confirms the target state and shows the unresolved-intent count", async () => {
  account("admin");
  botFixtures();
  server.routes.set("GET /api/bot/bots", () => [{ ...BOT, status: "paused" }]);
  let sent: Record<string, unknown> | null = null;
  server.routes.set(`POST /api/bot/control/bots/${BOT.id}/status`, (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId,
      result: { id: BOT.id, name: BOT.name, status: "active", changed: true, unresolvedIntents: 3 } });
  });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: "Start Trend bot" }));
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Start Trend bot" });
  assert.match(dialog.textContent ?? "", /unresolved intents/);
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Start bot" }));
  await settle(6);
  assert.equal((sent as unknown as Record<string, unknown>).status, "active", "a target state, not a toggle");
  assert.ok(body().includes("Started. 3 unresolved intents for this bot."));
});

test("risk limits: units, the latch warnings, and only the changed field is sent", async () => {
  await open({ panel: panel({}, { halted: true, haltedBy: "daily_loss", latched: true }) });
  let sent: Record<string, unknown> | null = null;
  server.routes.set("PATCH /api/bot/control/risk-limits", (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId, result: { latched: true } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Edit limits…" }));
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Change the Bot's risk limits" });
  for (const label of [/Max total exposure \(USDT\)/, /Max open trades \(count\)/, /Daily-loss limit \(USDT\)/, /Daily-loss window \(hours\)/]) {
    assert.ok(within(dialog).getByLabelText(label));
  }
  assert.match(dialog.textContent ?? "", /never clears a halt that is already latched/);
  fireEvent.change(within(dialog).getByLabelText(/Daily-loss limit \(USDT\)/), { target: { value: "" } });
  await settle(1);
  assert.ok(within(dialog).getAllByText(new RegExp(LOSS_LIMIT_WARNING.slice(0, 40).replace(/[()]/g, "."))).length >= 1);
  fireEvent.change(within(dialog).getByLabelText(/Code from your authenticator app/), { target: { value: "123456" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save limits" }));
  await settle(6);
  const s = sent as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(s).sort(), ["credential", "maxDailyLossQuote", "requestId"]);
  assert.equal(s.maxDailyLossQuote, null);
  assert.ok(body().includes("The daily-loss latch is still set; resume separately."));
});

test("classic appearance: off by default, remembered, and scoped to this page's body", async () => {
  await open();
  assert.ok(document.querySelector("[data-bot-appearance]") === null, "nobody gets it without opting in");
  const box = screen.getByRole("checkbox", { name: "Classic Bot appearance" }) as HTMLInputElement;
  assert.equal(box.checked, false);
  fireEvent.click(box);
  await settle(1);
  const wrapper = document.querySelector('[data-bot-appearance="classic"]');
  assert.ok(wrapper);
  assert.ok(wrapper !== document.documentElement);
  assert.ok(wrapper !== document.body);
  assert.equal(document.documentElement.getAttribute("data-bot-appearance"), null);
  assert.ok(wrapper.contains(screen.getByRole("heading", { level: 1, name: "Bot" })));
  assert.equal(window.localStorage.getItem(BOT_APPEARANCE_KEY), "classic");

  cleanup();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.equal((screen.getByRole("checkbox", { name: "Classic Bot appearance" }) as HTMLInputElement).checked, true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Classic Bot appearance" }));
  await settle(1);
  assert.ok(document.querySelector("[data-bot-appearance]") === null);
  assert.equal(window.localStorage.getItem(BOT_APPEARANCE_KEY), null);
});

test("classic appearance survives a browser that refuses storage", async () => {
  const proto = Object.getPrototypeOf(window.localStorage) as Storage;
  const original = proto.setItem;
  proto.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  try {
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Classic Bot appearance" }));
    await settle(1);
    assert.ok(document.querySelector('[data-bot-appearance="classic"]'), "applies for this visit");
  } finally {
    proto.setItem = original;
  }
});

test("390 px: trades are cards with P&L and actions, not a side-scrolling table", async () => {
  await open({ trades: () => page([TRADE, MANUAL_TRADE]) });
  const phone = document.querySelector('[data-layout="phone"]') as HTMLElement;
  const desktop = document.querySelector('[data-layout="desktop"]') as HTMLElement;
  assert.ok(phone && desktop);
  // jsdom lays nothing out; the breakpoint lives on the classes (see tests/phoneFit.test.ts).
  assert.ok(phone.classList.contains("sm:hidden"), "the cards are the layout below 640 px");
  assert.ok(desktop.classList.contains("hidden") && desktop.classList.contains("sm:block"), "the table only from 640 px");
  for (let el: HTMLElement | null = phone; el; el = el.parentElement) {
    assert.equal(el.classList.contains("overflow-x-auto"), false, "nothing on the phone scrolls sideways");
  }
  const card = phone.querySelector(`[data-trade-card="${TRADE_ID}"]`) as HTMLElement;
  assert.match(card.textContent ?? "", /\+\$10\.00 \(\+?10\.00%\)/, "P&L is on the card");
  assert.ok(within(card).getByRole("button", { name: "Close BTCUSDT" }));
  assert.ok((phone.textContent ?? "").includes("order-88"));
});
