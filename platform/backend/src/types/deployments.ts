import type { Interval } from "./market";
import type { StrategyParams } from "./strategy";

/**
 * How a deployment's signals leave the platform.
 *
 *   `custom`   — POST to the execution bot's webhook. Real orders.
 *   `3commas`  — POST to a 3Commas bot. Real orders.
 *   `off`      — evaluate and record; send nothing, simulate nothing.
 *   `paper`    — evaluate, record, and SIMULATE the fill with the live cost
 *                model. Sends nothing. `engine/paperBroker.ts` does the
 *                simulation and cannot reach the dispatcher; the isolation is
 *                asserted in tests/paperIsolation.test.ts.
 */
export type DeliveryMode = "3commas" | "custom" | "off" | "paper";

/** Modes that reach an external system. Everything else is local-only. */
export const LIVE_DELIVERY_MODES: readonly DeliveryMode[] = ["3commas", "custom"];

export function deliversLiveOrders(mode: DeliveryMode): boolean {
  return LIVE_DELIVERY_MODES.includes(mode);
}
export type DeploymentStatus = "active" | "paused" | "stopped";

/**
 * Persisted live-runner state (deployments.runtime_state). Survives restarts so
 * a redeploy resumes the exact position/stop/streak context rather than
 * re-entering. Mirrors the Pine `var` state the live path depends on.
 */
export interface RuntimeState {
  position: "flat" | "long";
  entryPrice: number | null;
  entryBarTime: number | null;
  savedLongStop: number | null;
  savedLongTp: number | null;
  /** % trailing-stop ratchet anchor (highest candidate seen). */
  trailAnchor: number | null;
  trailArmed: boolean;
  tp1Done: boolean;
  tp2Done: boolean;
  /** choppy-filter / run-limit streak tracking */
  consecLosses: number;
  choppyUntilBarTime: number | null;
  runWinStreak: number;
  runStreakPnlPct: number;
  runPauseUntilBarTime: number | null;
  /** one-trade-per-signal latch */
  indSigArmed: boolean;
  /** bar time of the last exit to flat (cooldown) */
  lastExitBarTime: number | null;
  /** Manual/dashboard close: block re-entry until a fresh primary BUY event. */
  manualCloseReentryLock: boolean;
}

export function initialRuntimeState(): RuntimeState {
  return {
    position: "flat",
    entryPrice: null,
    entryBarTime: null,
    savedLongStop: null,
    savedLongTp: null,
    trailAnchor: null,
    trailArmed: false,
    tp1Done: false,
    tp2Done: false,
    consecLosses: 0,
    choppyUntilBarTime: null,
    runWinStreak: 0,
    runStreakPnlPct: 0,
    runPauseUntilBarTime: null,
    indSigArmed: false,
    lastExitBarTime: null,
    manualCloseReentryLock: false,
  };
}

export interface DeploymentRow {
  id: string;
  strategyId: number;
  configId: string | null;
  symbol: string;
  timeframe: Interval;
  params: StrategyParams;
  status: DeploymentStatus;
  delivery: DeliveryMode;
  webhookUrl: string | null;
  secret: string | null;
  botUuid: string | null;
  buyQuoteQty: number | null;
  runtimeState: RuntimeState;
  lastBarTime: string | null;
  createdAt: string;
  updatedAt: string;
}
