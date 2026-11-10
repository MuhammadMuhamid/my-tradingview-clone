/**
 * A fake execution Bot on 127.0.0.1 for the Bot-control tests.
 *
 * It authenticates every request the way the Bot's `requireManualAuth` does
 * (`bot/backend/src/services/manualAuth.ts`), with its OWN copy of the
 * canonicalisation rather than the Platform's signer, so a drift between the
 * two would fail here rather than pass by agreeing with itself:
 *   - the signed path is the request's full URL (`req.originalUrl`), query sorted;
 *   - a body-less non-GET is hashed as `{}` (express.json sets `req.body = {}`);
 *   - timestamp within ±60 s, nonce and request id `^[A-Za-z0-9_-]{16,128}$`,
 *     nonce single-use;
 *   - `v1=` + hex HMAC-SHA256 over METHOD\npath\nts\nnonce\nrequestId\nbodyHash.
 *
 * Commands are idempotent per request id, like the Bot's `BotControlCommand`
 * table: the same id and the same {kind, target, params} replays the stored
 * answer, a different hash is 409 `request_id_reused`.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeBotManage } from "./fakeBotManage";

export interface FakeBotReply {
  status?: number;
  json?: unknown;
  /** Sent verbatim instead of `json`. */
  raw?: string;
  /** Wait this long before answering (the command still runs first). */
  delayMs?: number;
  /** Drop the connection instead of answering. */
  destroy?: boolean;
  /** Answer without running the command at all (a proxy, a limiter). */
  skipExecution?: boolean;
}

export interface RecordedBotRequest {
  method: string;
  path: string;
  requestId: string | undefined;
  body: unknown;
  raw: string;
  verified: boolean;
}

interface StoredCommand {
  requestId: string; kind: string; target: string; hash: string;
  status: "succeeded" | "failed" | "pending"; httpStatus: number; body: unknown;
  actorUserId: string; stepUpMethod: string; createdAt: string;
}

const ID = /^[A-Za-z0-9_-]{16,128}$/;

/** The Bot's canonical JSON, written out again on purpose (see the header). */
function canonical(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function canonicalUrl(raw: string): string {
  const url = new URL(raw, "http://bot.local");
  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  const query = new URLSearchParams(sorted).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

/** The Bot half of "pause new entries" (C9, OD-3), as C0 reports it. */
export interface FakeEntries {
  paused: boolean; pausedAt: string | null; pausedBy: string | null; reason: string | null;
  workingEntryLimits: number; unresolvedBuyIntents: number;
}

export function controlStatus(overrides: { halted?: boolean; haltedBy?: string | null; dryRun?: boolean;
  routing?: "TESTNET" | "MAINNET" | "MIXED" | "NONE"; latched?: boolean;
  /** Omitted from C0 when undefined (an older Bot). */
  entries?: FakeEntries; capabilities?: string[] } = {}) {
  const halted = overrides.halted ?? false;
  const dryRun = overrides.dryRun ?? true;
  return {
    operational: {
      service: { reachable: true, name: "signal-bot", version: "1.2.3" },
      execution: { mode: dryRun ? "DRY_RUN" : halted ? "HALTED" : "LIVE", dryRun, halted,
        haltedBy: halted ? overrides.haltedBy ?? "operator" : null, haltedReason: halted ? "test halt" : null },
      exchange: { mode: "TESTNET", processDefault: "TESTNET", configuredAccounts: { total: 1, testnet: 1, mainnet: 0 } },
      realisedPnl: { currency: "USDT", today: 0, dayStart: "2026-11-09T00:00:00.000Z", timezone: "UTC",
        rollingWindowHours: 24, rolling: 0 },
      openTrades: { count: 1, exposureQuote: 100, currency: "USDT" },
      dailyLossProtection: { authority: "BOT", limitQuote: 50, windowHours: 24, realisedPnlInWindow: 0, enabled: true },
      time: "2026-11-09T12:00:00.000Z",
    },
    dryRun,
    halt: { halted, haltedBy: halted ? overrides.haltedBy ?? "operator" : null,
      haltedReason: halted ? "test halt" : null, haltedAt: halted ? "2026-11-09T11:00:00.000Z" : null },
    exchange: { defaultTestnet: true, accounts: { testnet: 1, mainnet: 0 }, routing: overrides.routing ?? "TESTNET" },
    risk: {
      limits: { maxTotalExposureQuote: 1000, maxConcurrentTrades: 3, maxDailyLossQuote: 50, dailyLossWindowHours: 24 },
      snapshot: { openExposureQuote: 100, openTrades: 1, realisedPnlInWindow: -5 },
      summary: "ACTIVE", latched: overrides.latched ?? false,
    },
    bots: { active: 1, paused: 0 },
    protection: { mode: "in_process_poll", intervalSec: 30, exchangeResting: false,
      note: "TP/SL is checked by the Bot while it runs." },
    shariahFloor: { mode: "enforce", policyVersion: "2026.10" },
    manual: { enabled: true, mainnetEnabled: false },
    version: "1.2.3",
    time: "2026-11-09T12:00:00.000Z",
    ...(overrides.entries ? { entries: overrides.entries } : {}),
    ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
  };
}

export const FAKE_BOT_CAPABILITIES = ["entries.v1", "manualPositionFull.v1"];

export class FakeBot {
  readonly requests: RecordedBotRequest[] = [];
  /** Applied, in order, to the next authenticated requests. */
  readonly replies: FakeBotReply[] = [];
  /** How many commands actually RAN (replays excluded). */
  executions = 0;
  halted = false;
  haltedBy: string | null = null;
  limits = { maxTotalExposureQuote: 1000 as number | null, maxConcurrentTrades: 3 as number | null,
    maxDailyLossQuote: 50 as number | null, dailyLossWindowHours: 24 };
  readonly bots = new Map<string, { id: string; name: string; status: "active" | "paused" }>();
  /** C9 state. `legacyStatus` makes C0 omit `entries` and `capabilities`, as a Bot before OD-3 does. */
  entries: FakeEntries = { paused: false, pausedAt: null, pausedBy: null, reason: null,
    workingEntryLimits: 0, unresolvedBuyIntents: 0 };
  /** Manual LIMIT BUYs still working; a pause with `cancelWorkingEntries` cancels them. */
  workingEntries: { orderId: string; symbol: string }[] = [];
  capabilities: string[] = [...FAKE_BOT_CAPABILITIES];
  legacyStatus = false;
  /** Manual orders the Platform forwarded (POST /api/manual-trading/orders). */
  readonly manualOrders: { requestId: string; body: Record<string, unknown> }[] = [];
  readonly manualTrades = new Set<string>();
  /** Feature B: archived trade ids → when; and trades the Bot refuses to archive, with its typed answer. */
  readonly archivedTrades = new Map<string, string>();
  readonly archiveRefusals = new Map<string, { status: number; code: string; error: string }>();
  readonly commands = new Map<string, StoredCommand>();
  /** Slice 2 (C10-C19): bots, accounts, enrollments. */
  readonly manage = new FakeBotManage();
  private readonly nonces = new Set<string>();
  private server: Server | null = null;
  url = "";

  constructor(readonly secret: string) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  reset(): void {
    this.requests.length = 0;
    this.replies.length = 0;
    this.executions = 0;
    this.halted = false;
    this.haltedBy = null;
    this.commands.clear();
    this.entries = { paused: false, pausedAt: null, pausedBy: null, reason: null, workingEntryLimits: 0, unresolvedBuyIntents: 0 };
    this.workingEntries = [];
    this.capabilities = [...FAKE_BOT_CAPABILITIES];
    this.legacyStatus = false;
    this.manage.reset();
    this.manualOrders.length = 0;
    this.archivedTrades.clear();
    this.archiveRefusals.clear();
  }

  /** Requests that reached a command route (not C0/C3/C8 reads). */
  commandRequests(): RecordedBotRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  private verify(req: IncomingMessage, body: unknown): { ok: true } | { ok: false; status: number; code: string } {
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const ts = header("x-manual-timestamp");
    const nonce = header("x-manual-nonce");
    const requestId = header("x-manual-request-id");
    const signature = header("x-manual-signature");
    if (!ts || !nonce || !requestId || !signature || !ID.test(nonce) || !ID.test(requestId)) {
      return { ok: false, status: 401, code: "auth" };
    }
    if (!/^\d+$/.test(ts) || Math.abs(Date.now() - Number(ts)) > 60_000) return { ok: false, status: 401, code: "auth" };
    const bodyHash = createHash("sha256").update(canonical(body)).digest("hex");
    const signed = [req.method!.toUpperCase(), canonicalUrl(req.url!), ts, nonce, requestId, bodyHash].join("\n");
    const expected = Buffer.from(`v1=${createHmac("sha256", this.secret).update(signed).digest("hex")}`);
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, status: 401, code: "auth" };
    if (this.nonces.has(nonce)) return { ok: false, status: 409, code: "nonce_replay" };
    this.nonces.add(nonce);
    return { ok: true };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }
    const path = req.url ?? "";
    const auth = this.verify(req, body);
    const requestId = typeof req.headers["x-manual-request-id"] === "string" ? req.headers["x-manual-request-id"] : undefined;
    this.requests.push({ method: req.method ?? "", path, requestId, body, raw, verified: auth.ok });
    const send = (status: number, payload: unknown, rawText?: string) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": rawText === undefined ? "application/json" : "text/html" });
      res.end(rawText ?? JSON.stringify(payload));
    };
    if (!auth.ok) { send(auth.status, { error: "rejected", code: auth.code }); return; }

    const override = this.replies.shift();
    let answer = { status: 404, body: { error: "Not found" } as unknown };
    if (!override?.skipExecution) answer = this.route(req.method ?? "", path, body, requestId ?? "");
    if (override?.delayMs) await new Promise((r) => setTimeout(r, override.delayMs));
    if (override?.destroy) { res.destroy(); return; }
    if (override && (override.status !== undefined || override.json !== undefined || override.raw !== undefined)) {
      send(override.status ?? 200, override.json, override.raw);
      return;
    }
    send(answer.status, answer.body);
  }

  /** Runs one command at most once per request id, then answers. */
  private command(requestId: string, kind: string, target: string, params: unknown, actor: unknown,
    run: () => { status: number; body: unknown }): { status: number; body: unknown } {
    const hash = createHash("sha256").update(canonical({ kind, target, params })).digest("hex");
    const stored = this.commands.get(requestId);
    if (stored) {
      if (stored.hash !== hash) return { status: 409, body: { error: "reused", code: "request_id_reused" } };
      return { status: stored.httpStatus, body: stored.body };
    }
    this.executions += 1;
    const result = run();
    const a = (actor ?? {}) as { platformUserId?: string; stepUp?: { method?: string } };
    this.commands.set(requestId, {
      requestId, kind, target, hash, httpStatus: result.status, body: result.body,
      status: result.status >= 400 ? "failed" : result.status === 202 ? "pending" : "succeeded",
      actorUserId: a.platformUserId ?? "", stepUpMethod: a.stepUp?.method ?? "", createdAt: new Date().toISOString(),
    });
    return result;
  }

  private route(method: string, path: string, body: unknown, requestId: string): { status: number; body: unknown } {
    const b = (body ?? {}) as Record<string, unknown>;
    const { actor, ...params } = b;
    const base = "/api/manual-trading/control";
    if (method === "GET" && path === `${base}/status`) {
      return { status: 200, body: controlStatus({ halted: this.halted, haltedBy: this.haltedBy,
        ...(this.legacyStatus ? {} : {
          entries: { ...this.entries, workingEntryLimits: this.workingEntries.length },
          capabilities: this.capabilities,
        }) }) };
    }
    if (method === "GET" && path === `${base}/risk-limits`) {
      return { status: 200, body: { limits: this.limits, snapshot: { openExposureQuote: 100, openTrades: 1, realisedPnlInWindow: -5 },
        summary: "ACTIVE", latched: this.haltedBy === "daily_loss" } };
    }
    const commandMatch = /^\/api\/manual-trading\/control\/commands\/([^/?]+)$/.exec(path);
    if (method === "GET" && commandMatch) {
      const stored = this.commands.get(decodeURIComponent(commandMatch[1]!));
      if (!stored) return { status: 404, body: { error: "No such command.", code: "command_not_found" } };
      return { status: 200, body: { requestId: stored.requestId, kind: stored.kind, target: stored.target,
        status: stored.status, httpStatus: stored.httpStatus, result: stored.body, actorUserId: stored.actorUserId,
        stepUpMethod: stored.stepUpMethod, createdAt: stored.createdAt, updatedAt: stored.createdAt } };
    }
    if (method === "POST" && path === `${base}/halt`) {
      return this.command(requestId, "halt", "bot", params, actor, () => {
        const alreadyHalted = this.halted;
        if (!alreadyHalted) { this.halted = true; this.haltedBy = "operator"; }
        return { status: 200, body: { halted: true, haltedBy: this.haltedBy, haltedReason: params.reason ?? null,
          haltedAt: "2026-11-09T12:00:00.000Z", alreadyHalted } };
      });
    }
    if (method === "POST" && path === "/api/manual-trading/orders") {
      // The manual order route (OD-7 tests): recorded, answered as accepted. Not a control command.
      this.manualOrders.push({ requestId, body: b });
      return { status: 200, body: { id: `manual-order-${this.manualOrders.length}`, status: "submitted", requestId } };
    }
    if (method === "POST" && path === `${base}/entries`) {
      // C9 (OD-3), strict like the Bot's schema: pause {paused:true, reason 3..200,
      // cancelWorkingEntries?}, resume {paused:false}; anything else is 400.
      const keys = Object.keys(params).sort().join(",");
      const pausing = params.paused === true;
      const valid = pausing
        ? typeof params.reason === "string" && params.reason.length >= 3 && params.reason.length <= 200
          && (keys === "paused,reason" || (keys === "cancelWorkingEntries,paused,reason"
            && typeof params.cancelWorkingEntries === "boolean"))
        : params.paused === false && keys === "paused";
      if (!valid) return { status: 400, body: { error: "Invalid entries command.", code: "invalid_request" } };
      return this.command(requestId, "entries", "bot", params, actor, () => {
        const changed = this.entries.paused !== pausing;
        if (changed) {
          this.entries = pausing
            ? { ...this.entries, paused: true, pausedAt: "2026-11-09T12:00:00.000Z",
              pausedBy: (actor as { platformUserId?: string } | undefined)?.platformUserId ?? "operator",
              reason: params.reason as string }
            : { ...this.entries, paused: false, pausedAt: null, pausedBy: null, reason: null };
        }
        const canceled = pausing && params.cancelWorkingEntries === true
          ? this.workingEntries.map((o) => ({ ...o, outcome: "canceled" as const })) : undefined;
        if (canceled) this.workingEntries = [];
        const { workingEntryLimits: _w, unresolvedBuyIntents: _u, ...entries } = this.entries;
        return { status: 200, body: { entries, changed, ...(canceled ? { canceledEntries: canceled } : {}) } };
      });
    }
    if (method === "POST" && path === `${base}/resume`) {
      return this.command(requestId, "resume", "bot", params, actor, () => {
        const previous = this.haltedBy;
        this.halted = false; this.haltedBy = null;
        return { status: 200, body: { halted: false, previousHaltedBy: previous, previousReason: null } };
      });
    }
    if (method === "PATCH" && path === `${base}/risk-limits`) {
      return this.command(requestId, "risk_limits", "bot", params, actor, () => {
        Object.assign(this.limits, params);
        return { status: 200, body: { limits: this.limits, snapshot: { openExposureQuote: 100, openTrades: 1,
          realisedPnlInWindow: -5 }, summary: "ACTIVE", latched: false } };
      });
    }
    const botMatch = /^\/api\/manual-trading\/control\/bots\/([^/]+)\/status$/.exec(path);
    if (method === "POST" && botMatch) {
      const id = decodeURIComponent(botMatch[1]!);
      return this.command(requestId, "bot_status", `bot:${id}`, params, actor, () => {
        const bot = this.bots.get(id);
        if (!bot) return { status: 404, body: { error: "Bot not found.", code: "bot_not_found" } };
        const changed = bot.status !== params.status;
        bot.status = params.status as "active" | "paused";
        return { status: 200, body: { ...bot, changed, unresolvedIntents: 2 } };
      });
    }
    const tradeMatch = /^\/api\/manual-trading\/control\/trades\/([^/]+)\/(close|partial-close)$/.exec(path);
    if (method === "POST" && tradeMatch) {
      const id = decodeURIComponent(tradeMatch[1]!);
      const kind = tradeMatch[2] === "close" ? "trade_close" : "trade_partial_close";
      return this.command(requestId, kind, `trade:${id}`, params, actor, () => {
        if (this.manualTrades.has(id)) {
          return { status: 409, body: { error: "This position was opened from Trading Scene. Close it from the Trade panel.",
            code: "trade_manual" } };
        }
        return kind === "trade_close"
          ? { status: 200, body: { status: "ok", detail: "closed" } }
          : { status: 200, body: { partial: { pct: params.pct }, trade: { id }, requestedQty: 0.25, executedQty: 0.25 } };
      });
    }
    const archiveMatch = /^\/api\/manual-trading\/control\/trades\/([^/]+)\/archive$/.exec(path);
    if (method === "POST" && archiveMatch) {
      const id = decodeURIComponent(archiveMatch[1]!);
      return this.command(requestId, "trade_archive", `trade:${id}`, params, actor, () => {
        const refusal = this.archiveRefusals.get(id);
        if (refusal && params.archived === true) {
          return { status: refusal.status, body: { error: refusal.error, code: refusal.code } };
        }
        const was = this.archivedTrades.get(id) ?? null;
        if (params.archived === true && !was) this.archivedTrades.set(id, "2026-11-09T12:00:00.000Z");
        if (params.archived === false) this.archivedTrades.delete(id);
        const now = this.archivedTrades.get(id) ?? null;
        return { status: 200, body: { id, archived: now !== null, archivedAt: now,
          archivedBy: now ? "platform:actor" : null, changed: (was !== null) !== (now !== null) } };
      });
    }
    const managed = this.manage.route(method, path, params, actor, requestId,
      (id, kind, target, p, a, run) => this.storedCommand(id, kind, target, p, a, run));
    if (managed) return managed;
    return { status: 404, body: { error: "Not found" } };
  }

  /**
   * `command`, for a command whose stored answer differs from its live one
   * (X2: a secret or a ticket is answered once and never replayed).
   */
  private storedCommand(requestId: string, kind: string, target: string, params: unknown, actor: unknown,
    run: () => { status: number; body: unknown; stored?: unknown }): { status: number; body: unknown } {
    let live: { status: number; body: unknown } | null = null;
    const answer = this.command(requestId, kind, target, params, actor, () => {
      const result = run();
      live = { status: result.status, body: result.body };
      return { status: result.status, body: result.stored ?? result.body };
    });
    return live ?? answer;
  }
}
