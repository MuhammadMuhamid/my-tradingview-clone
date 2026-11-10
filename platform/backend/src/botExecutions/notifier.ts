/**
 * Bot execution push notifications (P-81).
 *
 * The Bot appends one immutable event per CONFIRMED execution: a fill its
 * ledger booked, never a submitted, rejected or unknown order. It serves them
 * on its signed control plane (`executions.v1`). This module:
 *
 *   1. polls that feed with the Platform's existing signed channel, only while
 *      at least one admin has opted in, and only when the Bot advertises the
 *      capability (an older Bot is left alone);
 *   2. stores each event once by its Bot event id (`bot_execution_events`)
 *      and advances the cursor in the SAME transaction, so a re-read page, a
 *      restart or a second Platform instance never stores an event twice;
 *   3. pushes each new event to every opted-in ADMIN through the existing web
 *      push (`sendPush`), recording each successful recipient
 *      (`bot_execution_deliveries`) so a retry never re-sends to them.
 *
 * It is an observer. It never calls a trading route, and nothing in trading
 * waits for it. A Bot or push-service outage only delays or skips
 * notifications. There is no exactly-once network delivery: the device-level
 * `tag` (one per event) collapses a rare duplicate on the same device.
 */
import type { PoolClient } from "pg";
import { pool, query } from "../db/pool";
import { sendPush, type PushMessage, type PushResult } from "../alerts/webPush";
import { botControlCommand, isManualControlChannelConfigured } from "../manualTrading/client";
import { botHasCapability, readSignedBotStatus, type SignedBotStatus } from "../operations/botStatus";

export const EXECUTION_FEED_CAPABILITY = "executions.v1";
export const EXECUTION_FEED_PATH = "/api/manual-trading/control/executions";
export const FEED_PAGE_LIMIT = 100;
export const FEED_MAX_PAGES_PER_TICK = 5;
/** Delivery attempts per event before it is given up. */
export const MAX_NOTIFY_ATTEMPTS = 3;
/** An execution older than this when first seen is stored but not pushed. */
export const NOTIFY_MAX_AGE_MS = 6 * 60 * 60_000;
/** The C0 capability reading is reused for this long. */
export const CAPABILITY_CACHE_MS = 5 * 60_000;

const ENVIRONMENTS = ["DRY_RUN", "TESTNET", "MAINNET", "UNKNOWN"] as const;
const SOURCES = ["strategy", "tpsl", "partial", "manual", "manual-protection", "manual-sweep"] as const;
export type ExecutionEnvironment = typeof ENVIRONMENTS[number];

export interface BotExecutionEvent {
  seq: number;
  eventId: string;
  side: "BUY" | "SELL";
  symbol: string;
  executedBaseQty: number;
  executedQuoteQty: number;
  averagePrice: number;
  environment: ExecutionEnvironment;
  source: typeof SOURCES[number];
  orderComplete: boolean;
  cumulativeBaseQty: number;
  botId: string | null;
  botName: string | null;
  smartTradeId: string | null;
  exchangeOrderId: string | null;
  executedAt: string;
}

export class ExecutionFeedError extends Error {}

const EVENT_ID = /^(strategy|exit|manual):[A-Za-z0-9:._-]{1,200}$/;
const SYMBOL = /^[A-Z0-9]{2,30}$/;
const SHORT_ID = /^[A-Za-z0-9:._-]{1,128}$/;

function nonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ExecutionFeedError(`${name} must be a non-negative number`);
  }
  return value;
}

function optionalId(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !SHORT_ID.test(value)) throw new ExecutionFeedError(`${name} is not an id`);
  return value;
}

/**
 * Validates one feed event. Fields this version does not know are dropped
 * (an additive v1 Bot field never breaks an older Platform); a missing or
 * malformed known field rejects the event.
 */
export function normalizeExecutionEvent(raw: unknown): BotExecutionEvent {
  if (!raw || typeof raw !== "object") throw new ExecutionFeedError("event must be an object");
  const e = raw as Record<string, unknown>;
  if (e.contractVersion !== 1 || e.type !== "BOT_EXECUTION") throw new ExecutionFeedError("unsupported event version");
  if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq < 1) throw new ExecutionFeedError("bad seq");
  if (typeof e.eventId !== "string" || !EVENT_ID.test(e.eventId)) throw new ExecutionFeedError("bad eventId");
  if (e.side !== "BUY" && e.side !== "SELL") throw new ExecutionFeedError("bad side");
  if (typeof e.symbol !== "string" || !SYMBOL.test(e.symbol)) throw new ExecutionFeedError("bad symbol");
  if (!(ENVIRONMENTS as readonly unknown[]).includes(e.environment)) throw new ExecutionFeedError("bad environment");
  if (!(SOURCES as readonly unknown[]).includes(e.source)) throw new ExecutionFeedError("bad source");
  if (typeof e.orderComplete !== "boolean") throw new ExecutionFeedError("bad orderComplete");
  if (typeof e.executedAt !== "string" || Number.isNaN(Date.parse(e.executedAt))) {
    throw new ExecutionFeedError("bad executedAt");
  }
  const executedBaseQty = nonNegative(e.executedBaseQty, "executedBaseQty");
  if (!(executedBaseQty > 0)) throw new ExecutionFeedError("an execution moves a positive quantity");
  let botName: string | null = null;
  if (e.botName !== null && e.botName !== undefined) {
    if (typeof e.botName !== "string") throw new ExecutionFeedError("bad botName");
    botName = Array.from(e.botName).filter((ch) => ch >= " " && ch !== "\u007f").join("").slice(0, 80);
  }
  return {
    seq: e.seq,
    eventId: e.eventId,
    side: e.side,
    symbol: e.symbol,
    executedBaseQty,
    executedQuoteQty: nonNegative(e.executedQuoteQty, "executedQuoteQty"),
    averagePrice: nonNegative(e.averagePrice, "averagePrice"),
    environment: e.environment as ExecutionEnvironment,
    source: e.source as BotExecutionEvent["source"],
    orderComplete: e.orderComplete,
    cumulativeBaseQty: nonNegative(e.cumulativeBaseQty, "cumulativeBaseQty"),
    botId: optionalId(e.botId, "botId"),
    botName,
    smartTradeId: optionalId(e.smartTradeId, "smartTradeId"),
    exchangeOrderId: optionalId(e.exchangeOrderId, "exchangeOrderId"),
    executedAt: new Date(e.executedAt).toISOString(),
  };
}

export interface FeedPage {
  latestSeq: number;
  nextAfter: number;
  events: unknown[];
}

function isFeedPage(value: unknown): value is FeedPage {
  const v = value as Partial<FeedPage> | null;
  return !!v && typeof v === "object" && Number.isSafeInteger(v.latestSeq) && Number.isSafeInteger(v.nextAfter)
    && Array.isArray(v.events) && v.events.length <= FEED_PAGE_LIMIT;
}

/** Wording people see. MAINNET is said as REAL only because the Bot proved it. */
export function environmentLabel(environment: ExecutionEnvironment): string {
  return { MAINNET: "REAL", TESTNET: "TESTNET", DRY_RUN: "DRY RUN (simulated)", UNKNOWN: "ENVIRONMENT UNKNOWN" }[environment];
}

const SOURCE_LABEL: Record<BotExecutionEvent["source"], string> = {
  strategy: "Strategy", tpsl: "TP/SL exit", partial: "Partial close", manual: "Manual order",
  "manual-protection": "Manual TP/SL exit", "manual-sweep": "Manual sweep",
};

function fmt(value: number): string {
  if (value === 0) return "0";
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : 8;
  return Number(value.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** The notification for one confirmed execution. No ids, secrets or amounts beyond the fill. */
export function executionMessage(event: BotExecutionEvent): PushMessage {
  const base = event.symbol.replace(/(USDT|USDC|BUSD|FDUSD|BTC|ETH)$/, "") || event.symbol;
  const quote = event.symbol.slice(base.length) || "";
  const fill = event.source.startsWith("manual") && !(event.orderComplete && event.cumulativeBaseQty <= event.executedBaseQty)
    ? event.orderComplete ? " · last fill, order complete" : ` · partial fill (${fmt(event.cumulativeBaseQty)} ${base} so far)`
    : "";
  const who = event.botName ? ` · ${event.botName}` : "";
  return {
    title: `${event.side} executed · ${event.symbol} · ${environmentLabel(event.environment)}`,
    body: `${fmt(event.executedBaseQty)} ${base} at ${fmt(event.averagePrice)}${quote ? ` ${quote}` : ""}`
      + ` (${fmt(event.executedQuoteQty)}${quote ? ` ${quote}` : ""})${fill} · ${SOURCE_LABEL[event.source]}${who}`,
    tag: `bot-exec-${event.eventId}`.slice(0, 120),
    url: "/bot",
  };
}

// ── persistence ─────────────────────────────────────────────────────────────

export async function anyAdminOptedIn(): Promise<boolean> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bot_execution_notification_prefs p JOIN users u ON u.id = p.user_id
      WHERE p.enabled AND u.role = 'admin'`);
  return (rows[0]?.n ?? 0) > 0;
}

export async function readCursor(): Promise<number | null> {
  const { rows } = await query<{ last_seq: string }>("SELECT last_seq FROM bot_execution_feed WHERE id = 1");
  return rows[0] ? Number(rows[0].last_seq) : null;
}

async function writeCursor(client: PoolClient | null, seq: number): Promise<void> {
  const sql = `INSERT INTO bot_execution_feed (id, last_seq, updated_at) VALUES (1, $1, now())
               ON CONFLICT (id) DO UPDATE SET last_seq = EXCLUDED.last_seq, updated_at = now()`;
  if (client) await client.query(sql, [seq]); else await query(sql, [seq]);
}

/**
 * Stores a page and moves the cursor atomically. Returns how many events were
 * new, or null when another poller holds the feed (nothing was written).
 */
async function storePage(events: BotExecutionEvent[], nextAfter: number, now: Date): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One poller at a time across Platform instances; a second one skips this tick.
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('bot_execution_feed')) AS ok");
    if (!lock.rows[0]?.ok) { await client.query("ROLLBACK"); return null; }
    let inserted = 0;
    for (const event of events) {
      const tooOld = now.getTime() - Date.parse(event.executedAt) > NOTIFY_MAX_AGE_MS;
      const result = await client.query(
        `INSERT INTO bot_execution_events (event_id, seq, side, symbol, environment, executed_at, payload,
                                           notified_at, notify_outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, event.seq, event.side, event.symbol, event.environment, event.executedAt,
          JSON.stringify(event), tooOld ? now : null, tooOld ? "expired" : null]);
      inserted += result.rowCount ?? 0;
    }
    await writeCursor(client, nextAfter);
    await client.query("COMMIT");
    return inserted;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── polling ─────────────────────────────────────────────────────────────────

export interface NotifierDeps {
  fetchFeed: (after: number | null) => Promise<FeedPage>;
  readStatus: () => Promise<SignedBotStatus>;
  push: (message: PushMessage, to: { userId: string }) => Promise<PushResult>;
  now: () => Date;
  log: { warn: (o: unknown, m: string) => void; info?: (o: unknown, m: string) => void };
}

export async function fetchFeedSigned(after: number | null, fetchImpl: typeof fetch = fetch): Promise<FeedPage> {
  const path = after === null ? EXECUTION_FEED_PATH : `${EXECUTION_FEED_PATH}?after=${after}&limit=${FEED_PAGE_LIMIT}`;
  const result = await botControlCommand({ method: "GET", path, accept: isFeedPage, timeoutMs: 10_000 }, fetchImpl);
  if (result.outcome !== "ok") throw new ExecutionFeedError(`execution feed unavailable (${result.outcome})`);
  return result.body as unknown as FeedPage;
}

export function defaultDeps(log: NotifierDeps["log"]): NotifierDeps {
  return {
    fetchFeed: (after) => fetchFeedSigned(after),
    readStatus: () => readSignedBotStatus(),
    push: (message, to) => sendPush(message, log, to),
    now: () => new Date(),
    log,
  };
}

export type PollState = "idle_no_subscribers" | "bot_unsupported" | "bot_unreachable" | "started" | "polled";

let capabilityCache: { at: number; supported: boolean | null } = { at: 0, supported: null };
export function resetCapabilityCache(): void { capabilityCache = { at: 0, supported: null }; }

/** Whether the Bot advertises `executions.v1`; null when it could not be read. */
export async function botSupportsFeed(deps: Pick<NotifierDeps, "readStatus" | "now">): Promise<boolean | null> {
  const now = deps.now().getTime();
  if (capabilityCache.supported !== null && now - capabilityCache.at < CAPABILITY_CACHE_MS) {
    return capabilityCache.supported;
  }
  const status = await deps.readStatus();
  if (status.state !== "CONNECTED") return null;
  capabilityCache = { at: now, supported: botHasCapability(status.status, EXECUTION_FEED_CAPABILITY) };
  return capabilityCache.supported;
}

/** One poll: store whatever is new. Never throws for a Bot fault. */
export async function pollExecutionFeed(deps: NotifierDeps): Promise<{ state: PollState; stored: number }> {
  if (!(await anyAdminOptedIn())) {
    // Nobody to notify: forget the cursor, so the next opt-in starts from
    // "now" instead of announcing a backlog.
    await query("DELETE FROM bot_execution_feed WHERE id = 1");
    return { state: "idle_no_subscribers", stored: 0 };
  }
  const supported = await botSupportsFeed(deps).catch(() => null);
  if (supported === null) return { state: "bot_unreachable", stored: 0 };
  if (!supported) return { state: "bot_unsupported", stored: 0 };

  let cursor = await readCursor();
  if (cursor === null) {
    const first = await deps.fetchFeed(null);
    await writeCursor(null, first.latestSeq);
    return { state: "started", stored: 0 };
  }
  let stored = 0;
  for (let page = 0; page < FEED_MAX_PAGES_PER_TICK; page += 1) {
    const result = await deps.fetchFeed(cursor);
    if (result.latestSeq < cursor) {
      // The Bot's feed went backwards (its database was restored or reset):
      // restart from its present end rather than wait forever.
      deps.log.warn({ cursor, latestSeq: result.latestSeq }, "bot execution feed restarted; cursor reset");
      await writeCursor(null, result.latestSeq);
      break;
    }
    const events: BotExecutionEvent[] = [];
    for (const raw of result.events) {
      try { events.push(normalizeExecutionEvent(raw)); }
      catch (error) {
        // One malformed event must not stall the feed: it is skipped, loudly.
        deps.log.warn({ err: (error as Error).message }, "bot execution event rejected");
      }
    }
    if (result.nextAfter <= cursor && events.length === 0) break;
    const added = await storePage(events, Math.max(cursor, result.nextAfter), deps.now());
    if (added === null) break; // another Platform instance is polling right now
    stored += added;
    cursor = Math.max(cursor, result.nextAfter);
    if (result.events.length < FEED_PAGE_LIMIT) break;
  }
  return { state: "polled", stored };
}

// ── delivery ────────────────────────────────────────────────────────────────

const retryBackoffMs = (attempts: number): number => 30_000 * (2 ** Math.max(0, attempts - 1));

/**
 * Pushes pending events to opted-in admins. Each event is claimed with
 * SKIP LOCKED, so two Platform instances never work on the same one.
 */
export async function dispatchPendingNotifications(deps: NotifierDeps, limit = 20): Promise<number> {
  const now = deps.now();
  const client = await pool.connect();
  let claimed: Array<{ event_id: string; payload: BotExecutionEvent; notify_attempts: number }>;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ event_id: string; payload: BotExecutionEvent; notify_attempts: number;
      last_attempt_at: Date | null }>(
      `SELECT event_id, payload, notify_attempts, last_attempt_at FROM bot_execution_events
        WHERE notified_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    claimed = [];
    for (const row of rows) {
      if (row.last_attempt_at && now.getTime() - row.last_attempt_at.getTime() < retryBackoffMs(row.notify_attempts)) {
        continue;
      }
      await client.query(
        "UPDATE bot_execution_events SET notify_attempts = notify_attempts + 1, last_attempt_at = $2 WHERE event_id = $1",
        [row.event_id, now]);
      claimed.push({ event_id: row.event_id, payload: row.payload, notify_attempts: row.notify_attempts + 1 });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  let sent = 0;
  for (const row of claimed) {
    // Recipients are re-read at send time: a demoted or deleted admin, or one
    // who opted out, is not notified, and a delivered one is never re-sent.
    const { rows: recipients } = await query<{ user_id: string }>(
      `SELECT p.user_id FROM bot_execution_notification_prefs p JOIN users u ON u.id = p.user_id
        WHERE p.enabled AND u.role = 'admin'
          AND NOT EXISTS (SELECT 1 FROM bot_execution_deliveries d WHERE d.event_id = $1 AND d.user_id = p.user_id)`,
      [row.event_id]);
    const message = executionMessage(row.payload);
    let failed = 0;
    for (const recipient of recipients) {
      let result: PushResult;
      try { result = await deps.push(message, { userId: recipient.user_id }); }
      catch (error) {
        failed += 1;
        deps.log.warn({ err: (error as Error).message }, "bot execution push failed");
        continue;
      }
      if (result.failed > 0 && result.sent === 0) { failed += 1; continue; }
      await query("INSERT INTO bot_execution_deliveries (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [row.event_id, recipient.user_id]);
      if (result.sent > 0) sent += 1;
    }
    if (failed === 0) {
      await query("UPDATE bot_execution_events SET notified_at = now(), notify_outcome = $2 WHERE event_id = $1",
        [row.event_id, recipients.length === 0 ? "no_recipients" : "sent"]);
    } else if (row.notify_attempts >= MAX_NOTIFY_ATTEMPTS) {
      await query("UPDATE bot_execution_events SET notified_at = now(), notify_outcome = 'gave_up' WHERE event_id = $1",
        [row.event_id]);
    }
  }
  return sent;
}

// ── status for the opt-in card ──────────────────────────────────────────────

export interface RecentExecution {
  eventId: string;
  side: "BUY" | "SELL";
  symbol: string;
  environment: ExecutionEnvironment;
  executedBaseQty: number;
  averagePrice: number;
  source: BotExecutionEvent["source"];
  orderComplete: boolean;
  executedAt: string;
  notified: string | null;
}

export async function recentExecutions(limit = 10): Promise<RecentExecution[]> {
  const { rows } = await query<{ payload: BotExecutionEvent; notify_outcome: string | null }>(
    "SELECT payload, notify_outcome FROM bot_execution_events ORDER BY executed_at DESC, seq DESC LIMIT $1", [limit]);
  return rows.map(({ payload: p, notify_outcome }) => ({
    eventId: p.eventId, side: p.side, symbol: p.symbol, environment: p.environment,
    executedBaseQty: p.executedBaseQty, averagePrice: p.averagePrice, source: p.source,
    orderComplete: p.orderComplete, executedAt: p.executedAt, notified: notify_outcome,
  }));
}

export async function readPreference(userId: string): Promise<boolean> {
  const { rows } = await query<{ enabled: boolean }>(
    "SELECT enabled FROM bot_execution_notification_prefs WHERE user_id = $1", [userId]);
  return rows[0]?.enabled ?? false;
}

export async function writePreference(userId: string, enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO bot_execution_notification_prefs (user_id, enabled, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [userId, enabled]);
}

/** The background loop. Errors are logged and the next tick tries again. */
export function startExecutionNotifier(log: NotifierDeps["log"], intervalMs = 15_000): () => void {
  if (!isManualControlChannelConfigured()) {
    log.warn({}, "bot execution notifications idle: no Bot control channel is configured");
  }
  const deps = defaultDeps(log);
  let running = false;
  const tick = async () => {
    if (running || !isManualControlChannelConfigured()) return;
    running = true;
    try {
      await pollExecutionFeed(deps);
      await dispatchPendingNotifications(deps);
    } catch (error) {
      log.warn({ err: (error as Error).message }, "bot execution notifier tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
