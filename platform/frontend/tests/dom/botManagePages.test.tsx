/**
 * /bot/bots/new and /bot/bots/[id]: the full form (every Classic field, the
 * Bot's validation incl. the 50% unprotected-size rule), free USDT, create →
 * "Link to deployment", edit sending only what changed and saying when a
 * fresh code is needed, rotate, the Bot-origin reveal, delete with its
 * refusals, and capability gating. No secret ever reaches these pages.
 */
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext, PathParamsContext, SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import NewBotPage from "@/app/bot/bots/new/page";
import BotDetailPage from "@/app/bot/bots/[id]/page";
import { resetSessionForTests } from "@/lib/session";
import { setCommandPollingForTests } from "@/components/bot/commandRunner";
import { setNavigateForTests } from "@/components/bot/navigate";
import { account, enterCode, facts, json, panel } from "./botFixtures";

const BOT_ID = "66666666-6666-4666-8666-666666666666";
const ACCOUNT_ID = "77777777-7777-4777-8777-777777777777";
const DEP_CUSTOM = "88888888-8888-4888-8888-888888888888";
const DEP_3C = "99999999-9999-4999-8999-999999999999";
const ALL = ["entries.v1", "operatorExit.v1", "bots.v1", "accounts.v1", "enroll.v1"];

const pushes: string[] = [];
const ROUTER = { push: (href: string) => { pushes.push(href); }, replace: () => {}, prefetch: () => {},
  back: () => {}, forward: () => {}, refresh: () => {}, hmrRefresh: () => {} };

function Route({ path, params = {}, children }: { path: string; params?: Record<string, string>; children: ReactNode }) {
  return (
    <AppRouterContext.Provider value={ROUTER as never}>
      <PathnameContext.Provider value={path}>
        <PathParamsContext.Provider value={params}>
          <SearchParamsContext.Provider value={new URLSearchParams() as never}>{children}</SearchParamsContext.Provider>
        </PathParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

const VIEW = {
  id: BOT_ID, name: "Trend bot", status: "active", alertType: "custom", direction: "long", pairs: ["BTCUSDT", "ETHUSDT"],
  maxInvestmentPct: 5, maxInvestmentUnit: "pct_bot", maxInvestmentLabel: "5% of balance", entryEnabled: true,
  entryVolumePct: 100, entryOrderType: "market", exitEnabled: true, takeProfitPct: null, stopLossPct: 3,
  maxEntryOrders: null, maxActiveSmartTradesEnabled: false, maxActiveSmartTrades: null, exchangeAccountId: ACCOUNT_ID,
  exchangeAccount: { id: ACCOUNT_ID, name: "Testnet account", testnet: true }, webhookSecretMasked: "••••abcd",
  webhookPath: "/api/webhooks/signal_bots", activeTrades: 0, unresolvedIntents: 0,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
};
const DEPLOYMENTS = [
  { id: DEP_CUSTOM, strategyId: 1, configId: null, symbol: "BTCUSDT", timeframe: "1h", params: {}, status: "active",
    delivery: "custom", webhookUrl: "https://bot.example.test/api/webhooks/signal_bots", botUuid: null, botId: null,
    buyQuoteQty: 10, runtimeState: { position: "flat", entryPrice: null }, lastBarTime: null, createdAt: "2026-11-01T00:00:00.000Z",
    secret: "[CONFIGURED]" },
  { id: DEP_3C, strategyId: 1, configId: null, symbol: "ETHUSDT", timeframe: "4h", params: {}, status: "paused",
    delivery: "3commas", webhookUrl: "https://api.3commas.io/signal", botUuid: "[CONFIGURED]", botId: null,
    buyQuoteQty: null, runtimeState: { position: "flat", entryPrice: null }, lastBarTime: null, createdAt: "2026-11-01T00:00:00.000Z",
    secret: "[CONFIGURED]" },
];

function fixtures(capabilities: string[] = ALL, detail: unknown = { bot: VIEW,
  platform: { secret: { stored: true, updatedAt: "2026-11-09T10:00:00.000Z" }, linkedDeployments: [] } }) {
  server.routes.set("GET /api/bot/control/status", () => ({ ...panel(), facts: { ...facts(), capabilities } }));
  server.routes.set("GET /api/bot/manage/accounts", () => ({ accounts: [{ id: ACCOUNT_ID, name: "Testnet account", exchange: "binance",
    marketType: "spot", testnet: true, createdAt: "2026-11-01T00:00:00.000Z", keyHint: "…a1b2", botsUsing: 1, openTrades: 0 }] }));
  server.routes.set(`GET /api/bot/manage/accounts/${ACCOUNT_ID}/balance`, () => ({ usdtFree: 812.5, totalUsdt: 1234.56,
    breakdown: [], cachedAt: "2026-11-09T12:00:00.000Z" }));
  server.routes.set(`GET /api/bot/manage/bots/${BOT_ID}`, () => detail);
  server.routes.set("GET /api/deployments", () => DEPLOYMENTS);
}

beforeEach(() => {
  resetBrowser(); resetSessionForTests(); pushes.length = 0;
  setCommandPollingForTests({ intervalMs: 25, windowMs: 1_000 });
});
afterEach(() => { setCommandPollingForTests(null); setNavigateForTests(null); });
after(closeBrowser);

const body = () => document.body.textContent ?? "";
const posts = (path: string) => server.calls.filter((c) => c.method !== "GET" && c.path === path);

async function openNew(capabilities = ALL) {
  account("admin");
  fixtures(capabilities);
  render(<Route path="/bot/bots/new"><NewBotPage /></Route>);
  await settle(8);
}

async function openDetail(capabilities = ALL, detail?: unknown) {
  account("admin");
  fixtures(capabilities, detail);
  render(<Route path={`/bot/bots/${BOT_ID}`} params={{ id: BOT_ID }}><BotDetailPage /></Route>);
  await settle(8);
}

test("new: a Bot without bots.v1 offers no form and says why", async () => {
  await openNew(["entries.v1"]);
  assert.equal(screen.queryByRole("form", { name: "New bot" }), null);
  assert.ok(body().includes("Creating bots from Trading Scene needs a newer Bot"));
});

test("new: every Classic field is there; the Bot's refusals are explained before anything is sent", async () => {
  await openNew();
  const form = screen.getByRole("form", { name: "New bot" });
  for (const label of [/Bot name/, /Exchange account/, /Max investment/, /^Unit/, /Volume per order/, /Max entry orders per pair/, /Stop loss \(%\)/]) {
    assert.ok(within(form).getByLabelText(label), String(label));
  }
  for (const name of ["Cap concurrent trades", "Entry orders", "Exit orders", "Take profit", "Stop loss"]) {
    assert.ok(within(form).getByRole("checkbox", { name }), name);
  }
  assert.equal(within(form).getAllByRole("radio").length, 2, "custom / TradingView");
  assert.ok(body().includes("Direct TradingView BUY alerts are disabled"), "the stale TradingView copy is corrected");
  assert.equal(within(form).queryByRole("button", { name: /^Limit/ }), null, "limit entries are not offered");

  fireEvent.change(within(form).getByLabelText(/Max investment/), { target: { value: "150" } });
  fireEvent.click(within(form).getByRole("button", { name: "Create bot…" }));
  await settle(2);
  assert.ok(body().includes("Select at least one trading pair."));
  assert.ok(body().includes("Enter a percentage from 0.01 to 100."));
  assert.equal(screen.queryByRole("dialog"), null);

  // The 50% unprotected-size rule, live.
  fireEvent.click(within(form).getByRole("button", { name: "BTCUSDT" }));
  fireEvent.change(within(form).getByLabelText(/Max investment/), { target: { value: "60" } });
  fireEvent.click(within(form).getByRole("checkbox", { name: "Stop loss" }));
  await settle(1);
  assert.ok(screen.getAllByRole("alert").some((a) => /50% of the balance or more requires a stop loss/.test(a.textContent ?? "")));
  fireEvent.click(within(form).getByRole("button", { name: "Create bot…" }));
  await settle(2);
  assert.equal(screen.queryByRole("dialog"), null);

  // A custom pair must be a USDT/USDC symbol; empty numbers are errors, never 0.
  fireEvent.change(within(form).getByLabelText("Add a pair"), { target: { value: "BTC-EUR" } });
  fireEvent.click(within(form).getByRole("button", { name: "Add" }));
  await settle(1);
  assert.ok(body().includes("A Binance Spot symbol quoted in USDT or USDC"));
  fireEvent.change(within(form).getByLabelText(/Volume per order/), { target: { value: "" } });
  await settle(1);
  assert.ok(body().includes("Enter a percentage from 1 to 100."));
  assert.equal(posts("/api/bot/manage/bots").length, 0);
});

test("new: free USDT under the account, and the investment estimate", async () => {
  await openNew();
  const form = screen.getByRole("form", { name: "New bot" });
  fireEvent.change(within(form).getByLabelText(/Exchange account/), { target: { value: ACCOUNT_ID } });
  await settle(4);
  assert.ok(body().includes("Available: 812.5 USDT"));
  assert.ok(body().includes("≈ 40.63 USDT of 812.50 available"));
});

test("new: create sends every field, needs a fresh code, and leads to Link to deployment", async () => {
  await openNew();
  let sent: Record<string, unknown> | null = null;
  server.routes.set("POST /api/bot/manage/bots", (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId, result: { bot: { ...VIEW, id: BOT_ID },
      secretIssued: true, platformSecret: { secretCaptured: true, linkedDeploymentsUpdated: 0 } } });
  });
  const form = screen.getByRole("form", { name: "New bot" });
  fireEvent.change(within(form).getByLabelText(/Bot name/), { target: { value: "  Trend bot " } });
  fireEvent.click(within(form).getByRole("button", { name: "BTCUSDT" }));
  fireEvent.change(within(form).getByLabelText("Add a pair"), { target: { value: "wif/usdt" } });
  fireEvent.keyDown(within(form).getByLabelText("Add a pair"), { key: "Enter" });
  fireEvent.change(within(form).getByLabelText(/Exchange account/), { target: { value: ACCOUNT_ID } });
  await settle(2);
  fireEvent.click(within(form).getByRole("button", { name: "Create bot…" }));
  await settle(2);
  const dialog = screen.getByRole("dialog", { name: "Create Trend bot" });
  assert.match(dialog.textContent ?? "", /BTCUSDT, WIFUSDT/);
  await enterCode(dialog, "Create bot");
  const s = sent as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(s).sort(), ["alertType", "credential", "direction", "entryEnabled", "entryOrderType", "entryVolumePct",
    "exchangeAccountId", "exitEnabled", "maxActiveSmartTrades", "maxActiveSmartTradesEnabled", "maxEntryOrders", "maxInvestmentPct",
    "maxInvestmentUnit", "name", "pairs", "requestId", "stopLossEnabled", "stopLossPct", "takeProfitEnabled", "takeProfitPct"]);
  assert.deepEqual([s.name, s.pairs, s.maxInvestmentPct, s.stopLossPct, s.takeProfitPct, s.exchangeAccountId],
    ["Trend bot", ["BTCUSDT", "WIFUSDT"], 5, 3, null, ACCOUNT_ID]);
  assert.ok(body().includes("Trend bot created"));
  assert.ok(body().includes("stored in Trading Scene (encrypted) and was never shown"));
  const deployment = document.querySelector(`[data-deployment="${DEP_CUSTOM}"]`) as HTMLElement;
  assert.ok(within(deployment).getByRole("button", { name: "Link BTCUSDT 1h" }));
  assert.match((document.querySelector(`[data-deployment="${DEP_3C}"]`) as HTMLElement).textContent ?? "", /Not a Bot webhook/);
});

test("new: a create whose secret was not captured says to rotate, and linking waits", async () => {
  await openNew();
  server.routes.set("POST /api/bot/manage/bots", (payload) => json(200, { status: "succeeded",
    requestId: (payload as { requestId: string }).requestId, result: { bot: VIEW, secretIssued: true,
      platformSecret: { secretCaptured: false, linkedDeploymentsUpdated: 0, replayed: true } } }));
  const form = screen.getByRole("form", { name: "New bot" });
  fireEvent.click(within(form).getByRole("button", { name: "ETHUSDT" }));
  fireEvent.click(within(form).getByRole("button", { name: "Create bot…" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog"), "Create bot");
  assert.ok(body().includes("Trading Scene did not capture it"));
  assert.equal((screen.getByRole("button", { name: "Link BTCUSDT 1h" }) as HTMLButtonElement).disabled, true);
});

test("detail: prefilled; an edit sends only what changed; loosening protection says a fresh code is needed", async () => {
  await openDetail();
  const form = screen.getByRole("form", { name: "Bot settings" });
  assert.equal((within(form).getByLabelText(/Bot name/) as HTMLInputElement).value, "Trend bot");
  assert.equal(within(form).getByRole("button", { name: "ETHUSDT" }).getAttribute("aria-pressed"), "true");
  assert.ok(body().includes("No changes."));
  let sent: Record<string, unknown> | null = null;
  server.routes.set(`PATCH /api/bot/manage/bots/${BOT_ID}`, (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: sent.requestId, result: { bot: VIEW } });
  });
  fireEvent.change(within(form).getByLabelText(/Bot name/), { target: { value: "Trend bot 2" } });
  await settle(1);
  assert.ok(body().includes("Changed: name."));
  assert.equal(body().includes("loosens protection"), false);
  fireEvent.click(within(form).getByRole("button", { name: "Save changes…" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog", { name: "Save Trend bot" }), "Save changes");
  const s = sent as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(s).sort(), ["credential", "name", "requestId"]);

  fireEvent.click(within(form).getByRole("checkbox", { name: "Stop loss" }));
  await settle(1);
  assert.ok(body().includes("This loosens protection, so it needs a fresh authenticator code."));
});

test("detail: rotate reports what was stored; reveal opens the Bot's page; delete explains a refusal", async () => {
  await openDetail();
  server.routes.set(`POST /api/bot/manage/bots/${BOT_ID}/rotate-secret`, (payload) => json(200, { status: "succeeded",
    requestId: (payload as { requestId: string }).requestId,
    result: { bot: VIEW, secretIssued: true, platformSecret: { secretCaptured: true, linkedDeploymentsUpdated: 2 } } }));
  fireEvent.click(screen.getByRole("button", { name: "Rotate secret…" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog"), "Rotate secret");
  assert.ok(body().includes("New secret stored in Trading Scene; 2 linked deployment(s) updated."));

  const went: string[] = [];
  setNavigateForTests((url) => went.push(url));
  const link = "https://bot.example.test/enroll#t=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  let mint: Record<string, unknown> | null = null;
  server.routes.set("POST /api/bot/manage/enrollments", (payload) => {
    mint = payload as Record<string, unknown>;
    return json(200, { status: "succeeded", requestId: mint.requestId,
      result: { enrollmentId: "e1", expiresAt: "2026-11-09T12:05:00.000Z", enrollUrl: link } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Show on the Bot…" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog"), "Open the Bot's page");
  assert.deepEqual([(mint as unknown as Record<string, unknown>).purpose, (mint as unknown as Record<string, unknown>).botId], ["reveal_webhook", BOT_ID]);
  assert.deepEqual(went, [link]);
  const stored = [window.localStorage, window.sessionStorage].flatMap((store) =>
    Array.from({ length: store.length }, (_, i) => store.getItem(store.key(i)!) ?? ""));
  assert.ok(stored.every((value) => !value.includes("abcdefghijklmnop")), "the link is stored nowhere");

  server.routes.set(`POST /api/bot/manage/bots/${BOT_ID}/delete`, () => json(409, { code: "bot_has_open_trades",
    error: "Cannot delete: this bot has 1 active trade(s). Close them first." }));
  fireEvent.click(screen.getByRole("button", { name: "Delete bot…" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog"), "Delete bot");
  assert.ok(body().includes("Cannot delete: this bot has 1 active trade(s). Close them first. The Bot did not run this."));
  assert.deepEqual(pushes, []);

  server.routes.set(`POST /api/bot/manage/bots/${BOT_ID}/delete`, (payload) => json(200, { status: "succeeded",
    requestId: (payload as { requestId: string }).requestId, result: { deleted: true } }));
  fireEvent.click(screen.getByRole("button", { name: "Delete bot…" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog"), "Delete bot");
  assert.deepEqual(pushes, ["/bot"]);
});

test("detail: link a deployment (grant tier), server-side; a 3Commas one is not linkable", async () => {
  await openDetail();
  let sent: Record<string, unknown> | null = null;
  server.routes.set(`POST /api/deployments/${DEP_CUSTOM}/link-bot`, (payload) => {
    sent = payload as Record<string, unknown>;
    return json(200, { linked: true, deploymentId: DEP_CUSTOM, botId: BOT_ID, replacedSecret: true });
  });
  fireEvent.click(screen.getByRole("button", { name: "Link BTCUSDT 1h" }));
  await settle(2);
  await enterCode(screen.getByRole("dialog", { name: "Link BTCUSDT 1h" }), "Link");
  const s = sent as unknown as Record<string, unknown>;
  assert.equal(s.botId, BOT_ID);
  assert.match(String(s.requestId), /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal("secret" in s, false, "the browser never carries a secret");
  assert.ok(body().includes("now signs its signals with Trend bot's secret (its previous secret was replaced)"));
});

test("detail: without enroll.v1 the reveal is off and says why; an unknown bot says so", async () => {
  await openDetail(["bots.v1", "accounts.v1"]);
  assert.equal((screen.getByRole("button", { name: "Show on the Bot…" }) as HTMLButtonElement).disabled, true);
  assert.ok(body().includes("Showing the exit alert on the Bot's page needs a newer Bot"));

  resetBrowser(); resetSessionForTests();
  account("admin");
  fixtures(ALL);
  server.routes.set(`GET /api/bot/manage/bots/${BOT_ID}`, () => json(404, { code: "bot_not_found", error: "Bot not found." }));
  render(<Route path={`/bot/bots/${BOT_ID}`} params={{ id: BOT_ID }}><BotDetailPage /></Route>);
  await settle(8);
  assert.ok(body().includes("The Bot has no bot with this id."));
});
