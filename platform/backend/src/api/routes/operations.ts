/**
 * Operator control surface: the kill switch, the risk limits, feed health and
 * the emitter lease.
 *
 * There was no way to halt trading short of pausing thirteen deployments one at
 * a time, and no way to see whether a feed was actually live (BE-11, BE-14,
 * X-06). Every route here is behind the same session gate as the rest of the
 * API — the guard hook in `api/server.ts` runs before all of them.
 *
 * Read routes are safe. The two write routes change what the live runner will
 * do, so both require an explicit confirmation string, the same convention the
 * real-order test endpoint already uses.
 */
import type { FastifyInstance } from "fastify";
import * as liveSafety from "../../repositories/liveSafety";
import * as deploymentRepo from "../../repositories/deployments";
import {
  countOpenPositions, intendedExposure, realisedPnlInWindow,
} from "../../engine/riskControls";
import { newestClosedBarOpenTime, worstFeedState, type FeedState } from "../../data/feedHealth";
import { summariseDelivery } from "../../engine/deliveryHealth";
import { config } from "../../config";
import type { LiveRunner } from "../../engine/liveRunner";
import { readBotStatus } from "../../operations/botStatus";
import { INTERVAL_MS, isInterval } from "../../types/market";
import type { CandleIntegrityState, CandleIntegrityIssueCode } from "../../data/candleIntegrity";

/** The word an operator must send to arm or disarm trading. */
const HALT_CONFIRMATION = "HALT_TRADING";
const RESUME_CONFIRMATION = "RESUME_TRADING";

interface FeedIntegrityStatusInput {
  symbol: string;
  interval: string;
  state: FeedState;
  lastBarTime: number | null;
  lastCheckedAt: number;
  integrityState: CandleIntegrityState | null;
  issueCodes: CandleIntegrityIssueCode[];
  issueCounts: Record<string, number>;
}

/** Cheap status projection over the already-incremental feed-health row. */
export function formatFeedIntegrityStatus(feed: FeedIntegrityStatusInput, now: number) {
  const interval = isInterval(feed.interval) ? feed.interval : null;
  const latestCompletedBarAgeMs = feed.lastBarTime === null || interval === null
    ? null
    : Math.max(0, now - (feed.lastBarTime + INTERVAL_MS[interval]));
  const fallback: CandleIntegrityState | null = feed.state === "live"
    ? "healthy"
    : feed.state === "unknown"
      ? null
      : feed.state === "error"
        ? "invalid"
        : "degraded";
  let state = feed.integrityState ?? fallback;
  const issueCodes = [...feed.issueCodes];
  const issueCounts = { ...feed.issueCounts };
  if (feed.lastBarTime !== null && interval !== null) {
    const expected = newestClosedBarOpenTime(interval, now);
    const barsBehind = Math.max(0, Math.round((expected - feed.lastBarTime) / INTERVAL_MS[interval]));
    if (barsBehind > 1) {
      if (!issueCodes.includes("stale_latest_completed_bar")) {
        issueCodes.push("stale_latest_completed_bar");
      }
      issueCounts.stale_latest_completed_bar = barsBehind;
      if (state !== "invalid") state = "degraded";
    }
  }
  return {
    state,
    market: "spot" as const,
    symbol: feed.symbol,
    interval: feed.interval,
    latestCompletedBarTime: feed.lastBarTime === null ? null : new Date(feed.lastBarTime).toISOString(),
    latestCompletedBarAgeMs,
    lastCheckedAt: new Date(feed.lastCheckedAt).toISOString(),
    issueCodes,
    issueCounts,
  };
}

export function operationsRoutes(getRunner: () => LiveRunner) {
  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * The single screen an operator needs: is trading on, is this process the
     * emitter, are the feeds live, and where do the risk numbers stand.
     */
    app.get("/api/ops/status", async () => {
      const limits = await liveSafety.getRiskLimits();
      const deployments = await deploymentRepo.listDeployments();
      const active = deployments.filter((d) => d.status === "active");
      const positions = active.map((d) => ({
        position: (d.runtimeState.position ?? "flat") as "flat" | "long",
        buyQuoteQty: d.buyQuoteQty,
      }));
      const snapshot = {
        currentExposureQuote: intendedExposure(positions),
        openPositions: countOpenPositions(positions),
        // The execution bot owns fills. This platform ledger has no production
        // writer, so zero is not presented as an observation or enforced.
        realisedPnlInWindow: null,
      };
      const platformRiskSummary = limits.tradingHalted
        ? `HALTED${limits.haltedBy ? ` (${limits.haltedBy})` : ""}${
            limits.haltedReason ? `: ${limits.haltedReason}` : ""
          }`
        : `ACTIVE — configured exposure ${snapshot.currentExposureQuote.toFixed(2)}${
            limits.maxTotalExposureQuote !== null ? `/${limits.maxTotalExposureQuote.toFixed(2)}` : ""
          }, positions ${snapshot.openPositions}${
            limits.maxConcurrentPositions !== null ? `/${limits.maxConcurrentPositions}` : ""
          }, platform daily-loss control disabled`;

      const feeds = await liveSafety.listFeedHealth();
      const lease = await liveSafety.getEmitterLease();
      const deliveryWindowHours = 24;
      const delivery = summariseDelivery(
        await liveSafety.listDeliveryOutcomes(deliveryWindowHours),
        { now: Date.now(), windowHours: deliveryWindowHours }
      );
      const bot = await readBotStatus([...active, ...deployments.filter((d) => d.status !== "active")]);

      let runnerIsEmitter = false;
      try {
        runnerIsEmitter = getRunner().isEmitter;
      } catch {
        // The runner is constructed after the server; before that it is simply
        // not the emitter. Never let this route 500 because of ordering.
      }

      const statusNow = Date.now();
      return {
        /*
         * Three states, and `unknown` is a real answer rather than a guess. A
         * process that is not the emitter cannot report on emission, and a feed
         * that has not been assessed must never be rendered as live.
         */
        mode: limits.tradingHalted
          ? "HALTED"
          : !config.liveRunnerEnabled
            ? "DISABLED"
            : runnerIsEmitter
              ? "LIVE"
              : "STANDBY",
        emitter: {
          thisProcess: config.emitterId,
          liveRunnerEnabled: config.liveRunnerEnabled,
          holdsLease: runnerIsEmitter,
          lease: lease
            ? {
                holder: lease.holder,
                hostname: lease.hostname,
                pid: lease.pid,
                acquiredAt: new Date(lease.acquiredAt).toISOString(),
                expiresAt: new Date(lease.expiresAt).toISOString(),
                isThisProcess: lease.holder === config.emitterId,
              }
            : null,
        },
        risk: {
          ...limits,
          snapshot,
          summary: platformRiskSummary,
          dailyLossControl: {
            state: "DISABLED_UNFED",
            authority: "BOT",
            note: "Platform daily-loss enforcement is disabled because this process does not own "
              + "exchange fills. Bot status below reports authoritative realised P/L and bot-side protection.",
          },
        },
        bot,
        deployments: {
          total: deployments.length,
          active: active.length,
          long: snapshot.openPositions,
          paused: deployments.filter((d) => d.status === "paused").length,
        },
        /**
         * Are the signals this system produced actually reaching the bot? Before
         * this the only way to ask was to read the alerts table by hand, so a
         * webhook that had been failing for a day looked like a quiet market.
         */
        delivery: {
          ...delivery,
          lastSentAt: delivery.lastSentAt === null ? null : new Date(delivery.lastSentAt).toISOString(),
          lastFailureAt: delivery.lastFailureAt === null ? null : new Date(delivery.lastFailureAt).toISOString(),
        },
        /**
         * Binance testnet is a bot-side setting; the platform records what it
         * believes so the two cannot silently disagree. No credentialed call is
         * made from here — see docs/OPERATIONS.md.
         */
        exchange: {
          testnetConfigured: process.env.BINANCE_TESTNET === "true",
          note: "Reported from this process's configuration. The execution bot holds the "
            + "credentials and is the authority; nothing here contacts Binance.",
        },
        feeds: {
          worst: worstFeedState(feeds.map((f) => f.state as FeedState)),
          rows: feeds.map((f) => ({
            ...f,
            lastBarTime: f.lastBarTime === null ? null : new Date(f.lastBarTime).toISOString(),
            lastCheckedAt: new Date(f.lastCheckedAt).toISOString(),
            integrity: formatFeedIntegrityStatus(f, statusNow),
          })),
        },
        time: new Date(statusNow).toISOString(),
      };
    });

    /**
     * HALT. Refuses every emission — entries and exits alike — until resumed.
     *
     * Halting is the safe direction, so it needs a confirmation only to prevent
     * an accident, not to discourage it. A reason is mandatory: an operator
     * arriving at a halted system must be able to see why.
     */
    app.post("/api/ops/halt", async (req, reply) => {
      const body = (req.body ?? {}) as { confirmation?: string; reason?: string };
      if (body.confirmation !== HALT_CONFIRMATION) {
        return reply.code(400).send({
          error: `confirmation must be exactly "${HALT_CONFIRMATION}"`,
        });
      }
      const reason = (body.reason ?? "").trim();
      if (reason.length < 3) {
        return reply.code(400).send({ error: "a reason is required, so the halt is explicable later" });
      }
      await liveSafety.setTradingHalted(true, { reason, by: "operator" });
      req.log.error({ reason, by: "operator" }, "TRADING HALTED by operator");
      return { halted: true, reason };
    });

    /**
     * RESUME. Deliberately harder than halting: this re-arms real order flow,
     * and the reason a halt was latched may not have gone away.
     */
    app.post("/api/ops/resume", async (req, reply) => {
      const body = (req.body ?? {}) as { confirmation?: string };
      if (body.confirmation !== RESUME_CONFIRMATION) {
        return reply.code(400).send({
          error: `confirmation must be exactly "${RESUME_CONFIRMATION}"`,
        });
      }
      const before = await liveSafety.getRiskLimits();
      if (!before.tradingHalted) return { halted: false, note: "trading was not halted" };

      // A latched daily-loss halt is re-checked against live numbers: resuming
      // straight back into a breached limit would trip again on the next signal.
      if (before.haltedBy === "daily_loss" && before.maxDailyLossQuote !== null) {
        const rows = await liveSafety.listRealisedPnl(before.dailyLossWindowHours);
        const loss = -Math.min(0, realisedPnlInWindow(rows, before.dailyLossWindowHours));
        if (loss >= before.maxDailyLossQuote) {
          return reply.code(409).send({
            error:
              `refusing to resume: the rolling ${before.dailyLossWindowHours}h loss ` +
              `${loss.toFixed(2)} still meets the limit ${before.maxDailyLossQuote.toFixed(2)}. ` +
              "Raise the limit deliberately, or wait for the window to roll.",
          });
        }
      }

      await liveSafety.setTradingHalted(false);
      req.log.warn({ previousReason: before.haltedReason }, "trading RESUMED by operator");
      return { halted: false, previousReason: before.haltedReason };
    });

    /** Adjust the numeric limits. `null` turns a limit off. */
    app.patch("/api/ops/risk-limits", async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;

      const optionalPositive = (key: string): number | null | undefined => {
        if (!(key in b)) return undefined;
        const v = b[key];
        if (v === null) return null;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          throw new Error(`${key} must be a non-negative number, or null to disable it`);
        }
        return v;
      };

      try {
        const patch = {
          maxTotalExposureQuote: optionalPositive("maxTotalExposureQuote"),
          maxConcurrentPositions: optionalPositive("maxConcurrentPositions"),
          maxDailyLossQuote: undefined as number | null | undefined,
          dailyLossWindowHours: undefined as number | undefined,
        };
        if ("maxDailyLossQuote" in b) {
          if (b.maxDailyLossQuote !== null) {
            return reply.code(409).send({
              error: "platform daily-loss control is disabled because the bot owns realised fills; "
                + "configure the bot-side daily-loss protection instead",
            });
          }
          // Allow an old, misleading value to be explicitly cleared.
          patch.maxDailyLossQuote = null;
        }
        if ("dailyLossWindowHours" in b) {
          const v = b.dailyLossWindowHours;
          if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 720) {
            return reply.code(400).send({ error: "dailyLossWindowHours must be an integer 1..720" });
          }
          patch.dailyLossWindowHours = v;
        }
        if (
          patch.maxConcurrentPositions !== undefined &&
          patch.maxConcurrentPositions !== null &&
          !Number.isInteger(patch.maxConcurrentPositions)
        ) {
          return reply.code(400).send({ error: "maxConcurrentPositions must be a whole number" });
        }
        await liveSafety.updateRiskLimits(patch);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      return liveSafety.getRiskLimits();
    });

    /**
     * Order intents whose outcome is unknown, and the deployments they belong
     * to. This is the list an operator has to work through after a crash.
     */
    app.get("/api/ops/unresolved-intents", async () => {
      const rows = await liveSafety.listUnresolvedIntents();
      return {
        count: rows.length,
        intents: rows.map((r) => ({
          ...r,
          barTime: new Date(r.barTime).toISOString(),
          createdAt: new Date(r.createdAt).toISOString(),
          resolvedAt: r.resolvedAt === null ? null : new Date(r.resolvedAt).toISOString(),
        })),
      };
    });
  };
}
