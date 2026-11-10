/**
 * Bot controls: the administrator operating the separately deployed execution
 * Bot from Trading Scene (BOT_CONTROL_CONTRACT v1.2).
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * One Platform route per Bot command, C0-C8, and nothing else. There is no
 * proxy: the browser never names a Bot path, every path id is checked and
 * encoded before it enters the signed path, and every body the Bot receives is
 * rebuilt here from validated fields (contract §0.2, F5, F10).
 *
 * ── Who may ─────────────────────────────────────────────────────────────────
 *
 * - Admin-only by the default-deny gate in `api/server.ts`: `/api/bot/*` is not
 *   in `USER_ROUTES`, so an ordinary account gets 403 and nobody signed in 401.
 * - A mutating command is refused outright while `AUTH_ENABLED` is false. The
 *   gate then treats every request as the administrator and `passPassword`
 *   says "ok" when there is no hash, so step-up would fail open. Reads stay
 *   available for local development (F18).
 * - Every mutating command is confirmed by `resolveStepUp` (`security/stepUp.ts`,
 *   contract §3, OD-2) at the tier its `CommandSpec` declares: `grant` (a valid
 *   step-up grant from a recent authenticator code suffices) or `fresh` (a new
 *   credential every time; the default when a spec says nothing).
 *     two-factor on                       -> the authenticator code, only;
 *     two-factor off, a password exists   -> the password, for C1 halt only;
 *                                            anything else: two_factor_required;
 *     two-factor off, no password         -> step_up_unavailable.
 *   How the session was created (password, Google, GitHub) plays no part.
 *   The credential is never forwarded, stored or logged; the Bot receives
 *   `actor: { platformUserId, stepUp: { method, at } }`. A grant is sent as
 *   `method: "totp"` with `at` = when the code that minted it was entered.
 *
 * ── Adding a command (for the next engineer) ────────────────────────────────
 *
 * Write a `(body) => CommandSpec` builder in a NEW file, validate every field
 * with `invalid`, `pathId` and `limitValue`, set `tier` deliberately, and
 * register it with `app.post(url, (req, reply) => runCommand(req, reply, build))`.
 * `runCommand` owns the request id, the auth/channel checks, step-up, the
 * in-flight join, the audit rows and the F8 mapping.
 *
 * ── What an answer means (F8, F11) ──────────────────────────────────────────
 *
 * Definitive: a Bot-authored JSON 2xx of the expected shape, or a JSON 4xx
 * carrying `code`. Everything else on a mutating command is UNCERTAIN, and the
 * browser is told 202 `{status:"uncertain", requestId}` and asks C8 with the
 * same id. "Nothing was changed" is only ever C8's 404.
 *
 * ── Audit (contract §5) ─────────────────────────────────────────────────────
 *
 * `bot.<kind>.requested` is appended before anything is sent, and the command
 * is not sent if that row cannot be written. `.succeeded`, `.refused` or
 * `.uncertain` follows with the outcome. No row carries the credential.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config";
import {
  botControlCommand, botControlReplies, canonicalJson, isManualControlChannelConfigured,
  type BotControlOutcome,
} from "../../manualTrading/client";
import { readBotOperations } from "../../operations/botStatus";
import * as deploymentRepo from "../../repositories/deployments";
import * as liveSafety from "../../repositories/liveSafety";
import * as users from "../../repositories/users";
import { appendAdminAudit } from "../../repositories/adminAudit";
import { userIdOf } from "../../security/requestUser";
import {
  Refusal, actorStepUpMethod, resolveStepUp, type StepUpProof, type StepUpTier,
} from "../../security/stepUp";

export { Refusal };
export type { StepUpProof, StepUpTier };

export const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
/** SignalBot and SmartTrade ids are Prisma `uuid()` (bot `schema.prisma`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BOT_BASE = "/api/manual-trading/control";

/**
 * The commands this file defines. A spec built elsewhere may use any other
 * lower_snake kind; it names the audit rows `bot.<kind>.*`.
 */
export type BotCommandKind = "halt" | "resume" | "risk_limits" | "bot_status" | "trade_close" | "trade_partial_close"
  | "entries" | "trade_archive";

// ── timeouts (contract §1, F8) ──────────────────────────────────────────────

const DEFAULT_TIMEOUTS = { defaultMs: 10_000, longMs: 30_000 };
let timeouts = { ...DEFAULT_TIMEOUTS };

/** The current waits, for command files that issue their own reads. */
export const botControlTimeouts = (): { defaultMs: number; longMs: number } => ({ ...timeouts });

/** Tests only: shorten the wait so a timeout can be exercised without sleeping 10 s. */
export function setBotControlTimeoutsForTests(next: { defaultMs: number; longMs: number } | null): void {
  timeouts = next ? { ...next } : { ...DEFAULT_TIMEOUTS };
}

// ── input ───────────────────────────────────────────────────────────────────

const bodyOf = (req: FastifyRequest): Record<string, unknown> =>
  typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};

/**
 * The browser's id for this intent. Never minted here (F7): an id this
 * service invented would make a retry a new command, exactly when retrying
 * safely matters.
 */
export function requestIdOf(req: FastifyRequest, body: Record<string, unknown>): string {
  const header = req.headers["x-manual-request-id"];
  const fromHeader = typeof header === "string" ? header : undefined;
  const fromBody = body.requestId;
  if (fromHeader !== undefined && fromBody !== undefined && fromHeader !== fromBody) {
    throw new Refusal(400, "invalid_request_id", "The request id in the header and the body differ.");
  }
  const id = fromHeader ?? fromBody;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) {
    throw new Refusal(400, "invalid_request_id",
      "A request id of 16 to 128 letters, digits, - or _ is required.");
  }
  return id;
}

export function pathId(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !UUID.test(raw)) {
    throw new Refusal(400, "invalid_target_id", `That ${what} id is not valid.`);
  }
  return encodeURIComponent(raw.toLowerCase());
}

export const invalid = (message: string) => new Refusal(400, "invalid_request", message);

/** A quote amount or count the Bot accepts: null (no limit) or a finite number ≥ 0. */
export function limitValue(raw: unknown, name: string, integer: boolean): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || (integer && !Number.isInteger(raw))) {
    throw invalid(`${name} must be ${integer ? "a whole number" : "a number"} of 0 or more, or null for no limit.`);
  }
  return raw;
}

// ── the commands ────────────────────────────────────────────────────────────

export interface CommandSpec {
  /** `BotCommandKind`, or another lower_snake name for a command defined elsewhere. */
  kind: BotCommandKind | (string & {});
  method: "POST" | "PATCH" | "PUT";
  /** Already validated and encoded. */
  botPath: string;
  target: string;
  /** JSON-stable values only (F10): no undefined, Date, NaN. */
  params: Record<string, unknown>;
  accept: (body: Record<string, unknown>) => boolean;
  long: boolean;
  /** Risk-reducing commands only (C1 halt, pausing entries) may be confirmed with the password when two-factor is off (OD-2). */
  allowsPassword: boolean;
  /** OD-2 tier. Absent means `fresh`: a new credential every time. */
  tier?: StepUpTier;
  /**
   * A Platform-side change made after step-up and before the Bot is contacted
   * (pausing entries sets the Platform's own flag first). Its result is
   * answered beside the Bot's as `{ platform, bot }`. With this set, an
   * unconfigured Bot channel does not refuse the request: the Platform half
   * still applies and the Bot half says why it was not sent.
   */
  platformHalf?: (context: { actor: string; requestId: string; proof: StepUpProof }) => Promise<Record<string, unknown>>;
  /**
   * Runs on the Bot's definitive 2xx body BEFORE it is answered, remembered
   * or audited (a create's webhook secret is stored and stripped here, an
   * enrollment link's origin checked). It returns the body the browser sees;
   * optionally a different `replayBody` for the in-memory replay cache (a
   * link that may be shown once), extra NON-secret `audit` fields, or a
   * `refusal` that replaces the answer (never remembered: the Bot did run it).
   * It must not throw; if it does, the body is withheld entirely.
   */
  shapeResult?: (body: Record<string, unknown>, context: { actor: string; requestId: string })
    => Promise<ShapedResult>;
}

export interface ShapedResult {
  body: Record<string, unknown>;
  replayBody?: Record<string, unknown>;
  audit?: Record<string, unknown>;
  refusal?: { status: number; code: string; error: string };
}

function haltSpec(body: Record<string, unknown>): CommandSpec {
  if (body.confirmation !== "HALT_TRADING") throw invalid('confirmation must be "HALT_TRADING".');
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 200) throw invalid("A reason of 3 to 200 characters is required.");
  return { kind: "halt", method: "POST", botPath: `${BOT_BASE}/halt`, target: "bot",
    params: { confirmation: "HALT_TRADING", reason }, accept: botControlReplies.halt, long: false,
    allowsPassword: true, tier: "grant" };
}

function resumeSpec(body: Record<string, unknown>): CommandSpec {
  if (body.confirmation !== "RESUME_TRADING") throw invalid('confirmation must be "RESUME_TRADING".');
  return { kind: "resume", method: "POST", botPath: `${BOT_BASE}/resume`, target: "bot",
    params: { confirmation: "RESUME_TRADING" }, accept: botControlReplies.resume, long: false,
    allowsPassword: false, tier: "grant" };
}

function riskLimitsSpec(body: Record<string, unknown>): CommandSpec {
  const params: Record<string, unknown> = {};
  if (body.maxTotalExposureQuote !== undefined) {
    params.maxTotalExposureQuote = limitValue(body.maxTotalExposureQuote, "maxTotalExposureQuote", false);
  }
  if (body.maxConcurrentTrades !== undefined) {
    params.maxConcurrentTrades = limitValue(body.maxConcurrentTrades, "maxConcurrentTrades", true);
  }
  if (body.maxDailyLossQuote !== undefined) {
    params.maxDailyLossQuote = limitValue(body.maxDailyLossQuote, "maxDailyLossQuote", false);
  }
  if (body.dailyLossWindowHours !== undefined) {
    const hours = body.dailyLossWindowHours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 720) {
      throw invalid("dailyLossWindowHours must be a whole number of hours from 1 to 720.");
    }
    params.dailyLossWindowHours = hours;
  }
  if (Object.keys(params).length === 0) throw invalid("Change at least one limit.");
  return { kind: "risk_limits", method: "PATCH", botPath: `${BOT_BASE}/risk-limits`, target: "bot",
    params, accept: botControlReplies.riskLimits, long: false, allowsPassword: false, tier: "fresh" };
}

function botStatusSpec(body: Record<string, unknown>, rawId: unknown): CommandSpec {
  const id = pathId(rawId, "bot");
  if (body.status !== "active" && body.status !== "paused") throw invalid('status must be "active" or "paused".');
  return { kind: "bot_status", method: "POST", botPath: `${BOT_BASE}/bots/${id}/status`,
    target: `bot:${decodeURIComponent(id)}`, params: { status: body.status },
    accept: botControlReplies.botStatus, long: false, allowsPassword: false, tier: "grant" };
}

function closeSpec(_body: Record<string, unknown>, rawId: unknown): CommandSpec {
  const id = pathId(rawId, "trade");
  return { kind: "trade_close", method: "POST", botPath: `${BOT_BASE}/trades/${id}/close`,
    target: `trade:${decodeURIComponent(id)}`, params: {}, accept: botControlReplies.close, long: true,
    allowsPassword: false, tier: "grant" };
}

/**
 * C9, pause or resume new entries (OD-3), with the Platform's own switch as
 * its first half. Pausing is risk-reducing, so like a halt it accepts the
 * password when two-factor is off; resuming needs two-factor.
 *   pause  {paused:true, reason:3..200, cancelWorkingEntries?:boolean}
 *   resume {paused:false}
 * The body the Bot receives is rebuilt from these validated fields only.
 */
function entriesSpec(body: Record<string, unknown>): CommandSpec {
  if (typeof body.paused !== "boolean") throw invalid("paused must be true or false.");
  const paused = body.paused;
  const params: Record<string, unknown> = { paused };
  if (paused) {
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 200) throw invalid("A reason of 3 to 200 characters is required.");
    params.reason = reason;
    if (body.cancelWorkingEntries !== undefined) {
      if (typeof body.cancelWorkingEntries !== "boolean") throw invalid("cancelWorkingEntries must be true or false.");
      if (body.cancelWorkingEntries) params.cancelWorkingEntries = true;
    }
  } else if (body.cancelWorkingEntries !== undefined && body.cancelWorkingEntries !== false) {
    throw invalid("cancelWorkingEntries applies only to pausing.");
  }
  return {
    kind: "entries", method: "POST", botPath: `${BOT_BASE}/entries`, target: "bot", params,
    accept: botControlReplies.entries, long: true, allowsPassword: paused, tier: "grant",
    platformHalf: async ({ actor, requestId, proof }) => {
      if (!paused) {
        // Resuming increases exposure: like every other risk-increasing command, it is
        // recorded before it takes effect, and refused when it cannot be recorded
        // (Fable review R1). Pausing stays set-first: it reduces risk.
        try {
          await appendAdminAudit(actor, "platform.entries_resume.requested", "platform", {
            requestId, stepUpMethod: proof.method, ...(proof.grantId ? { grantId: proof.grantId } : {}),
          });
        } catch {
          throw new Refusal(503, "audit_unavailable",
            "New entries were not resumed because the change could not be recorded. Try again.");
        }
      }
      const state = await liveSafety.setEntriesPaused(paused,
        { reason: paused ? params.reason as string : null, by: actor });
      try {
        await appendAdminAudit(actor, paused ? "platform.entries_paused" : "platform.entries_resumed", "platform", {
          requestId, changed: state.changed, ...(paused ? { reason: params.reason } : {}),
          stepUpMethod: proof.method, ...(proof.grantId ? { grantId: proof.grantId } : {}),
        });
      } catch {
        // The switch is set (risk-reducing when pausing); a lost audit row must not hide that.
      }
      return { paused: state.paused, at: state.pausedAt, by: state.pausedBy, reason: state.reason, changed: state.changed };
    },
  };
}

function partialCloseSpec(body: Record<string, unknown>, rawId: unknown): CommandSpec {
  const id = pathId(rawId, "trade");
  const pct = body.pct;
  if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 1 || pct > 99) {
    throw invalid("pct must be a whole percentage from 1 to 99.");
  }
  return { kind: "trade_partial_close", method: "POST", botPath: `${BOT_BASE}/trades/${id}/partial-close`,
    target: `trade:${decodeURIComponent(id)}`, params: { pct },
    accept: botControlReplies.partialClose, long: true, allowsPassword: false, tier: "grant" };
}

/**
 * Feature B: archive (`archived: true`) or restore (`false`) one CLOSED trade
 * on the Bot (capability `tradeArchive.v1`). Presentation state only: the Bot
 * keeps the trade in every P&L total, the daily-loss window and the halt
 * latch, and refuses a trade that is not fully resolved with a typed code.
 * Not a money action, so it takes the lightest admin tier, `grant` (as C5
 * start/stop and C6 Close do); the password is not accepted, because only
 * risk-reducing commands may use it (OD-2).
 */
function archiveSpec(body: Record<string, unknown>, rawId: unknown): CommandSpec {
  const id = pathId(rawId, "trade");
  if (typeof body.archived !== "boolean") throw invalid("archived must be true or false.");
  return { kind: "trade_archive", method: "POST", botPath: `${BOT_BASE}/trades/${id}/archive`,
    target: `trade:${decodeURIComponent(id)}`, params: { archived: body.archived },
    accept: botControlReplies.archive, long: false, allowsPassword: false, tier: "grant" };
}

// ── outcome → browser ───────────────────────────────────────────────────────

export interface Answer {
  status: number;
  payload: Record<string, unknown>;
  /**
   * A definitive answer the BOT gave — its JSON 2xx, or its typed refusal —
   * which a repeat of the same request id may be answered from. Never this
   * Platform's own refusals (a wrong code, a missing field): a retry after
   * one of those must be able to succeed.
   */
  fromBot?: boolean;
  /** What the replay cache keeps instead of `payload` (a shown-once link is not kept). */
  replayPayload?: Record<string, unknown>;
}

const CHANNEL_REJECTED = "The execution bot refused this Platform's signed request (channel configuration).";

function commandAnswer(outcome: BotControlOutcome, requestId: string): Answer {
  if (outcome.outcome === "ok") {
    const pending = outcome.status === 202 || outcome.body.status === "pending";
    return pending
      ? { status: 202, payload: { status: "pending", requestId, result: outcome.body } }
      : { status: 200, payload: { status: "succeeded", requestId, result: outcome.body }, fromBot: true };
  }
  if (outcome.outcome === "uncertain") {
    return { status: 202, payload: { status: "uncertain", requestId } };
  }
  /*
   * The Bot's 409 `command_in_progress` is "still running", not "did not run":
   * the same request id is being executed right now. It is an unknown outcome
   * like any other, so the browser keeps the id and asks C8; it is never
   * replayed from here and never audited as a refusal.
   */
  if (outcome.fault === "business" && outcome.code === "command_in_progress") {
    return { status: 202, payload: { status: "uncertain", requestId, code: "command_in_progress" } };
  }
  const answer = refusalAnswer(outcome);
  // `request_id_reused` is about the id, not the command: a corrected retry must reach the Bot.
  // `bot_busy_retry` (contract v2.0, C12-C14) asks for exactly that retry, so it is never replayed from here.
  return outcome.fault === "business" && outcome.code !== "request_id_reused" && outcome.code !== "bot_busy_retry"
    ? { ...answer, fromBot: true } : answer;
}

function refusalAnswer(outcome: Extract<BotControlOutcome, { outcome: "refused" }>): Answer {
  switch (outcome.fault) {
    case "channel_auth":
    case "channel_proxy":
    case "channel_replay":
      return { status: 502, payload: { code: "bot_channel_rejected", error: CHANNEL_REJECTED,
        cause: outcome.fault.replace("channel_", "") } };
    case "rate_limited":
      return { status: 503, payload: { code: "bot_rate_limited", error: outcome.message } };
    case "not_configured":
      return { status: 503, payload: { code: "bot_channel_not_configured", error: "Bot control channel not configured." } };
    default:
      // Only a typed refusal's own words are passed on (F11).
      return { status: outcome.status, payload: { code: outcome.code, error: outcome.message } };
  }
}

export function readAnswer(outcome: BotControlOutcome): Answer {
  if (outcome.outcome === "ok") return { status: 200, payload: outcome.body };
  if (outcome.outcome === "refused") return refusalAnswer(outcome);
  return outcome.reason === "invalid_reply" || outcome.reason === "no_code"
    ? { status: 502, payload: { code: "bot_invalid_response", error: "The execution bot answered, but not in the expected form." } }
    : { status: 502, payload: { code: "bot_unreachable", error: "The execution bot could not be reached." } };
}

function auditOutcomeOf(answer: Answer): "succeeded" | "refused" | "uncertain" {
  if (answer.status === 200) return "succeeded";
  if (answer.status === 202) return "uncertain";
  return "refused";
}

// ── one in-flight command per request id ────────────────────────────────────

/*
 * A double-click, or a retry racing a slow first attempt, arrives with the SAME
 * request id. It must not become a second command, and the second click must
 * not be refused because the first one already spent the authenticator code.
 * So a request whose id is already in flight for the same administrator and
 * the same command joins it and gets the same answer; one that finished with a
 * definitive answer a moment ago gets that answer replayed. Neither contacts
 * the Bot again. The Bot keeps its own idempotency table as well (contract §4);
 * this only stops the duplicate before it costs a nonce and a code.
 *
 * Nothing uncertain is replayed from here: a resend after an uncertain answer
 * goes to the Bot, which knows the truth.
 */
interface Flight { actor: string; hash: string; answer: Promise<Answer> }
const inFlight = new Map<string, Flight>();
const settled = new Map<string, { actor: string; hash: string; at: number; answer: Answer }>();
const SETTLED_TTL_MS = 10 * 60_000;
const SETTLED_MAX = 500;

function remember(requestId: string, entry: { actor: string; hash: string; answer: Answer }): void {
  if (!entry.answer.fromBot) return;
  const { replayPayload, ...answer } = entry.answer;
  settled.set(requestId, { ...entry, answer: replayPayload ? { ...answer, payload: replayPayload } : answer,
    at: Date.now() });
  while (settled.size > SETTLED_MAX) settled.delete(settled.keys().next().value!);
}

function earlier(requestId: string): { actor: string; hash: string; answer: Promise<Answer> | Answer } | null {
  const flight = inFlight.get(requestId);
  if (flight) return flight;
  const done = settled.get(requestId);
  if (!done) return null;
  if (Date.now() - done.at > SETTLED_TTL_MS) { settled.delete(requestId); return null; }
  return done;
}

/** Tests only. */
export function resetBotControlStateForTests(): void {
  inFlight.clear();
  settled.clear();
}

const commandHash = (spec: CommandSpec): string =>
  createHash("sha256").update(canonicalJson({ kind: spec.kind, target: spec.target, params: spec.params })).digest("hex");

// ── the handler every mutating route shares ─────────────────────────────────

export async function runCommand(req: FastifyRequest, reply: FastifyReply,
  build: (body: Record<string, unknown>) => CommandSpec): Promise<FastifyReply> {
  try {
    if (!config.authEnabled) {
      throw new Refusal(403, "auth_disabled",
        "Bot commands need sign-in to be on (AUTH_ENABLED). Reads still work.");
    }
    const body = bodyOf(req);
    const requestId = requestIdOf(req, body);
    const spec = build(body);
    // Before step-up, so an authenticator code is not spent on a command that cannot be sent.
    if (!spec.platformHalf && !isManualControlChannelConfigured()) {
      throw new Refusal(503, "bot_channel_not_configured", "Bot control channel not configured.");
    }
    const actor = userIdOf(req);
    const hash = commandHash(spec);

    const previous = earlier(requestId);
    if (previous) {
      if (previous.actor !== actor || previous.hash !== hash) {
        throw new Refusal(409, "request_id_reused", "That request id was already used for a different command.");
      }
      const answer = await previous.answer;
      return reply.code(answer.status).send({ ...answer.payload, replayed: true });
    }

    // Registered with no await since the check above, so a second click cannot slip between.
    const flight: Flight = { actor, hash, answer: execute(req, reply, spec, requestId, actor) };
    inFlight.set(requestId, flight);
    let answer: Answer;
    try {
      answer = await flight.answer;
    } finally {
      inFlight.delete(requestId);
    }
    remember(requestId, { actor, hash, answer });
    return reply.code(answer.status).send(answer.payload);
  } catch (error) {
    if (error instanceof Refusal) {
      return reply.code(error.status).send({ code: error.code, error: error.message, ...error.extra });
    }
    throw error;
  }
}

/**
 * Step-up, (the Platform half,) audit, send, audit. Resolves to the answer;
 * throws only `Refusal` or a defect.
 */
async function execute(req: FastifyRequest, reply: FastifyReply, spec: CommandSpec, requestId: string,
  actor: string): Promise<Answer> {
  try {
    const account = await users.getUser(actor);
    if (!account) throw new Refusal(401, "not_authenticated", "not authenticated");
    const proof = await resolveStepUp(req, reply, account,
      { tier: spec.tier ?? "fresh", allowsPassword: spec.allowsPassword });
    if (!spec.platformHalf) return await sendToBot(req, spec, requestId, actor, proof);
    const platform = await spec.platformHalf({ actor, requestId, proof });
    // From here the Platform half has happened: a Bot-side refusal must not hide it.
    let bot: Answer;
    if (!isManualControlChannelConfigured()) {
      bot = { status: 503, payload: { code: "bot_channel_not_configured", error: "Bot control channel not configured." } };
    } else {
      try {
        bot = await sendToBot(req, spec, requestId, actor, proof);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        bot = { status: error.status, payload: { code: error.code, error: error.message, ...error.extra } };
      }
    }
    return {
      status: 200, payload: { platform, bot: { httpStatus: bot.status, ...bot.payload } }, fromBot: bot.fromBot,
    };
  } catch (error) {
    if (error instanceof Refusal) {
      return { status: error.status, payload: { code: error.code, error: error.message, ...error.extra } };
    }
    throw error;
  }
}

/** Audit `requested`, send, audit the outcome. Not sent if the first row cannot be written. */
async function sendToBot(req: FastifyRequest, spec: CommandSpec, requestId: string, actor: string,
  proof: StepUpProof): Promise<Answer> {
  try {
    await appendAdminAudit(actor, `bot.${spec.kind}.requested`, spec.target, {
      requestId, stepUpMethod: proof.method, ...(proof.grantId ? { grantId: proof.grantId } : {}),
      params: spec.params,
    });
  } catch (err) {
    req.log.error({ err: (err as Error).name, requestId }, "bot command not sent: the audit row could not be written");
    throw new Refusal(503, "audit_unavailable", "The command was not sent because it could not be recorded. Try again.");
  }

  let outcome = await botControlCommand({
    method: spec.method, path: spec.botPath, requestId,
    body: { ...spec.params, actor: { platformUserId: actor, stepUp: { method: actorStepUpMethod(proof), at: proof.at } } },
    accept: spec.accept, timeoutMs: spec.long ? timeouts.longMs : timeouts.defaultMs,
  });
  let shaped: ShapedResult | null = null;
  if (outcome.outcome === "ok" && spec.shapeResult) {
    try {
      shaped = await spec.shapeResult(outcome.body, { actor, requestId });
    } catch (err) {
      req.log.error({ err: (err as Error).name, requestId }, "a bot command result could not be shaped; withheld");
      shaped = { body: { resultWithheld: true } };
    }
    outcome = { ...outcome, body: shaped.body };
  }
  let answer = commandAnswer(outcome, requestId);
  if (shaped?.refusal) {
    answer = { status: shaped.refusal.status, payload: { code: shaped.refusal.code, error: shaped.refusal.error } };
  } else if (shaped?.replayBody && answer.fromBot) {
    answer = { ...answer, replayPayload: { ...answer.payload, result: shaped.replayBody } };
  }
  const verdict = auditOutcomeOf(answer);
  try {
    await appendAdminAudit(actor, `bot.${spec.kind}.${verdict}`, spec.target, {
      requestId, status: answer.status,
      ...(typeof answer.payload.status === "string" ? { outcome: answer.payload.status } : {}),
      ...(typeof answer.payload.code === "string" ? { code: answer.payload.code } : {}),
      ...(outcome.outcome === "uncertain" ? { reason: outcome.reason } : {}),
      ...(shaped?.audit ?? {}),
    });
  } catch (err) {
    // The command has run (or may have); its answer must still reach the operator.
    req.log.error({ err: (err as Error).name, requestId }, "could not record a bot command outcome");
  }
  return answer;
}

// ── reads ───────────────────────────────────────────────────────────────────

async function platformHalt() {
  try {
    const limits = await liveSafety.getRiskLimits();
    return { halted: limits.tradingHalted, haltedBy: limits.haltedBy, haltedReason: limits.haltedReason };
  } catch {
    return null;
  }
}

/** The Platform half of "pause new entries" (OD-3); null when it could not be read (show unknown). */
async function platformEntries() {
  try {
    const limits = await liveSafety.getRiskLimits();
    return { paused: limits.entriesPaused === true, pausedAt: limits.entriesPausedAt ?? null,
      pausedBy: limits.entriesPausedBy ?? null, reason: limits.entriesPausedReason ?? null };
  } catch {
    return null;
  }
}

export async function botControlRoutes(app: FastifyInstance): Promise<void> {
  /** C0, plus what only this Platform knows: is the channel set, the webhook path, the Platform halt. */
  app.get("/api/bot/control/status", async () => {
    const deployments = await deploymentRepo.listDeployments();
    const [{ panel }, halt, entries] = await Promise.all([
      readBotOperations(deployments), platformHalt(), platformEntries()]);
    return { ...panel, platformHalt: halt, platformEntries: entries };
  });

  /** C3. */
  app.get("/api/bot/control/risk-limits", async (_req, reply) => {
    const answer = readAnswer(await botControlCommand({ method: "GET", path: `${BOT_BASE}/risk-limits`,
      accept: botControlReplies.riskLimits, timeoutMs: timeouts.defaultMs }));
    return reply.code(answer.status).send(answer.payload);
  });

  /** C8. Its 404 is the one answer that may be shown as "nothing was changed". */
  app.get("/api/bot/control/commands/:requestId", async (req, reply) => {
    const raw = (req.params as { requestId?: string }).requestId;
    if (typeof raw !== "string" || !REQUEST_ID.test(raw)) {
      return reply.code(400).send({ code: "invalid_request_id",
        error: "A request id of 16 to 128 letters, digits, - or _ is required." });
    }
    const outcome = await botControlCommand({ method: "GET", path: `${BOT_BASE}/commands/${encodeURIComponent(raw)}`,
      accept: botControlReplies.command, timeoutMs: timeouts.defaultMs });
    if (outcome.outcome === "refused" && outcome.fault === "business" && outcome.status === 404
      && outcome.code === "command_not_found") {
      return reply.code(404).send({ code: "command_not_found",
        error: "The execution bot has no record of this command." });
    }
    const answer = readAnswer(outcome);
    return reply.code(answer.status).send(answer.payload);
  });

  // ── C1-C7 ────────────────────────────────────────────────────────────────

  app.post("/api/bot/control/halt", async (req, reply) => runCommand(req, reply, haltSpec));
  app.post("/api/bot/control/resume", async (req, reply) => runCommand(req, reply, resumeSpec));
  app.patch("/api/bot/control/risk-limits", async (req, reply) => runCommand(req, reply, riskLimitsSpec));
  app.post("/api/bot/control/bots/:id/status", async (req, reply) =>
    runCommand(req, reply, (body) => botStatusSpec(body, (req.params as { id?: string }).id)));
  app.post("/api/bot/control/trades/:id/close", async (req, reply) =>
    runCommand(req, reply, (body) => closeSpec(body, (req.params as { id?: string }).id)));
  app.post("/api/bot/control/trades/:id/partial-close", async (req, reply) =>
    runCommand(req, reply, (body) => partialCloseSpec(body, (req.params as { id?: string }).id)));
  // Feature B (`tradeArchive.v1`): hide / show a closed trade in History.
  app.post("/api/bot/control/trades/:id/archive", async (req, reply) =>
    runCommand(req, reply, (body) => archiveSpec(body, (req.params as { id?: string }).id)));

  // ── C9 with the Platform half (OD-3) ─────────────────────────────────────

  /** Answers `{platform:{paused, at, by, reason, changed}, bot:{httpStatus, status, …}}`. */
  app.post("/api/bot/control/entries", async (req, reply) => runCommand(req, reply, entriesSpec));
}
