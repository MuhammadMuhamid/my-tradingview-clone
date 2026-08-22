import type { Interval } from "./market";
import type { StrategyParams } from "./strategy";

export type DeliveryMode = "3commas" | "custom" | "off";
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
