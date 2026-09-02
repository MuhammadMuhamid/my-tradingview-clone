/**
 * Telling the execution Bot that this installation enforces.
 *
 * ── Why this module has to exist ────────────────────────────────────────────
 *
 * Turning Shariah Mode on used to be a purely Platform-side act. Every path
 * the Platform itself originates was gated correctly by `shariah/gate.ts` — but
 * the Bot also accepts signals it never sees, on its own TradingView-style
 * webhook, authenticated by a per-bot secret. Nothing the Platform did could
 * arm enforcement for those: the Bot remembers enforcement per SENDER SCOPE,
 * and a Platform manual order arms `manual-account:<id>`, never `bot:<id>`.
 *
 * So an operator could switch Shariah Mode ON, believe the installation was
 * enforcing, and have the very first direct webhook BUY admitted ungated —
 * permanently, not transitionally.
 *
 * This module closes that by pushing the MODE, and only the mode, to the Bot
 * over the existing HMAC control channel when the operator changes it. It sends
 * no asset, no symbol and no classification: the Bot holds no registry, and the
 * per-asset decision continues to travel with each individual order.
 *
 * ── Ordering, which is the whole safety argument ────────────────────────────
 *
 * Turning ON  : arm the Bot FIRST, persist locally only if that succeeded. A
 *               failure leaves the Platform showing `off`, which is honest —
 *               better than an operator being told they are protected while the
 *               executing side still admits webhook BUYs.
 * Turning OFF : persist locally first, disarm the Bot after. Every intermediate
 *               state is the stricter one.
 */
import { manualBotRequest } from "../manualTrading/client";
import { config } from "../config";
import { TS_SHARIAH_V1 } from "./policy";
import type { ShariahMode } from "./mode";

const PATH = "/api/manual-trading/shariah-enforcement";

export class ShariahModeDriftError extends Error {
  readonly status = 500;
  constructor(readonly botMode: ShariahMode, readonly storedMode: ShariahMode, cause: string) {
    super(
      `the execution bot was set to "${botMode}" but this Platform could not record the ` +
      `change, so it still reports "${storedMode}". Retry the mode change: the two must ` +
      `agree before either can be trusted. Underlying failure: ${cause}`);
    this.name = "ShariahModeDriftError";
  }
}

export class ShariahBotSyncError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "ShariahBotSyncError";
  }
}

export interface BotEnforcementDeps {
  /** Injected in tests; production uses the real HMAC client. */
  request?: typeof manualBotRequest;
  /** Injected in tests; production reads config. */
  manualTradingEnabled?: boolean;
}

/** What the Bot currently believes, so drift is visible rather than silent. */
export async function readBotShariahMode(
  deps: BotEnforcementDeps = {}
): Promise<{ mode: ShariahMode; policyVersion: string | null } | null> {
  const enabled = deps.manualTradingEnabled ?? config.manualTradingEnabled;
  if (!enabled) return null;
  const request = deps.request ?? manualBotRequest;
  try {
    const body = await request<{ mode?: unknown; policyVersion?: unknown }>(
      { method: "GET", path: PATH });
    return {
      mode: body.mode === "enforce" ? "enforce" : "off",
      policyVersion: typeof body.policyVersion === "string" ? body.policyVersion : null,
    };
  } catch {
    /*
     * Unreachable is not the same as `off`. Returning null lets the caller say
     * "unknown", which is honest; claiming `off` would invent agreement, and
     * claiming `enforce` would invent protection.
     */
    return null;
  }
}

/**
 * Push the mode to the Bot.
 *
 * When manual trading is not configured there is no HMAC channel and no Bot to
 * talk to, so this is a no-op rather than an error: an installation that never
 * wired an execution Bot has no webhook path to protect.
 */
export async function pushShariahModeToBot(
  mode: ShariahMode, deps: BotEnforcementDeps = {}
): Promise<{ pushed: boolean }> {
  const enabled = deps.manualTradingEnabled ?? config.manualTradingEnabled;
  if (!enabled) return { pushed: false };
  const request = deps.request ?? manualBotRequest;
  try {
    await request({
      method: "PUT",
      path: PATH,
      body: { mode, policyVersion: mode === "enforce" ? TS_SHARIAH_V1 : null },
    });
  } catch (error) {
    throw new ShariahBotSyncError(
      "the execution bot could not be told about this Shariah mode change, so the " +
      "change was not applied: " + (error instanceof Error ? error.message : String(error))
    );
  }
  return { pushed: true };
}
