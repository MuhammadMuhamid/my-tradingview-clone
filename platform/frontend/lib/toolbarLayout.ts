/**
 * The chart toolbar's hierarchy, as data.
 *
 * ── The problem this exists to fix ─────────────────────────────────────────
 *
 * The toolbar had one tier. Everything from "change the instrument" to "apply
 * the optimizer's best saved config" sat in the same undifferentiated run of
 * buttons, and which of them you could see depended on the viewport: below
 * 1280px they collapsed behind a ⋯ toggle, at or above it they all appeared at
 * once and wrapped. So a 13" laptop showed a compact bar and a 27" monitor
 * showed three ragged rows of chrome — the opposite of what more space should
 * buy, and impossible to reason about because the ordering existed only as JSX.
 *
 * Naming the tiers here makes two things possible. The component renders from
 * this registry, so a control cannot be added without deciding what tier it is
 * in; and a test can assert that the controls a trader reaches for constantly
 * are on the primary row at every desktop width, rather than asserting a
 * screenshot.
 *
 * ── The tiers ──────────────────────────────────────────────────────────────
 *
 *   context   — what am I looking at: instrument, timeframe, presentation,
 *               studies, replay. Changing any of these changes the chart.
 *   workspace — what am I doing with it: arm an alert, open the ticket, change
 *               the pane layout, synchronise panes, go fullscreen.
 *   secondary — real controls used a few times a session: history depth,
 *               read-only trading overlays, server-side automation, strategy
 *               properties, the optimizer's best config. These live behind an
 *               explicit "More" toggle at EVERY width, so the primary row is
 *               the same bar on a laptop and on a monitor.
 *
 * Nothing here is decorative and nothing was removed: every id below is a
 * control that already existed and still does something.
 */

export type ToolbarGroup = "context" | "workspace" | "secondary";

export type ToolbarControlId =
  | "symbol" | "timeframe" | "chartType" | "indicators" | "replay"
  | "alert" | "trade" | "layout" | "sync" | "fullscreen" | "more"
  | "history" | "overlays" | "automate" | "strategy" | "best" | "savedLayouts";

export interface ToolbarControl {
  id: ToolbarControlId;
  /** The accessible name the control carries, for the record — not rendered from here. */
  label: string;
  group: ToolbarGroup;
}

export const TOOLBAR_CONTROLS: readonly ToolbarControl[] = [
  // ── chart context ──
  { id: "symbol", label: "Symbol", group: "context" },
  { id: "timeframe", label: "Timeframe", group: "context" },
  { id: "chartType", label: "Chart type", group: "context" },
  { id: "indicators", label: "Indicators", group: "context" },
  { id: "replay", label: "Replay", group: "context" },

  // ── workspace and actions ──
  { id: "alert", label: "Alert", group: "workspace" },
  { id: "trade", label: "Trade", group: "workspace" },
  { id: "layout", label: "Chart layout", group: "workspace" },
  { id: "sync", label: "Sync", group: "workspace" },
  { id: "fullscreen", label: "Fullscreen", group: "workspace" },
  { id: "more", label: "More controls", group: "workspace" },
  { id: "savedLayouts", label: "Saved layouts", group: "workspace" },

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
