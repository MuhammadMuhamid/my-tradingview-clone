/**
 * Feature B on /bot: Archive / Restore a closed Bot trade (`tradeArchive.v1`).
 *
 *   - offered only when the Bot advertises the capability; an older Bot gets
 *     no control, no `archived` query parameter, and a note saying why;
 *   - Archive is a step-up command (grant tier) whose body is {requestId,
 *     archived, credential}; the confirmation keeps the Classic wording;
 *   - History hides archived trades by default and says the totals still count
 *     them; "Show archived" asks the Bot for them and marks each one, with Restore;
 *   - a row the Bot reports as not archivable is disabled with its reason, and
 *     a refusal is shown in the Bot's words.
 */
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import BotPage from "@/app/bot/page";
import { resetSessionForTests } from "@/lib/session";
import { setCommandPollingForTests } from "@/components/bot/commandRunner";
import { ARCHIVED_HIDDEN_NOTE } from "@/components/bot/HistorySummary";
import { account, botFixtures, enterCode, facts, json, page, panel, TRADE } from "./botFixtures";

beforeEach(() => {
  resetBrowser(); resetSessionForTests(); server.interpose(null);
  setCommandPollingForTests({ intervalMs: 25, windowMs: 2_000 });
});
afterEach(() => { setCommandPollingForTests(null); server.interpose(null); cleanup(); });
after(closeBrowser);

const CLOSED_ID = "55555555-5555-4555-8555-555555555555";
const ARCHIVED_ID = "66666666-6666-4666-8666-666666666666";
const BLOCKED_ID = "77777777-7777-4777-8777-777777777777";
const CLOSED = { ...TRADE, id: CLOSED_ID, status: "closed", closedAt: "2026-11-08T10:00:00.000Z",
  closedReason: "take_profit", exchangeOrderId: "closed-1", archivedAt: null, archiveBlocked: null };
const ARCHIVED = { ...CLOSED, id: ARCHIVED_ID, pair: "ETHUSDT", exchangeOrderId: "closed-2",
  archivedAt: "2026-11-09T09:00:00.000Z" };
const BLOCKED = { ...CLOSED, id: BLOCKED_ID, pair: "SOLUSDT", exchangeOrderId: "closed-3",
  archiveBlocked: { code: "trade_has_unresolved_orders", message: "An exit order is still working at the exchange." } };

const withArchive = panel({ facts: { ...facts(), capabilities: ["operatorExit.v1", "tradeArchive.v1"] } });
const body = () => document.body.textContent ?? "";
const tradeReads = () => server.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/bot/trades?"));

async function openHistory(opts: { capable?: boolean; rows?: (url: URL) => unknown[] } = {}) {
  account("admin");
  botFixtures({
    panel: opts.capable === false ? panel() : withArchive,
    trades: (url) => url.searchParams.get("status") === "active" ? page([TRADE])
      : page((opts.rows ?? (() => [CLOSED]))(url)),
  });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: "Trade history" }));
  await settle(6);
}

test("Archive: the Classic confirmation, a step-up, and {requestId, archived:true, credential} sent once", async () => {
  await openHistory();
  let sent: Record<string, unknown> | null = null;
  server.routes.set(`POST /api/bot/control/trades/${CLOSED_ID}/archive`, (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId,
      result: { id: CLOSED_ID, archived: true, archivedAt: "2026-11-09T12:00:00.000Z", archivedBy: "platform:x", changed: true } });
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Archive BTCUSDT" })[0]!);
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Archive BTCUSDT" });
  assert.match(dialog.textContent ?? "",
    /Archive this BTCUSDT trade\? It will be hidden from History\. Its P&L and daily-loss history are kept\. You can restore it\./);
  assert.match(dialog.textContent ?? "", /Realized P&L, the daily-loss limit and any halt are unchanged/);
  await enterCode(dialog, "Archive trade");
  assert.ok(sent);
  const s = sent as Record<string, unknown>;
  assert.deepEqual({ ...s, requestId: "x" }, { requestId: "x", archived: true, credential: { code: "123456" } });
  assert.equal(server.calls.filter((c) => c.method === "POST" && c.path.endsWith("/archive")).length, 1);
  assert.ok(body().includes("Archived. It is hidden from History; its P&L is still counted."));
});

test("History hides archived by default and says totals still count them; Show archived asks for them, badges and restores", async () => {
  await openHistory({ rows: (url) => url.searchParams.get("archived") === "include" ? [CLOSED, ARCHIVED] : [CLOSED] });
  assert.equal(tradeReads().some((c) => c.path.includes("archived=")), false, "default view sends no archived parameter");
  assert.ok(body().includes(ARCHIVED_HIDDEN_NOTE));
  assert.ok(screen.queryByRole("button", { name: "Restore ETHUSDT" }) === null);

  fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
  await settle(6);
  assert.ok(tradeReads().some((c) => c.path.includes("archived=include")));
  assert.equal(body().includes(ARCHIVED_HIDDEN_NOTE), false);
  assert.ok(screen.getAllByText("Archived").length >= 1);

  let sent: Record<string, unknown> | null = null;
  server.routes.set(`POST /api/bot/control/trades/${ARCHIVED_ID}/archive`, (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId,
      result: { id: ARCHIVED_ID, archived: false, archivedAt: null, archivedBy: null, changed: true } });
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Restore ETHUSDT" })[0]!);
  await settle(2);
  await enterCode(screen.getByRole("dialog", { name: "Restore ETHUSDT" }), "Restore trade");
  assert.equal((sent as Record<string, unknown> | null)?.archived, false);
  assert.ok(body().includes("Restored to History."));
});

test("a row the Bot would refuse is disabled with its reason; a refusal is shown in the Bot's words", async () => {
  await openHistory({ rows: () => [CLOSED, BLOCKED] });
  const blocked = screen.getAllByRole("button", { name: "Archive SOLUSDT" })[0] as HTMLButtonElement;
  assert.equal(blocked.disabled, true);
  assert.ok(body().includes("Cannot archive yet: An exit order is still working at the exchange."));

  server.routes.set(`POST /api/bot/control/trades/${CLOSED_ID}/archive`, () =>
    json(409, { code: "trade_needs_attention", error: "This trade carries an unresolved operator flag." }));
  fireEvent.click(screen.getAllByRole("button", { name: "Archive BTCUSDT" })[0]!);
  await settle(2);
  await enterCode(screen.getByRole("dialog", { name: "Archive BTCUSDT" }), "Archive trade");
  const alert = screen.getByRole("alert");
  assert.match(alert.textContent ?? "", /unresolved operator flag\. The Bot did not archive it\./);
});

test("an older Bot without tradeArchive.v1: no Archive, no Show archived, no archived parameter, and a note", async () => {
  await openHistory({ capable: false });
  assert.ok(screen.queryByRole("button", { name: /^Archive / }) === null);
  assert.ok(screen.queryByRole("checkbox", { name: "Show archived" }) === null);
  assert.equal(tradeReads().some((c) => c.path.includes("archived=")), false);
  assert.match(body(), /Archiving trades from Trading Scene needs a newer Bot/);
  assert.equal(body().includes(ARCHIVED_HIDDEN_NOTE), false);
  const history = within(document.querySelector('[data-layout="desktop"]') as HTMLElement);
  assert.ok(history.getAllByText("closed-1").length >= 1);
});
