/**
 * The fake Bot's Slice 2 commands (contract v2.0, C10-C19), mirroring the
 * Bot's `routes/manualControlManage.ts` shapes:
 *   - C10/C14 answer `{bot, webhookSecret}` LIVE and store/replay only
 *     `{bot, secretIssued:true}` (X2);
 *   - C17 answers `{enrollmentId, enrollUrl, expiresAt}` live (201) and
 *     stores `{enrollmentId, expiresAt}`;
 *   - refusals are `{error, code}`; C19 fails with 502 `exchange_unavailable`.
 * Secrets and tickets are random at run time; no literal key material here.
 */
import { randomBytes, randomUUID } from "node:crypto";

export interface FakeManagedBot {
  id: string; name: string; status: "active" | "paused"; alertType: string; direction: string; pairs: string[];
  maxInvestmentPct: number; maxInvestmentUnit: string; entryEnabled: boolean; entryVolumePct: number;
  entryOrderType: string; exitEnabled: boolean; takeProfitEnabled: boolean; takeProfitPct: number | null;
  stopLossEnabled: boolean; stopLossPct: number | null; maxEntryOrders: number | null;
  maxActiveSmartTradesEnabled: boolean; maxActiveSmartTrades: number | null; exchangeAccountId: string | null;
  webhookSecret: string; activeTrades: number; unresolvedIntents: number; createdAt: string; updatedAt: string;
}

export interface FakeAccount {
  id: string; name: string; exchange: string; marketType: string; testnet: boolean; createdAt: string;
  keyHint: string | null; botsUsing: number; openTrades: number;
}

export interface FakeEnrollment {
  id: string; purpose: string; status: "issued" | "opened" | "completed" | "expired" | "failed";
  accountId?: string; keyHint?: string; outcome?: string;
}

type Answer = { status: number; body: unknown; stored?: unknown };
type Run = (requestId: string, kind: string, target: string, params: unknown, actor: unknown,
  run: () => Answer) => { status: number; body: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refuse = (status: number, code: string, error: string): Answer => ({ status, body: { error, code } });
const secretNow = () => randomBytes(24).toString("hex");
const mask = (s: string) => `${s.slice(0, 4)}${"*".repeat(s.length - 8)}${s.slice(-4)}`;

export class FakeBotManage {
  readonly bots = new Map<string, FakeManagedBot>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly enrollments = new Map<string, FakeEnrollment>();
  readonly failingBalances = new Set<string>();
  /** Every webhook secret this fake has issued, newest last (tests look for them in places they must not be). */
  readonly issuedSecrets: string[] = [];
  /** Every enrollment link issued (tickets included). */
  readonly issuedLinks: string[] = [];
  /** The same two, across `reset()`: a suite checks at its end that none leaked anywhere. */
  readonly everIssuedSecrets: string[] = [];
  readonly everIssuedLinks: string[] = [];
  /** The origin enrollment links are minted on (the Bot's PUBLIC_URL). */
  publicOrigin = "https://bot.example.test";

  reset(): void {
    this.bots.clear(); this.accounts.clear(); this.enrollments.clear(); this.failingBalances.clear();
    this.issuedSecrets.length = 0; this.issuedLinks.length = 0;
    this.publicOrigin = "https://bot.example.test";
  }

  addAccount(over: Partial<FakeAccount> = {}): FakeAccount {
    const a: FakeAccount = { id: randomUUID(), name: "Testnet account", exchange: "binance", marketType: "spot",
      testnet: true, createdAt: "2026-11-01T00:00:00.000Z", keyHint: "…a1b2", botsUsing: 0, openTrades: 0, ...over };
    this.accounts.set(a.id, a);
    return a;
  }

  addBot(over: Partial<FakeManagedBot> = {}): FakeManagedBot {
    const b = this.newBot({ name: "Managed bot", pairs: ["BTCUSDT"], maxInvestmentPct: 5 });
    Object.assign(b, over);
    this.bots.set(b.id, b);
    return b;
  }

  view(b: FakeManagedBot) {
    const account = b.exchangeAccountId ? this.accounts.get(b.exchangeAccountId) ?? null : null;
    return {
      id: b.id, name: b.name, status: b.status, alertType: b.alertType, direction: b.direction, pairs: b.pairs,
      maxInvestmentPct: b.maxInvestmentPct, maxInvestmentUnit: b.maxInvestmentUnit,
      maxInvestmentLabel: b.maxInvestmentUnit.startsWith("pct") ? `${b.maxInvestmentPct}% of balance` : `${b.maxInvestmentPct} USDT`,
      entryEnabled: b.entryEnabled, entryVolumePct: b.entryVolumePct, entryOrderType: b.entryOrderType,
      exitEnabled: b.exitEnabled, takeProfitPct: b.takeProfitEnabled ? b.takeProfitPct : null,
      stopLossPct: b.stopLossEnabled ? b.stopLossPct : null, maxEntryOrders: b.maxEntryOrders,
      maxActiveSmartTradesEnabled: b.maxActiveSmartTradesEnabled,
      maxActiveSmartTrades: b.maxActiveSmartTradesEnabled ? b.maxActiveSmartTrades : null,
      exchangeAccountId: b.exchangeAccountId,
      exchangeAccount: account ? { id: account.id, name: account.name, testnet: account.testnet } : null,
      webhookSecretMasked: mask(b.webhookSecret), webhookPath: "/api/webhooks/signal_bots",
      activeTrades: b.activeTrades, unresolvedIntents: b.unresolvedIntents, createdAt: b.createdAt, updatedAt: b.updatedAt,
    };
  }

  private newBot(fields: Record<string, unknown>): FakeManagedBot {
    const secret = secretNow();
    this.issuedSecrets.push(secret);
    this.everIssuedSecrets.push(secret);
    const now = "2026-11-09T12:00:00.000Z";
    return {
      id: randomUUID(), name: String(fields.name), status: "active", alertType: (fields.alertType as string) ?? "custom",
      direction: "long", pairs: (fields.pairs as string[]) ?? [], maxInvestmentPct: Number(fields.maxInvestmentPct),
      maxInvestmentUnit: (fields.maxInvestmentUnit as string) ?? "pct_bot", entryEnabled: (fields.entryEnabled as boolean) ?? true,
      entryVolumePct: (fields.entryVolumePct as number) ?? 100, entryOrderType: (fields.entryOrderType as string) ?? "market",
      exitEnabled: (fields.exitEnabled as boolean) ?? true, takeProfitEnabled: (fields.takeProfitEnabled as boolean) ?? false,
      takeProfitPct: (fields.takeProfitPct as number | null) ?? null, stopLossEnabled: (fields.stopLossEnabled as boolean) ?? true,
      stopLossPct: (fields.stopLossPct as number | null) ?? 3, maxEntryOrders: (fields.maxEntryOrders as number | null) ?? null,
      maxActiveSmartTradesEnabled: (fields.maxActiveSmartTradesEnabled as boolean) ?? false,
      maxActiveSmartTrades: (fields.maxActiveSmartTrades as number | null) ?? null,
      exchangeAccountId: (fields.exchangeAccountId as string | null) ?? null, webhookSecret: secret,
      activeTrades: 0, unresolvedIntents: 0, createdAt: now, updatedAt: now,
    };
  }

  /** Answers a Slice 2 route, or null when the path is not one. */
  route(method: string, path: string, params: Record<string, unknown>, actor: unknown, requestId: string,
    run: Run): { status: number; body: unknown } | null {
    const base = "/api/manual-trading/control";
    if (!path.startsWith(`${base}/bots`) && !path.startsWith(`${base}/exchange-`)) return null;
    const rel = path.slice(base.length);

    if (method === "POST" && rel === "/bots") {
      return run(requestId, "bot_create", "bot:new", params, actor, () => {
        if (typeof params.name !== "string" || !Array.isArray(params.pairs)) return refuse(400, "invalid_request", "Invalid bot.");
        if (params.exchangeAccountId && !this.accounts.has(params.exchangeAccountId as string)) {
          return refuse(404, "account_not_found", "That exchange account does not exist.");
        }
        const bot = this.newBot(params);
        this.bots.set(bot.id, bot);
        const view = this.view(bot);
        return { status: 201, body: { bot: view, webhookSecret: bot.webhookSecret }, stored: { bot: view, secretIssued: true } };
      });
    }
    let m = /^\/bots\/([^/]+)$/.exec(rel);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (!UUID.test(id)) return refuse(400, "invalid_id", "Invalid id.");
      if (method === "GET") {
        const bot = this.bots.get(id);
        return bot ? { status: 200, body: { bot: this.view(bot) } } : refuse(404, "bot_not_found", "Bot not found.");
      }
      if (method === "PATCH") {
        return run(requestId, "bot_update", `bot:${id}`, params, actor, () => {
          const bot = this.bots.get(id);
          if (!bot) return refuse(404, "bot_not_found", "Bot not found.");
          if (params.exchangeAccountId !== undefined && params.exchangeAccountId !== bot.exchangeAccountId && bot.activeTrades > 0) {
            return refuse(409, "bot_has_open_trades", "Cannot change the exchange account: this bot has active trades.");
          }
          Object.assign(bot, params);
          return { status: 200, body: { bot: this.view(bot) } };
        });
      }
    }
    m = /^\/bots\/([^/]+)\/(delete|rotate-secret)$/.exec(rel);
    if (m && method === "POST") {
      const id = decodeURIComponent(m[1]!);
      if (m[2] === "delete") {
        return run(requestId, "bot_delete", `bot:${id}`, params, actor, () => {
          const bot = this.bots.get(id);
          if (!bot) return refuse(404, "bot_not_found", "Not found");
          if (bot.activeTrades > 0) {
            return refuse(409, "bot_has_open_trades", `Cannot delete: this bot has ${bot.activeTrades} active trade(s). Close them first.`);
          }
          if (bot.unresolvedIntents > 0) {
            return refuse(409, "bot_has_unresolved_intents", "Cannot delete: orders are still being reconciled.");
          }
          this.bots.delete(id);
          return { status: 200, body: { deleted: true } };
        });
      }
      return run(requestId, "bot_rotate_secret", `bot:${id}`, params, actor, () => {
        const bot = this.bots.get(id);
        if (!bot) return refuse(404, "bot_not_found", "Bot not found.");
        bot.webhookSecret = secretNow();
        this.issuedSecrets.push(bot.webhookSecret);
        this.everIssuedSecrets.push(bot.webhookSecret);
        const view = this.view(bot);
        return { status: 200, body: { bot: view, webhookSecret: bot.webhookSecret }, stored: { bot: view, secretIssued: true } };
      });
    }
    if (method === "GET" && rel === "/exchange-accounts") {
      return { status: 200, body: { accounts: [...this.accounts.values()] } };
    }
    m = /^\/exchange-accounts\/([^/]+)\/(delete|balance)$/.exec(rel);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (m[2] === "balance" && method === "GET") {
        if (!this.accounts.has(id)) return refuse(404, "account_not_found", "That exchange account does not exist.");
        if (this.failingBalances.has(id)) {
          return refuse(502, "exchange_unavailable", "The exchange could not be reached, or refused this account's keys. Nothing was changed.");
        }
        return { status: 200, body: { usdtFree: 812.5, totalUsdt: 1234.56,
          breakdown: [{ asset: "USDT", free: 812.5, locked: 0, usdt: 812.5 }, { asset: "BTC", free: 0.01, locked: 0, usdt: 422.06 }],
          cachedAt: "2026-11-09T12:00:00.000Z" } };
      }
      if (m[2] === "delete" && method === "POST") {
        if (params.confirmation !== "REMOVE_ACCOUNT") return refuse(400, "invalid_request", "confirmation required");
        return run(requestId, "account_delete", `account:${id}`, params, actor, () => {
          const account = this.accounts.get(id);
          if (!account) return refuse(404, "account_not_found", "Not found");
          if (account.botsUsing > 0 || account.openTrades > 0) {
            return refuse(409, "account_in_use", `This account is used by ${account.botsUsing} bot(s); nothing was removed.`);
          }
          this.accounts.delete(id);
          return { status: 200, body: { deleted: true } };
        });
      }
    }
    if (method === "POST" && rel === "/exchange-enrollments") {
      const target = params.purpose === "reveal_webhook" ? `bot:${params.botId}`
        : params.purpose === "replace" ? `account:${params.accountId}` : "account:new";
      return run(requestId, "enrollment_create", target, params, actor, () => {
        if (params.purpose === "create" && params.testnet === false && params.mainnetConfirmation !== "MAINNET") {
          return refuse(400, "mainnet_confirmation_required", "Type MAINNET to confirm.");
        }
        if (params.purpose === "replace" && !this.accounts.has(params.accountId as string)) {
          return refuse(404, "account_not_found", "That exchange account does not exist.");
        }
        if (params.purpose === "reveal_webhook" && !this.bots.has(params.botId as string)) {
          return refuse(404, "bot_not_found", "Bot not found.");
        }
        const id = randomUUID();
        const ticket = randomBytes(32).toString("base64url");
        const enrollUrl = `${this.publicOrigin}/enroll#t=${ticket}`;
        this.issuedLinks.push(enrollUrl);
        this.everIssuedLinks.push(enrollUrl);
        this.enrollments.set(id, { id, purpose: String(params.purpose), status: "issued",
          ...(params.accountId ? { accountId: params.accountId as string } : {}) });
        const expiresAt = "2026-11-09T12:05:00.000Z";
        return { status: 201, body: { enrollmentId: id, enrollUrl, expiresAt }, stored: { enrollmentId: id, expiresAt } };
      });
    }
    m = /^\/exchange-enrollments\/([^/]+)$/.exec(rel);
    if (m && method === "GET") {
      const e = this.enrollments.get(decodeURIComponent(m[1]!));
      if (!e) return refuse(404, "enrollment_not_found", "No enrollment with this id.");
      const { id: _id, ...rest } = e;
      return { status: 200, body: rest };
    }
    return null;
  }
}
