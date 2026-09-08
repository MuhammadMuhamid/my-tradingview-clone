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

/*
 * ── Why every id carries its menu's name ───────────────────────────────────
 *
 * The chart menu and the drawing menu both offered "add-alert", and the
 * handler ran one shared switch first. So right-clicking a horizontal line and
 * choosing "Add alert on this level" armed the alert at the PIXEL price under
 * the cursor — off by however far the click landed from the line — and the
 * branch that read the drawing's own level was unreachable. Silent, plausible
 * and wrong. Prefixing removes the class of defect rather than that one
 * instance: two menus cannot collide on an id they cannot share.
 */

/** Shown on a disabled item so a greyed control is not a mystery. */
const REPLAY_REASON = "Not while Replay is running — the price shown is not the market";
const LOCKED_REASON = "This drawing is locked";

export interface ChartMenuContext {
  /** The price under the pointer, or null off the price scale. */
  price: number | null;
  /**
   * That price, formatted the way the chart shows it.
   *
   * Passed in rather than formatted here: the number of decimals depends on
   * the instrument, and this module has no business knowing about instruments.
   */
  priceLabel: string;
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
  /** The Screener's candlestick-pattern marks are being drawn. */
  candlePatterns: boolean;
}

export const CHART_MENU_IDS = [
  "chart:copy-price", "chart:add-alert", "chart:trade-at-price",
  "chart:reset-view", "chart:toggle-auto", "chart:toggle-log",
  "chart:toggle-drawings-hidden", "chart:toggle-drawings-locked",
  "chart:toggle-candle-patterns",
  "chart:indicators", "chart:chart-settings",
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
  /*
   * An item that acts on a price NAMES the price.
   *
   * "Add alert at this price" leaves the user to work out which price the menu
   * opened at, on the one item whose entire purpose is a specific number — and
   * the value is already in hand when the payload is built. TradingView writes
   * "Add alert on ETHUSDT at 2,500.26…" for the same reason.
   */
  const at = hasPrice ? ` at ${ctx.priceLabel}` : "";
  return [
    {
      id: "chart:copy-price",
      label: hasPrice ? `Copy price ${ctx.priceLabel}` : "Copy price",
      disabled: !hasPrice, disabledReason: noPrice,
    },
    {
      id: "chart:add-alert", label: `Add alert${at}`,
      disabled: !hasPrice || ctx.replayActive,
      disabledReason: ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    {
      id: "chart:trade-at-price", label: `Prepare an order${at}`,
      hint: "fills the ticket",
      disabled: !hasPrice || ctx.replayActive || !ctx.tradingEnabled,
      disabledReason: !ctx.tradingEnabled
        ? "Manual trading is not enabled on this installation"
        : ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    { id: "sep-view", separator: true },
    { id: "chart:reset-view", label: "Reset view" },
    { id: "chart:toggle-auto", label: "Auto scale", checked: ctx.autoScale },
    { id: "chart:toggle-log", label: "Logarithmic scale", checked: ctx.logScale },
    { id: "sep-drawings", separator: true },
    {
      id: "chart:toggle-drawings-hidden", label: "Hide drawings",
      checked: ctx.drawingsHidden,
      disabled: !ctx.hasDrawings, disabledReason: "There are no drawings on this instrument",
    },
    {
      id: "chart:toggle-drawings-locked", label: "Lock drawings",
      checked: ctx.drawingsLocked,
      disabled: !ctx.hasDrawings, disabledReason: "There are no drawings on this instrument",
    },
    {
      id: "chart:toggle-candle-patterns", label: "Candlestick patterns",
      checked: ctx.candlePatterns,
      // Named as the Screener's, because that is whose opinion it is — the
      // chart contains no pattern logic and never will.
      hint: "Screener",
    },
    { id: "sep-studies", separator: true },
    { id: "chart:indicators", label: "Indicators…", hint: "I" },
    { id: "chart:chart-settings", label: "Chart settings…" },
  ];
}

export interface DrawingMenuContext {
  locked: boolean;
  /** THIS drawing's own hidden state, not the workspace's "hide drawings". */
  hidden: boolean;
  /** The drawing is a single horizontal level an alert can be armed on. */
  alertable: boolean;
  replayActive: boolean;
  /** Rendering order can be changed safely for this drawing. */
  canReorder: boolean;
  /**
   * macOS uses ⌘ where every other platform uses Ctrl.
   *
   * The hints used to be the literal `⌘D` and `⌘C`, so a Windows or Linux user
   * was shown a combination that does nothing on their keyboard.
   */
  mac: boolean;
}

export const DRAWING_MENU_IDS = [
  "drawing:settings", "drawing:clone", "drawing:copy", "drawing:toggle-lock",
  "drawing:toggle-hidden", "drawing:add-alert", "drawing:bring-front",
  "drawing:send-back", "drawing:remove",
] as const;
export type DrawingMenuId = (typeof DRAWING_MENU_IDS)[number];

export function drawingMenu(ctx: DrawingMenuContext): MenuEntry[] {
  return [
    // "Style", because that is what it opens: the colour / width / dash / fill
    // bar beside the drawing. Calling it "Settings" would promise a dialog
    // this product does not have.
    { id: "drawing:settings", label: "Style…" },
    {
      id: "drawing:clone", label: "Duplicate", hint: `${ctx.mac ? "⌘" : "Ctrl+"}D`,
      // Cloning a locked drawing is fine — the copy is unlocked — but cloning
      // is an edit of the LIST, so it follows the same rule as the rest.
      disabled: ctx.locked, disabledReason: LOCKED_REASON,
    },
    { id: "drawing:copy", label: "Copy", hint: `${ctx.mac ? "⌘" : "Ctrl+"}C` },
    { id: "sep-state", separator: true },
    // No hints on these two: `L` and `J` are the WORKSPACE-wide lock and hide,
    // which are a different action from locking or hiding this one drawing.
    { id: "drawing:toggle-lock", label: "Lock", checked: ctx.locked },
    { id: "drawing:toggle-hidden", label: "Hide", checked: ctx.hidden },
    {
      id: "drawing:add-alert", label: "Add alert on this level",
      disabled: !ctx.alertable || ctx.replayActive,
      disabledReason: ctx.replayActive
        ? REPLAY_REASON
        : "Only a horizontal level can carry a price alert",
    },
    { id: "sep-order", separator: true },
    {
      id: "drawing:bring-front", label: "Bring to front",
      disabled: !ctx.canReorder,
      disabledReason: "Rendering order is not adjustable for this drawing",
    },
    {
      id: "drawing:send-back", label: "Send to back",
      disabled: !ctx.canReorder,
      disabledReason: "Rendering order is not adjustable for this drawing",
    },
    { id: "sep-remove", separator: true },
    {
      id: "drawing:remove", label: "Remove", hint: "Del", destructive: true,
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
  "study:settings", "study:toggle-visible", "study:move-up", "study:move-down",
  "study:open-source", "study:remove",
] as const;
export type StudyMenuId = (typeof STUDY_MENU_IDS)[number];

export function studyMenu(ctx: StudyMenuContext): MenuEntry[] {
  return [
    { id: "study:settings", label: "Settings…" },
    { id: "study:toggle-visible", label: "Visible", checked: ctx.visible },
    { id: "sep-order", separator: true },
    {
      id: "study:move-up", label: "Move up",
      disabled: ctx.first, disabledReason: "Already first",
    },
    {
      id: "study:move-down", label: "Move down",
      disabled: ctx.last, disabledReason: "Already last",
    },
    { id: "sep-source", separator: true },
    {
      id: "study:open-source", label: "Open source in the Pine Editor",
      // A built-in has no Pine source to open. Offering it and then doing
      // nothing would be worse than saying so.
      disabled: !ctx.hasSource,
      disabledReason: "A built-in study has no Pine source",
    },
    { id: "sep-remove", separator: true },
    { id: "study:remove", label: "Remove", destructive: true },
  ];
}

export interface AxisMenuContext {
  autoScale: boolean;
  logScale: boolean;
  /** The axis reads as movement since the left edge rather than as a price. */
  percentScale: boolean;
  indexedScale: boolean;
  inverted: boolean;
}

export const AXIS_MENU_IDS = [
  "axis:toggle-auto", "axis:toggle-log", "axis:toggle-percent",
  "axis:toggle-indexed", "axis:toggle-invert", "axis:reset",
] as const;
export type AxisMenuId = (typeof AXIS_MENU_IDS)[number];

/**
 * The price axis's own menu.
 *
 * Spacing first, then meaning, then orientation — because those are three
 * different questions and grouping them as one list of five checkboxes is how
 * a reader ends up believing "Logarithmic" and "Percent" are alternatives to
 * each other rather than to Linear. The separators carry that grouping.
 */
export function priceAxisMenu(ctx: AxisMenuContext): MenuEntry[] {
  return [
    { id: "axis:toggle-auto", label: "Auto scale", checked: ctx.autoScale },
    { id: "axis:toggle-log", label: "Logarithmic scale", checked: ctx.logScale },
    { id: "sep-meaning", separator: true },
    { id: "axis:toggle-percent", label: "Percent scale", checked: ctx.percentScale },
    { id: "axis:toggle-indexed", label: "Indexed to 100", checked: ctx.indexedScale },
    { id: "sep-invert", separator: true },
    { id: "axis:toggle-invert", label: "Invert scale", checked: ctx.inverted },
    { id: "sep", separator: true },
    { id: "axis:reset", label: "Reset scale" },
  ];
}

export interface WatchlistMenuContext {
  symbol: string;
  replayActive: boolean;
  /** The workspace can open another pane without exceeding its maximum. */
  canOpenNewPane: boolean;
}

export const WATCHLIST_MENU_IDS = [
  "watchlist:open-focused", "watchlist:open-new-pane", "watchlist:add-alert", "watchlist:remove",
] as const;
export type WatchlistMenuId = (typeof WATCHLIST_MENU_IDS)[number];

export function watchlistMenu(ctx: WatchlistMenuContext): MenuEntry[] {
  return [
    { id: "watchlist:open-focused", label: "Open in the focused chart" },
    {
      id: "watchlist:open-new-pane", label: "Open in a new pane",
      disabled: !ctx.canOpenNewPane,
      disabledReason: "The workspace is already at its maximum number of panes",
    },
    { id: "sep", separator: true },
    {
      id: "watchlist:add-alert", label: `Add alert on ${ctx.symbol}`,
      disabled: ctx.replayActive, disabledReason: REPLAY_REASON,
    },
    { id: "sep-remove", separator: true },
    { id: "watchlist:remove", label: "Remove from this list", destructive: true },
  ];
}
