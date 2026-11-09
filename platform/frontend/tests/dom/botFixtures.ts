/**
 * Bot-page fixtures shared by the Bot DOM tests: the shapes `lib/api.ts`
 * describes and the backend (`api/routes/botControl.ts`, `botView.ts`) sends.
 */
import type { BotControlPanel, BotControlStatus } from "@/lib/api";
import { server } from "./harness/env";

export const BOT_ID = "11111111-1111-4111-8111-111111111111";
export const TRADE_ID = "33333333-3333-4333-8333-333333333333";
export const MANUAL_TRADE_ID = "44444444-4444-4444-8444-444444444444";

export function account(role: "admin" | "user", opts: { twoFactorEnabled?: boolean; authEnabled?: boolean } = {}): void {
  server.routes.set("GET /api/auth/me", () => ({
    authenticated: true, authEnabled: opts.authEnabled ?? true,
    user: {
      id: "22222222-2222-4222-8222-222222222222", email: "trader@example.test", displayName: "Trader",
      avatarUrl: null, role, onboarded: true, hasPassword: true, passwordManagedByServer: role === "admin",
      googleLinked: false, githubLinked: false, emailVerified: true, twoFactorEnabled: opts.twoFactorEnabled ?? true,
      moneyFeaturesUnlocked: true, createdAt: "2026-10-16T00:00:00.000Z",
    },
    providers: { google: false, github: false, signups: true, email: false },
  }));
}

export const SUMMARY = {
  mode: { dryRun: true, binanceTestnet: true },
  stats: { upnl: 10, locked: 100, activeCount: 1, closedCount: 3, todayPnl: 2.5, totalRealizedPnl: 7.5,
    botCount: 1, activeBotCount: 1, stoppedBotCount: 0 },
};
export const BOT = {
  id: BOT_ID, name: "Trend bot", status: "active", pairs: ["BTCUSDT", "ETHUSDT"],
  investment: "5% of balance", entryEnabled: true, exitEnabled: true, takeProfitPct: null, stopLossPct: 3,
  maxEntryOrders: null, maxActiveSmartTrades: null, account: { name: "Testnet account", testnet: true },
  activeTrades: 1, closedTrades: 3, realizedPnl: 7.5, signalCount: 9, createdAt: "2026-10-01T00:00:00.000Z",
};
export const TRADE = {
  id: TRADE_ID, botId: BOT.id, botName: "Trend bot", source: "strategy", pair: "BTCUSDT", status: "active",
  entryPrice: 100, currentPrice: 110, quantity: 1, quoteSpent: 100, pnlUsdt: 10, pnlPct: 10,
  exchangeOrderId: "order-77", closedReason: null, partialCloses: 0, account: BOT.account,
  createdAt: "2026-10-20T00:00:00.000Z", closedAt: null,
};
export const MANUAL_TRADE = {
  ...TRADE, id: MANUAL_TRADE_ID, botId: null, botName: "Manual", source: "manual", pair: "ETHUSDT",
  exchangeOrderId: "order-88", pnlUsdt: -4, pnlPct: -2,
};
export const page = (rows: unknown[], total = rows.length) => ({ total, page: 1, pageSize: 50, rows });

export function facts(overrides: { halted?: boolean; haltedBy?: string | null; dryRun?: boolean;
  routing?: BotControlStatus["exchange"]["routing"]; latched?: boolean; realisedPnlInWindow?: number } = {}): BotControlStatus {
  const halted = overrides.halted ?? false;
  const dryRun = overrides.dryRun ?? true;
  return {
    operational: {
      service: { reachable: true, name: "signal-bot", version: "1.2.3" },
      execution: { mode: dryRun ? "DRY_RUN" : halted ? "HALTED" : "LIVE", dryRun, halted,
        haltedBy: halted ? overrides.haltedBy ?? "operator" : null, haltedReason: halted ? "maintenance" : null },
      exchange: { mode: "TESTNET", processDefault: "TESTNET", configuredAccounts: { total: 1, testnet: 1, mainnet: 0 } },
      realisedPnl: { currency: "USDT", today: 0, dayStart: "2026-11-09T00:00:00.000Z", timezone: "UTC", rollingWindowHours: 24, rolling: 0 },
      openTrades: { count: 1, exposureQuote: 100, currency: "USDT" },
      dailyLossProtection: { authority: "BOT", limitQuote: 50, windowHours: 24, realisedPnlInWindow: -5, enabled: true },
      time: "2026-11-09T12:00:00.000Z",
    },
    dryRun,
    halt: { halted, haltedBy: halted ? overrides.haltedBy ?? "operator" : null,
      haltedReason: halted ? "maintenance" : null, haltedAt: halted ? "2026-11-09T11:00:00.000Z" : null },
    exchange: { defaultTestnet: true, accounts: { testnet: 1, mainnet: 0 }, routing: overrides.routing ?? "TESTNET" },
    risk: {
      limits: { maxTotalExposureQuote: 1000, maxConcurrentTrades: 3, maxDailyLossQuote: 50, dailyLossWindowHours: 24 },
      snapshot: { openExposureQuote: 100, openTrades: 1, realisedPnlInWindow: overrides.realisedPnlInWindow ?? -5 },
      summary: "ACTIVE", latched: overrides.latched ?? false,
    },
    bots: { active: 1, paused: 0 },
    protection: { mode: "in_process_poll", intervalSec: 30, exchangeResting: false, note: "" },
    shariahFloor: { mode: "enforce", policyVersion: "2026.10" },
    manual: { enabled: true, mainnetEnabled: false },
    version: "1.2.3",
    time: "2026-11-09T12:00:00.000Z",
  };
}

export function panel(overrides: Partial<BotControlPanel> = {}, factOverrides: Parameters<typeof facts>[0] = {}): BotControlPanel {
  return {
    channel: { configured: true },
    signed: { state: "CONNECTED", cause: null },
    webhook: { state: "NOT_CONFIGURED", configuredEndpoints: 0, reason: "no_custom_bot_deployment" },
    preferred: "signed",
    facts: facts(factOverrides),
    readAt: "2026-11-09T12:00:00.000Z",
    platformHalt: { halted: false, haltedBy: null, haltedReason: null },
    ...overrides,
  };
}

export function botFixtures(opts: { trades?: (url: URL) => unknown; panel?: BotControlPanel } = {}): void {
  server.routes.set("GET /api/bot/summary", () => SUMMARY);
  server.routes.set("GET /api/bot/bots", () => [BOT]);
  server.routes.set("GET /api/bot/trades", (_body, url) => (opts.trades ?? (() => page([TRADE])))(url));
  server.routes.set("GET /api/bot/control/status", () => opts.panel ?? panel());
}

export const failing = (status: number, error: string, extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ error, ...extra }), { status, headers: { "content-type": "application/json" } });

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
