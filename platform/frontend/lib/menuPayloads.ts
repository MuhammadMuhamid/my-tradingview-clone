/**
 * What each right-click offers, and what it refuses to offer.
 *
 * ── Why these are functions and not JSX ────────────────────────────────────
 *
 * Because most of what a menu says is a DECISION, not a layout: whether "Add
 * alert at price" is available at all during a Replay, whether "Move up" means
 * anything for the topmost study, whether the price axis is currently on Auto.
 * Each of those is a rule about the product, and each is the sort of rule that
 * quietly rots inside a component. Here they are pure, exhaustive, and tested.
 *
 * ── The one rule every payload holds ───────────────────────────────────────
 *
 * An action that cannot be taken is DISABLED with a reason, never hidden. A
 * menu whose items appear and disappear teaches nobody where anything is, and
 * a greyed item with no explanation is a mystery. Replay is the sharpest case:
 * arming a live alert or staging an order from a replayed bar would be acting
 * on a price that is not the market, so those items are present, off, and say
 * why.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * "Invert scale". TradingView has it; this product has no use for it, and a
 * chart control whose only justification is that another product has one is
 * how a menu becomes forty items long.
 */
import type { MenuEntry } from "./contextMenu";

/** Shown on a disabled item so a greyed control is not a mystery. */
const REPLAY_REASON = "Not while Replay is running — the price shown is not the market";
const LOCKED_REASON = "This drawing is locked";

export interface ChartMenuContext {
  /** The price under the pointer, or null off the price scale. */
  price: number | null;
  replayActive: boolean;
  /** The price scale is on automatic fit. */
  autoScale: boolean;
  /** The price scale is logarithmic. */
  logScale: boolean;
  /** Any drawings exist on this instrument. */
  hasDrawings: boolean;
  drawingsHidden: boolean;
  drawingsLocked: boolean;
  /** Manual trading is available at all on this installation. */
  tradingEnabled: boolean;
}

export const CHART_MENU_IDS = [
  "copy-price", "add-alert", "trade-at-price",
  "reset-view", "toggle-auto", "toggle-log",
  "toggle-drawings-hidden", "toggle-drawings-locked",
  "indicators", "chart-settings",
] as const;
export type ChartMenuId = (typeof CHART_MENU_IDS)[number];

/**
 * The chart's own menu.
 *
 * `trade-at-price` PREFILLS a ticket; it never submits. That is the alert /
 * automation boundary this product holds everywhere, and a context menu is
 * exactly the surface where a one-click order would be easiest to add and
 * worst to have.
 */
export function chartMenu(ctx: ChartMenuContext): MenuEntry[] {
  const hasPrice = ctx.price !== null && Number.isFinite(ctx.price);
  const noPrice = "Right-click on the chart to pick a price";
  return [
    {
      id: "copy-price", label: "Copy price",
      disabled: !hasPrice, disabledReason: noPrice,
    },
    {
      id: "add-alert", label: "Add alert at this price",
      disabled: !hasPrice || ctx.replayActive,
      disabledReason: ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    {
      id: "trade-at-price", label: "Prepare an order at this price",
      hint: "fills the ticket",
      disabled: !hasPrice || ctx.replayActive || !ctx.tradingEnabled,
      disabledReason: !ctx.tradingEnabled
        ? "Manual trading is not enabled on this installation"
        : ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    { id: "sep-view", separator: true },
    { id: "reset-view", label: "Reset view" },
    { id: "toggle-auto", label: "Auto scale", checked: ctx.autoScale },
    { id: "toggle-log", label: "Logarithmic scale", checked: ctx.logScale },
    { id: "sep-drawings", separator: true },
    {
      id: "toggle-drawings-hidden", label: "Hide drawings",
      checked: ctx.drawingsHidden,
      disabled: !ctx.hasDrawings, disabledReason: "There are no drawings on this instrument",
    },
    {
      id: "toggle-drawings-locked", label: "Lock drawings",
      checked: ctx.drawingsLocked,
      disabled: !ctx.hasDrawings, disabledReason: "There are no drawings on this instrument",
    },
    { id: "sep-studies", separator: true },
    { id: "indicators", label: "Indicators…", hint: "I" },
    { id: "chart-settings", label: "Chart settings…" },
  ];
}

export interface DrawingMenuContext {
  locked: boolean;
  hidden: boolean;
  /** The drawing is a single horizontal level an alert can be armed on. */
  alertable: boolean;
  replayActive: boolean;
  /** Rendering order can be changed safely for this drawing. */
  canReorder: boolean;
}

export const DRAWING_MENU_IDS = [
  "settings", "clone", "copy", "toggle-lock", "toggle-hidden",
  "add-alert", "bring-front", "send-back", "remove",
] as const;
export type DrawingMenuId = (typeof DRAWING_MENU_IDS)[number];

export function drawingMenu(ctx: DrawingMenuContext): MenuEntry[] {
  return [
    { id: "settings", label: "Settings…" },
    {
      id: "clone", label: "Duplicate", hint: "⌘D",
      // Cloning a locked drawing is fine — the copy is unlocked — but cloning
      // is an edit of the LIST, so it follows the same rule as the rest.
      disabled: ctx.locked, disabledReason: LOCKED_REASON,
    },
    { id: "copy", label: "Copy", hint: "⌘C" },
    { id: "sep-state", separator: true },
    { id: "toggle-lock", label: "Lock", checked: ctx.locked, hint: "L" },
    { id: "toggle-hidden", label: "Hide", checked: ctx.hidden, hint: "J" },
    {
      id: "add-alert", label: "Add alert on this level",
      disabled: !ctx.alertable || ctx.replayActive,
      disabledReason: ctx.replayActive
        ? REPLAY_REASON
        : "Only a horizontal level can carry a price alert",
    },
    { id: "sep-order", separator: true },
    {
      id: "bring-front", label: "Bring to front",
      disabled: !ctx.canReorder,
      disabledReason: "Rendering order is not adjustable for this drawing",
    },
    {
      id: "send-back", label: "Send to back",
      disabled: !ctx.canReorder,
      disabledReason: "Rendering order is not adjustable for this drawing",
    },
    { id: "sep-remove", separator: true },
    {
      id: "remove", label: "Remove", hint: "Del", destructive: true,
      disabled: ctx.locked, disabledReason: LOCKED_REASON,
    },
  ];
}

export interface StudyMenuContext {
  visible: boolean;
  first: boolean;
  last: boolean;
  /** Pine studies have source to open; built-ins do not. */
  hasSource: boolean;
}

export const STUDY_MENU_IDS = [
  "settings", "toggle-visible", "move-up", "move-down", "open-source", "remove",
] as const;
export type StudyMenuId = (typeof STUDY_MENU_IDS)[number];

export function studyMenu(ctx: StudyMenuContext): MenuEntry[] {
  return [
    { id: "settings", label: "Settings…" },
    { id: "toggle-visible", label: "Visible", checked: ctx.visible },
    { id: "sep-order", separator: true },
    {
      id: "move-up", label: "Move up",
      disabled: ctx.first, disabledReason: "Already first",
    },
    {
      id: "move-down", label: "Move down",
      disabled: ctx.last, disabledReason: "Already last",
    },
    { id: "sep-source", separator: true },
    {
      id: "open-source", label: "Open source in the Pine Editor",
      // A built-in has no Pine source to open. Offering it and then doing
      // nothing would be worse than saying so.
      disabled: !ctx.hasSource,
      disabledReason: "A built-in study has no Pine source",
    },
    { id: "sep-remove", separator: true },
    { id: "remove", label: "Remove", destructive: true },
  ];
}

export interface AxisMenuContext {
  autoScale: boolean;
  logScale: boolean;
}

export const AXIS_MENU_IDS = ["toggle-auto", "toggle-log", "reset"] as const;
export type AxisMenuId = (typeof AXIS_MENU_IDS)[number];

export function priceAxisMenu(ctx: AxisMenuContext): MenuEntry[] {
  return [
    { id: "toggle-auto", label: "Auto scale", checked: ctx.autoScale },
    { id: "toggle-log", label: "Logarithmic scale", checked: ctx.logScale },
    { id: "sep", separator: true },
    { id: "reset", label: "Reset scale" },
  ];
}

export interface WatchlistMenuContext {
  symbol: string;
  replayActive: boolean;
  /** The workspace can open another pane without exceeding its maximum. */
  canOpenNewPane: boolean;
}

export const WATCHLIST_MENU_IDS = [
  "open-focused", "open-new-pane", "add-alert", "remove",
] as const;
export type WatchlistMenuId = (typeof WATCHLIST_MENU_IDS)[number];

export function watchlistMenu(ctx: WatchlistMenuContext): MenuEntry[] {
  return [
    { id: "open-focused", label: "Open in the focused chart" },
    {
      id: "open-new-pane", label: "Open in a new pane",
      disabled: !ctx.canOpenNewPane,
      disabledReason: "The workspace is already at its maximum number of panes",
    },
    { id: "sep", separator: true },
    {
      id: "add-alert", label: `Add alert on ${ctx.symbol}`,
      disabled: ctx.replayActive, disabledReason: REPLAY_REASON,
    },
    { id: "sep-remove", separator: true },
    { id: "remove", label: "Remove from this list", destructive: true },
  ];
}
