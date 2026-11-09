import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config";
import * as liveSafety from "../../repositories/liveSafety";
import { ManualBotError, manualBotRequest } from "../../manualTrading/client";
import {
  ShariahExposureBlockedError, assertShariahExposureAllowed,
  normalizeSpotSide, type ShariahGateDeps, type ShariahRequestContext, type SpotSide,
} from "../../shariah/gate";
import {
  assertExecutionSupported, defaultExecutionTarget, UnsupportedExecutionError,
  type ExecutionTarget,
} from "../../market/execution";
import { Refusal, resolveStepUp, type StepUpProof } from "../../security/stepUp";
import { userIdOf } from "../../security/requestUser";
import * as users from "../../repositories/users";

/**
 * Step-up for a manual BUY (OD-2/OD-7): grant tier, two-factor only. Injected
 * in tests that are about something else; the real one refuses everything
 * while AUTH_ENABLED is false.
 */
export type ManualStepUp = (req: FastifyRequest, reply: FastifyReply) => Promise<StepUpProof>;

const realStepUp: ManualStepUp = async (req, reply) => {
  const account = await users.getUser(userIdOf(req));
  if (!account) throw new Refusal(401, "not_authenticated", "not authenticated");
  return resolveStepUp(req, reply, account, { tier: "grant" });
};

const ORDER_REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The browser's id for this order, required (OD-7, F7). The order route never
 * mints one: an id invented here would make a retry a second order.
 */
function browserRequestId(body: Record<string, unknown>): string {
  const id = body.requestId;
  if (typeof id === "string" && ORDER_REQUEST_ID.test(id)) return id;
  throw new ManualBotError("A request id of 16 to 128 letters, digits, - or _ is required.", 400, "invalid_request_id");
}

/**
 * `positionFull: true` (OD-7, B-OD7) sells the whole remaining quantity of
 * `positionId`. Only `true`, only on a SELL with a position, and never beside a
 * `baseQuantity`; the browser sends it only when the Bot advertises
 * `manualPositionFull.v1`.
 */
function assertPositionFullShape(command: Record<string, unknown>): void {
  if (command.positionFull === undefined) return;
  if (command.positionFull !== true || normalizeSpotSide(command.side) !== "SELL"
    || typeof command.positionId !== "string" || command.positionId.length === 0
    || command.baseQuantity !== undefined || command.quoteQuantity !== undefined) {
    throw new ManualBotError(
      "positionFull must be true, on a SELL with a positionId and no quantity.", 400, "invalid_request");
  }
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ManualBotError("invalid request body", 400);
  return body as Record<string, unknown>;
}

function requestIdentity(body: Record<string, unknown>): string {
  const id = body.requestId;
  if (typeof id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(id)) return id;
  return randomUUID();
}

async function send<T>(reply: FastifyReply, action: () => Promise<T>) {
  try { return await action(); }
  catch (error) {
    // A refused new-exposure intent is an operator-readable 403, not a generic
    // failure: the panel shows this string verbatim so the user learns WHY the
    // BUY was blocked and that SELL is still available.
    if (error instanceof ShariahExposureBlockedError) {
      return reply.code(error.status).send({ error: error.message, shariah: error.context });
    }
    if (error instanceof UnsupportedExecutionError) {
      return reply.code(error.status).send({ error: error.message, code: "unsupported_execution" });
    }
    if (error instanceof Refusal) {
      return reply.code(error.status).send({ code: error.code, error: error.message, ...error.extra });
    }
    if (error instanceof ManualBotError) {
      return reply.code(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    throw error;
  }
}

/**
 * Fail closed on an unreadable side.
 *
 * The route is otherwise a pass-through — the Bot owns command validation — so
 * a body with a missing or malformed `side` reaches here. Treating it as BUY
 * means the Shariah gate applies to it; the Bot then rejects the malformed
 * command on its own terms, exactly as before. Treating it as SELL would make
 * `side: "bUy "` a bypass.
 */
function gatedSide(command: Record<string, unknown>): SpotSide {
  return normalizeSpotSide(command.side) ?? "BUY";
}

/**
 * Refuse NEW exposure while the operator halt is on.
 *
 * ── Why this was missing, and why it matters ──────────────────────────────
 *
 * `evaluateRisk` blocks a halted order, and the only thing that calls it is
 * `liveRunner`. So the halt stopped the automated deployments and nothing
 * else, while `/api/ops/status` reported `mode: "HALTED"` for the whole
 * platform. An operator who pressed halt was told the market would not be
 * touched, and the manual ticket could still open a position.
 *
 * ── Why only BUY ──────────────────────────────────────────────────────────
 *
 * `SELL is never gated, here as everywhere. An operator must always be able to
 * get out of a position` — `shariah/gate.ts` states the rule and this follows
 * it. Halting is the moment an operator most needs to close by hand, and this
 * codebase has twice shipped a safety fix that trapped the exit it was meant
 * to protect. Cancel and stop-loss/take-profit edits stay open for the same
 * reason: they can only reduce or bound exposure, never create it.
 *
 * The apparent disagreement with `evaluateRisk` — which blocks exits too — is
 * the intended division. Halting stops the AUTOMATION from acting in both
 * directions; the operator then manages what is open by hand, which is the
 * only reason to halt rather than simply stop the runner.
 */
async function assertNotHalted(
  command: Record<string, unknown>,
  readLimits: () => Promise<ManualRiskLimits>
): Promise<void> {
  if (gatedSide(command) !== "BUY") return;
  const limits = await readLimits();
  if (limits.tradingHalted) {
    throw new ManualBotError(
      limits.haltedReason
        ? `trading is halted: ${limits.haltedReason}. Closing an open position is still allowed.`
        : "trading is halted. Closing an open position is still allowed.",
      409
    );
  }
  // OD-3: paused new entries refuse a manual BUY too. SELL never reaches here.
  if (limits.entriesPaused === true) {
    throw new ManualBotError(
      limits.entriesPausedReason
        ? `new entries are paused: ${limits.entriesPausedReason}. Selling is still allowed.`
        : "new entries are paused. Selling is still allowed.",
      409, "entries_paused"
    );
  }
}

/** What the manual route reads of the risk controls (injectable for tests). */
export interface ManualRiskLimits {
  tradingHalted: boolean;
  haltedReason: string | null;
  entriesPaused?: boolean;
  entriesPausedReason?: string | null;
}

export async function manualTradingRoutes(
  app: FastifyInstance,
  dependencies: {
    shariah?: ShariahGateDeps;
    executionTarget?: (instrument: string) => ExecutionTarget;
    botRequest?: typeof manualBotRequest;
    /** Injected so the halt (and pause) refusal is provable without a database. */
    riskLimits?: () => Promise<ManualRiskLimits>;
    /** Injected by tests about something other than step-up. */
    stepUp?: ManualStepUp;
  } = {}
): Promise<void> {
  const shariahDeps = dependencies.shariah ?? {};
  const resolveExecutionTarget = dependencies.executionTarget ?? defaultExecutionTarget;
  const sendBotRequest = dependencies.botRequest ?? manualBotRequest;
  const readRiskLimits = dependencies.riskLimits ?? liveSafety.getRiskLimits;
  const stepUp = dependencies.stepUp ?? realStepUp;

  /**
   * Advisory account context for the ticket: free and locked for the two assets
   * of one symbol, plus the exchange's own size and price rules.
   *
   * A pure pass-through to the Bot, deliberately. Binance credentials stay on
   * the execution side and never come here; this is the same authenticated
   * boundary the order itself crosses. It is read-only and it authorises
   * nothing — the Bot re-derives everything it needs at submission time, so a
   * figure shown here can inform a human but can never widen what executes.
   */
  app.get("/api/manual-trading/account-state", async (req, reply) => send(reply, async () => {
    if (!config.manualTradingEnabled) throw new ManualBotError("manual trading is disabled", 404);
    const query = req.query as { symbol?: unknown; accountId?: unknown };
    const symbol = typeof query.symbol === "string" ? query.symbol : "";
    const accountId = typeof query.accountId === "string" ? query.accountId : "";
    if (!symbol || !accountId) throw new ManualBotError("symbol and accountId are required", 400);
    return sendBotRequest({ method: "GET",
      path: `/api/manual-trading/account-state?accountId=${encodeURIComponent(accountId)}`
        + `&symbol=${encodeURIComponent(symbol)}` });
  }));

  app.get("/api/manual-trading/state", async (req, reply) => send(reply, async () => {
    if (!config.manualTradingEnabled) {
      // This read is also the browser's capability handshake. A stable 200
      // keeps an intentionally disabled installation out of the error console;
      // no Bot is contacted, and every mutating route remains fail-closed.
      return {
        enabled: false,
        mainnetEnabled: false,
        dryRun: true,
        mixed: false,
        accounts: [],
        orders: [],
        positions: [],
        protection: {
          type: "bot-managed",
          exchangeResting: false,
          note: "Manual trading is disabled; no execution Bot was contacted.",
        },
      };
    }
    const symbol = (req.query as { symbol?: unknown }).symbol;
    const query = typeof symbol === "string" ? `?symbol=${encodeURIComponent(symbol)}` : "";
    return sendBotRequest({ method: "GET", path: `/api/manual-trading/state${query}` });
  }));

  /**
   * The manual BUY/SELL path. This is a new-exposure path, so it is gated
   * BEFORE the Bot is contacted; the browser is never trusted to have applied
   * the rule, and any client-supplied `shariah` key is discarded rather than
   * forwarded — the block that ships is the one this backend just computed.
   */
  app.post("/api/manual-trading/orders", async (req, reply) => send(reply, async () => {
    // Before anything that could ask for a credential: an install without manual
    // trading refuses the same way it always did.
    if (!config.manualTradingEnabled) throw new ManualBotError("manual trading is disabled", 404);
    const body = bodyRecord(req.body);
    // The credential is for this Platform's step-up only: never forwarded.
    const { requestId: _browserOnly, shariah: _neverTrustedFromClient, credential: _stepUpOnly, ...command } = body;

    const target = resolveExecutionTarget(String(command.symbol ?? ""));
    assertExecutionSupported(target, command);
    const requestId = browserRequestId(body);
    assertPositionFullShape(command);

    // Before the Bot is contacted, and before the Shariah gate, because a
    // halted platform has nothing to say about permissibility — it has said it
    // is not trading.
    await assertNotHalted(command, readRiskLimits);

    let context: ShariahRequestContext | undefined;
    try {
      context = await assertShariahExposureAllowed(
        { symbol: String(command.symbol ?? ""), side: gatedSide(command) },
        shariahDeps
      );
    } catch (error) {
      // Healthy exits keep their provenance, but screening availability is
      // never permission to SELL. If the read fails, send no decision rather
      // than inventing an approval or trapping the operator's exit. The Bot
      // independently treats a Spot SELL as an exit, without reading a block.
      if (gatedSide(command) !== "SELL") throw error;
      req.log.warn({ err: error }, "manual exit proceeds without unavailable Shariah provenance");
    }

    /*
     * A BUY opens new exposure, so it is confirmed (grant tier: a recent code
     * suffices). Last, after every refusal that needs no credential, so a code
     * is not spent on an order that would be refused anyway. A SELL never asks:
     * an exit is never blocked by step-up, a halt or a pause.
     */
    if (gatedSide(command) === "BUY") await stepUp(req, reply);

    /*
     * The block rides inside the signed request body — `client.ts`
     * canonicalises the WHOLE body into the HMAC — so it cannot be added,
     * removed or edited in flight, and needs no signature of its own. It ships
     * on every entry and whenever exit provenance is readable: an installation
     * enforcing Shariah Mode must not depend on a second, hidden switch to send
     * the evidence that lets the Bot enforce new exposure.
     */
    if (!context) {
      return sendBotRequest({ method: "POST", path: "/api/manual-trading/orders",
        body: command, requestId });
    }
    return sendBotRequest({ method: "POST", path: "/api/manual-trading/orders",
      body: { ...command, shariah: context }, requestId });
  }));

  // Cancelling an order and editing stop-loss/take-profit protection can only
  // reduce or bound existing exposure, never create it, so neither is gated —
  // and neither must be, since an EXCLUDED position still has to be exitable.
  app.post<{ Params: { id: string } }>("/api/manual-trading/orders/:id/cancel", async (req, reply) =>
    send(reply, async () => { const body = bodyRecord(req.body); const requestId = requestIdentity(body);
      const { requestId: _browserOnly, ...command } = body;
      return sendBotRequest({ method: "POST",
        path: `/api/manual-trading/orders/${encodeURIComponent(req.params.id)}/cancel`,
        body: command, requestId });
    }));

  app.patch<{ Params: { id: string } }>("/api/manual-trading/positions/:id/protection", async (req, reply) =>
    send(reply, async () => { const body = bodyRecord(req.body); const requestId = requestIdentity(body);
      const { requestId: _browserOnly, ...command } = body;
      return sendBotRequest({ method: "PATCH",
        path: `/api/manual-trading/positions/${encodeURIComponent(req.params.id)}/protection`,
        body: command, requestId });
    }));
}
