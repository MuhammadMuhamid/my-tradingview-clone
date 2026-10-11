/**
 * What a STORED backtest means today, said at read time.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A row records the engine that produced it (`engine_fingerprint`) and the
 * settings it ran under. Two things can make that row misleading later, and
 * neither is visible from the row alone:
 *
 *  1. The engine moved on. A run recorded before `lotDustExit` and
 *     `affordableEntries` carries a headline inflated by sub-lot dust legs and
 *     by entries the account could not pay for, and the result page called it
 *     "Reproducible — engine, data source and cost model recorded". It is
 *     reproducible only under an engine this server no longer runs; a re-run
 *     today produces different figures. (C-02)
 *  2. The request rules moved on. Runs queued before input validation existed
 *     — an initial capital of −5, −1 % commission, −50 ticks of slippage — are
 *     stored as `done`, with Net −320 %, PF ∞ and Win 100 %, and were offered
 *     Re-run and "Stress this run", both of which the server now refuses.
 *     (C-07)
 *
 * Both are judged here by the SAME rules new work is held to — the active
 * correction set from `engine/corrections.ts` and the request validators from
 * `backtestRequest.ts` — so the read can never disagree with what a re-run
 * would do. Nothing is written back: the stored row stays exactly what it was.
 *
 * Pure apart from its defaults, so it is testable without the database.
 */
import { CORRECTION_KEYS, correctionsFingerprint, type CorrectionKey } from "../engine/corrections";
import { engineDefaultParams } from "../engine/backtester";
import type { BacktestRow } from "../types/backtest";
import { paramsProblem, runSettingsProblem, sizingProblem } from "./backtestRequest";

/** How a stored run's engine relates to the one this server runs now. */
export interface EngineCurrency {
  /** The fingerprint new runs on this server are recorded with. */
  activeFingerprint: string;
  /** True when the run's correction set is exactly the active one. */
  current: boolean;
  /** Corrections the server applies now that this run did not. */
  missing: CorrectionKey[];
  /** Corrections this run applied that the server does not apply now. */
  extra: CorrectionKey[];
}

const KNOWN = new Set<string>(CORRECTION_KEYS);

/**
 * The correction keys a fingerprint names, or null when it is not one this
 * engine writes (`engine:v2-corrected:a+b+c`, `engine:legacy-baseline:…`).
 */
export function fingerprintCorrections(fingerprint: string | null | undefined): CorrectionKey[] | null {
  if (typeof fingerprint !== "string") return null;
  if (/^engine:legacy-baseline(:|$)/.test(fingerprint)) return [];
  const m = /^engine:v2-corrected:(.+)$/.exec(fingerprint);
  if (!m) return null;
  const keys = m[1]!.split("+").map((s) => s.trim()).filter(Boolean);
  // A name this engine does not know cannot be compared honestly; refuse to guess.
  if (keys.some((k) => !KNOWN.has(k))) return null;
  return keys as CorrectionKey[];
}

/**
 * The run's engine against the server's, or null when the run recorded no
 * engine it can be compared by (not finished, or older than fingerprints).
 */
export function engineCurrency(
  stored: string | null | undefined,
  active: string = correctionsFingerprint(),
): EngineCurrency | null {
  const ran = fingerprintCorrections(stored);
  const now = fingerprintCorrections(active);
  if (ran === null || now === null) return null;
  const missing = now.filter((k) => !ran.includes(k));
  const extra = ran.filter((k) => !now.includes(k));
  return { activeFingerprint: active, current: missing.length === 0 && extra.length === 0, missing, extra };
}

/**
 * The first reason this server would refuse the run's settings as a new
 * request, or null.
 *
 * `nowMs` is the clock a re-run would be judged at: what matters is whether
 * the same settings can be queued again, not whether they could have been on
 * the day they were.
 */
export function storedSettingsProblem(
  row: Pick<BacktestRow, "initialCapital" | "commissionPct" | "slippageTicks" | "holdoutFraction"
    | "startTime" | "endTime" | "params">,
  strategyKey: string | null,
  nowMs: number,
): string | null {
  return runSettingsProblem({
    initialCapital: row.initialCapital,
    commissionPct: row.commissionPct,
    slippageTicks: row.slippageTicks,
    holdoutFraction: row.holdoutFraction ?? undefined,
    startTime: row.startTime,
    endTime: row.endTime,
  }, nowMs)
    ?? paramsProblem(row.params ?? {})
    ?? sizingProblem(row.params ?? {}, row.initialCapital, strategyKey ? engineDefaultParams(strategyKey) : null);
}

/** A row as the API returns it: the stored record plus what it means today. */
export function withReadTruth(
  row: BacktestRow,
  strategyKey: string | null,
  opts: { nowMs?: number; activeFingerprint?: string } = {},
): BacktestRow {
  return {
    ...row,
    engineCurrency: engineCurrency(row.engineFingerprint, opts.activeFingerprint ?? correctionsFingerprint()),
    refusedSettings: storedSettingsProblem(row, strategyKey, opts.nowMs ?? Date.now()),
  };
}

/** Why a run cannot be deleted, as the status and sentence the route answers with, or null. */
export function deleteRefusal(
  row: Pick<BacktestRow, "status" | "stressRunId"> | null,
): { code: 404 | 409; error: string } | null {
  if (row === null) return { code: 404, error: "backtest not found" };
  if (row.status === "running") {
    return { code: 409, error: "This run is still running. It can be deleted once it has finished." };
  }
  if (row.stressRunId !== null) {
    return {
      code: 409,
      error: "This run is one window of a stress analysis, and the analysis reads it. It cannot be deleted on its own.",
    };
  }
  return null;
}
