/**
 * TradingView-style chart layouts, persisted server-side in PostgreSQL via
 * /api/layouts so they survive refreshes, browsers, and redeployments. A
 * layout snapshots the whole workspace: symbol, timeframe, history depth,
 * strategy and its params/properties.
 *
 * Legacy localStorage layouts (pre-database) are imported to the server once
 * on first load, then kept as a local backup under a `.migrated` key. Only
 * the current-layout pointer and the autosave toggle stay device-local.
 */
import { api, type ServerLayout } from "./api";
import type { Interval, StrategyParams } from "./types";
import type { StrategyProperties } from "@/components/tv/StrategySettingsModal";
import { defaultMaLines, type MaLine } from "./movingAverages";

export interface WorkspaceState {
  symbol: string;
  interval: Interval;
  bars: number;
  strategyKey: string;
  params: StrategyParams;
  properties: StrategyProperties;
  /** Which SMA/EMA lines this workspace draws. */
  movingAverages: MaLine[];
}

export interface Layout extends WorkspaceState {
  id: string;
  name: string;
  updatedAt: number;
}

const LEGACY_KEY = "srtrend.layouts.v1";
const CUR = "srtrend.currentLayout.v1";
const AUTO = "srtrend.autosave.v1";

const canStore = (): boolean => typeof window !== "undefined" && !!window.localStorage;

function fromServer(l: ServerLayout): Layout {
  return {
    id: l.id,
    name: l.name,
    symbol: l.symbol,
    interval: l.timeframe,
    bars: l.bars,
    strategyKey: l.strategyKey,
    params: l.params,
    properties: l.properties as StrategyProperties,
    // Layouts saved before MA lines existed carry an empty array; fall back to
    // the full set so an older coin layout still opens with its averages.
    movingAverages: l.movingAverages?.length ? l.movingAverages : defaultMaLines(),
    updatedAt: Date.parse(l.updatedAt),
  };
}

function toServerBody(name: string, s: WorkspaceState) {
  return {
    name,
    symbol: s.symbol,
    timeframe: s.interval,
    bars: s.bars,
    strategyKey: s.strategyKey,
    params: s.params,
    properties: s.properties,
    movingAverages: s.movingAverages,
  };
}

/** One-time import of pre-database localStorage layouts into the server. */
export async function migrateLegacyLayouts(): Promise<void> {
  if (!canStore()) return;
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const legacy = JSON.parse(raw) as Layout[];
    const existing = await api.listLayouts();
    const taken = new Set(existing.map((l) => l.name.trim().toUpperCase()));
    for (const l of legacy) {
      if (!l?.name || taken.has(l.name.trim().toUpperCase())) continue;
      await api.upsertLayout(toServerBody(l.name, l));
    }
    localStorage.setItem(`${LEGACY_KEY}.migrated`, raw);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Server unreachable — keep the legacy data and retry next load.
  }
}

/** Most recently updated first (TV's "recently used" ordering). */
export async function listLayouts(): Promise<Layout[]> {
  const rows = await api.listLayouts();
  return rows.map(fromServer);
}

export async function getLayout(id: string): Promise<Layout | null> {
  try {
    return fromServer(await api.getLayout(id));
  } catch {
    return null;
  }
}

/** Create or update by case-insensitive name (server-side upsert). */
export async function createLayout(name: string, state: WorkspaceState): Promise<Layout> {
  const layout = fromServer(
    await api.upsertLayout(toServerBody(name.trim() || "Unnamed", state))
  );
  setCurrentLayoutId(layout.id);
  return layout;
}

export async function saveLayout(id: string, state: WorkspaceState): Promise<Layout | null> {
  try {
    return fromServer(await api.updateLayout(id, {
      symbol: state.symbol,
      timeframe: state.interval,
      bars: state.bars,
      strategyKey: state.strategyKey,
      params: state.params,
      properties: state.properties,
      movingAverages: state.movingAverages,
    }));
  } catch {
    return null;
  }
}

export async function renameLayout(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  try {
    await api.updateLayout(id, { name: clean });
  } catch { /* name conflict or missing layout — keep old name */ }
}

export async function deleteLayout(id: string): Promise<void> {
  try {
    await api.deleteLayout(id);
  } catch { /* already gone */ }
  if (getCurrentLayoutId() === id && canStore()) localStorage.removeItem(CUR);
}

/**
 * Ensure every coin with a saved alert has a layout named after the coin,
 * carrying the alert's strategy settings (server-side sync).
 */
export async function syncDeploymentLayouts(): Promise<void> {
  try {
    await api.syncDeploymentLayouts();
  } catch { /* offline — layouts list still loads */ }
}

export function getCurrentLayoutId(): string | null {
  return canStore() ? localStorage.getItem(CUR) : null;
}

export function setCurrentLayoutId(id: string | null): void {
  if (!canStore()) return;
  if (id === null) localStorage.removeItem(CUR);
  else localStorage.setItem(CUR, id);
}

export function getAutosave(): boolean {
  return canStore() ? localStorage.getItem(AUTO) !== "false" : true;
}

export function setAutosave(on: boolean): void {
  if (canStore()) localStorage.setItem(AUTO, String(on));
}
