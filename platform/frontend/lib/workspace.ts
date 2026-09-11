/**
 * The chart workspace: one to sixteen first-class panes and the state that
 * belongs to the workspace rather than to any one of them.
 *
 * ── What replaced what ─────────────────────────────────────────────────────
 *
 * The workspace used to be `splitOpen: boolean` plus `splitInterval`. A pane
 * was identified by the literal `1` or `2`, the second one was a different
 * component with fewer capabilities than the first, and every rule about which
 * chart an action applied to was written inline in a 1,795-line page.
 *
 * Here a pane is a record with an id, and everything that differs per chart is
 * a field on it. The transitions are pure functions so that "changing the
 * active pane must not silently retarget an armed order" and "a synchronised
 * symbol change reaches every applicable pane exactly once" are properties a
 * test can assert, instead of behaviour that only exists while a component is
 * mounted.
 *
 * ── Per-pane versus workspace-wide ─────────────────────────────────────────
 *
 * PER-PANE (in `PaneState`, persisted): symbol, interval, presentation type,
 * history depth, moving-average selection. PER-PANE but derived at runtime and
 * therefore not stored here: loaded candles, applied Pine studies (each pane's
 * `useIndicators` owns its own scoped storage), indicator sub-panes, the
 * visible range, and the pane's chart instance.
 *
 * WORKSPACE-WIDE (on `ChartWorkspace`): the layout preset, which pane is
 * active, and which pane is maximised. Deliberately NOT here, because they are
 * genuinely global and duplicating them per pane would be a lie: the sync
 * settings (`lib/paneSync`), the replay session, the strategy tester's
 * strategy/params/properties, and the drawing store — drawings are canonically
 * keyed by symbol, so two panes on one instrument share them by construction.
 */
import {
  DEFAULT_PRESET_ID, defaultPresetFor, MAX_PANES, presetOrDefault,
  type LayoutPreset,
} from "./layoutPresets";
import { isChartType, type ChartType } from "./chartType";
import { defaultMaLines, type MaLine, type MaType } from "./movingAverages";
import type { SyncOptions } from "./paneSync";
import { isResolution, type Resolution } from "./resolution";
import {
  isDefaultPriceScale, normalizePriceScale, resetPriceScale, type PriceScaleState,
} from "./priceScale";
import { canonicalizeLegacySpotSymbol } from "./instrument";

/** Stable across layout changes, maximise, and reloads. */
export type PaneId = string;

/** Everything one chart pane owns and persists. */
export interface PaneState {
  id: PaneId;
  symbol: string;
  interval: Resolution;
  chartType: ChartType;
  /** History depth, in bars. */
  bars: number;
  /** Which SMA/EMA lines this pane draws. Copied, never shared. */
  maLines: MaLine[];
  /**
   * A second instrument this pane compares against, or null.
   *
   * Per PANE rather than per workspace: "compare SOL to BTC on this chart" is
   * a property of the chart it is on, and a four-pane layout comparing four
   * different things against four different benchmarks is an ordinary way to
   * use one. Absent on a pane restored from an older record, which is why
   * every reader treats it as optional rather than required.
   */
  compare?: PaneCompare | null;
  /**
   * How this pane's price axis reads, and whether it is fitting itself.
   *
   * Per pane and PERSISTED, which it was not: the scale lived in a record
   * beside the workspace, so a chart deliberately put on a logarithmic axis
   * came back linear after a reload — and a saved layout, which is supposed to
   * be "the way I look at this", did not carry the way the axis was read.
   *
   * Absent on a pane restored from an older record, which is why every reader
   * treats it as optional and defaults it.
   */
  priceScale?: PriceScaleState;
}

/** What a pane is comparing against, and how it is drawing the comparison. */
export interface PaneCompare {
  /** The second instrument, as a stored ticker. */
  symbol: string;
  /**
   * `percent` overlays both series rebased to 0 % on the price pane;
   * everything else is a statistic on its own scale and gets its own pane.
   *
   * `ratio` and `zspread` are the pair surfaces: the price of one instrument
   * in units of the other, and how unusual that ratio currently is against its
   * own recent history.
   */
  mode: "percent" | "correlation" | "beta" | "ratio" | "zspread";
  /** Window for the rolling statistics. Unused by `percent` and `ratio`. */
  length: number;
}

export const DEFAULT_COMPARE_LENGTH = 60;

export const COMPARE_MODES = [
  "percent", "correlation", "beta", "ratio", "zspread",
] as const;

export const isCompareMode = (v: unknown): v is PaneCompare["mode"] =>
  (COMPARE_MODES as readonly unknown[]).includes(v);

export interface ChartWorkspace {
  version: 2;
  presetId: string;
  /** In preset-cell order. `panes.length` always equals the preset's count. */
  panes: PaneState[];
  activePaneId: PaneId;
  /** When set, only this pane is rendered; the rest keep their state. */
  maximizedPaneId: PaneId | null;
}

/** What a brand-new pane starts from when nothing else says otherwise. */
export interface PaneSeed {
  symbol: string;
  interval: Resolution;
  chartType?: ChartType;
  bars?: number;
  maLines?: MaLine[];
}

export const WORKSPACE_STORAGE_KEY = "tv.workspace.v2";
/** The pre-workspace split preference. Read for migration; never written. */
export const LEGACY_SPLIT_KEY = "tv.split";

const DEFAULT_BARS = 10000;

/**
 * Pane ids are `p<n>`, lowest free n.
 *
 * Deterministic rather than random so a test can name the pane it means, and
 * so a persisted workspace round-trips to the same ids it was saved with.
 */
export function nextPaneId(panes: readonly PaneState[]): PaneId {
  const taken = new Set(panes.map((p) => p.id));
  for (let n = 1; ; n++) {
    const id = `p${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A deep copy of the MA selection, so no two panes share one array. */
const copyMaLines = (lines: readonly MaLine[]): MaLine[] => lines.map((l) => ({ ...l }));

export function createPane(id: PaneId, seed: PaneSeed): PaneState {
  return {
    id,
    symbol: seed.symbol,
    interval: seed.interval,
    chartType: seed.chartType ?? "candles",
    bars: seed.bars ?? DEFAULT_BARS,
    maLines: copyMaLines(seed.maLines ?? defaultMaLines()),
  };
}

/**
 * A new pane with the same view as `source`.
 *
 * The MA array is copied rather than referenced. Sharing it would make hiding
 * a line in one pane hide it in another the moment anything mutated in place —
 * the exact class of accident a per-pane model exists to prevent.
 */
export function clonePane(source: PaneState, id: PaneId): PaneState {
  return { ...source, id, maLines: copyMaLines(source.maLines) };
}

export function createWorkspace(seed: PaneSeed, presetId = DEFAULT_PRESET_ID): ChartWorkspace {
  const preset = presetOrDefault(presetId);
  const panes: PaneState[] = [];
  for (let i = 0; i < preset.panes; i++) {
    panes.push(i === 0 ? createPane("p1", seed) : clonePane(panes[0]!, nextPaneId(panes)));
  }
  return {
    version: 2,
    presetId: preset.id,
    panes,
    activePaneId: panes[0]!.id,
    maximizedPaneId: null,
  };
}

export function paneById(ws: ChartWorkspace, id: PaneId): PaneState | null {
  return ws.panes.find((p) => p.id === id) ?? null;
}

/** The focused pane. Never null: the workspace always has at least one pane. */
export function activePane(ws: ChartWorkspace): PaneState {
  return paneById(ws, ws.activePaneId) ?? ws.panes[0]!;
}

export function workspacePreset(ws: ChartWorkspace): LayoutPreset {
  return presetOrDefault(ws.presetId);
}

/** The panes actually rendered right now — one when a pane is maximised. */
export function visiblePanes(ws: ChartWorkspace): PaneState[] {
  if (ws.maximizedPaneId === null) return ws.panes;
  const one = paneById(ws, ws.maximizedPaneId);
  return one ? [one] : ws.panes;
}

/**
 * Move to a different layout, keeping as much as possible.
 *
 * Surviving panes keep their id and their entire state. Growing clones the
 * active pane, which is what a user asking for another chart means by it.
 * Shrinking drops from the end; if that removed the active pane, focus falls
 * to the first survivor rather than to nothing.
 */
export function setPreset(ws: ChartWorkspace, presetId: string): ChartWorkspace {
  const preset = presetOrDefault(presetId);
  const panes = ws.panes.slice(0, preset.panes);
  const template = paneById(ws, ws.activePaneId) ?? ws.panes[0]!;
  while (panes.length < preset.panes) {
    panes.push(clonePane(template, nextPaneId(panes)));
  }
  const activePaneId = panes.some((p) => p.id === ws.activePaneId)
    ? ws.activePaneId : panes[0]!.id;
  const maximizedPaneId = ws.maximizedPaneId !== null
    && panes.some((p) => p.id === ws.maximizedPaneId) ? ws.maximizedPaneId : null;
  return { ...ws, presetId: preset.id, panes, activePaneId, maximizedPaneId };
}

/**
 * Close one pane.
 *
 * The layout drops to the default shape for what is left, every surviving pane
 * keeps its id and its state, and NOTHING belonging to the closed pane's
 * instrument is deleted: its drawings are stored per symbol and its studies
 * under its own scope, both of which outlive the view. Closing the last pane
 * is refused — a workspace with no charts is not a state this product has.
 */
export function removePane(ws: ChartWorkspace, id: PaneId): ChartWorkspace {
  if (ws.panes.length <= 1 || !ws.panes.some((p) => p.id === id)) return ws;
  const panes = ws.panes.filter((p) => p.id !== id);
  return {
    ...ws,
    presetId: defaultPresetFor(panes.length).id,
    panes,
    activePaneId: panes.some((p) => p.id === ws.activePaneId)
      ? ws.activePaneId : panes[0]!.id,
    maximizedPaneId: ws.maximizedPaneId !== null
      && panes.some((p) => p.id === ws.maximizedPaneId) ? ws.maximizedPaneId : null,
  };
}

/** The default preset for a pane count — what a "4 charts" button means. */
export function setPaneCount(ws: ChartWorkspace, count: number): ChartWorkspace {
  const clamped = Math.max(1, Math.min(MAX_PANES, Math.floor(count)));
  return setPreset(ws, defaultPresetFor(clamped).id);
}

/**
 * Focus a pane.
 *
 * This is the ONLY thing it does. It does not move an order ticket, cancel
 * anything, or change any pane's symbol — see `lib/tradingTarget` for the rule
 * that keeps an armed ticket on the instrument it was staged for.
 */
export function setActivePane(ws: ChartWorkspace, id: PaneId): ChartWorkspace {
  if (!ws.panes.some((p) => p.id === id) || ws.activePaneId === id) return ws;
  return { ...ws, activePaneId: id };
}

export function updatePane(
  ws: ChartWorkspace, id: PaneId, patch: Partial<Omit<PaneState, "id">>
): ChartWorkspace {
  if (!ws.panes.some((p) => p.id === id)) return ws;
  return {
    ...ws,
    panes: ws.panes.map((p) => (p.id === id
      ? { ...p, ...patch, ...(patch.maLines ? { maLines: copyMaLines(patch.maLines) } : {}) }
      : p)),
  };
}

/** Toggle one MA line on one pane. Only that pane's array is rebuilt. */
export function togglePaneMa(
  ws: ChartWorkspace, id: PaneId, type: MaType, length: number
): ChartWorkspace {
  const pane = paneById(ws, id);
  if (!pane) return ws;
  return updatePane(ws, id, {
    maLines: pane.maLines.map((l) =>
      l.type === type && l.length === length ? { ...l, visible: !l.visible } : l),
  });
}

export function setPaneMaVisibility(
  ws: ChartWorkspace, id: PaneId, visible: boolean
): ChartWorkspace {
  const pane = paneById(ws, id);
  if (!pane) return ws;
  return updatePane(ws, id, { maLines: pane.maLines.map((l) => ({ ...l, visible })) });
}

/**
 * Maximise one pane.
 *
 * The layout, every other pane's state, and the pane's own identity all
 * survive: only `maximizedPaneId` changes, so restoring is one field back.
 * A maximised pane is also the focused one — it is the only one on screen.
 */
export function maximizePane(ws: ChartWorkspace, id: PaneId): ChartWorkspace {
  if (!ws.panes.some((p) => p.id === id)) return ws;
  return { ...ws, maximizedPaneId: id, activePaneId: id };
}

export function restoreLayout(ws: ChartWorkspace): ChartWorkspace {
  return ws.maximizedPaneId === null ? ws : { ...ws, maximizedPaneId: null };
}

export function toggleMaximize(ws: ChartWorkspace, id: PaneId): ChartWorkspace {
  return ws.maximizedPaneId === id ? restoreLayout(ws) : maximizePane(ws, id);
}

// ── synchronisation ────────────────────────────────────────────────────────

/** Which sync toggles are field-propagating, as opposed to view-mirroring. */
type SyncField = "symbol" | "interval";

/**
 * The panes a change originating in `originId` also applies to.
 *
 * A plain list, computed once. The old design mirrored a value from pane 1 to
 * pane 2 through props and back through callbacks, which is how a two-pane
 * mirror becomes an N-pane feedback loop. Here the fan-out is a single state
 * transition: there is no second event to feed back, so no loop can form, and
 * "reaches applicable panes exactly once" is true by construction.
 *
 * Never includes the origin.
 */
export function syncTargets(
  ws: ChartWorkspace, originId: PaneId, sync: SyncOptions, field: SyncField
): PaneId[] {
  if (!sync[field]) return [];
  return ws.panes.filter((p) => p.id !== originId).map((p) => p.id);
}

export function applyPaneSymbol(
  ws: ChartWorkspace, originId: PaneId, symbol: string, sync: SyncOptions
): ChartWorkspace {
  if (!ws.panes.some((p) => p.id === originId)) return ws;
  const targets = new Set([originId, ...syncTargets(ws, originId, sync, "symbol")]);
  return { ...ws, panes: ws.panes.map((p) => (targets.has(p.id) ? { ...p, symbol } : p)) };
}

/**
 * Set or clear what one pane compares against.
 *
 * Never synced to other panes, unlike symbol and interval. "Compare SOL to
 * BTC" is a statement about THIS chart, and pushing it across a synced layout
 * would silently put the same second instrument on four charts the user was
 * using to look at four different things.
 */
/**
 * Set one pane's price scale.
 *
 * Never synced, like `compare` and for the same reason: reading a chart on a
 * logarithmic or percent axis is a statement about that chart. It is also the
 * one pane field a user changes by DRAGGING — the axis drag turns auto-fit off
 * — so it is written far more often than the others, and the default is
 * removed rather than stored so an untouched pane carries nothing.
 */
export function setPanePriceScale(
  ws: ChartWorkspace, id: PaneId, priceScale: PriceScaleState
): ChartWorkspace {
  if (!ws.panes.some((p) => p.id === id)) return ws;
  return {
    ...ws,
    panes: ws.panes.map((p) => {
      if (p.id !== id) return p;
      if (isDefaultPriceScale(priceScale)) {
        const { priceScale: _removed, ...rest } = p;
        return rest;
      }
      return { ...p, priceScale };
    }),
  };
}

export function panePriceScale(ws: ChartWorkspace, id: PaneId): PriceScaleState {
  return ws.panes.find((p) => p.id === id)?.priceScale ?? resetPriceScale();
}

export function setPaneCompare(
  ws: ChartWorkspace, id: PaneId, compare: PaneCompare | null
): ChartWorkspace {
  if (!ws.panes.some((p) => p.id === id)) return ws;
  return {
    ...ws,
    panes: ws.panes.map((p) => {
      if (p.id !== id) return p;
      if (!compare) {
        // Removed entirely rather than left as null, so a stored workspace
        // does not carry a field whose only value is "there isn't one".
        const { compare: _removed, ...rest } = p;
        return rest;
      }
      return {
        ...p,
        compare: {
          symbol: compare.symbol.trim().toUpperCase(),
          mode: compare.mode,
          length: Math.max(2, Math.min(1000, Math.round(compare.length))),
        },
      };
    }),
  };
}

export function applyPaneInterval(
  ws: ChartWorkspace, originId: PaneId, interval: Resolution, sync: SyncOptions
): ChartWorkspace {
  if (!ws.panes.some((p) => p.id === originId)) return ws;
  const targets = new Set([originId, ...syncTargets(ws, originId, sync, "interval")]);
  return { ...ws, panes: ws.panes.map((p) => (targets.has(p.id) ? { ...p, interval } : p)) };
}

/** History depth is a workspace-wide reading choice, applied to every pane. */
export function setWorkspaceBars(ws: ChartWorkspace, bars: number): ChartWorkspace {
  return { ...ws, panes: ws.panes.map((p) => ({ ...p, bars })) };
}

/** The distinct upstream feeds this workspace needs — its real resource cost. */
export function feedKeys(ws: ChartWorkspace): string[] {
  return [...new Set(ws.panes.map((p) => `${p.symbol.toUpperCase()}|${p.interval}`))];
}

// ── persistence ────────────────────────────────────────────────────────────

function validCompare(value: unknown): PaneCompare | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.symbol !== "string" || raw.symbol.trim() === "") return null;
  if (!isCompareMode(raw.mode)) return null;
  const length = typeof raw.length === "number" && Number.isFinite(raw.length)
    ? Math.max(2, Math.min(1000, Math.round(raw.length)))
    : DEFAULT_COMPARE_LENGTH;
  const symbol = canonicalizeLegacySpotSymbol(raw.symbol) ?? raw.symbol.trim().toUpperCase();
  return { symbol, mode: raw.mode, length };
}

function validPane(value: unknown): PaneState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (typeof raw.symbol !== "string" || raw.symbol === "") return null;
  if (!isResolution(raw.interval)) return null;
  if (!isChartType(raw.chartType)) return null;
  if (typeof raw.bars !== "number" || !Number.isFinite(raw.bars) || raw.bars <= 0) return null;
  const lines = Array.isArray(raw.maLines) ? raw.maLines : null;
  if (!lines) return null;
  const maLines: MaLine[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") return null;
    const l = line as Record<string, unknown>;
    if (l.type !== "sma" && l.type !== "ema") return null;
    if (typeof l.length !== "number" || !Number.isFinite(l.length)) return null;
    if (typeof l.visible !== "boolean") return null;
    maLines.push({ type: l.type, length: l.length, visible: l.visible });
  }
  /*
   * An unreadable `compare` is dropped rather than failing the whole pane.
   *
   * Deliberately different from every field above, which are all-or-nothing:
   * those describe WHAT chart this is, and a pane with a corrupt symbol is not
   * recoverable. A comparison is a decoration on a chart that is otherwise
   * fine, and losing the user's whole workspace over one is the wrong trade.
   */
  const compare = validCompare(raw.compare);
  /*
   * Same trade as the comparison above: a corrupt scale is a decoration on a
   * chart that is otherwise fine, so it degrades to the default rather than
   * discarding the pane — and with it, because `parseWorkspace` is
   * all-or-nothing, the user's whole layout.
   */
  const priceScale = raw.priceScale === undefined
    ? null : normalizePriceScale(raw.priceScale);

  return {
    id: raw.id, symbol: canonicalizeLegacySpotSymbol(raw.symbol) ?? raw.symbol.trim().toUpperCase(), interval: raw.interval,
    chartType: raw.chartType, bars: raw.bars, maLines,
    ...(compare ? { compare } : {}),
    ...(priceScale && !isDefaultPriceScale(priceScale) ? { priceScale } : {}),
  };
}

/**
 * A stored workspace, or `null` if anything about it is wrong.
 *
 * Deliberately all-or-nothing. A workspace half-restored from a damaged record
 * is worse than a clean single pane: the user cannot tell which parts of what
 * they are looking at are theirs.
 */
export function parseWorkspace(raw: unknown): ChartWorkspace | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 2) return null;
  if (typeof value.presetId !== "string") return null;
  const preset = presetOrDefault(value.presetId);
  if (preset.id !== value.presetId) return null;
  if (!Array.isArray(value.panes) || value.panes.length !== preset.panes) return null;
  const panes: PaneState[] = [];
  for (const entry of value.panes) {
    const pane = validPane(entry);
    if (!pane || panes.some((p) => p.id === pane.id)) return null;
    panes.push(pane);
  }
  if (typeof value.activePaneId !== "string") return null;
  if (!panes.some((p) => p.id === value.activePaneId)) return null;
  const maximized = value.maximizedPaneId ?? null;
  if (maximized !== null
    && (typeof maximized !== "string" || !panes.some((p) => p.id === maximized))) return null;
  return {
    version: 2, presetId: preset.id, panes,
    activePaneId: value.activePaneId, maximizedPaneId: maximized as PaneId | null,
  };
}

/** The legacy `tv.split` record, if it is one. */
function parseLegacySplit(raw: unknown): { open: boolean; interval: Resolution | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const open = value.open === true;
  return { open, interval: isResolution(value.interval) ? value.interval : null };
}

export interface WorkspaceRestore {
  workspace: ChartWorkspace;
  /** How the workspace was obtained, for the caller's migration bookkeeping. */
  source: "stored" | "legacy-split" | "default";
}

/**
 * Restore the workspace from what is on disk.
 *
 * Order matters and is the migration contract:
 *
 *   a valid v2 record            → used as-is
 *   a v2 record that is damaged  → a safe single pane, and the damaged record
 *                                  is NOT treated as a split preference
 *   no v2 record, legacy split   → one or two panes matching what the legacy
 *                                  boolean meant, second pane on its timeframe
 *   nothing at all               → a single pane on the seed
 *
 * Pure, so the whole table above is testable without a browser.
 */
export function restoreWorkspace(input: {
  stored: unknown;
  legacySplit: unknown;
  seed: PaneSeed;
}): WorkspaceRestore {
  if (input.stored !== null && input.stored !== undefined) {
    const parsed = parseWorkspace(input.stored);
    if (parsed) return { workspace: parsed, source: "stored" };
    return { workspace: createWorkspace(input.seed), source: "default" };
  }
  const legacy = parseLegacySplit(input.legacySplit);
  if (legacy?.open) {
    const two = setPreset(createWorkspace(input.seed), "2-cols");
    const second = two.panes[1]!;
    return {
      workspace: updatePane(two, second.id, { interval: legacy.interval ?? second.interval }),
      source: "legacy-split",
    };
  }
  if (legacy) return { workspace: createWorkspace(input.seed), source: "legacy-split" };
  return { workspace: createWorkspace(input.seed), source: "default" };
}

/**
 * Parsed storage, distinguishing "absent" from "present but unreadable".
 *
 * A record that is there and damaged returns the raw string, which
 * `parseWorkspace` rejects — so it lands on the safe single pane rather than
 * falling through to the legacy split key and restoring a layout the stored
 * workspace had already replaced.
 */
const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
};

/**
 * Read the workspace from `localStorage`, migrating the legacy split key.
 *
 * The legacy value is copied to `tv.split.migrated` before it is removed, in
 * the same shape `lib/layouts` uses for its own retired key: nothing is
 * destroyed until the replacement has been written successfully.
 */
export function loadWorkspace(seed: PaneSeed): ChartWorkspace {
  if (typeof window === "undefined") return createWorkspace(seed);
  let storedRaw: string | null = null;
  let legacyRaw: string | null = null;
  try {
    storedRaw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    legacyRaw = window.localStorage.getItem(LEGACY_SPLIT_KEY);
  } catch {
    return createWorkspace(seed);
  }
  const { workspace, source } = restoreWorkspace({
    stored: parseJson(storedRaw), legacySplit: parseJson(legacyRaw), seed,
  });
  if (source !== "stored" && legacyRaw !== null) {
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
      window.localStorage.setItem(`${LEGACY_SPLIT_KEY}.migrated`, legacyRaw);
      window.localStorage.removeItem(LEGACY_SPLIT_KEY);
    } catch { /* quota — the workspace still works, migration retries next load */ }
  }
  return workspace;
}

export function saveWorkspace(ws: ChartWorkspace): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
  } catch { /* quota — the layout is a preference, not state an order depends on */ }
}
