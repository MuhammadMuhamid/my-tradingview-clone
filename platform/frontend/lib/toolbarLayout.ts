/**
 * The chart toolbar's hierarchy, as data.
 *
 * ── The problem this exists to fix ─────────────────────────────────────────
 *
 * The toolbar had one tier. Everything from "change the instrument" to "apply
 * the optimizer's best saved config" sat in the same undifferentiated run of
 * buttons, and which of them you could see depended on the viewport. Naming
 * the tiers here makes two things possible: the component renders from this
 * registry, so a control cannot be added without deciding what tier it is in;
 * and a test can assert the hierarchy without a screenshot.
 *
 * ── TVP8 owner veto (OV-B): the order IS the reference's ───────────────────
 *
 * The primary row's sequence is TradingView's, measured live on 2026-09-14
 * (`TradingView-Parity-TVP8-20260913/measurements/tv-shell-live-inventory-20260914.md`):
 *
 *   symbol · compare │ interval favourites + caret │ style favourites + caret │
 *   indicators │ alert · replay │ undo · redo   …   layout · saved layout name
 *   + caret · (sync) │ quick search · settings · fullscreen · snapshot · (more)
 *   · Trade
 *
 * Sync and More are Trading Scene's own and sit inside that sequence without
 * breaking it: Sync beside the layout controls it belongs with (rendered only
 * when there is more than one pane), More as the last icon before the Trade
 * pill. Publish has no counterpart here and is not imitated.
 *
 * ── The tiers ──────────────────────────────────────────────────────────────
 *
 *   context   — what am I looking at: instrument, timeframe, presentation,
 *               studies, alert, replay, and the drawing history that edits
 *               the chart.
 *   workspace — what am I doing with it: pane layout, saved layouts, sync,
 *               the utilities, the ticket.
 *   secondary — real controls used a few times a session: history depth,
 *               read-only trading overlays, server-side automation, strategy
 *               properties, the optimizer's best config. Behind More at EVERY
 *               width, so the primary row is the same bar on a laptop and on
 *               a monitor.
 *
 * ── Why the row no longer measures itself against the panel ───────────────
 *
 * The row used to be narrowed by the watchlist panel and the manual ticket,
 * which were flex siblings of the toolbar's column, and a whole arithmetic
 * (`toolbarRowWidth`, `WIDGET_PANEL_ROW_WIDTH`, four density branches) existed
 * to keep labels from overprinting. TVP8 made the toolbar the first FULL-WIDTH
 * row of the workstation, above the rails, the chart and the panel — which is
 * where the reference has it — so the row is always the viewport minus the
 * 52px account cell, the labels are gone (every control on the reference is
 * icon-only), and the one decision left is the phone breakpoint.
 */

export type ToolbarGroup = "context" | "workspace" | "secondary";

export type ToolbarControlId =
  | "symbol" | "compare" | "timeframe" | "chartType" | "indicators"
  | "alert" | "replay" | "undo" | "redo"
  | "layout" | "savedLayouts" | "sync"
  | "commandPalette" | "chartSettings" | "fullscreen" | "snapshot" | "more" | "trade"
  | "history" | "overlays" | "automate" | "strategy" | "best";

export interface ToolbarControl {
  id: ToolbarControlId;
  /** The accessible name the control carries, for the record — not rendered from here. */
  label: string;
  group: ToolbarGroup;
}

/** In RENDER order: the primary row left → right, then the More strip. */
export const TOOLBAR_CONTROLS: readonly ToolbarControl[] = [
  // ── chart context ──
  { id: "symbol", label: "Symbol", group: "context" },
  { id: "compare", label: "Compare", group: "context" },
  { id: "timeframe", label: "Timeframe", group: "context" },
  { id: "chartType", label: "Chart style", group: "context" },
  { id: "indicators", label: "Indicators", group: "context" },
  { id: "alert", label: "Create alert", group: "context" },
  { id: "replay", label: "Bar replay", group: "context" },
  { id: "undo", label: "Undo", group: "context" },
  { id: "redo", label: "Redo", group: "context" },

  // ── workspace, right-aligned ──
  { id: "layout", label: "Chart layout", group: "workspace" },
  { id: "savedLayouts", label: "Saved layouts", group: "workspace" },
  { id: "sync", label: "Sync", group: "workspace" },
  { id: "commandPalette", label: "Quick search", group: "workspace" },
  { id: "chartSettings", label: "Chart settings", group: "workspace" },
  { id: "fullscreen", label: "Fullscreen", group: "workspace" },
  { id: "snapshot", label: "Chart image", group: "workspace" },
  { id: "more", label: "More controls", group: "workspace" },
  { id: "trade", label: "Trade", group: "workspace" },

  // ── secondary, behind More ──
  { id: "history", label: "History depth", group: "secondary" },
  { id: "overlays", label: "Trading overlays", group: "secondary" },
  { id: "automate", label: "Automate", group: "secondary" },
  { id: "strategy", label: "Strategy", group: "secondary" },
  { id: "best", label: "Best config", group: "secondary" },
] as const;

const BY_ID = new Map(TOOLBAR_CONTROLS.map((c) => [c.id, c]));

export function toolbarControl(id: ToolbarControlId): ToolbarControl {
  const found = BY_ID.get(id);
  /* istanbul ignore next — the id type makes this unreachable from callers. */
  if (!found) throw new Error(`unknown toolbar control: ${id}`);
  return found;
}

export function toolbarGroup(id: ToolbarControlId): ToolbarGroup {
  return toolbarControl(id).group;
}

export function controlsInGroup(group: ToolbarGroup): ToolbarControl[] {
  return TOOLBAR_CONTROLS.filter((c) => c.group === group);
}

/** Controls that stay on the toolbar's own row at desktop widths. */
export function primaryControls(): ToolbarControl[] {
  return TOOLBAR_CONTROLS.filter((c) => c.group !== "secondary");
}

/** Controls reached through the explicit More toggle. */
export function secondaryControls(): ToolbarControl[] {
  return controlsInGroup("secondary");
}

export function isPrimaryControl(id: ToolbarControlId): boolean {
  return toolbarGroup(id) !== "secondary";
}

/** The account cell at the top of the left-rail column; the row starts after it. */
export const TOOLBAR_ACCOUNT_CELL_WIDTH = 52;


/**
 * The controls that can leave the row for the ⋯ menu, lowest priority LAST.
 *
 * Symbol, the interval control, the chart style and ⋯ itself never leave: they
 * are what the bar is FOR, and ⋯ is the way in to everything that has left.
 */
export type OverflowControlId =
  | "compare" | "indicators" | "trade" | "chartSettings" | "snapshot" | "layout"
  | "savedLayouts" | "sync" | "alert" | "replay" | "templates" | "undo" | "redo"
  | "fullscreen" | "commandPalette";

/**
 * The viewport width from which each control is drawn on the row; below it, the
 * control is a row of the ⋯ menu instead. Never both, never neither.
 *
 * ── Why progressive, and why this order ───────────────────────────────────
 *
 * TVP8 had one decision: below 1280 the whole right-hand cluster — layout,
 * saved layout, quick search, settings, fullscreen, snapshot, Trade — left at
 * once for a second 38px row under ⋯. At 1200 the bar gave up its seven most
 * used workspace controls for room it did not need; at 768 the LEFT side still
 * did not fit, and Undo, Redo and ⋯ itself were drawn off the edge with no way
 * to reach them (and with ⋯ went Correlation, the object tree, the data window
 * and Maximize pane, whose route on a narrow screen it is). Premium at 1200
 * keeps Layout, the layout name, Settings, Snapshot and Trade and moves the
 * rest into a dropdown.
 *
 * So each control leaves on its own, lowest priority first: quick search (⌘K
 * reaches it anyway), fullscreen (⇧F), undo/redo (⌘Z), indicator templates,
 * alert and replay, the saved-layout name and sync, the layout grid, snapshot,
 * settings, Trade, indicators — and Compare at `sm`, where it always went.
 *
 * ── Where the numbers come from ───────────────────────────────────────────
 *
 * Each is the cumulative width of the row with that control and everything
 * ranked above it (`TOOLBAR_WIDTHS`, measured from the classes: a 38px icon
 * cell, a 24px caret, a 9px separator), rounded UP with slack — the row is
 * `flex-nowrap` on a page that never scrolls sideways, so a threshold that is
 * a pixel low does not produce a dense bar, it produces a clipped ⋯. The
 * saved-layout name is the row's one absorber above `sm`: it truncates, so a
 * long name or the Sync cell of a multi-pane layout costs the name's tail, not
 * a control. `tests/chartToolbar.test.ts` sweeps every width from 640 to 1440
 * against these numbers and the class literals in `toolbarDensity.ts`.
 */
export const TOOLBAR_OVERFLOW_FROM: Readonly<Record<OverflowControlId, number>> = {
  compare: 640,
  indicators: 680,
  trade: 760,
  chartSettings: 800,
  snapshot: 840,
  layout: 880,
  savedLayouts: 1000,
  sync: 1000,
  alert: 1060,
  replay: 1060,
  templates: 1120,
  undo: 1200,
  redo: 1200,
  fullscreen: 1240,
  commandPalette: 1280,
};

/**
 * What each piece of the row costs, in CSS pixels, from its classes.
 *
 * Typical content, not worst case: a seven-letter ticker, the six default
 * interval favourites, the three default style favourites, a layout called
 * "Unnamed". Beyond that the slack in `TOOLBAR_OVERFLOW_FROM` and the
 * truncating layout name absorb the difference.
 */
export const TOOLBAR_WIDTHS = {
  account: TOOLBAR_ACCOUNT_CELL_WIDTH,
  /** `pl-1` + `pr-1.5` on the row. */
  padding: 10,
  separator: 9,
  symbol: 88,
  compare: 38,
  /** 1m 5m 15m 1h 4h D, then the 24px caret. */
  timeframe: 185,
  /** Three favourite styles and the caret. */
  chartType: 138,
  /** The Indicators cell and its 24px favourites caret. */
  indicators: 62,
  templates: 38,
  alert: 38,
  replay: 38,
  undo: 38,
  redo: 38,
  layout: 38,
  /** `Unnamed` and the menu caret; the cloud only appears on hover or drift. */
  savedLayouts: 92,
  sync: 38,
  commandPalette: 38,
  chartSettings: 38,
  fullscreen: 38,
  snapshot: 38,
  more: 38,
  /** The pill and its `ml-1.5`. */
  trade: 67,
} as const;

/** Which controls the row draws at a viewport width, and which are in ⋯. */
export function toolbarPlacement(viewport: number): {
  row: OverflowControlId[]; menu: OverflowControlId[];
} {
  const ids = Object.keys(TOOLBAR_OVERFLOW_FROM) as OverflowControlId[];
  return {
    row: ids.filter((id) => viewport >= TOOLBAR_OVERFLOW_FROM[id]),
    menu: ids.filter((id) => viewport < TOOLBAR_OVERFLOW_FROM[id]),
  };
}

/**
 * The row's width at a viewport, from `TOOLBAR_WIDTHS` and the placement — the
 * figure the sweep in `tests/chartToolbar.test.ts` holds under the viewport.
 *
 * Separators follow `TOOLBAR_SEPARATOR_TIERS`: each is drawn only while both of
 * its neighbours are on the row.
 */
export function toolbarRowWidth(viewport: number, options: { panes?: number } = {}): number {
  const w = TOOLBAR_WIDTHS;
  const on = new Set(toolbarPlacement(viewport).row);
  if ((options.panes ?? 1) < 2) on.delete("sync");
  let total = w.account + w.padding + w.symbol + w.timeframe + w.chartType + w.more;
  for (const id of on) total += w[id];
  // compare │ interval │ style │ indicators
  if (on.has("compare")) total += 3 * w.separator;
  if (on.has("alert")) total += w.separator;
  if (on.has("undo")) total += w.separator;
  if (on.has("layout")) total += w.separator;
  return total;
}
