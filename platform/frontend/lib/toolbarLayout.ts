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

/** Tailwind's `md`, in pixels: below it the workspace cluster moves into the More strip. */
export const TOOLBAR_CLUSTER_WIDTH = 768;

export interface ToolbarDensity {
  /** The workspace-action cluster, the saved-layout identity and Trade are on the primary row. */
  clusterOnPrimaryRow: boolean;
}

/**
 * The bar's one collapse decision. The row is the viewport minus the account
 * cell at every width, so this is a plain viewport query and
 * `toolbarDensityClasses` in `components/tv/toolbarDensity.ts` is the same
 * rule as a Tailwind literal.
 */
export function toolbarDensity(viewport: number): ToolbarDensity {
  return { clusterOnPrimaryRow: viewport >= TOOLBAR_CLUSTER_WIDTH };
}
