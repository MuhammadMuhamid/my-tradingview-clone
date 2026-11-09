/**
 * OD-7 on screen: a manual SELL is for a chosen position. The SELL tab
 * preselects the only position (or makes the operator choose among several),
 * "100%" is that position, a wallet sell needs an explicit tick, a deep link
 * to a position that is gone does nothing, and the whole position goes as
 * `positionFull` only to a Bot that advertises it. A manual BUY the server
 * asks to confirm opens the step-up dialog and retries with the same id.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertPresent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { ManualTradingPanel } from "@/components/tv/ManualTradingPanel";
import { loadSession, resetSessionForTests } from "@/lib/session";
import type { ManualPosition, ManualTradingState } from "@/lib/api";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const position = (id: string, quantity: number, over: Partial<ManualPosition> = {}): ManualPosition => ({
  id, exchangeAccountId: "acct-test", pair: "SOLUSDT", status: "active", entryPrice: 150,
  currentPrice: 151, quantity, quoteSpent: 50, pnlUsdt: 0, pnlPct: 0,
  manualTpPrice: null, manualSlPrice: null, protectionType: null, protectionState: null,
  createdAt: "2026-11-09T10:00:00.000Z", closedAt: null, closedReason: null, ...over,
});

const state = (positions: ManualPosition[]): ManualTradingState => ({
  enabled: true, mainnetEnabled: false, dryRun: true, mixed: false, tradingHalted: false,
  accounts: [{ id: "acct-test", name: "Testnet", exchange: "binance", marketType: "spot", testnet: true, mode: "testnet" }],
  orders: [], positions,
  protection: { type: "bot-managed", exchangeResting: false, note: "", polling: true, haltedBy: null, mainnetPositionsChecked: false },
});

function routes(positions: ManualPosition[], options: { capabilities?: string[] | null; free?: number } = {}) {
  server.routes.set("GET /api/manual-trading/state", () => state(positions));
  server.routes.set("GET /api/manual-trading/account-state", () => ({
    symbol: "SOLUSDT", simulated: true,
    base: { asset: "SOL", free: options.free ?? 1.2, locked: 0 },
    quote: { asset: "USDT", free: 1000, locked: 0 },
    rules: { lotStep: 0.01, minQty: 0.01, priceTick: 0.01, minNotional: 1 },
  }));
  server.routes.set("GET /api/bot/control/status", () => ({
    channel: { configured: true }, signed: { state: "CONNECTED", cause: null }, preferred: "signed",
    webhook: { state: "NOT_CONFIGURED", configuredEndpoints: 0 }, readAt: "2026-11-09T12:00:00.000Z",
    facts: options.capabilities === null ? null : { capabilities: options.capabilities ?? [] },
  }));
  const orders: Record<string, unknown>[] = [];
  server.routes.set("POST /api/manual-trading/orders", (body) => { orders.push(body as Record<string, unknown>); return { id: "o1" }; });
  return orders;
}

async function open(props: Partial<Parameters<typeof ManualTradingPanel>[0]> = {}) {
  await loadSession();
  render(<ManualTradingPanel symbol="SOLUSDT" onStateChange={() => {}} {...props} />);
  await settle(8);
}
const amount = () => (screen.getByLabelText("Base quantity") as HTMLInputElement).value;
const reviewButton = () => screen.getByRole("button", { name: /^Review (SELL|BUY)/ }) as HTMLButtonElement;
const sellTab = () => screen.getByRole("button", { name: /^SELL/ });
async function confirmOrder() {
  fireEvent.click(reviewButton());
  await settle(3);
  fireEvent.click(screen.getByRole("button", { name: /^Confirm (SELL|BUY)$/ }));
  await settle(6);
}

test("one open position: the SELL tab selects it, 100% is that position (floored), and the order names it", async () => {
  const orders = routes([position("pos-a", 0.375)]);
  await open();
  fireEvent.click(sellTab());
  await settle(4);
  const picker = screen.getByLabelText(/Position to sell/) as HTMLSelectElement;
  assert.equal(picker.value, "pos-a");
  assert.equal(amount(), "0.37", "the whole position, floored to the 0.01 lot step");
  assert.match(assertPresent(document.querySelector('[data-testid="manual-sell-dust"]'), "dust note").textContent ?? "",
    /0\.005 SOL below the lot step/);
  assert.match(document.querySelector('[data-testid="manual-quickfill-basis"]')?.textContent ?? "", /selected position/);
  fireEvent.click(screen.getByTestId("manual-quickfill-50"));
  await settle(2);
  assert.equal(amount(), "0.18", "50% of the position, not of the 1.2 SOL wallet");
  fireEvent.click(screen.getByTestId("manual-quickfill-100"));
  await settle(2);
  assert.equal(amount(), "0.37");
  await confirmOrder();
  assert.equal(orders.length, 1);
  assert.deepEqual([orders[0]!.side, orders[0]!.positionId, orders[0]!.baseQuantity, orders[0]!.positionFull],
    ["SELL", "pos-a", 0.37, undefined], "an older Bot gets the floored quantity");
  assert.equal(typeof orders[0]!.requestId, "string");
});

test("with manualPositionFull.v1 the whole position goes as positionFull and no quantity; a partial stays a quantity", async () => {
  const orders = routes([position("pos-a", 0.375)], { capabilities: ["manualPositionFull.v1"] });
  await open();
  fireEvent.click(sellTab());
  await settle(4);
  await confirmOrder();
  assert.deepEqual([orders[0]!.positionFull, "baseQuantity" in orders[0]!, orders[0]!.positionId], [true, false, "pos-a"]);
  fireEvent.click(screen.getByRole("tab", { name: "Order" }));
  await settle(2);
  fireEvent.click(sellTab());
  await settle(4);
  fireEvent.click(screen.getByTestId("manual-quickfill-50"));
  await settle(2);
  await confirmOrder();
  assert.deepEqual([orders[1]!.positionFull, orders[1]!.baseQuantity], [undefined, 0.18]);
});

test("the wallet caps a position larger than the free balance", async () => {
  routes([position("pos-a", 2)], { free: 1.2 });
  await open();
  fireEvent.click(sellTab());
  await settle(4);
  assert.equal(amount(), "1.2");
});

test("several positions: nothing is chosen for the operator, and SELL waits for a choice or the explicit wallet tick", async () => {
  const orders = routes([position("pos-a", 0.37), position("pos-b", 0.5)]);
  await open();
  fireEvent.click(sellTab());
  await settle(4);
  const picker = screen.getByLabelText(/Position to sell/) as HTMLSelectElement;
  assert.equal(picker.value, "");
  assert.match(screen.getByTestId("manual-sell-requirement").textContent ?? "", /Choose which position to sell/);
  fireEvent.change(screen.getByLabelText("Base quantity"), { target: { value: "0.1" } });
  await settle(2);
  assert.equal(reviewButton().disabled, true, "no silent wallet sell");
  fireEvent.click(screen.getByTestId("manual-wallet-sell"));
  await settle(2);
  assert.match(document.body.textContent ?? "", /can sell coins that belong to another position/);
  assert.match(document.querySelector('[data-testid="manual-quickfill-basis"]')?.textContent ?? "", /free wallet balance/);
  fireEvent.click(screen.getByTestId("manual-quickfill-100"));
  await settle(2);
  assert.equal(amount(), "1.2", "100% of the free wallet balance, only in wallet mode");
  await confirmOrder();
  assert.equal(orders.length, 1);
  assert.equal("positionId" in orders[0]!, false);
  assert.equal(orders[0]!.baseQuantity, 1.2);
});

test("no positions: a wallet sell, as before", async () => {
  routes([]);
  await open();
  fireEvent.click(sellTab());
  await settle(4);
  assert.equal(screen.queryByLabelText(/Position to sell/), null);
  fireEvent.click(screen.getByTestId("manual-quickfill-100"));
  await settle(2);
  assert.equal(amount(), "1.2");
});

test("a deep link preselects exactly its position; a link to a closed one says so and selects nothing", async () => {
  routes([position("pos-a", 0.37), position("pos-b", 0.5)]);
  let used = 0;
  await open({ initialSell: { accountId: "acct-test", positionId: "pos-b" }, onInitialSellUsed: () => { used += 1; } });
  assert.equal(used, 1);
  assert.equal((screen.getByLabelText(/Position to sell/) as HTMLSelectElement).value, "pos-b");
  assert.equal(amount(), "0.5");
  assert.equal(reviewButton().textContent?.startsWith("Review SELL"), true);
  assert.equal(server.callsTo("/api/manual-trading/orders").length, 0, "prefill only, nothing submitted");
});

test("a deep link to a position that is no longer open does nothing but say so", async () => {
  routes([position("pos-a", 0.37)]);
  await open({ initialSell: { accountId: "acct-test", positionId: "pos-gone" } });
  assert.match(screen.getByTestId("manual-sell-target-notice").textContent ?? "", /no longer open/);
  assert.equal(screen.getByRole("button", { name: /^BUY/ }).getAttribute("aria-pressed"), "true", "the side did not change");
  assert.equal(server.callsTo("/api/manual-trading/orders").length, 0);
});

test("a BUY the server wants confirmed opens the step-up dialog; the retry carries the same request id and the code", async () => {
  server.routes.set("GET /api/auth/me", () => ({ authenticated: true, authEnabled: true, username: "owner",
    providers: { google: false, github: false, signups: false, email: false },
    user: { id: "00000000-0000-4000-8000-000000000001", email: null, displayName: "Admin", avatarUrl: null,
      role: "admin", onboarded: true, hasPassword: true, passwordManagedByServer: true, googleLinked: false,
      githubLinked: false, emailVerified: true, twoFactorEnabled: true, moneyFeaturesUnlocked: true,
      createdAt: "2026-01-01T00:00:00.000Z" } }));
  await loadSession();
  routes([]);
  const attempts: Record<string, unknown>[] = [];
  server.routes.set("POST /api/manual-trading/orders", (body) => {
    attempts.push(body as Record<string, unknown>);
    if (!(body as { credential?: unknown }).credential) {
      return new Response(JSON.stringify({ code: "step_up_required", method: "totp", tier: "grant",
        error: "Enter the code from your authenticator app to confirm." }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return { id: "o-buy" };
  });
  render(<ManualTradingPanel symbol="SOLUSDT" onStateChange={() => {}} />);
  await settle(8);
  fireEvent.change(screen.getByLabelText("Quote amount"), { target: { value: "25" } });
  await settle(2);
  await confirmOrder();
  assert.equal(attempts.length, 1);
  const dialog = assertPresent(screen.queryByRole("dialog", { name: "Confirm this BUY" }), "step-up dialog");
  const code = dialog.querySelector("input") as HTMLInputElement;
  // The shared six-digit field confirms on the sixth digit (OD-2).
  fireEvent.change(code, { target: { value: "123456" } });
  await settle(6);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]!.requestId, attempts[0]!.requestId, "one order, one request id");
  assert.deepEqual(attempts[1]!.credential, { code: "123456" });
  assert.match(document.body.textContent ?? "", /Order accepted by the execution bot/);
});

test("OD-1: a partial SELL of a position whose entry still works says so; the Bot's cancel state and notes show; an over-sell is explained", async () => {
  const entry = { id: "entry-1", requestId: "r-entry", exchangeAccountId: "acct-test", linkedPositionId: "pos-a", symbol: "SOLUSDT",
    side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedBaseQty: null, requestedQuoteQty: 60, limitPrice: 150,
    takeProfitPrice: null, stopLossPrice: null, protectionType: null, protectionState: null, status: "partially_filled",
    exchangeOrderId: "e1", clientOrderId: "c1", filledBaseQty: 0.375, filledQuoteQty: 56, averageFillPrice: 150,
    error: null, submittedAt: null, completedAt: null, createdAt: "2026-11-09T10:00:00.000Z", updatedAt: "2026-11-09T10:00:00.000Z" };
  const failedCancel = { ...entry, id: "entry-2", requestId: "r2", linkedPositionId: "pos-z", status: "open",
    exitCancelState: "failed", error: "ENTRY CANCEL FAILED: the exchange refused the cancel; cancel it on Binance" };
  const swept = position("pos-swept", 0.02, { protectionState: "race_fill_sweep" });
  routes([position("pos-a", 0.375), swept]);
  server.routes.set("GET /api/manual-trading/state", () => ({ ...state([position("pos-a", 0.375), swept]),
    orders: [entry, failedCancel] }));
  server.routes.set("POST /api/manual-trading/orders", () => new Response(JSON.stringify({ code: "sell_exceeds_position",
    error: "baseQuantity exceeds the remaining position" }), { status: 409, headers: { "content-type": "application/json" } }));
  await open();
  fireEvent.click(sellTab());
  await settle(4);
  fireEvent.change(screen.getByLabelText(/Position to sell/), { target: { value: "pos-a" } });
  await settle(2);
  assert.equal(screen.queryByTestId("manual-partial-entry-note"), null, "the whole position cancels the entry first");
  fireEvent.click(screen.getByTestId("manual-quickfill-50"));
  await settle(2);
  assert.equal(screen.getByTestId("manual-partial-entry-note").textContent, "Partial sell: the entry order keeps working.");
  await confirmOrder();
  assert.match(screen.getByRole("alert").textContent ?? "", /more than this position still holds/);
  fireEvent.click(screen.getByRole("tab", { name: /^Orders/ }));
  await settle(4);
  assert.match(document.body.textContent ?? "", /ENTRY CANCEL FAILED — cancel on Binance/);
  assert.match(screen.getByTestId("manual-order-note").textContent ?? "", /^ENTRY CANCEL FAILED: the exchange refused/);
  const sweptRow = assertPresent(document.querySelector('[data-position-id="pos-swept"]'), "race-fill position");
  assert.equal(sweptRow.querySelector("[data-protection]")?.textContent, "Race fill — being sold automatically");
});
