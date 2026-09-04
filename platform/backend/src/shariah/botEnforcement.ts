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
 *
 * ── What the channel depends on, and what it must NOT depend on (BOT-P1-4) ──
 *
 * This push used to be skipped entirely when MANUAL_TRADING_ENABLED was false,
 * on both sides. That flag governs manual ORDER submission. Coupling the floor
 * to it meant an operator running with manual trading deliberately off could
 * switch Shariah Mode on, be told it worked, and have the Bot's floor stay
 * `off` — leaving every direct webhook BUY ungated. The push now depends on the
 * control CHANNEL being configured (URL + HMAC key), which is the only thing it
 * actually needs, and on nothing else.
 *
 * ── A 200 is not proof ──────────────────────────────────────────────────────
 *
 * The Bot answers with the floor it applied. That answer is checked against
 * what was asked for, because the failure this module exists to prevent is
 * precisely a receiver that accepts the request and does nothing: an older Bot
 * that ignores the field, a proxy that swallows it, a wrong route that happens
 * to return 200. Treating any of those as "armed" is the fail-open again, one
 * layer up.
 */
import { isManualControlChannelConfigured, manualBotControlRequest } from "../manualTrading/client";
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
  /** Injected in tests; production uses the real HMAC control client. */
  request?: typeof manualBotControlRequest;
  /**
   * Whether a Bot control channel exists at all. Injected in tests; production
   * reads config. Deliberately NOT `manualTradingEnabled` — see the header.
   */
  controlChannelConfigured?: boolean;
}

/** What the Bot reports back on the control path. Nothing here is trusted blindly. */
interface BotFloorReply {
  mode?: unknown;
  policyVersion?: unknown;
  supportedPolicyVersion?: unknown;
}

/** What the Bot currently believes, so drift is visible rather than silent. */
export async function readBotShariahMode(
  deps: BotEnforcementDeps = {}
): Promise<{ mode: ShariahMode; policyVersion: string | null } | null> {
  const configured = deps.controlChannelConfigured ?? isManualControlChannelConfigured();
  if (!configured) return null;
  const request = deps.request ?? manualBotControlRequest;
  try {
    const body = await request<BotFloorReply>({ method: "GET", path: PATH });
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
 * Push the mode to the Bot, and prove it landed.
 *
 * When no control channel is configured at all there is no Bot to talk to, so
 * this is a no-op rather than an error: an installation that never wired an
 * execution Bot has no webhook path to protect. `pushed: false` says exactly
 * that, and the caller reports it — it is never dressed up as an arming.
 *
 * When a channel IS configured, the only successful outcome is a Bot that
 * answers with the floor that was asked for. Anything else raises
 * `ShariahBotSyncError`, which the route turns into a 502 with the mode
 * unchanged.
 */
export async function pushShariahModeToBot(
  mode: ShariahMode, deps: BotEnforcementDeps = {}
): Promise<{ pushed: boolean }> {
  const configured = deps.controlChannelConfigured ?? isManualControlChannelConfigured();
  if (!configured) return { pushed: false };
  const request = deps.request ?? manualBotControlRequest;
  let reply: BotFloorReply;
  try {
    reply = await request<BotFloorReply>({
      method: "PUT",
      path: PATH,
      body: { mode, policyVersion: mode === "enforce" ? TS_SHARIAH_V1 : null },
    });
  } catch (error) {
    /*
     * The refusal itself is correct and unchanged — the mode does not move
     * unless the Bot confirms it. Only the sentence is different: this used to
     * end in a bare transport string ("…was not applied: fetch failed"), which
     * told an operator nothing about what is now true or what to do. The cause
     * is kept, after a statement of state and before a next step.
     */
    throw new ShariahBotSyncError(
      "the execution bot could not be told about this Shariah mode change, so the change " +
      "was not applied and Platform Shariah Mode is unchanged. Cause: " +
      (error instanceof Error ? error.message : String(error)) +
      ". Check that the execution bot is running and reachable from this Platform, then try again."
    );
  }
  const applied = (reply ?? {}).mode;
  if (applied !== mode) {
    throw new ShariahBotSyncError(
      `the execution bot answered with floor ${JSON.stringify(applied ?? null)} after being ` +
      `asked to set "${mode}", so the change was not applied. The two must agree before ` +
      "either can be trusted."
    );
  }
  /*
   * Arming under an unrecognised policy identity is not arming. The Bot's
   * `.strict()` schema refuses `enforce` without the exact version, so a reply
   * naming a different one means the receiver is not the contract this Platform
   * is written against.
   */
  if (mode === "enforce" && reply.policyVersion !== TS_SHARIAH_V1) {
    throw new ShariahBotSyncError(
      `the execution bot reports its floor under policy ` +
      `${JSON.stringify(reply.policyVersion ?? null)}, not ${TS_SHARIAH_V1}, so this ` +
      "Platform cannot treat the installation as enforcing."
    );
  }
  return { pushed: true };
}
