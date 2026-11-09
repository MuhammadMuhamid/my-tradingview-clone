import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { config, isPublishedPlaceholder } from "../config";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

function canonicalPath(raw: string): string {
  const url = new URL(raw, "http://manual.local");
  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak.localeCompare(bk) || av.localeCompare(bv));
  const query = new URLSearchParams(sorted).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function signManualCommand(input: { method: string; path: string; timestamp: string;
  nonce: string; requestId: string; body?: unknown }, secret = config.manualTradingHmacSecret): string {
  const bodyHash = createHash("sha256").update(canonicalJson(input.body)).digest("hex");
  const canonical = [input.method.toUpperCase(), canonicalPath(input.path), input.timestamp,
    input.nonce, input.requestId, bodyHash].join("\n");
  return `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

export class ManualBotError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface ManualBotRequestInput {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body?: unknown;
  requestId?: string;
  /**
   * How long to wait for the Bot. 10 s unless the caller knows the command
   * does more work first: a strategy Close or Partial may reconcile earlier
   * exits at the exchange before it sends its own order (contract §1: 30 s).
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Whether this Platform holds a usable Bot CONTROL channel.
 *
 * MANUAL_TRADING_HMAC_SECRET is a control-plane key, not a manual-order key: it
 * signs manual orders AND the Shariah installation-floor push, and the floor is
 * armed whether or not manual order submission is enabled. So the question
 * "can I talk to the execution Bot's control plane at all" is answered by the
 * key and the URL — never by MANUAL_TRADING_ENABLED, which answers a different
 * question entirely.
 *
 * A key that is missing, too short, or one of this repository's published
 * placeholders is not a channel. Signing with `""` would not authenticate
 * anything; it would just produce a MAC anyone who guessed the key is unset
 * could produce too.
 */
export function isManualControlChannelConfigured(): boolean {
  return config.manualTradingBotUrl.length > 0
    && config.manualTradingHmacSecret.length >= 32
    && !isPublishedPlaceholder(config.manualTradingHmacSecret);
}

/**
 * The Platform -> Bot CONTROL-PLANE call.
 *
 * Identical transport and identical HMAC to `manualBotRequest`; the ONLY
 * difference is which precondition it asks about. Arming the Shariah floor is
 * not a manual order and must not be disabled by the manual-order feature flag
 * (BOT-P1-4) — an operator who runs with MANUAL_TRADING_ENABLED=false still has
 * a Bot accepting direct webhook BUYs, and that is precisely the traffic the
 * floor exists to gate.
 *
 * It refuses rather than degrading: with no channel configured the caller gets
 * a 503 it can report, never a silent success.
 */
export async function manualBotControlRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch = fetch
): Promise<T> {
  if (!isManualControlChannelConfigured()) {
    throw new ManualBotError(
      "no execution bot control channel is configured (MANUAL_TRADING_HMAC_SECRET)", 503);
  }
  return sendManualBotRequest<T>(input, fetchImpl);
}

/** Manual ORDER traffic. Gated by the manual-order feature flag, as it always was. */
export async function manualBotRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch = fetch
): Promise<T> {
  if (!config.manualTradingEnabled) throw new ManualBotError("manual trading is disabled", 404);
  return sendManualBotRequest<T>(input, fetchImpl);
}

/** X3A order traffic. This flag exposes only the Bot's paper/testnet/demo API. */
export async function spotBotRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch = fetch
): Promise<T> {
  if (!config.spotExecutionEnabled) {
    throw new ManualBotError("paper/testnet spot execution is disabled", 404);
  }
  return sendManualBotRequest<T>(input, fetchImpl);
}

/** X3B order traffic. The only representable environments are paper/testnet/demo. */
export async function derivativeBotRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch = fetch
): Promise<T> {
  if (!config.derivativeExecutionEnabled) {
    throw new ManualBotError("paper/testnet derivatives execution is disabled", 404);
  }
  return sendManualBotRequest<T>(input, fetchImpl);
}

/** X4 order traffic. The wire schema contains only environment=paper. */
export async function equityBotRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch = fetch
): Promise<T> {
  if (!config.equityPaperExecutionEnabled) {
    throw new ManualBotError("Alpaca paper equity execution is disabled", 404);
  }
  return sendManualBotRequest<T>(input, fetchImpl);
}

/** X5 order traffic. The wire schema contains only OANDA practice / IBKR paper. */
export async function traditionalBotRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch = fetch
): Promise<T> {
  if (!config.traditionalPaperExecutionEnabled) {
    throw new ManualBotError("traditional paper/practice execution is disabled", 404);
  }
  return sendManualBotRequest<T>(input, fetchImpl);
}

/**
 * One signed request on the wire. Rejects only when no HTTP response arrived:
 * a refused connection, a DNS failure, a refused redirect or the timeout.
 */
async function dispatchSigned(input: ManualBotRequestInput, fetchImpl: typeof fetch): Promise<Response> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = input.requestId ?? randomUUID();
  const signature = signManualCommand({ ...input, timestamp, nonce, requestId });
  return fetchImpl(`${config.manualTradingBotUrl}${input.path}`, {
    method: input.method,
    headers: { "content-type": "application/json", "x-manual-timestamp": timestamp,
      "x-manual-nonce": nonce, "x-manual-request-id": requestId,
      "x-manual-signature": signature },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    /*
     * A signed request is never followed anywhere. A proxy's 3xx would move a
     * request signed for one Bot route onto whatever the Location names
     * (contract F5); refusing the redirect turns it into a transport failure,
     * which every caller already reports.
     */
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

const isTimeout = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");

async function sendManualBotRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch
): Promise<T> {
  /*
   * A bot that never answered is not an internal error of THIS service.
   *
   * `fetch` rejects on a refused connection, a DNS failure or the timeout,
   * and that rejection is not a `ManualBotError`, so it fell through the
   * route's handler to Fastify's generic 500 — reaching the operator as
   * "internal server error" on the manual trading panel, which is both wrong
   * about whose fault it is and useless about what to do next. 502 with the
   * cause named is the truthful answer: an upstream this service depends on
   * did not respond.
   *
   * Nothing about what executes changes. The request had already failed; only
   * the status and the sentence are different.
   */
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await dispatchSigned(input, fetchImpl);
  } catch (cause) {
    const reason = isTimeout(cause)
      ? `did not respond within ${Math.round(timeoutMs / 1000)}s`
      : "could not be reached";
    throw new ManualBotError(`the execution bot ${reason}`, 502);
  }
  if (!response.ok) {
    let message = `execution bot returned ${response.status}`;
    try { message = ((await response.json()) as { error?: string }).error ?? message; } catch { /* status only */ }
    throw new ManualBotError(message, response.status);
  }
  return response.json() as Promise<T>;
}

// ── Bot CONTROL commands: typed outcomes (contract §6, F8, F9, F11) ─────────

/**
 * What one control call to the Bot amounted to.
 *
 * `manualBotRequest` throws on anything but a 2xx, and its callers only ever
 * needed "worked" or "did not". A money-moving command needs a third answer:
 * the Bot may have acted and nobody can say. Folding that into a 502 is how an
 * operator gets told "nothing was changed" about a market SELL that filled
 * (Fable finding 8), so the three are kept apart here, once, for every caller.
 *
 * - `ok`: a Bot-authored JSON 2xx whose shape the caller recognised.
 * - `refused`: a definitive "this did not run". Either the Bot's own typed
 *   refusal (a JSON 4xx carrying `code`), or a fault that is known to stop a
 *   request before any command logic: the Bot's signature check (401), the
 *   proxy's Platform-IP rule (403 without a code), a nonce replay, the Bot's
 *   control limiter (429 `bot_rate_limited`) or an unset control secret.
 * - `uncertain`: everything else. A timeout, a socket error, a proxy or other
 *   5xx, a 2xx that is not JSON or not the expected shape, a 4xx without a
 *   code. For a mutating command the outcome is unknown and the caller must
 *   ask C8; for a read it simply means "could not read".
 */
export type BotControlOutcome =
  | { outcome: "ok"; status: number; body: Record<string, unknown> }
  | {
      outcome: "refused"; status: number; code: string; message: string;
      fault: "business" | "channel_auth" | "channel_proxy" | "channel_replay" | "rate_limited" | "not_configured";
    }
  | { outcome: "uncertain"; reason: "timeout" | "transport" | "invalid_reply" | "no_code" | "server_error" };

export interface BotControlCommandInput extends ManualBotRequestInput {
  /** Recognises the Bot's 2xx body. A 2xx it rejects is not an answer (F8). */
  accept: (body: Record<string, unknown>) => boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const MESSAGE_LIMIT = 300;

/** The Bot's typed-refusal code, or null when the body carries none. */
function refusalCode(body: unknown): string | null {
  return isObject(body) && typeof body.code === "string" && CODE.test(body.code) ? body.code : null;
}

function refusalMessage(body: unknown, fallback: string): string {
  const raw = isObject(body) && typeof body.error === "string" ? body.error.trim() : "";
  return raw ? raw.slice(0, MESSAGE_LIMIT) : fallback;
}

/**
 * The pure half of `botControlCommand`: an HTTP status and a parsed body (or
 * `undefined` when the body was not JSON) to an outcome. Exported for tests.
 */
export function classifyBotControlReply(
  status: number, body: unknown, accept: (body: Record<string, unknown>) => boolean,
): BotControlOutcome {
  if (status >= 200 && status < 300) {
    return isObject(body) && accept(body)
      ? { outcome: "ok", status, body }
      : { outcome: "uncertain", reason: "invalid_reply" };
  }
  const code = refusalCode(body);
  // The Bot's signature check is the only thing that answers 401 on this path,
  // and it runs before any route: a refusal of the CHANNEL, not of the command.
  if (status === 401) {
    return { outcome: "refused", status, code: code ?? "auth", fault: "channel_auth",
      message: "The execution bot refused this Platform's signed request." };
  }
  if (status === 403 && (code === null || code === "auth")) {
    return { outcome: "refused", status, code: code ?? "proxy", fault: code ? "channel_auth" : "channel_proxy",
      message: "A proxy in front of the execution bot refused this Platform's request." };
  }
  if (status === 409 && code === "nonce_replay") {
    return { outcome: "refused", status, code, fault: "channel_replay",
      message: "The execution bot refused a replayed signed request." };
  }
  if (status === 429) {
    return code === "bot_rate_limited"
      ? { outcome: "refused", status, code, fault: "rate_limited",
        message: "The execution bot is rate-limiting control commands. Nothing was run; retry shortly." }
      : { outcome: "uncertain", reason: "no_code" };
  }
  if (status === 503 && code !== null && /not_configured|unconfigured/.test(code)) {
    return { outcome: "refused", status, code, fault: "not_configured",
      message: "The execution bot's control channel is not configured." };
  }
  if (status >= 400 && status < 500 && code !== null) {
    return { outcome: "refused", status, code, fault: "business",
      message: refusalMessage(body, "The execution bot refused this command.") };
  }
  return { outcome: "uncertain", reason: status >= 500 ? "server_error" : "no_code" };
}

/**
 * A signed control call that never throws for anything the Bot or the network
 * does: it returns what happened. With no control channel configured nothing
 * is sent, and that is a definitive refusal.
 */
export async function botControlCommand(
  input: BotControlCommandInput, fetchImpl: typeof fetch = fetch,
): Promise<BotControlOutcome> {
  if (!isManualControlChannelConfigured()) {
    return { outcome: "refused", status: 503, code: "bot_channel_not_configured", fault: "not_configured",
      message: "Bot control channel not configured." };
  }
  let response: Response;
  try {
    response = await dispatchSigned(input, fetchImpl);
  } catch (cause) {
    return { outcome: "uncertain", reason: isTimeout(cause) ? "timeout" : "transport" };
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : undefined;
  } catch (cause) {
    // A body that stopped arriving is not an answer, whatever the status said.
    if (isTimeout(cause)) return { outcome: "uncertain", reason: "timeout" };
    body = undefined;
  }
  return classifyBotControlReply(response.status, body, input.accept);
}

/**
 * The shapes of the Bot's control replies (contract §2), checked before any is
 * treated as an answer. They check what the Platform relies on, not every
 * field: extra fields from a newer Bot are fine, a missing or mistyped one is
 * not an answer.
 */
const nullableNumber = (value: unknown): boolean =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);

export const botControlReplies = {
  halt: (b: Record<string, unknown>): boolean =>
    b.halted === true && typeof b.alreadyHalted === "boolean",
  resume: (b: Record<string, unknown>): boolean => b.halted === false,
  riskLimits: (b: Record<string, unknown>): boolean => {
    const limits = b.limits;
    const snapshot = b.snapshot;
    return isObject(limits) && nullableNumber(limits.maxTotalExposureQuote)
      && nullableNumber(limits.maxConcurrentTrades) && nullableNumber(limits.maxDailyLossQuote)
      && finite(limits.dailyLossWindowHours)
      && isObject(snapshot) && finite(snapshot.openExposureQuote) && finite(snapshot.openTrades)
      && finite(snapshot.realisedPnlInWindow)
      && typeof b.summary === "string" && typeof b.latched === "boolean";
  },
  botStatus: (b: Record<string, unknown>): boolean =>
    typeof b.id === "string" && (b.status === "active" || b.status === "paused")
    && typeof b.changed === "boolean",
  close: (b: Record<string, unknown>): boolean =>
    b.status === "ok" || b.status === "ignored_duplicate" || b.status === "pending",
  partialClose: (b: Record<string, unknown>): boolean =>
    b.status === "pending" || (finite(b.requestedQty) && finite(b.executedQty)),
  command: (b: Record<string, unknown>): boolean =>
    typeof b.requestId === "string" && typeof b.kind === "string"
    && (b.status === "processing" || b.status === "succeeded" || b.status === "failed" || b.status === "pending"),
};
