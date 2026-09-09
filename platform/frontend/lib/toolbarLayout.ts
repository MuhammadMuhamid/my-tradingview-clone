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

/**
 * ── Why the toolbar's breakpoints are not the viewport's ───────────────────
 *
 * Every collapse decision on the bar was a Tailwind viewport query, and the bar
 * is not the viewport. Open the manual-trading ticket and `ChartSidePanel`
 * stops being a phone overlay and becomes a STATIC flex sibling of the chart
 * column (`fixed … md:static`), so the toolbar's row loses the ticket's whole
 * width. At a 1280px viewport that leaves a 939px row — but `xl:` had already
 * fired, so every control's text label rendered, the row overflowed its column,
 * and the saved-layout identity was painted over the ticket's own instrument
 * header. Two live controls, one on top of the other, at a mainstream laptop
 * size. The same arithmetic explains 1024 (a 683px row) and why 1152 and 1366
 * were clean: it is not a new defect at each width, it is one comparison made
 * against the wrong number.
 *
 * The fix is to make the comparison against the width the row actually has.
 * These are the only two numbers that need to be shared between that decision
 * and the class names that express it in `ChartToolbar`.
 */

/** `w-[340px]` plus its own left border, from `ManualTradingPanel`. */
export const MANUAL_TICKET_ROW_WIDTH = 341;

/** Tailwind's `md` and `2xl`, in pixels, because the row has to do the sum itself. */
export const TOOLBAR_CLUSTER_WIDTH = 768;
/*
 * FC2R: 1536, not 1280.
 *
 * The same class of error as the ticket one described above, one level up. The
 * chart column is not the viewport either: the watchlist and the two 52px
 * rails take a fixed ~400px out of it, so a 1440px screen gives this row 1040px
 * — and at 1280 the labels had already fired. Measured on the repaired bar at
 * 1440: 1123px of content in a 1040px row, which the timeframe strip absorbed
 * by scrolling, so a laptop user saw `1m 5m 15m 1|` with the rest of their own
 * favourites clipped mid-glyph. The favourites strip is the thing a trader
 * actually aims at; the word "Indicators" beside an already-legible chart icon
 * is not. So the labels wait for a row that can hold both, and every control
 * that loses its label keeps its `title` and its `aria-label`.
 */
export const TOOLBAR_LABEL_WIDTH = 1536;

/** The viewports at which the ROW reaches those widths with the ticket open. */
export const TOOLBAR_CLUSTER_WIDTH_WITH_TICKET = TOOLBAR_CLUSTER_WIDTH + MANUAL_TICKET_ROW_WIDTH;
export const TOOLBAR_LABEL_WIDTH_WITH_TICKET = TOOLBAR_LABEL_WIDTH + MANUAL_TICKET_ROW_WIDTH;

/**
 * How wide the toolbar's own row is. Below `md` the ticket is a fixed overlay
 * rather than a flex sibling, so it takes no width out of the row.
 */
export function toolbarRowWidth(viewport: number, ticketOpen: boolean): number {
  return ticketOpen && viewport >= TOOLBAR_CLUSTER_WIDTH
    ? viewport - MANUAL_TICKET_ROW_WIDTH
    : viewport;
}

export interface ToolbarDensity {
  /** Control labels sit beside their icons instead of collapsing to them. */
  labels: boolean;
  /** The workspace-action cluster and the saved-layout identity are on the primary row. */
  clusterOnPrimaryRow: boolean;
}

/**
 * The bar's two collapse decisions, resolved against the row rather than the
 * screen. `ChartToolbar` expresses exactly this in CSS; this function is what
 * makes it assertable without a browser.
 */
export function toolbarDensity(viewport: number, ticketOpen: boolean): ToolbarDensity {
  const row = toolbarRowWidth(viewport, ticketOpen);
  return {
    labels: row >= TOOLBAR_LABEL_WIDTH,
    clusterOnPrimaryRow: row >= TOOLBAR_CLUSTER_WIDTH,
  };
}
