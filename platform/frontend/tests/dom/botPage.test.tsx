/**
 * The Bot section: what the administrator sees in each state, and that an
 * ordinary account is never shown or fetches any of it.
 *
 * WS-BOTCMD (2026-11-09): the page was read-only and this file pinned exactly
 * three buttons. It now operates the Bot through signed, step-up-confirmed
 * commands, so the pin is replaced, deliberately, by the exact list of
 * controls the page may offer. Opening the page still sends nothing but GETs.
 * The command flows themselves are in `botControls.test.tsx`.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import BotPage from "@/app/bot/page";
import { ADMIN_ONLY_PAGE_NOTICE } from "@/components/AdminOnlyPage";
import { resetSessionForTests } from "@/lib/session";
import { account, botFixtures, failing, page, panel, SUMMARY, TRADE } from "./botFixtures";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const body = () => document.body.textContent ?? "";
const botCalls = () => server.calls.filter((c) => c.path.startsWith("/api/bot"));
const DOWN = panel({ signed: { state: "UNREACHABLE", cause: null }, facts: null });

test("an ordinary account gets the notice, and nothing is fetched", async () => {
  account("user");
  botFixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.equal(screen.getByRole("status").textContent, ADMIN_ONLY_PAGE_NOTICE);
  assert.deepEqual(botCalls(), []);
  assert.equal(body().includes("Trend bot"), false);
  assert.ok(screen.queryByRole("button", { name: /Halt Bot/ }) === null);
});

test("the administrator sees the mode, the bots, open trades and an order id", async () => {
  account("admin");
  botFixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getByRole("heading", { level: 1, name: "Bot" }));
  // Dry run is the Bot's own simulation, never the Platform's PAPER.
  assert.ok(screen.getAllByText("Dry run (simulated)").length >= 1);
  assert.equal(body().includes("Paper simulation"), false);
  assert.ok(screen.getAllByText("Trend bot", { selector: "span" }).length >= 1);
  assert.ok(body().includes("Testnet account (testnet)"));
  assert.ok(body().includes("Stop loss 3%"));
  assert.ok(screen.getAllByText("BTCUSDT").length >= 1);
  assert.ok(screen.getAllByText("order-77").length >= 1);
});

test("the page offers exactly these controls, and opening it sends only reads", async () => {
  account("admin");
  botFixtures({ panel: panel({}, { halted: true }) });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const allowed = ["Refresh", "Open trades", "Trade history", "Halt Bot…", "Resume Bot…", "Edit limits…",
    "Stop…", "Start…", "Partial…", "Close…"];
  const names = screen.getAllByRole("button").map((b) => b.textContent ?? "");
  for (const name of names) assert.ok(allowed.includes(name), `unexpected control: ${name}`);
  for (const name of ["Halt Bot…", "Resume Bot…", "Edit limits…", "Stop…", "Close…", "Partial…"]) {
    assert.ok(names.includes(name), `missing control: ${name}`);
  }
  // The classic appearance is a checkbox, not a command.
  assert.ok(screen.getByRole("checkbox", { name: "Classic Bot appearance" }));
  assert.ok(botCalls().every((c) => c.method === "GET"));
});

test("Resume is offered only while the Bot is (or may be) halted; Halt always", async () => {
  account("admin");
  botFixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getByRole("button", { name: "Halt Bot…" }));
  assert.ok(screen.queryByRole("button", { name: "Resume Bot…" }) === null);
});

test("the mode is the per-account routing, not the process default", async () => {
  account("admin");
  botFixtures({ panel: panel({}, { routing: "MAINNET", dryRun: false }) });
  // The Bot's PROCESS default says testnet; one account is mainnet. The page must say mainnet.
  server.routes.set("GET /api/bot/summary", () => ({ ...SUMMARY, mode: { dryRun: false, binanceTestnet: true } }));
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getAllByText("Mainnet").length >= 1);
  assert.ok(screen.queryByText("Testnet") === null);
  assert.ok(screen.queryByText("Dry run (simulated)") === null);
});

test("routing that could not be read is unknown, never the process default", async () => {
  account("admin");
  botFixtures({ panel: DOWN });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getByText("Routing unknown"));
  assert.ok(screen.getAllByText("Unreachable").length >= 1);
});

test("the Bot being down says so, never a blank page, and Refresh recovers", async () => {
  account("admin");
  const down = failing(502, "the execution bot could not be reached");
  server.routes.set("GET /api/bot/summary", down);
  server.routes.set("GET /api/bot/bots", down);
  server.routes.set("GET /api/bot/trades", down);
  server.routes.set("GET /api/bot/control/status", () => DOWN);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const alerts = screen.getAllByRole("alert");
  assert.equal(alerts.length, 1, "one outage is one notice");
  assert.match(alerts[0].textContent ?? "", /Bot unreachable/);
  assert.ok(screen.getByRole("heading", { level: 1, name: "Bot" }));

  botFixtures();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle(6);
  assert.ok(screen.queryByRole("alert") === null);
  assert.ok(screen.getAllByText("order-77").length >= 1);
});

test("a failed refresh keeps what was already read", async () => {
  account("admin");
  botFixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  const down = failing(502, "the execution bot could not be reached");
  server.routes.set("GET /api/bot/summary", down);
  server.routes.set("GET /api/bot/bots", down);
  server.routes.set("GET /api/bot/trades", down);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await settle(6);
  assert.match(screen.getByRole("alert").textContent ?? "", /Bot unreachable/);
  assert.ok(screen.getAllByText("Dry run (simulated)").length >= 1);
  assert.ok(screen.getAllByText("order-77").length >= 1);
});

test("the read-only views being off is stated as a setting, and the controls still work", async () => {
  account("admin");
  const off = failing(404, "manual trading is disabled");
  server.routes.set("GET /api/bot/summary", off);
  server.routes.set("GET /api/bot/bots", off);
  server.routes.set("GET /api/bot/trades", off);
  server.routes.set("GET /api/bot/control/status", () => panel());
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.queryByRole("alert") === null);
  assert.ok(body().includes("read-only views are off"));
  assert.equal((screen.getByRole("button", { name: "Halt Bot…" }) as HTMLButtonElement).disabled, false);
});

test("no control channel: everything is shown and every command is off", async () => {
  account("admin");
  botFixtures({ panel: panel({ channel: { configured: false }, signed: { state: "NOT_CONFIGURED", cause: null }, facts: null }) });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(body().includes("Bot control channel not configured."));
  for (const name of ["Halt Bot…", "Edit limits…", "Stop…", "Close…"]) {
    for (const button of screen.getAllByRole("button", { name: new RegExp(`^${name.replace("…", "")}`) })) {
      assert.equal((button as HTMLButtonElement).disabled, true, name);
    }
  }
});

test("only the trades failing leaves the rest on screen", async () => {
  account("admin");
  botFixtures();
  server.routes.set("GET /api/bot/trades", failing(500, "boom"));
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.match(screen.getByRole("alert").textContent ?? "", /trades could not be read/);
  assert.ok(screen.getAllByText("Dry run (simulated)").length >= 1);
});

test("nothing yet is an empty state in each section", async () => {
  account("admin");
  botFixtures({ trades: () => page([]) });
  server.routes.set("GET /api/bot/bots", () => []);
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(body().includes("No bots yet."));
  assert.ok(body().includes("No open trades."));
  fireEvent.click(screen.getByRole("button", { name: "Trade history" }));
  await settle(6);
  assert.ok(body().includes("No closed trades yet."));
});

test("the history tab asks for closed trades and pages through them, with no actions", async () => {
  account("admin");
  botFixtures({ trades: (url) => {
    const status = url.searchParams.get("status");
    const pageNumber = Number(url.searchParams.get("page"));
    if (status === "active") return page([TRADE]);
    return { total: 60, page: pageNumber, pageSize: 50, rows: [{ ...TRADE, id: `c${pageNumber}`, status: "closed",
      exchangeOrderId: `closed-${pageNumber}`, closedAt: "2026-10-21T00:00:00.000Z", closedReason: "signal" }] };
  } });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  fireEvent.click(screen.getByRole("button", { name: "Trade history" }));
  await settle(6);
  assert.ok(screen.getAllByText("closed-1").length >= 1);
  assert.ok(body().includes("Page 1 of 2"));
  assert.ok(screen.queryByRole("button", { name: /^Close / }) === null, "a closed trade has nothing to close");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await settle(6);
  assert.ok(screen.getAllByText("closed-2").length >= 1);
  assert.ok(body().includes("Page 2 of 2"));
});

test("the page links to the Journal and Operations, and states the recovery path", async () => {
  account("admin");
  botFixtures();
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.equal(screen.getByRole("link", { name: "Journal" }).getAttribute("href"), "/journal");
  assert.ok(screen.getAllByRole("link", { name: "Operations" }).every((a) => a.getAttribute("href") === "/operations"));
  assert.ok(body().includes("The standalone Bot dashboard remains available to the Bot operator for recovery."));
});
