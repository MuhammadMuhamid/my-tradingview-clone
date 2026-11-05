/**
 * The Bot section: what the administrator sees in each state, and that an
 * ordinary account is never shown or fetches any of it.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import BotPage from "@/app/bot/page";
import { ADMIN_ONLY_PAGE_NOTICE } from "@/components/AdminOnlyPage";
import { resetSessionForTests } from "@/lib/session";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

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

const SUMMARY = {
  mode: { dryRun: true, binanceTestnet: true },
  stats: { upnl: 10, locked: 100, activeCount: 1, closedCount: 3, todayPnl: 2.5, totalRealizedPnl: 7.5,
    botCount: 1, activeBotCount: 1, stoppedBotCount: 0 },
};
const BOT = {
  id: "11111111-1111-4111-8111-111111111111", name: "Trend bot", status: "active", pairs: ["BTCUSDT", "ETHUSDT"],
  investment: "5% of balance", entryEnabled: true, exitEnabled: true, takeProfitPct: null, stopLossPct: 3,
  maxEntryOrders: null, maxActiveSmartTrades: null, account: { name: "Testnet account", testnet: true },
  activeTrades: 1, closedTrades: 3, realizedPnl: 7.5, signalCount: 9, createdAt: "2026-10-01T00:00:00.000Z",
};
const TRADE = {
  id: "t1", botId: BOT.id, botName: "Trend bot", source: "strategy", pair: "BTCUSDT", status: "active",
  entryPrice: 100, currentPrice: 110, quantity: 1, quoteSpent: 100, pnlUsdt: 10, pnlPct: 10,
  exchangeOrderId: "order-77", closedReason: null, partialCloses: 0, account: BOT.account,
  createdAt: "2026-10-20T00:00:00.000Z", closedAt: null,
};
const page = (rows: unknown[], total = rows.length) => ({ total, page: 1, pageSize: 50, rows });

function fixtures(trades: (url: URL) => unknown = () => page([TRADE])): void {
  server.routes.set("GET /api/bot/summary", () => SUMMARY);
  server.routes.set("GET /api/bot/bots", () => [BOT]);
  server.routes.set("GET /api/bot/trades", (_body, url) => trades(url));
}

const failing = (status: number, error: string) => () =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

const body = () => document.body.textContent ?? "";
const botCalls = () => server.calls.filter((c) => c.path.startsWith("/api/bot"));

test("an ordinary account gets the notice, and nothing is fetched", async () => {
  account("user");
  fixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.equal(screen.getByRole("status").textContent, ADMIN_ONLY_PAGE_NOTICE);
  assert.deepEqual(botCalls(), []);
  assert.equal(body().includes("Trend bot"), false);
});

test("the administrator sees the mode, the bots, open trades and an order id", async () => {
  account("admin");
  fixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getByRole("heading", { level: 1, name: "Bot" }));
  assert.ok(screen.getByText("Paper simulation"));
  assert.ok(screen.getByText("Trend bot", { selector: "span" }));
  assert.ok(body().includes("Testnet account (testnet)"));
  assert.ok(body().includes("Stop loss 3%"));
  assert.ok(screen.getByText("BTCUSDT"));
  assert.ok(screen.getByText("order-77"));
});

test("this page offers nothing that changes the Bot", async () => {
  account("admin");
  fixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const names = screen.getAllByRole("button").map((b) => b.textContent);
  for (const name of names) {
    assert.ok(["Refresh", "Open trades", "Trade history"].includes(name ?? ""), `unexpected control: ${name}`);
  }
  assert.ok(botCalls().every((c) => c.method === "GET"));
});

test("a mode that isn't simulation is named", async () => {
  account("admin");
  fixtures();
  server.routes.set("GET /api/bot/summary", () => ({ ...SUMMARY, mode: { dryRun: false, binanceTestnet: false } }));
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getByText("Mainnet"));
});

test("the Bot being down says so, never a blank page, and Refresh recovers", async () => {
  account("admin");
  const down = failing(502, "the execution bot could not be reached");
  server.routes.set("GET /api/bot/summary", down);
  server.routes.set("GET /api/bot/bots", down);
  server.routes.set("GET /api/bot/trades", down);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const alerts = screen.getAllByRole("alert");
  assert.equal(alerts.length, 1, "one outage is one notice");
  assert.match(alerts[0].textContent ?? "", /Bot unreachable/);
  assert.ok(screen.getByRole("heading", { level: 1, name: "Bot" }));

  fixtures();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle(6);
  assert.equal(screen.queryByRole("alert"), null);
  assert.ok(screen.getByText("order-77"));
});

test("a failed refresh keeps what was already read", async () => {
  account("admin");
  fixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const down = failing(502, "the execution bot could not be reached");
  server.routes.set("GET /api/bot/summary", down);
  server.routes.set("GET /api/bot/bots", down);
  server.routes.set("GET /api/bot/trades", down);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle(6);
  assert.match(screen.getByRole("alert").textContent ?? "", /Bot unreachable/);
  assert.ok(screen.getByText("Paper simulation"));
  assert.ok(screen.getByText("order-77"));
});

test("the connection being off is stated as a setting, not an outage", async () => {
  account("admin");
  const off = failing(404, "manual trading is disabled");
  server.routes.set("GET /api/bot/summary", off);
  server.routes.set("GET /api/bot/bots", off);
  server.routes.set("GET /api/bot/trades", off);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.equal(screen.queryByRole("alert"), null);
  assert.ok(body().includes("The Bot connection is off"));
});

test("only the trades failing leaves the rest on screen", async () => {
  account("admin");
  fixtures();
  server.routes.set("GET /api/bot/trades", failing(500, "boom"));
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.match(screen.getByRole("alert").textContent ?? "", /trades could not be read/);
  assert.ok(screen.getByText("Paper simulation"));
});

test("nothing yet is an empty state in each section", async () => {
  account("admin");
  fixtures(() => page([]));
  server.routes.set("GET /api/bot/bots", () => []);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(body().includes("No bots yet."));
  assert.ok(body().includes("No open trades."));
  fireEvent.click(screen.getByRole("button", { name: "Trade history" }));
  await settle(6);
  assert.ok(body().includes("No closed trades yet."));
});

test("the history tab asks for closed trades and pages through them", async () => {
  account("admin");
  fixtures((url) => {
    const status = url.searchParams.get("status");
    const pageNumber = Number(url.searchParams.get("page"));
    if (status === "active") return page([TRADE]);
    return { total: 60, page: pageNumber, pageSize: 50, rows: [{ ...TRADE, id: `c${pageNumber}`, status: "closed",
      exchangeOrderId: `closed-${pageNumber}`, closedAt: "2026-10-21T00:00:00.000Z", closedReason: "signal" }] };
  });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: "Trade history" }));
  await settle(6);
  assert.ok(screen.getByText("closed-1"));
  assert.ok(body().includes("Page 1 of 2"));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await settle(6);
  assert.ok(screen.getByText("closed-2"));
  assert.ok(body().includes("Page 2 of 2"));
});
