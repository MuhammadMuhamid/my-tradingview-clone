import type { DeploymentRow } from "../types/deployments";
import { validateWebhookUrl } from "../alerts/dispatcher";
import { botControlCommand, isManualControlChannelConfigured } from "../manualTrading/client";

export interface BotOperationalStatus {
  service: { reachable: true; name: string; version: string | null };
  execution: {
    mode: "DRY_RUN" | "HALTED" | "LIVE";
    dryRun: boolean;
    halted: boolean;
    haltedBy: string | null;
    haltedReason: string | null;
  };
  exchange: {
    mode: "TESTNET" | "MAINNET" | "MIXED";
    processDefault: "TESTNET" | "MAINNET";
    configuredAccounts: { total: number; testnet: number; mainnet: number };
  };
  realisedPnl: {
    currency: "USDT";
    today: number;
    dayStart: string;
    timezone: "UTC";
    rollingWindowHours: number;
    rolling: number;
  };
  openTrades: { count: number; exposureQuote: number; currency: "USDT" };
  dailyLossProtection: {
    authority: "BOT";
    limitQuote: number | null;
    windowHours: number;
    realisedPnlInWindow: number;
    enabled: boolean;
  };
  time: string;
}

export type BotStatusConnection =
  | { state: "CONNECTED"; configuredEndpoints: number; status: BotOperationalStatus }
  | { state: "NOT_CONFIGURED"; configuredEndpoints: 0; reason: "no_custom_bot_deployment" }
  | {
      state: "UNAVAILABLE";
      configuredEndpoints: number;
      reason: "authentication_rejected" | "request_failed" | "invalid_response";
    };

interface Candidate { url: string; secret: string }

export function botStatusCandidates(
  deployments: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">[]
): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const deployment of deployments) {
    if (deployment.delivery !== "custom" || !deployment.webhookUrl || !deployment.secret) continue;
    try {
      const url = new URL(deployment.webhookUrl);
      if (!/\/signal_bots\/?$/.test(url.pathname)) continue;
      url.pathname = url.pathname.replace(/\/signal_bots\/?$/, "/signal_bots/operations");
      const validated = validateWebhookUrl(url.toString());
      const key = `${validated}\u0000${deployment.secret}`;
      candidates.set(key, { url: validated, secret: deployment.secret });
    } catch {
      // Invalid/unsafe endpoints are not contacted and credentials are not sent.
    }
  }
  return [...candidates.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime guard for the cross-repository response. Reject guesses and drift. */
export function isBotOperationalStatus(value: unknown): value is BotOperationalStatus {
  if (!isRecord(value)) return false;
  const service = value.service;
  const execution = value.execution;
  const exchange = value.exchange;
  const pnl = value.realisedPnl;
  const open = value.openTrades;
  const protection = value.dailyLossProtection;
  return isRecord(service) && service.reachable === true && typeof service.name === "string"
    && (service.version === null || typeof service.version === "string")
    && isRecord(execution) && ["DRY_RUN", "HALTED", "LIVE"].includes(String(execution.mode))
    && typeof execution.dryRun === "boolean" && typeof execution.halted === "boolean"
    && isRecord(exchange) && ["TESTNET", "MAINNET", "MIXED"].includes(String(exchange.mode))
    && isRecord(pnl) && typeof pnl.today === "number" && Number.isFinite(pnl.today)
    && typeof pnl.rolling === "number" && Number.isFinite(pnl.rolling)
    && typeof pnl.dayStart === "string" && pnl.timezone === "UTC"
    && isRecord(open) && typeof open.count === "number" && typeof open.exposureQuote === "number"
    && isRecord(protection) && protection.authority === "BOT"
    && typeof protection.enabled === "boolean" && typeof value.time === "string";
}

/**
 * The webhook-credential path: an unsigned POST of a deployment's webhook
 * secret to the first custom deployment's `/signal_bots/operations`. A
 * different trust path from the signed control channel, and reported as such.
 */
export async function readWebhookBotStatus(
  deployments: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">[],
  fetchImpl: typeof fetch = fetch
): Promise<BotStatusConnection> {
  const candidates = botStatusCandidates(deployments);
  if (candidates.length === 0) {
    return { state: "NOT_CONFIGURED", configuredEndpoints: 0, reason: "no_custom_bot_deployment" };
  }

  const candidate = candidates[0]!;
  try {
    const response = await fetchImpl(candidate.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: candidate.secret }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        state: "UNAVAILABLE",
        configuredEndpoints: candidates.length,
        reason: response.status === 401 ? "authentication_rejected" : "request_failed",
      };
    }
    const body: unknown = await response.json();
    if (!isBotOperationalStatus(body)) {
      return { state: "UNAVAILABLE", configuredEndpoints: candidates.length, reason: "invalid_response" };
    }
    return { state: "CONNECTED", configuredEndpoints: candidates.length, status: body };
  } catch {
    return { state: "UNAVAILABLE", configuredEndpoints: candidates.length, reason: "request_failed" };
  }
}

// ── U1: the signed control channel first (contract §7) ─────────────────────

/**
 * C0, `GET /api/manual-trading/control/status`, as the Bot sends it.
 *
 * `dryRun` and `halt` are independent: a dry-run Bot can be halted, and the
 * old single `mode` word hid exactly that (scout-4 finding 0.4).
 */
export interface BotControlStatus {
  operational: BotOperationalStatus;
  dryRun: boolean;
  halt: { halted: boolean; haltedBy: string | null; haltedReason: string | null; haltedAt: string | null };
  exchange: {
    defaultTestnet: boolean;
    accounts: { testnet: number; mainnet: number };
    routing: "TESTNET" | "MAINNET" | "MIXED" | "NONE";
  };
  risk: {
    limits: {
      maxTotalExposureQuote: number | null; maxConcurrentTrades: number | null;
      maxDailyLossQuote: number | null; dailyLossWindowHours: number;
    };
    snapshot: { openExposureQuote: number; openTrades: number; realisedPnlInWindow: number };
    summary: string;
    latched: boolean;
  };
  bots: { active: number; paused: number };
  protection: { mode: string; intervalSec: number; exchangeResting: boolean; note: string };
  shariahFloor: { mode: string; policyVersion: string | null };
  manual: { enabled: boolean; mainnetEnabled: boolean };
  version: string | null;
  time: string;
}

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const nullableFinite = (value: unknown): boolean =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const finiteNumber = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

/** Runtime guard for C0. Everything the Platform displays is checked. */
export function isBotControlStatus(value: unknown): value is BotControlStatus {
  if (!isRecord(value)) return false;
  const { halt, exchange, risk, bots, protection, shariahFloor, manual } = value;
  if (!isBotOperationalStatus(value.operational) || typeof value.dryRun !== "boolean") return false;
  if (!isRecord(halt) || typeof halt.halted !== "boolean" || !nullableString(halt.haltedBy)
    || !nullableString(halt.haltedReason) || !nullableString(halt.haltedAt)) return false;
  if (!isRecord(exchange) || typeof exchange.defaultTestnet !== "boolean" || !isRecord(exchange.accounts)
    || !finiteNumber(exchange.accounts.testnet) || !finiteNumber(exchange.accounts.mainnet)
    || !["TESTNET", "MAINNET", "MIXED", "NONE"].includes(String(exchange.routing))) return false;
  if (!isRecord(risk) || !isRecord(risk.limits) || !isRecord(risk.snapshot)
    || !nullableFinite(risk.limits.maxTotalExposureQuote) || !nullableFinite(risk.limits.maxConcurrentTrades)
    || !nullableFinite(risk.limits.maxDailyLossQuote) || !finiteNumber(risk.limits.dailyLossWindowHours)
    || !finiteNumber(risk.snapshot.openExposureQuote) || !finiteNumber(risk.snapshot.openTrades)
    || !finiteNumber(risk.snapshot.realisedPnlInWindow)
    || typeof risk.summary !== "string" || typeof risk.latched !== "boolean") return false;
  if (!isRecord(bots) || !finiteNumber(bots.active) || !finiteNumber(bots.paused)) return false;
  if (!isRecord(protection) || typeof protection.mode !== "string" || !finiteNumber(protection.intervalSec)
    || typeof protection.exchangeResting !== "boolean" || typeof protection.note !== "string") return false;
  if (!isRecord(shariahFloor) || typeof shariahFloor.mode !== "string"
    || !nullableString(shariahFloor.policyVersion)) return false;
  if (!isRecord(manual) || typeof manual.enabled !== "boolean" || typeof manual.mainnetEnabled !== "boolean") return false;
  return nullableString(value.version) && typeof value.time === "string";
}

/**
 * Signed reachability, one word per distinct fact.
 *
 * - `NOT_CONFIGURED`: THIS Platform has no usable control key or URL. Nothing
 *   was sent; it is a setting, not an outage.
 * - `REJECTED`: the request reached something that refused the channel —
 *   the Bot's signature check (`auth`), the proxy's Platform-IP rule
 *   (`proxy`), a nonce replay (`replay`), or a Bot whose own control secret
 *   is unset (`bot_unconfigured`).
 * - `RATE_LIMITED`: the Bot's control limiter answered.
 * - `UNREACHABLE`: no answer, a timeout, or a server error.
 * - `INVALID`: an answer that is not the status contract.
 * - `CONNECTED`: a signed C0 that passed the guard.
 */
export type BotSignedState = "CONNECTED" | "REJECTED" | "UNREACHABLE" | "INVALID" | "RATE_LIMITED" | "NOT_CONFIGURED";
export type BotSignedCause = "auth" | "proxy" | "replay" | "bot_unconfigured" | null;

export interface SignedBotStatus {
  state: BotSignedState;
  cause: BotSignedCause;
  status: BotControlStatus | null;
}

export const BOT_CONTROL_STATUS_PATH = "/api/manual-trading/control/status";

export async function readSignedBotStatus(fetchImpl: typeof fetch = fetch): Promise<SignedBotStatus> {
  if (!isManualControlChannelConfigured()) return { state: "NOT_CONFIGURED", cause: null, status: null };
  const result = await botControlCommand(
    { method: "GET", path: BOT_CONTROL_STATUS_PATH, accept: isBotControlStatus, timeoutMs: 10_000 }, fetchImpl);
  if (result.outcome === "ok") {
    return { state: "CONNECTED", cause: null, status: result.body as unknown as BotControlStatus };
  }
  if (result.outcome === "refused") {
    switch (result.fault) {
      case "channel_auth": return { state: "REJECTED", cause: "auth", status: null };
      case "channel_proxy": return { state: "REJECTED", cause: "proxy", status: null };
      case "channel_replay": return { state: "REJECTED", cause: "replay", status: null };
      case "not_configured": return { state: "REJECTED", cause: "bot_unconfigured", status: null };
      case "rate_limited": return { state: "RATE_LIMITED", cause: null, status: null };
      // A typed refusal of a status READ is not the status contract.
      default: return { state: "INVALID", cause: null, status: null };
    }
  }
  return result.reason === "invalid_reply" || result.reason === "no_code"
    ? { state: "INVALID", cause: null, status: null }
    : { state: "UNREACHABLE", cause: null, status: null };
}

/** The signed reading, in the older single-connection shape `bot` still carries. */
function connectionFromSigned(signed: SignedBotStatus): BotStatusConnection {
  if (signed.state === "CONNECTED" && signed.status) {
    return { state: "CONNECTED", configuredEndpoints: 1, status: signed.status.operational };
  }
  const reason = signed.state === "REJECTED" ? "authentication_rejected"
    : signed.state === "INVALID" ? "invalid_response" : "request_failed";
  return { state: "UNAVAILABLE", configuredEndpoints: 1, reason };
}

/**
 * Bot status in the single-connection shape (`/api/ops/status` `bot`, the
 * chart overlays' exchange mode).
 *
 * U1: the signed control channel is preferred whenever it is configured, and
 * the webhook candidates are only the fallback. Before this, a Platform with a
 * working signed channel and no custom webhook deployment reported the Bot as
 * NOT CONFIGURED. A configured channel that cannot reach the Bot is UNAVAILABLE,
 * never NOT_CONFIGURED: that word is about this Platform's settings.
 */
export async function readBotStatus(
  deployments: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">[],
  fetchImpl: typeof fetch = fetch
): Promise<BotStatusConnection> {
  if (isManualControlChannelConfigured()) return connectionFromSigned(await readSignedBotStatus(fetchImpl));
  return readWebhookBotStatus(deployments, fetchImpl);
}

/**
 * Every Bot fact the operator surfaces show, as SEPARATE named statuses
 * (contract §7). There is deliberately no overall "ready" word: a Bot can be
 * connected and halted, connected and dry-run, connected with the daily-loss
 * latch set, or reachable on one path and refused on the other.
 *
 * `facts` is C0 when the signed read succeeded and null otherwise — null means
 * "could not read", never "none" or "off".
 */
export interface BotControlPanel {
  channel: { configured: boolean };
  signed: { state: BotSignedState; cause: BotSignedCause };
  webhook: BotStatusConnection;
  /** Which path fed the single-connection `bot` field beside this panel. */
  preferred: "signed" | "webhook";
  facts: BotControlStatus | null;
  readAt: string;
}

export async function readBotOperations(
  deployments: Pick<DeploymentRow, "delivery" | "webhookUrl" | "secret">[],
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<{ connection: BotStatusConnection; panel: BotControlPanel }> {
  const configured = isManualControlChannelConfigured();
  const [signed, webhook] = await Promise.all([
    readSignedBotStatus(fetchImpl),
    readWebhookBotStatus(deployments, fetchImpl),
  ]);
  return {
    connection: configured ? connectionFromSigned(signed) : webhook,
    panel: {
      channel: { configured },
      signed: { state: signed.state, cause: signed.cause },
      webhook,
      preferred: configured ? "signed" : "webhook",
      facts: signed.status,
      readAt: now().toISOString(),
    },
  };
}
