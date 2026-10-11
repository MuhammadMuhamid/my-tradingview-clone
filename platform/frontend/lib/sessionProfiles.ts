"use client";
/**
 * The two SESSION chart types — Session volume profile and TPO — as one
 * profile per session rather than one for the latest day.
 *
 * ── Why per session ────────────────────────────────────────────────────────
 *
 * Both presentations used to filter the loaded bars down to the latest UTC
 * day and draw a single histogram at the right edge of the plot. Scroll back
 * one day and the chart type stopped meaning anything: the candles of
 * yesterday had no profile at all, so the one comparison a session profile
 * exists for — today's value area against yesterday's — could not be made.
 * TradingView draws one profile per session across everything loaded, each
 * inside its own session's span, and that is what this builds.
 *
 * ── What a session is ──────────────────────────────────────────────────────
 *
 * A UTC calendar day. Nothing in `lib` defines exchange sessions, and the
 * chart clock is UTC throughout, so a UTC day is the only session boundary
 * that is true for every instrument this pane can show. The basis notice says
 * so rather than letting a reader assume an exchange's own open.
 *
 * ── Bounded ────────────────────────────────────────────────────────────────
 *
 * A minute chart holds weeks of bars. Profiling every day of them would spend
 * most of the work on sessions far off screen, so only the most recent
 * `MAX_SESSION_PROFILES` are built. The layer clips the rest of the work: a
 * session whose span is entirely off screen paints nothing.
 */
import type { ChartProfileDecoration } from "@/lib/chartSeries";
import { PRICE_PANE_ID } from "@/lib/chartSeries";
import { PROFILE_COLORS } from "@/lib/native/profile";
import { resolutionMs, type Resolution } from "@/lib/resolution";
import type { Candle } from "@/lib/types";
import {
  computeTpoProfile, computeVolumeProfile, DEFAULT_PROFILE_SETTINGS,
} from "@/lib/volumeProfile";

/** Sessions profiled, newest first. Older loaded days draw candles only. */
export const MAX_SESSION_PROFILES = 20;

const DAY_MS = 86_400_000;

/** The nine chart-settings fields the two session presentations read. */
export interface SessionProfileSettings {
  profileRows: number;
  profileValueAreaPercent: number;
  profileAllocation: "range" | "close";
  profileSide: "left" | "right";
  profileSplit: "total" | "upDown";
  profileShowPoc: boolean;
  profileShowValueArea: boolean;
  profileWidthPercent: number;
  tpoBlockMinutes: number;
}

/**
 * Sorted bars cut into UTC-day sessions, oldest first, keeping at most the
 * `max` most recent. Each session is a contiguous slice of the input.
 */
export function utcDaySessions(
  candles: readonly Candle[], max: number = MAX_SESSION_PROFILES,
): Candle[][] {
  const sessions: Candle[][] = [];
  let current: Candle[] = [];
  let day = Number.NaN;
  for (const candle of candles) {
    const start = Math.floor(candle.openTime / DAY_MS);
    if (start !== day && current.length > 0) {
      sessions.push(current);
      current = [];
    }
    day = start;
    current.push(candle);
  }
  if (current.length > 0) sessions.push(current);
  return max > 0 && sessions.length > max ? sessions.slice(sessions.length - max) : sessions;
}

/**
 * One profile decoration per session, for either session chart type.
 *
 * Each decoration covers exactly its own session: from its first bar to the
 * first bar of the NEXT session — a real bar time, so the layer can place it —
 * and, for the latest session, to the close of its last bar. `fitToRange`
 * tells the layer to size the rows against that span rather than against the
 * whole plot, which is what keeps twenty profiles from overlapping.
 */
export function sessionProfileDecorations(
  kind: "sessionVolumeProfile" | "tpo",
  candles: readonly Candle[],
  settings: SessionProfileSettings,
  interval: Resolution,
  paneId: string,
): ChartProfileDecoration[] {
  const sessions = utcDaySessions(candles);
  if (sessions.length === 0) return [];
  const step = resolutionMs(interval);
  const tpo = kind === "tpo";
  const profileSettings = {
    ...DEFAULT_PROFILE_SETTINGS,
    rowSize: settings.profileRows,
    valueAreaPercent: settings.profileValueAreaPercent,
    allocation: settings.profileAllocation,
    ...(tpo ? { tpoBlockMinutes: settings.tpoBlockMinutes } : {}),
  };
  /*
   * One notice for every session, not one per session.
   *
   * The chart shows a chip per distinct title-and-notice pair; a bar count in
   * the notice would have printed twenty chips for twenty days.
   */
  const basisNotice = tpo
    ? `TPO count per UTC-day session from ${interval} bars; each bar contributes one opportunity to every row its range touched`
    : `UTC-day session estimates from ${interval} bars`;
  const out: ChartProfileDecoration[] = [];
  for (let s = 0; s < sessions.length; s++) {
    const session = sessions[s]!;
    const profile = tpo
      ? computeTpoProfile(session, profileSettings, interval, "chart")
      : computeVolumeProfile(session, profileSettings, interval, "chart");
    if (profile.rows.length === 0 || profile.from === null || profile.to === null) continue;
    const next = sessions[s + 1]?.[0];
    const endMs = next ? next.openTime : profile.to + step;
    out.push({
      kind: "profile",
      id: `${tpo ? "tpo" : "session-profile"}:${paneId}:${Math.floor(profile.from / DAY_MS)}`,
      paneId: PRICE_PANE_ID,
      title: tpo ? "Time Price Opportunity" : "Session Volume Profile",
      basis: profile.basis,
      sourceInterval: profile.sourceInterval,
      basisNotice,
      from: Math.floor(profile.from / 1000),
      to: Math.floor(endMs / 1000),
      rows: profile.rows,
      pocIndex: profile.pocIndex,
      valueAreaRows: profile.valueAreaRows,
      // One letter string per row, built once here rather than on every pan
      // frame from a list that holds one entry per bar per row it touched.
      ...(profile.tpoLabels ? { labels: lettersByRow(profile.tpoLabels) } : {}),
      peakVolume: profile.peakVolume,
      split: settings.profileSplit,
      showValueArea: settings.profileShowValueArea,
      showValueAreaEdges: settings.profileShowValueArea,
      showPoc: settings.profileShowPoc,
      showRange: false,
      fitToRange: true,
      side: settings.profileSide,
      widthRatio: settings.profileWidthPercent / 100,
      colors: tpo
        ? { ...PROFILE_COLORS, total: "#a855f7", valueArea: "#a855f7" }
        : { ...PROFILE_COLORS },
    });
  }
  return out;
}

/** Bracket letters folded to one string per row, first appearance order. */
export function lettersByRow(
  labels: readonly { rowIndex: number; label: string }[],
): { rowIndex: number; label: string }[] {
  const byRow = new Map<number, string>();
  for (const { rowIndex, label } of labels) {
    const previous = byRow.get(rowIndex) ?? "";
    if (!previous.includes(label)) byRow.set(rowIndex, previous + label);
  }
  return [...byRow].map(([rowIndex, label]) => ({ rowIndex, label }));
}
