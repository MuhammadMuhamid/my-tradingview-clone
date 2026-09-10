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
}

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

async function sendManualBotRequest<T>(
  input: ManualBotRequestInput, fetchImpl: typeof fetch
): Promise<T> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = input.requestId ?? randomUUID();
  const signature = signManualCommand({ ...input, timestamp, nonce, requestId });
  /*
   * A bot that never answered is not an internal error of THIS service.
   *
   * `fetch` rejects on a refused connection, a DNS failure or the 10s timeout,
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
  let response: Response;
  try {
    response = await fetchImpl(`${config.manualTradingBotUrl}${input.path}`, {
      method: input.method,
      headers: { "content-type": "application/json", "x-manual-timestamp": timestamp,
        "x-manual-nonce": nonce, "x-manual-request-id": requestId,
        "x-manual-signature": signature },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError"
      ? "did not respond within 10s"
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
