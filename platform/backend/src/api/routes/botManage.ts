/**
 * Bot management from Trading Scene: bots, exchange accounts and key
 * enrollment (BOT contract v2.0, commands C10-C19; B-SLICE2 "Platform side").
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * One Platform route per Bot command, as in `botControl.ts`, and no proxy:
 * every path id is checked before it enters a signed path, and every body the
 * Bot receives is rebuilt here from validated fields. Mutations run through
 * `runCommand` (request id required and never minted, the in-flight join, the
 * replay cache, step-up, `bot.<kind>.*` audit rows, the F8 "uncertain"
 * mapping). Reads (C11, C15, C18, C19) need only the administrator's session.
 *
 * ── Who may ─────────────────────────────────────────────────────────────────
 *
 * Admin-only by the default-deny gate in `api/server.ts`: neither `/api/bot/*`
 * nor `/api/deployments/*` is in `USER_ROUTES`, so an ordinary account gets 403
 * and nobody signed in 401, whatever the spelling of the path.
 *
 * ── Step-up tiers (OD-2, B-SLICE2) ──────────────────────────────────────────
 *
 *   C10 create      fresh when the new bot can open positions (entries on),
 *                   grant when it is created with entries off;
 *   C12 edit        fresh when it WEAKENS protection compared with the bot as
 *                   C11 reads it right before (`weakensProtection`), grant
 *                   otherwise; fresh when the current bot cannot be read;
 *   C13 delete, C16 account remove, link-bot              grant;
 *   C14 rotate secret, C17 enrollment / reveal link       fresh.
 *
 * ── Secrets (X2, B-SLICE2) ──────────────────────────────────────────────────
 *
 * A create's or a rotation's live answer carries the bot's webhook secret
 * once. It is stored encrypted in `bot_webhook_secrets` BEFORE the browser is
 * answered, then removed from the browser's answer, from the replay cache and
 * from every audit row; the browser learns only `platformSecret.secretCaptured`.
 * A replayed answer (the Bot repeats only `secretIssued:true`) is said to be
 * not captured, and the operator is offered a rotation.
 *
 * An enrollment link (C17) is a five-minute bearer ticket. It is passed to the
 * browser once, with `Cache-Control: no-store`, and only when its origin is
 * exactly BOT_PUBLIC_ORIGIN; it is never written to the replay cache, the
 * database, a log or an audit row (the audit keeps the enrollment id only).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config";
import {
  classifyBotControlReply, dispatchSigned, isManualControlChannelConfigured,
} from "../../manualTrading/client";
import * as webhookSecrets from "../../repositories/botWebhookSecrets";
import * as users from "../../repositories/users";
import { appendAdminAudit } from "../../repositories/adminAudit";
import { userIdOf } from "../../security/requestUser";
import { resolveStepUp } from "../../security/stepUp";
import {
  BOT_BASE, REQUEST_ID, Refusal, botControlTimeouts, invalid, pathId, readAnswer, runCommand,
  type Answer, type CommandSpec, type ShapedResult,
} from "./botControl";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ── the Bot's rules, mirrored so a refusal happens before step-up ───────────
// (bot `services/botAdmin.ts`; the Bot stays authoritative)

export const BOT_NAME_MAX = 64;
export const PAIR_RE = /^[A-Z0-9]{2,20}(USDT|USDC)$/;
export const MAX_PAIRS = 50;
export const MAX_PCT_INVESTMENT = 100;
/** The Bot's own bound for every investment unit (`botAdmin.ts`, `.max(10000)`); final review R1. */
export const MAX_USDT_INVESTMENT = 10_000;
export const UNPROTECTED_SIZE_LIMIT_PCT = 50;
const ACCOUNT_NAME_MAX = 64;
const INVESTMENT_UNITS = ["pct_bot", "pct_trade", "usdt_bot", "usdt_trade"] as const;
type InvestmentUnit = typeof INVESTMENT_UNITS[number];
const isPctUnit = (unit: string) => unit === "pct_bot" || unit === "pct_trade";

/** The Bot's `BotConfigView` (B-SLICE2), as far as this file relies on it. */
export interface BotConfigView {
  id: string;
  pairs: string[];
  maxInvestmentPct: number;
  maxInvestmentUnit: string;
  entryEnabled: boolean;
  entryVolumePct: number;
  entryOrderType: string;
  exitEnabled: boolean;
  takeProfitPct: number | null;
  stopLossPct: number | null;
  maxEntryOrders: number | null;
  maxActiveSmartTradesEnabled: boolean;
  maxActiveSmartTrades: number | null;
  exchangeAccountId: string | null;
}

function isBotConfigView(value: unknown): value is BotConfigView {
  if (!isObject(value)) return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const nullableNum = (v: unknown) => v === null || num(v);
  return typeof value.id === "string" && Array.isArray(value.pairs) && num(value.maxInvestmentPct)
    && typeof value.maxInvestmentUnit === "string" && typeof value.entryEnabled === "boolean"
    && num(value.entryVolumePct) && typeof value.exitEnabled === "boolean"
    && nullableNum(value.takeProfitPct) && nullableNum(value.stopLossPct) && nullableNum(value.maxEntryOrders)
    && typeof value.maxActiveSmartTradesEnabled === "boolean" && nullableNum(value.maxActiveSmartTrades)
    && (value.exchangeAccountId === null || typeof value.exchangeAccountId === "string");
}

const normalizePair = (pair: string) => pair.trim().toUpperCase().replace(/\//g, "");

function finiteIn(raw: unknown, name: string, min: number, max: number, opts: { integer?: boolean; minExclusive?: boolean } = {}): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || (opts.integer && !Number.isInteger(raw))
      || (opts.minExclusive ? raw <= min : raw < min) || raw > max) {
    throw invalid(`${name} must be ${opts.integer ? "a whole number" : "a number"} ${opts.minExclusive ? "above" : "from"} ${min} ${opts.minExclusive ? "and at most" : "to"} ${max}.`);
  }
  return raw;
}

function bool(raw: unknown, name: string): boolean {
  if (typeof raw !== "boolean") throw invalid(`${name} must be true or false.`);
  return raw;
}

/**
 * The bot fields of a create (every field the Classic form has) or an edit
 * (only those present), validated and rebuilt. Unknown keys are dropped: the
 * Bot never receives anything this function did not check.
 */
export function botFields(body: Record<string, unknown>, mode: "create" | "update",
  current: BotConfigView | null = null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => body[k] !== undefined;

  if (mode === "create" || has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > BOT_NAME_MAX) throw invalid(`name must be 1 to ${BOT_NAME_MAX} characters.`);
    out.name = name;
  }
  if (has("alertType")) {
    if (body.alertType !== "custom" && body.alertType !== "tradingview") throw invalid('alertType must be "custom" or "tradingview".');
    out.alertType = body.alertType;
  }
  if (has("direction")) {
    if (body.direction !== "long") throw invalid('direction must be "long": shorts are not implemented.');
    out.direction = "long";
  }
  if (mode === "create" || has("pairs")) {
    if (!Array.isArray(body.pairs) || body.pairs.some((p) => typeof p !== "string")) throw invalid("pairs must be a list of symbols.");
    const pairs = [...new Set((body.pairs as string[]).map(normalizePair))];
    if (pairs.length < 1) throw invalid("Select at least one trading pair.");
    const kept = new Set(current?.pairs ?? []);
    if (pairs.length > Math.max(MAX_PAIRS, kept.size)) throw invalid(`At most ${MAX_PAIRS} pairs per bot.`);
    // As the Bot: a pair the bot already has is not re-judged, so a bot stays editable.
    for (const pair of pairs) {
      if (!kept.has(pair) && !PAIR_RE.test(pair)) {
        throw invalid("Each pair must be a Binance Spot symbol quoted in USDT or USDC, e.g. BTCUSDT.");
      }
    }
    out.pairs = pairs;
  }
  if (has("maxInvestmentUnit")) {
    if (!INVESTMENT_UNITS.includes(body.maxInvestmentUnit as InvestmentUnit)) {
      throw invalid(`maxInvestmentUnit must be one of ${INVESTMENT_UNITS.join(", ")}.`);
    }
    out.maxInvestmentUnit = body.maxInvestmentUnit;
  }
  if (mode === "create" || has("maxInvestmentPct")) {
    const unit = (out.maxInvestmentUnit as string | undefined) ?? current?.maxInvestmentUnit
      ?? (mode === "create" ? "pct_bot" : null);
    const max = unit === null ? MAX_USDT_INVESTMENT : isPctUnit(unit) ? MAX_PCT_INVESTMENT : MAX_USDT_INVESTMENT;
    out.maxInvestmentPct = finiteIn(body.maxInvestmentPct, "maxInvestmentPct", 0.01, max);
  } else if (has("maxInvestmentUnit") && current && current.maxInvestmentUnit !== out.maxInvestmentUnit
      && isPctUnit(out.maxInvestmentUnit as string) && current.maxInvestmentPct > MAX_PCT_INVESTMENT) {
    throw invalid(`A percentage unit allows at most ${MAX_PCT_INVESTMENT}; change the amount too.`);
  }
  if (has("exchangeAccountId")) {
    const raw = body.exchangeAccountId;
    if (raw === null || raw === "") out.exchangeAccountId = null;
    else if (typeof raw === "string" && UUID.test(raw)) out.exchangeAccountId = raw.toLowerCase();
    else throw invalid("exchangeAccountId must be an account id, or null for none.");
  }
  if (has("entryEnabled")) out.entryEnabled = bool(body.entryEnabled, "entryEnabled");
  if (has("entryVolumePct")) out.entryVolumePct = finiteIn(body.entryVolumePct, "entryVolumePct", 1, 100);
  if (has("entryOrderType")) {
    // Limit entries are stored but never executed; a bot that already has one stays editable.
    if (body.entryOrderType !== "market" && !(body.entryOrderType === "limit" && current?.entryOrderType === "limit")) {
      throw invalid('entryOrderType must be "market": limit entries are not implemented.');
    }
    out.entryOrderType = body.entryOrderType;
  }
  if (has("exitEnabled")) out.exitEnabled = bool(body.exitEnabled, "exitEnabled");
  if (has("takeProfitEnabled")) out.takeProfitEnabled = bool(body.takeProfitEnabled, "takeProfitEnabled");
  if (has("takeProfitPct")) {
    out.takeProfitPct = body.takeProfitPct === null ? null
      : finiteIn(body.takeProfitPct, "takeProfitPct", 0, 1000, { minExclusive: true });
  }
  if (has("stopLossEnabled")) out.stopLossEnabled = bool(body.stopLossEnabled, "stopLossEnabled");
  if (has("stopLossPct")) {
    out.stopLossPct = body.stopLossPct === null ? null
      : finiteIn(body.stopLossPct, "stopLossPct", 0, 100, { minExclusive: true });
  }
  if (has("maxEntryOrders")) {
    out.maxEntryOrders = body.maxEntryOrders === null ? null
      : finiteIn(body.maxEntryOrders, "maxEntryOrders", 1, 1_000_000, { integer: true });
  }
  if (has("maxActiveSmartTradesEnabled")) {
    out.maxActiveSmartTradesEnabled = bool(body.maxActiveSmartTradesEnabled, "maxActiveSmartTradesEnabled");
  }
  if (has("maxActiveSmartTrades")) {
    out.maxActiveSmartTrades = body.maxActiveSmartTrades === null ? null
      : finiteIn(body.maxActiveSmartTrades, "maxActiveSmartTrades", 1, 1_000_000, { integer: true });
  }

  const merged = mergedProtection(out, mode, current);
  if (merged) {
    const unsafe = unsafeConfigReason(merged);
    if (unsafe) throw invalid(unsafe);
  }
  return out;
}

interface Protection {
  maxInvestmentPct: number; maxInvestmentUnit: string; entryVolumePct: number;
  stopLossEnabled: boolean; stopLossPct: number | null; takeProfitEnabled: boolean; takeProfitPct: number | null;
}

/** The configuration after this change, when it can be known (always on create; on edit, with C11). */
function mergedProtection(fields: Record<string, unknown>, mode: "create" | "update",
  current: BotConfigView | null): Protection | null {
  const pick = <T>(k: string, fallback: T): T => (fields[k] !== undefined ? fields[k] as T : fallback);
  if (mode === "create") {
    return {
      maxInvestmentPct: fields.maxInvestmentPct as number,
      maxInvestmentUnit: pick("maxInvestmentUnit", "pct_bot"),
      entryVolumePct: pick("entryVolumePct", 100),
      stopLossEnabled: pick("stopLossEnabled", true),
      // As the Bot judges a create: an absent distance is no distance.
      stopLossPct: pick<number | null>("stopLossPct", null),
      takeProfitEnabled: pick("takeProfitEnabled", false),
      takeProfitPct: pick<number | null>("takeProfitPct", null),
    };
  }
  if (!current) return null;
  return {
    maxInvestmentPct: pick("maxInvestmentPct", current.maxInvestmentPct),
    maxInvestmentUnit: pick("maxInvestmentUnit", current.maxInvestmentUnit),
    entryVolumePct: pick("entryVolumePct", current.entryVolumePct),
    stopLossEnabled: pick("stopLossEnabled", current.stopLossPct !== null),
    stopLossPct: pick<number | null>("stopLossPct", current.stopLossPct),
    takeProfitEnabled: pick("takeProfitEnabled", current.takeProfitPct !== null),
    takeProfitPct: pick<number | null>("takeProfitPct", current.takeProfitPct),
  };
}

/** The Bot's `assertSafeBotConfig`, incl. the 50 % unprotected-size rule. */
export function unsafeConfigReason(b: Protection): string | null {
  if (isPctUnit(b.maxInvestmentUnit)) {
    const effective = (b.maxInvestmentPct * b.entryVolumePct) / 100;
    if (effective >= UNPROTECTED_SIZE_LIMIT_PCT && !b.stopLossEnabled) {
      return `A position of ${UNPROTECTED_SIZE_LIMIT_PCT}% of the balance or more requires a stop loss. `
        + "Enable the stop loss, or reduce the investment or the entry volume.";
    }
  }
  if (b.stopLossEnabled && (b.stopLossPct ?? 0) <= 0) return "The stop loss % must be greater than 0 when the stop loss is on.";
  if (b.takeProfitEnabled && (b.takeProfitPct ?? 0) <= 0) return "The take profit % must be greater than 0 when take profit is on.";
  return null;
}

/**
 * Whether an edit weakens the bot's protection, so it needs a fresh code
 * (B-SLICE2): the stop loss removed or moved further away (take profit is
 * irrelevant), the investment amount raised or its unit changed, the entry
 * volume raised, a concurrency cap (open trades, or entry orders per pair)
 * removed or raised, the exchange account changed, entries turned on, or
 * exits turned off. With the current bot unknown, every edit counts.
 */
export function weakensProtection(fields: Record<string, unknown>, current: BotConfigView | null): boolean {
  if (!current) return true;
  const has = (k: string) => fields[k] !== undefined;
  // Stop loss.
  const slOffNow = fields.stopLossEnabled === false || (has("stopLossPct") && fields.stopLossPct === null
    && fields.stopLossEnabled !== true);
  if (current.stopLossPct !== null) {
    if (slOffNow) return true;
    if (typeof fields.stopLossPct === "number" && fields.stopLossPct > current.stopLossPct) return true;
  }
  // Investment.
  if (has("maxInvestmentUnit") && fields.maxInvestmentUnit !== current.maxInvestmentUnit) return true;
  if (typeof fields.maxInvestmentPct === "number" && fields.maxInvestmentPct > current.maxInvestmentPct) return true;
  if (typeof fields.entryVolumePct === "number" && fields.entryVolumePct > current.entryVolumePct) return true;
  // Concurrency caps.
  if (current.maxActiveSmartTradesEnabled) {
    if (fields.maxActiveSmartTradesEnabled === false) return true;
    if (has("maxActiveSmartTrades") && fields.maxActiveSmartTrades === null && fields.maxActiveSmartTradesEnabled !== true) return true;
    if (typeof fields.maxActiveSmartTrades === "number" && current.maxActiveSmartTrades !== null
      && fields.maxActiveSmartTrades > current.maxActiveSmartTrades) return true;
  }
  if (current.maxEntryOrders !== null && has("maxEntryOrders")
    && (fields.maxEntryOrders === null || (fields.maxEntryOrders as number) > current.maxEntryOrders)) return true;
  // Account, entries, exits.
  if (has("exchangeAccountId") && fields.exchangeAccountId !== (current.exchangeAccountId?.toLowerCase() ?? null)) return true;
  if (fields.entryEnabled === true && !current.entryEnabled) return true;
  if (fields.exitEnabled === false && current.exitEnabled) return true;
  return false;
}

// ── reply shapes ────────────────────────────────────────────────────────────

const replies = {
  botWithSecret: (b: Record<string, unknown>) => isObject(b.bot) && typeof b.bot.id === "string"
    && (typeof b.webhookSecret === "string" || b.secretIssued === true),
  bot: (b: Record<string, unknown>) => isObject(b.bot) && typeof b.bot.id === "string",
  deleted: (b: Record<string, unknown>) => b.deleted === true,
  enrollment: (b: Record<string, unknown>) => typeof b.enrollmentId === "string" && typeof b.expiresAt === "string"
    && (b.enrollUrl === undefined || typeof b.enrollUrl === "string"),
  accounts: (b: Record<string, unknown>) => Array.isArray(b.accounts) && b.accounts.every((a) => isObject(a)
    && typeof a.id === "string" && typeof a.name === "string" && typeof a.testnet === "boolean"),
  enrollmentStatus: (b: Record<string, unknown>) =>
    ["issued", "opened", "completed", "expired", "failed"].includes(String(b.status)) && typeof b.purpose === "string",
  balance: (b: Record<string, unknown>) => typeof b.usdtFree === "number" && typeof b.totalUsdt === "number"
    && Array.isArray(b.breakdown),
};

// ── secrets: captured, stored, stripped ─────────────────────────────────────

/**
 * C10/C14: store the live answer's webhook secret encrypted, then answer
 * without it. `expectedBotId` (rotation) must be the bot the Bot answered for.
 */
function captureSecret(expectedBotId: string | null) {
  return async (body: Record<string, unknown>): Promise<ShapedResult> => {
    const { webhookSecret, ...rest } = body;
    const bot = isObject(body.bot) ? body.bot : {};
    const rawId = typeof bot.id === "string" ? bot.id.toLowerCase() : "";
    const botId = UUID.test(rawId) && (expectedBotId === null || rawId === expectedBotId) ? rawId : null;
    let secretCaptured = false;
    let secretStoreFailed = false;
    let linkedDeploymentsUpdated = 0;
    if (typeof webhookSecret === "string" && webhookSecret.length >= 32 && webhookSecret.length <= 512 && botId) {
      try {
        ({ linkedDeploymentsUpdated } = await webhookSecrets.storeBotWebhookSecret(botId, webhookSecret));
        secretCaptured = true;
      } catch {
        secretStoreFailed = true;
      }
    }
    const platformSecret = {
      secretCaptured, linkedDeploymentsUpdated,
      ...(secretStoreFailed ? { secretStoreFailed: true } : {}),
      // The Bot repeats a secret only in its first, live answer (X2).
      ...(typeof webhookSecret !== "string" ? { replayed: true } : {}),
    };
    return {
      body: { ...rest, secretIssued: true, platformSecret },
      audit: { botId, secretCaptured, linkedDeploymentsUpdated, ...(secretStoreFailed ? { secretStoreFailed: true } : {}) },
    };
  };
}

/** C17: pass the link once, and only on BOT_PUBLIC_ORIGIN. */
async function checkEnrollmentLink(body: Record<string, unknown>): Promise<ShapedResult> {
  const enrollmentId = typeof body.enrollmentId === "string" ? body.enrollmentId : null;
  const expiresAt = body.expiresAt;
  const base = { enrollmentId, expiresAt };
  if (typeof body.enrollUrl !== "string") {
    // A replay from the Bot's record: the link is never stored, so it cannot be shown again.
    return { body: { ...base, linkUnavailable: true }, audit: { enrollmentId } };
  }
  let ok = false;
  try {
    const url = new URL(body.enrollUrl);
    ok = config.botPublicOrigin !== "" && url.origin === config.botPublicOrigin && url.pathname === "/enroll"
      && url.search === "" && /^#t=[A-Za-z0-9_-]{20,256}$/.test(url.hash) && !url.username && !url.password;
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      body: base, audit: { enrollmentId, linkRejected: true },
      refusal: { status: 502, code: "enrollment_origin_mismatch",
        error: "The Bot answered with a link that is not on its configured public address, so it was not opened. "
          + "Check BOT_PUBLIC_ORIGIN on this Platform and PUBLIC_URL on the Bot. The link expires on its own." },
    };
  }
  return {
    body: { ...base, enrollUrl: body.enrollUrl },
    replayBody: { ...base, linkUnavailable: true },
    audit: { enrollmentId },
  };
}

// ── the command specs ───────────────────────────────────────────────────────

function createSpec(body: Record<string, unknown>): CommandSpec {
  const params = botFields(body, "create");
  return {
    kind: "bot_create", method: "POST", botPath: `${BOT_BASE}/bots`, target: "bot:new", params,
    accept: replies.botWithSecret, long: false, allowsPassword: false,
    // A new bot that can open positions widens exposure from nothing: fresh.
    tier: params.entryEnabled === false ? "grant" : "fresh",
    shapeResult: captureSecret(null),
  };
}

function updateSpec(body: Record<string, unknown>, rawId: unknown, current: BotConfigView | null): CommandSpec {
  const id = pathId(rawId, "bot");
  const botId = decodeURIComponent(id);
  const usable = current && current.id.toLowerCase() === botId ? current : null;
  const params = botFields(body, "update", usable);
  if (Object.keys(params).length === 0) throw invalid("Change at least one field.");
  return {
    kind: "bot_update", method: "PATCH", botPath: `${BOT_BASE}/bots/${id}`, target: `bot:${botId}`, params,
    accept: replies.bot, long: false, allowsPassword: false,
    tier: weakensProtection(params, usable) ? "fresh" : "grant",
  };
}

function deleteSpec(_body: Record<string, unknown>, rawId: unknown): CommandSpec {
  const id = pathId(rawId, "bot");
  const botId = decodeURIComponent(id);
  return {
    kind: "bot_delete", method: "POST", botPath: `${BOT_BASE}/bots/${id}/delete`, target: `bot:${botId}`, params: {},
    accept: replies.deleted, long: false, allowsPassword: false, tier: "grant",
    shapeResult: async (result) => {
      let secretForgotten = true;
      try { await webhookSecrets.forgetBotWebhookSecret(botId); } catch { secretForgotten = false; }
      return { body: result, audit: { secretForgotten } };
    },
  };
}

function rotateSpec(_body: Record<string, unknown>, rawId: unknown): CommandSpec {
  const id = pathId(rawId, "bot");
  const botId = decodeURIComponent(id);
  return {
    kind: "bot_rotate_secret", method: "POST", botPath: `${BOT_BASE}/bots/${id}/rotate-secret`, target: `bot:${botId}`,
    params: {}, accept: replies.botWithSecret, long: false, allowsPassword: false, tier: "fresh",
    shapeResult: captureSecret(botId),
  };
}

function accountDeleteSpec(body: Record<string, unknown>, rawId: unknown): CommandSpec {
  const id = pathId(rawId, "account");
  if (body.confirmation !== "REMOVE_ACCOUNT") throw invalid('confirmation must be "REMOVE_ACCOUNT".');
  return {
    kind: "account_delete", method: "POST", botPath: `${BOT_BASE}/exchange-accounts/${id}/delete`,
    target: `account:${decodeURIComponent(id)}`, params: { confirmation: "REMOVE_ACCOUNT" },
    accept: replies.deleted, long: false, allowsPassword: false, tier: "grant",
  };
}

function uuidParam(raw: unknown, name: string): string {
  if (typeof raw !== "string" || !UUID.test(raw)) throw invalid(`${name} must be an id.`);
  return raw.toLowerCase();
}

function enrollmentSpec(body: Record<string, unknown>): CommandSpec {
  // Before step-up: nothing could be opened, so a code must not be spent.
  if (!config.botPublicOrigin) {
    throw new Refusal(503, "enrollment_not_configured",
      "Key enrollment is not set up on this Platform (BOT_PUBLIC_ORIGIN). Nothing was sent.");
  }
  const params: Record<string, unknown> = {};
  let target: string;
  if (body.purpose === "create") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > ACCOUNT_NAME_MAX) throw invalid(`name must be 1 to ${ACCOUNT_NAME_MAX} characters.`);
    if (typeof body.testnet !== "boolean") throw invalid("testnet must be true or false.");
    if (body.testnet === false && body.mainnetConfirmation !== "MAINNET") {
      throw new Refusal(400, "mainnet_confirmation_required", 'Type MAINNET to confirm a mainnet (real money) account.');
    }
    Object.assign(params, { purpose: "create", name, testnet: body.testnet,
      ...(body.testnet === false ? { mainnetConfirmation: "MAINNET" } : {}) });
    target = "account:new";
  } else if (body.purpose === "replace") {
    const accountId = uuidParam(body.accountId, "accountId");
    if (body.mainnetConfirmation !== undefined && body.mainnetConfirmation !== "MAINNET") {
      throw invalid('mainnetConfirmation must be "MAINNET".');
    }
    Object.assign(params, { purpose: "replace", accountId,
      ...(body.mainnetConfirmation === "MAINNET" ? { mainnetConfirmation: "MAINNET" } : {}) });
    target = `account:${accountId}`;
  } else if (body.purpose === "reveal_webhook") {
    const botId = uuidParam(body.botId, "botId");
    Object.assign(params, { purpose: "reveal_webhook", botId });
    target = `bot:${botId}`;
  } else {
    throw invalid('purpose must be "create", "replace" or "reveal_webhook".');
  }
  return {
    kind: "enrollment_create", method: "POST", botPath: `${BOT_BASE}/exchange-enrollments`, target, params,
    accept: replies.enrollment, long: false, allowsPassword: false, tier: "fresh",
    shapeResult: checkEnrollmentLink,
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * A signed GET. Like `readAnswer(botControlCommand(...))`, except that a 5xx
 * carrying one of `passCodes` (C19's `exchange_unavailable`) is the Bot's own
 * answer and is passed on as itself.
 */
async function botRead(path: string, accept: (b: Record<string, unknown>) => boolean,
  passCodes: readonly string[] = []): Promise<Answer> {
  if (!isManualControlChannelConfigured()) {
    return { status: 503, payload: { code: "bot_channel_not_configured", error: "Bot control channel not configured." } };
  }
  let response: Response;
  try {
    response = await dispatchSigned({ method: "GET", path, timeoutMs: botControlTimeouts().defaultMs }, fetch);
  } catch {
    return readAnswer({ outcome: "uncertain", reason: "transport" });
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (response.status >= 500 && isObject(body) && typeof body.code === "string" && passCodes.includes(body.code)) {
    const error = typeof body.error === "string" ? body.error.slice(0, 300) : body.code;
    return { status: response.status, payload: { code: body.code, error } };
  }
  return readAnswer(classifyBotControlReply(response.status, body, accept));
}

/** The bot as C11 reads it, for an edit's tier; null when it cannot be read. */
async function readCurrentBot(id: string): Promise<BotConfigView | null> {
  try {
    const answer = await botRead(`${BOT_BASE}/bots/${encodeURIComponent(id)}`, replies.bot);
    return answer.status === 200 && isBotConfigView(answer.payload.bot) ? answer.payload.bot : null;
  } catch {
    return null;
  }
}

function send(reply: FastifyReply, answer: Answer): FastifyReply {
  return reply.code(answer.status).send(answer.payload);
}

function refusalReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof Refusal) return reply.code(error.status).send({ code: error.code, error: error.message, ...error.extra });
  throw error;
}

// ── link a deployment to a bot (server-side secret copy) ────────────────────

async function linkBot(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  try {
    if (!config.authEnabled) {
      throw new Refusal(403, "auth_disabled", "Linking needs sign-in to be on (AUTH_ENABLED).");
    }
    const body = isObject(req.body) ? req.body : {};
    const deploymentId = uuidParam((req.params as { id?: unknown }).id, "deployment id");
    const botId = uuidParam(body.botId, "botId");
    if (body.requestId !== undefined && (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId))) {
      throw new Refusal(400, "invalid_request_id", "A request id of 16 to 128 letters, digits, - or _ is required.");
    }
    const requestId = typeof body.requestId === "string" ? body.requestId : null;
    // Before step-up, so a code is not spent on a link that cannot be made.
    const status = await webhookSecrets.botWebhookSecretStatus(botId);
    if (!status.stored) {
      throw new Refusal(409, "bot_secret_unknown",
        "This Platform does not hold that bot's webhook secret. Rotate the secret from the bot's page; the new one is stored here.");
    }
    const actor = userIdOf(req);
    const account = await users.getUser(actor);
    if (!account) throw new Refusal(401, "not_authenticated", "not authenticated");
    const proof = await resolveStepUp(req, reply, account, { tier: "grant", allowsPassword: false });
    const outcome = await webhookSecrets.linkDeploymentToBot(deploymentId, botId);
    const audit = { deploymentId, botId, requestId, stepUpMethod: proof.method,
      ...(proof.grantId ? { grantId: proof.grantId } : {}) };
    const record = (verdict: "succeeded" | "refused", extra: Record<string, unknown> = {}) =>
      appendAdminAudit(actor, `platform.deployment_link_bot.${verdict}`, `deployment:${deploymentId}`, { ...audit, ...extra })
        .catch(() => req.log.error({ requestId }, "could not record a deployment link"));
    switch (outcome.outcome) {
      case "linked":
        await record("succeeded", { replaced: outcome.replaced });
        return reply.code(200).send({ linked: true, deploymentId, botId, replacedSecret: outcome.replaced });
      case "deployment_not_found":
        await record("refused", { code: "deployment_not_found" });
        throw new Refusal(404, "deployment_not_found", "That deployment no longer exists.");
      case "delivery_not_custom":
        await record("refused", { code: "delivery_not_custom" });
        throw new Refusal(409, "delivery_not_custom",
          `Only a custom-webhook deployment sends to the Bot; this one delivers by ${outcome.delivery}.`);
      default:
        await record("refused", { code: "bot_secret_unknown" });
        throw new Refusal(409, "bot_secret_unknown", "This Platform does not hold that bot's webhook secret.");
    }
  } catch (error) {
    return refusalReply(reply, error);
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

export const BOT_MANAGE_BASE = "/api/bot/manage";

export async function botManageRoutes(app: FastifyInstance): Promise<void> {
  const B = BOT_MANAGE_BASE;
  const idOf = (req: FastifyRequest) => (req.params as { id?: string }).id;

  // ── C10-C14 bots ──────────────────────────────────────────────────────────
  app.post(`${B}/bots`, async (req, reply) => runCommand(req, reply, createSpec));

  /** C11, plus what only this Platform knows: is the secret held here, which deployments are linked. */
  app.get(`${B}/bots/:id`, async (req, reply) => {
    try {
      const id = decodeURIComponent(pathId(idOf(req), "bot"));
      const answer = await botRead(`${BOT_BASE}/bots/${encodeURIComponent(id)}`, replies.bot);
      if (answer.status !== 200) return send(reply, answer);
      const [secret, linkedDeployments] = await Promise.all([
        webhookSecrets.botWebhookSecretStatus(id), webhookSecrets.deploymentsLinkedTo(id)]);
      return reply.send({ bot: answer.payload.bot, platform: { secret, linkedDeployments } });
    } catch (error) {
      return refusalReply(reply, error);
    }
  });

  app.patch(`${B}/bots/:id`, async (req, reply) => {
    const raw = idOf(req);
    // The edit's tier is decided against the bot as it is now (C11), read first.
    const current = config.authEnabled && isManualControlChannelConfigured() && typeof raw === "string" && UUID.test(raw)
      ? await readCurrentBot(raw.toLowerCase()) : null;
    return runCommand(req, reply, (body) => updateSpec(body, raw, current));
  });
  app.post(`${B}/bots/:id/delete`, async (req, reply) =>
    runCommand(req, reply, (body) => deleteSpec(body, idOf(req))));
  app.post(`${B}/bots/:id/rotate-secret`, async (req, reply) =>
    runCommand(req, reply, (body) => rotateSpec(body, idOf(req))));

  // ── C15, C16, C19 accounts ────────────────────────────────────────────────
  app.get(`${B}/accounts`, async (_req, reply) =>
    send(reply, await botRead(`${BOT_BASE}/exchange-accounts`, replies.accounts)));
  app.post(`${B}/accounts/:id/delete`, async (req, reply) =>
    runCommand(req, reply, (body) => accountDeleteSpec(body, idOf(req))));
  app.get(`${B}/accounts/:id/balance`, async (req, reply) => {
    try {
      const id = pathId(idOf(req), "account");
      return send(reply, await botRead(`${BOT_BASE}/exchange-accounts/${id}/balance`, replies.balance,
        ["exchange_unavailable"]));
    } catch (error) {
      return refusalReply(reply, error);
    }
  });

  // ── C17, C18 enrollment ───────────────────────────────────────────────────
  app.post(`${B}/enrollments`, async (req, reply) => {
    // The live answer can carry a bearer link: never cached by anything in between.
    reply.header("cache-control", "no-store");
    return runCommand(req, reply, enrollmentSpec);
  });
  app.get(`${B}/enrollments/:id`, async (req, reply) => {
    try {
      const id = pathId(idOf(req), "enrollment");
      return send(reply, await botRead(`${BOT_BASE}/exchange-enrollments/${id}`, replies.enrollmentStatus));
    } catch (error) {
      return refusalReply(reply, error);
    }
  });

  // ── link a deployment to a bot ────────────────────────────────────────────
  app.post("/api/deployments/:id/link-bot", linkBot);
}
