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
import { displayTicker } from "./instrument";
import { BINDINGS, type ShortcutAction } from "./shortcuts";

/**
 * The key cap a row prints, read from the table that implements the chord.
 *
 * ── Why it is derived rather than typed ────────────────────────────────────
 *
 * R8-17/20/21: the reference prints `⌥A`, `⇧T`, `⌘V`, `⌥N`, `⌥I`, `⌥P`, `⌥L`
 * beside the rows they fire, and this product printed none of them. The
 * obvious repair is to type the strings in — and that is how a menu ends up
 * advertising a chord the browser eats or one nobody ever bound, which is the
 * exact sin `ShortcutsSheet` was rewritten to stop committing.
 *
 * So a cap is a QUERY against `BINDINGS`. A row whose action has no chord
 * prints no cap and says nothing, and the day the binding lands the cap
 * appears without anyone remembering to come back here.
 */
export function menuCap(action: ShortcutAction | string, mac: boolean): string | undefined {
  const binding = BINDINGS.find((b) => b.action === action && !b.chordless && b.key !== "");
  if (!binding) return undefined;
  const parts: string[] = [];
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) parts.push(mac ? "⌥" : "Alt");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  const key = binding.key === " " ? "Space"
    : binding.key === "ArrowLeft" ? "←"
      : binding.key === "ArrowRight" ? "→"
        : binding.key === "Delete" ? "Del"
          : binding.key === "Backspace" ? "⌫"
            : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  parts.push(key);
  return parts.join(mac ? "" : "+");
}

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
  /**
   * The instrument, as a TICKER.
   *
   * R8-18, contract §5: the reference names the symbol on six of this menu's
   * rows and in the menu's own accessible name, and this product had the
   * canonical `instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot` in the latter.
   * The caller passes `displayTicker(paneSymbol)`; `displayTicker` is applied
   * again here so a canonical id handed in by mistake still cannot reach a row.
   */
  ticker: string;
  /** macOS writes ⌘ where every other platform writes Ctrl. */
  mac: boolean;
  /** A drawing is on the workspace clipboard, so Paste has something to do. */
  canPaste: boolean;
  /**
   * The watchlists this workspace holds.
   *
   * One list makes `Add {TICKER} to watchlist` a plain action; more than one
   * makes it a submenu, which is how the reference draws it.
   */
  lists: readonly { id: string; name: string }[];
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
  /** The canonical classical-pattern geometry is being drawn. */
  classicalPatterns?: boolean;
}

export const CHART_MENU_IDS = [
  "chart:add-alert", "chart:trade-at-price", "chart:add-indicator",
  "chart:symbol-info",
  "chart:copy-price", "chart:paste",
  "chart:add-to-watchlist", "chart:text-note",
  "chart:chart-settings",
  "chart:reset-view", "chart:toggle-auto", "chart:toggle-log",
  "chart:toggle-drawings-hidden", "chart:toggle-drawings-locked",
  "chart:toggle-candle-patterns",
  "chart:toggle-classical-patterns",
  "chart:indicators",
] as const;
export type ChartMenuId = (typeof CHART_MENU_IDS)[number];

/** The prefix a `Add {TICKER} to watchlist ›` child carries. */
export const CHART_ADD_TO_LIST_PREFIX = "chart:add-to-watchlist:";

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
  /*
   * R8-17: the reference names the SYMBOL too — "Add alert on BTCUSDT at
   * 77,581.72…" — which matters on a multi-pane workspace, where the menu may
   * have opened on a pane that is not the one the toolbar is describing.
   * `displayTicker` again, so a canonical id handed in by mistake cannot reach
   * a row (contract §5, R8-18).
   */
  const ticker = displayTicker(ctx.ticker);
  const on = ` on ${ticker}${at}`;
  return [
    {
      id: "chart:add-alert", label: `Add alert${on}…`, glyph: "alarm",
      // The cap is a QUERY against `BINDINGS` (see `menuCap`): the reference's
      // ⌥A appears here the day that binding is declared, and never before.
      hint: menuCap("add-alert", ctx.mac),
      disabled: !hasPrice || ctx.replayActive,
      disabledReason: ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    {
      /*
       * The reference's own wording, and the row is still a PREPARATION.
       *
       * `hint` says so in the menu itself, the handler stages a ticket, and
       * nothing in this product submits from a context menu — that is the
       * alerts-never-trade line, and a context menu is exactly the surface
       * where a one-click order would be easiest to add and worst to have. On
       * an installation with manual trading off — the default — the row is
       * present, disabled, and says why.
       */
      id: "chart:trade-at-price", label: `Add order${on}…`, glyph: "order",
      hint: "fills the ticket",
      disabled: !hasPrice || ctx.replayActive || !ctx.tradingEnabled,
      disabledReason: !ctx.tradingEnabled
        ? "Manual trading is not enabled on this installation"
        : ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    {
      id: "chart:add-indicator", label: `Add indicator/strategy on ${ticker}…`,
      glyph: "indicator",
    },
    { id: "sep-symbol", separator: true },
    { id: "chart:symbol-info", label: "Symbol info…", glyph: "info" },
    { id: "sep-clipboard", separator: true },
    {
      id: "chart:copy-price",
      label: hasPrice ? `Copy price ${ctx.priceLabel}` : "Copy price",
      glyph: "copy",
      disabled: !hasPrice, disabledReason: noPrice,
    },
    {
      /*
       * The DRAWING clipboard, which ⌘C on a selected drawing fills and which
       * had no menu route at all — so a copied drawing could be pasted only by
       * someone who already knew the chord.
       */
      id: "chart:paste", label: "Paste", glyph: "paste",
      hint: menuCap("paste", ctx.mac),
      disabled: !ctx.canPaste,
      disabledReason: "Copy a drawing first — there is nothing on the clipboard",
    },
    { id: "sep-symbol-actions", separator: true },
    {
      id: "chart:add-to-watchlist",
      label: `Add ${ticker} to watchlist`,
      glyph: "watchlist",
      /*
       * A submenu only where there is a choice to make. With one list the row
       * IS the action; with several it is the reference's `›`, and each child
       * id carries the list it adds to.
       */
      ...(ctx.lists.length > 1
        ? { children: ctx.lists.map((list) => ({
          id: `${CHART_ADD_TO_LIST_PREFIX}${list.id}`, label: list.name,
        })) }
        : {}),
      disabled: ctx.lists.length === 0,
      disabledReason: "This workspace has no watchlist to add to",
    },
    {
      id: "chart:text-note", label: `Add text note for ${ticker}`, glyph: "note",
      hint: menuCap("tool:text", ctx.mac),
      disabled: !hasPrice, disabledReason: noPrice,
    },
    { id: "sep-settings", separator: true },
    {
      id: "chart:chart-settings", label: "Settings…", glyph: "gear",
      hint: menuCap("chart-settings", ctx.mac),
    },
    /*
     * ── Below the fold: the rows the reference keeps elsewhere ─────────────
     *
     * TradingView puts Auto / Logarithmic on the PRICE AXIS menu and has no
     * pattern overlays at all. They stay, after `Settings…` and behind a
     * separator, because they work and because removing a working control to
     * match a layout is a regression dressed as parity. Their proper home is
     * the axis menu, which now carries all four scale readings (R8-20).
     */
    { id: "sep-view", separator: true },
    {
      id: "chart:reset-view", label: "Reset view", glyph: "reset",
      hint: menuCap("reset-view", ctx.mac),
    },
    {
      id: "chart:toggle-auto", label: "Auto scale", checked: ctx.autoScale,
      hint: menuCap("toggle-auto", ctx.mac),
    },
    {
      id: "chart:toggle-log", label: "Logarithmic scale", checked: ctx.logScale,
      hint: menuCap("toggle-log", ctx.mac),
    },
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
    {
      id: "chart:toggle-classical-patterns", label: "Classical chart patterns",
      checked: ctx.classicalPatterns === true,
      hint: "5/5 pivots · close breakouts",
    },
    { id: "sep-studies", separator: true },
    {
      /*
       * The cap was the literal `I`, and `I` has not opened the indicator
       * browser since R4b-05 gave every bare letter to the symbol search —
       * the chord is `/`. A hand-typed cap is a cap that rots; `menuCap` reads
       * the table that actually answers the key.
       */
      id: "chart:indicators", label: "Indicators…", glyph: "indicator",
      hint: menuCap("indicators", ctx.mac),
    },
  ];
}

export interface DrawingMenuContext {
  /**
   * What the drawing IS, in the reader's words — "trendline", "level".
   *
   * R8-21: the reference writes `Add alert on trendline…`, and this product
   * wrote `Add alert on this level` whatever had been right-clicked, including
   * on the tools that are not levels at all.
   */
  toolName: string;
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

/**
 * What to call a drawing in a sentence — "Add alert on trendline…".
 *
 * A PARTIAL map with an honest fallback, not an exhaustive record over the 90
 * members of `DrawingTool`. Every entry here is a tool a reader is likely to
 * right-click and name out loud; the rest read "drawing", which is true and is
 * better than a camel-cased identifier leaking into a menu row. Lower case
 * because it sits mid-sentence, exactly as the reference's does.
 */
const TOOL_NAMES: Record<string, string> = {
  trend: "trendline", trendAngle: "trend angle", ray: "ray", extended: "extended line",
  arrow: "arrow", hline: "horizontal line", hray: "horizontal ray",
  vline: "vertical line", crossline: "crossline", infoline: "info line",
  parallel: "parallel channel", pitchfork: "pitchfork", regression: "regression trend",
  fib: "Fib retracement", fibext: "Fib extension", fibChannel: "Fib channel",
  rect: "rectangle", ellipse: "ellipse", circle: "circle", triangle: "triangle",
  brush: "brush", path: "path", polyline: "polyline", highlighter: "highlighter",
  text: "text", note: "note", callout: "callout", pricelabel: "price label",
  ruler: "measurement", pricerange: "price range", daterange: "date range",
  long: "long position", short: "short position",
  avwap: "anchored VWAP", vprange: "fixed-range profile", avprofile: "anchored profile",
  icon: "icon", table: "table",
};

export function drawingToolName(tool: string): string {
  return TOOL_NAMES[tool] ?? "drawing";
}

/*
 * ── Ids a payload can EMIT ─────────────────────────────────────────────────
 *
 * A row that owns a submenu emits nothing — clicking it opens its children —
 * so parent ids (`drawing:visual-order`) are deliberately absent from these
 * lists. `tests/powerUx.test.ts` requires every id here to reach a `case`, and
 * a no-op case written only to satisfy that rule would be a handler that lies.
 * The same test asserts separately that every CHILD id is in the list.
 */
export const DRAWING_MENU_IDS = [
  "drawing:add-alert",
  "drawing:bring-front", "drawing:send-back",
  "drawing:clone", "drawing:copy",
  "drawing:toggle-lock", "drawing:toggle-hidden", "drawing:remove",
  "drawing:settings",
] as const;
export type DrawingMenuId = (typeof DRAWING_MENU_IDS)[number];

/**
 * The selected drawing's own menu.
 *
 * ── R8-21: the alert leads ─────────────────────────────────────────────────
 *
 * This used to open with `Style…`, and the reference opens with `Add alert on
 * trendline… ⌥A`. The order is not decoration: the first row is the one a
 * reflexive Enter takes and the one the eye lands on, and on a drawing the
 * thing a trader does is arm a level, not restyle it. Style is still here,
 * last, named `Settings…` as the reference names it, and it opens the deeper
 * editor rather than the colour bar beside the drawing — the bar has its own
 * gesture and does not need a menu row too.
 *
 * `Template ›`, `Visibility on intervals ›` and `Object tree` are the
 * reference's and are ABSENT rather than greyed. This file's rule — disabled
 * WITH a reason — is for an action the product has and cannot take right now;
 * an action the engine has no route to at all is not a state, it is absence,
 * and three permanently grey rows on a drawing menu teach nobody anything.
 */
export function drawingMenu(ctx: DrawingMenuContext): MenuEntry[] {
  const reorderReason = "Rendering order is not adjustable for this drawing";
  return [
    {
      id: "drawing:add-alert", label: `Add alert on ${ctx.toolName}…`, glyph: "alarm",
      hint: menuCap("add-alert", ctx.mac),
      disabled: !ctx.alertable || ctx.replayActive,
      disabledReason: ctx.replayActive
        ? REPLAY_REASON
        : "Only a horizontal level can carry a price alert",
    },
    { id: "sep-order", separator: true },
    {
      /*
       * The reference's `Visual order ›`, which is where front/back belong: a
       * question about stacking, asked once, answered two ways. They were two
       * sibling rows in the middle of the menu and read as two separate
       * features.
       */
      id: "drawing:visual-order", label: "Visual order", glyph: "template",
      disabled: !ctx.canReorder, disabledReason: reorderReason,
      children: [
        { id: "drawing:bring-front", label: "Bring to front" },
        { id: "drawing:send-back", label: "Send to back" },
      ],
    },
    { id: "sep-copy", separator: true },
    {
      id: "drawing:clone", label: "Clone", glyph: "clone",
      hint: menuCap("clone", ctx.mac),
      // Cloning a locked drawing is fine — the copy is unlocked — but cloning
      // is an edit of the LIST, so it follows the same rule as the rest.
      disabled: ctx.locked, disabledReason: LOCKED_REASON,
    },
    {
      id: "drawing:copy", label: "Copy", glyph: "copy",
      hint: menuCap("copy", ctx.mac),
    },
    { id: "sep-state", separator: true },
    // No cap on these two: ⇧⌥L and ⌘⌥H are the WORKSPACE-wide lock and hide,
    // which are a different action from locking or hiding this one drawing.
    { id: "drawing:toggle-lock", label: "Lock", glyph: "lock", checked: ctx.locked },
    { id: "drawing:toggle-hidden", label: "Hide", glyph: "eye", checked: ctx.hidden },
    {
      id: "drawing:remove", label: "Remove", glyph: "trash",
      hint: menuCap("delete", ctx.mac), destructive: true,
      disabled: ctx.locked, disabledReason: LOCKED_REASON,
    },
    { id: "sep-settings", separator: true },
    { id: "drawing:settings", label: "Settings…", glyph: "gear" },
  ];
}

export interface StudyMenuContext {
  visible: boolean;
  first: boolean;
  last: boolean;
  /** Pine studies have source to open; built-ins do not. */
  hasSource: boolean;
  /**
   * A built-in, which is what can be duplicated.
   *
   * A Pine study's copy would need its script and its inputs cloned through a
   * different API. Offering Duplicate and doing nothing would be worse than
   * saying so, which is the same reasoning as `hasSource` above.
   */
  canDuplicate: boolean;
}

export const STUDY_MENU_IDS = [
  "study:settings", "study:toggle-visible", "study:duplicate",
  "study:move-up", "study:move-down",
  "study:open-source", "study:remove",
] as const;
export type StudyMenuId = (typeof STUDY_MENU_IDS)[number];

export function studyMenu(ctx: StudyMenuContext): MenuEntry[] {
  return [
    { id: "study:settings", label: "Settings…" },
    { id: "study:toggle-visible", label: "Visible", checked: ctx.visible },
    /*
     * TVP8: the reference has Duplicate on this menu and there was no route to
     * two of anything — an RSI(14) beside an RSI(50) meant adding the second
     * from the browser and retyping every input. The copy carries the tuning
     * AND the styling, which is most of what a duplicate is for.
     */
    {
      id: "study:duplicate", label: "Duplicate",
      disabled: !ctx.canDuplicate,
      disabledReason: "A Pine study is duplicated from the editor",
    },
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

/**
 * The study LEGEND's `⋯` menu (R3b-19).
 *
 * ── Why this is a second, shorter study menu ───────────────────────────────
 *
 * `studyMenu` above is the Indicators PANEL's, and the panel can reach every
 * API it names: the Pine list, the native list, the editor, the ordering. The
 * legend row on the chart can reach exactly one resolver —
 * `ChartPane.paneAction`, which owns hide, settings and remove — so those are
 * the three rows here.
 *
 * The reference's own indicator menu (`measurements/tv-study-context-menu-
 * 20260914.md`) also carries `Add alert on …`, `Visual order ›`,
 * `Visibility on intervals ›`, `Move to ›`, `Pin to scale ›`, `Source code…`,
 * `Copy` and `Object tree`. Not one of them is written here as a disabled row,
 * and that is deliberate: this file's own rule — an action that cannot be
 * taken is disabled WITH A REASON — is about an action this product has and
 * cannot take right now. An action the engine has no route to at all is not a
 * state; it is absence, and eight greyed rows on a chart legend would be a
 * menu that teaches nothing. They land here the moment the legend can hand
 * them somewhere, which is one prop on `IndicatorLegend` and one branch in
 * `ChartPane.paneAction`.
 */
export const LEGEND_STUDY_MENU_IDS = [
  "study-legend:settings", "study-legend:toggle-visible", "study-legend:remove",
] as const;
export type LegendStudyMenuId = (typeof LEGEND_STUDY_MENU_IDS)[number];

export function legendStudyMenu(ctx: { title: string }): MenuEntry[] {
  return [
    { id: "study-legend:settings", label: "Settings…" },
    // The legend only ever draws a study that is currently drawn, so this row
    // hides; the row for a hidden study lives on the legend's own hidden list.
    { id: "study-legend:toggle-visible", label: "Hide" },
    { id: "sep-remove", separator: true },
    {
      id: "study-legend:remove", label: `Remove ${ctx.title}`, destructive: true,
    },
  ];
}

export interface AxisMenuContext {
  autoScale: boolean;
  logScale: boolean;
  /** The axis reads as movement since the left edge rather than as a price. */
  percentScale: boolean;
  indexedScale: boolean;
  inverted: boolean;
  /** macOS writes ⌘ where every other platform writes Ctrl. */
  mac: boolean;
  /** The scale is currently drawn on the left of the plot. */
  onLeft: boolean;
  /** The three axis LABELS the Scales tab already owns. */
  labels: { lastValue: boolean; indicatorValue: boolean; dayOfWeek: boolean };
  /** The two axis LINES it owns. `bidAsk` is null where the feed has no book. */
  lines: { lastValue: boolean; bidAsk: boolean | null };
}

export const AXIS_MENU_IDS = [
  "axis:toggle-auto", "axis:toggle-invert",
  "axis:mode-regular", "axis:toggle-percent", "axis:toggle-indexed", "axis:toggle-log",
  "axis:move-left",
  "axis:label-last-value", "axis:label-indicator-value", "axis:label-day-of-week",
  "axis:line-last-value", "axis:line-bid-ask",
  "axis:reset", "axis:more-settings",
] as const;
export type AxisMenuId = (typeof AXIS_MENU_IDS)[number];

/**
 * The price axis's own menu.
 *
 * ── R8-20: four readings of one scale, not four checkboxes ─────────────────
 *
 * `Regular`, `Percent`, `Indexed to 100` and `Logarithmic` are MUTUALLY
 * EXCLUSIVE, and this drew them as independent checkboxes with no `Regular` at
 * all — so a reader was told "Percent is on" and "Logarithmic is off" as two
 * separate facts rather than as one choice with four positions, and the way
 * back to a plain price axis was to untick whichever one happened to be on.
 * They are `menuitemradio` now, which is what assistive technology announces
 * as "2 of 4", and `Regular` is the position that was missing.
 *
 * `Labels ›` and `Lines ›` are the reference's submenus over settings this
 * product already has in Chart settings → Scales; `More settings…` opens that
 * tab. `Lock price to bar ratio` and `Plus button` stay recorded omissions
 * (contract §6): lightweight-charts 4.2 exposes no bar-ratio lock, and the
 * plus button is not a thing the axis menu switches — it is R8-08's own
 * hover affordance, and a switch for something that is always on would be a
 * switch that does nothing.
 */
export function priceAxisMenu(ctx: AxisMenuContext): MenuEntry[] {
  const regular = !ctx.logScale && !ctx.percentScale && !ctx.indexedScale;
  return [
    {
      id: "axis:toggle-auto", label: "Auto (fits data to screen)",
      checked: ctx.autoScale, hint: menuCap("toggle-auto", ctx.mac),
    },
    {
      id: "axis:toggle-invert", label: "Invert scale", checked: ctx.inverted,
      hint: menuCap("toggle-invert", ctx.mac),
    },
    { id: "sep-meaning", separator: true },
    { id: "axis:mode-regular", label: "Regular", radio: true, checked: regular },
    {
      id: "axis:toggle-percent", label: "Percent", radio: true,
      checked: ctx.percentScale, hint: menuCap("toggle-percent", ctx.mac),
    },
    { id: "axis:toggle-indexed", label: "Indexed to 100", radio: true, checked: ctx.indexedScale },
    {
      id: "axis:toggle-log", label: "Logarithmic", radio: true,
      checked: ctx.logScale, hint: menuCap("toggle-log", ctx.mac),
    },
    { id: "sep-side", separator: true },
    {
      id: "axis:move-left",
      label: ctx.onLeft ? "Move scale to right" : "Move scale to left",
    },
    { id: "sep-decoration", separator: true },
    {
      id: "axis:labels", label: "Labels", glyph: "template",
      children: [
        {
          id: "axis:label-last-value", label: "Symbol last value",
          checked: ctx.labels.lastValue,
        },
        {
          id: "axis:label-indicator-value", label: "Indicator last value",
          checked: ctx.labels.indicatorValue,
        },
        {
          id: "axis:label-day-of-week", label: "Day of week on the time axis",
          checked: ctx.labels.dayOfWeek,
        },
      ],
    },
    {
      id: "axis:lines", label: "Lines", glyph: "template",
      children: [
        {
          id: "axis:line-last-value", label: "Symbol price line",
          checked: ctx.lines.lastValue,
        },
        {
          id: "axis:line-bid-ask", label: "Bid and ask lines",
          checked: ctx.lines.bidAsk === true,
          disabled: ctx.lines.bidAsk === null,
          disabledReason: "This feed publishes no book, so there is no bid or ask to draw",
        },
      ],
    },
    { id: "sep-reset", separator: true },
    {
      id: "axis:reset", label: "Reset scale", glyph: "reset",
      hint: menuCap("reset-view", ctx.mac),
    },
    { id: "axis:more-settings", label: "More settings…", glyph: "gear" },
  ];
}

export interface WatchlistMenuContext {
  symbol: string;
  replayActive: boolean;
  /** The workspace can open another pane without exceeding its maximum. */
  canOpenNewPane: boolean;
  /**
   * Every list in the workspace, so the row can offer the OTHER ones.
   *
   * TVP8 R7b-18: the reference's row menu carries `Add <ticker> to watchlist ›`
   * and `Add symbol`, and both are functions this product has — it has more
   * lists than TradingView's free tier does. With one list there is nowhere to
   * add the row TO, so the entry is absent rather than present and greyed:
   * "disabled with a reason" is for an action that is temporarily unavailable,
   * and this one has no meaning at all until a second list exists.
   */
  lists: readonly { id: string; name: string }[];
}

/*
 * ── The time axis ──────────────────────────────────────────────────────────
 *
 * TVP8: right-clicking the time scale opened CHROME's menu over the chart.
 *
 * `DrawingCanvas` returned early for that strip, with a comment saying the
 * time scale "is the one strip with nothing to offer". That had stopped being
 * true: resetting the view, locking the price-to-bar ratio and the settings
 * dialog are all things the reference puts on exactly this menu, and all three
 * already exist here. The result was that one of the three strips of the chart
 * fell out of the product and into the browser — Inspect, Save as, Translate —
 * which is the single loudest tell a copy can have.
 */
export const TIME_AXIS_MENU_IDS = [
  "time:reset-view", "time:go-to", "time:chart-settings",
] as const;
export type TimeAxisMenuId = (typeof TIME_AXIS_MENU_IDS)[number];

/**
 * The reference also offers "Lock price to bar ratio" here. It is absent for
 * the same reason `lib/chartSettings.ts` gives for leaving it out of the
 * settings model: lightweight-charts 4.2 exposes no equivalent, and this
 * product does not ship switches that do nothing.
 */
export function timeAxisMenu(ctx: { mac: boolean }): MenuEntry[] {
  return [
    {
      /*
       * R8-19: the reference's own wording. "Reset chart view" described the
       * whole chart on a menu that belongs to one strip of it; what this row
       * actually restores is the time scale's fit, and the price scale has its
       * own `Reset scale` two menus over.
       */
      id: "time:reset-view", label: "Reset time scale", glyph: "reset",
      hint: menuCap("reset-view", ctx.mac),
    },
    { id: "sep-goto", separator: true },
    /*
     * `Time zone ›` is the reference's and is NOT applicable: every Trading
     * Scene chart is UTC by contract, so the submenu would have one row.
     * `Session breaks` is a recorded omission — there is no session primitive
     * on a 24/7 venue. `Go to…` is this product's and has no reference row.
     */
    { id: "time:go-to", label: "Go to…", glyph: "calendar" },
    { id: "sep-settings", separator: true },
    { id: "time:chart-settings", label: "More settings…", glyph: "gear" },
  ];
}

export const WATCHLIST_MENU_IDS = [
  "watchlist:open-focused", "watchlist:open-new-pane", "watchlist:add-to-list",
  "watchlist:add-alert", "watchlist:add-symbol", "watchlist:remove",
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
    /*
     * R7b-18: the reference's own `Add <ticker> to watchlist ›`. Absent —
     * not greyed — with a single list; see `WatchlistMenuContext.lists`.
     */
    ...(ctx.lists.length > 1 ? [{
      id: "watchlist:add-to-list", label: `Add ${displayTicker(ctx.symbol)} to watchlist…`,
    }] : []),
    { id: "sep", separator: true },
    {
      /*
       * TVP8 R7-10: this interpolated the STORAGE key, so a canonical row's
       * right-click offered "Add alert on
       * instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot" as a 455px-wide menu
       * row and as the menu's own accessible name. Contract §5: a canonical
       * string is never primary copy.
       */
      id: "watchlist:add-alert", label: `Add alert on ${displayTicker(ctx.symbol)}`,
      disabled: ctx.replayActive, disabledReason: REPLAY_REASON,
    },
    { id: "sep-add", separator: true },
    { id: "watchlist:add-symbol", label: "Add symbol…" },
    { id: "sep-remove", separator: true },
    /*
     * The reference has no Remove here — it removes with the hover trash and
     * the Delete key, both of which this row now has too (R7b-09). Keeping
     * the menu item as well is deliberate: it is the only route that survives
     * a pointer that cannot hover and a keyboard focus that is on the menu.
     */
    { id: "watchlist:remove", label: "Remove from this list", destructive: true },
  ];
}

/**
 * The second level of `Add <ticker> to watchlist ›`.
 *
 * A flat menu opened from the first, rather than a nested flyout, because
 * `ContextMenu` has one level and a second one is a keyboard, placement and
 * focus-restore contract of its own — the thing that component's header
 * explains at length. The behaviour a reader sees is the same: choose the
 * item, choose the list.
 */
export function watchlistAddToListMenu(
  lists: readonly { id: string; name: string }[], activeId: string | null,
): MenuEntry[] {
  return lists.filter((list) => list.id !== activeId)
    .map((list) => ({ id: `watchlist:add-to-list:${list.id}`, label: list.name }));
}

/*
 * ── R7b-08: list editing is on the list's NAME, view settings are on `⋯` ───
 *
 * The two header menus were on the wrong buttons. `⋯` held New / Rename /
 * Delete list, and the name's own caret opened a bare list of lists — so the
 * control that says which list you are looking at could not act on it, and
 * the control the reference fills with view settings had no view settings in
 * it at all. The reference's list-name menu is where a list is copied,
 * renamed, cleared and created, with the lists themselves underneath it; its
 * `⋯` is `Settings`: which columns are shown and how a symbol is written.
 *
 * These two return a RICHER entry than `MenuEntry` because both are anchored
 * dropdowns rather than point menus: they carry section headings and, for the
 * lists and the symbol-display choice, radio semantics — neither of which a
 * `menuitem`/`menuitemcheckbox` list can express. They are rendered by the
 * panel's own `.tvc-menu` dropdown, which is the same grammar `ContextMenu`
 * paints, so nothing about how they look is a second opinion.
 */
export type WatchlistPanelEntry =
  | { kind: "separator"; id: string }
  | { kind: "heading"; id: string; label: string }
  | {
      kind: "item"; id: string; label: string;
      /** A checkbox when `radio` is false, a radio when it is true. */
      checked?: boolean;
      radio?: boolean;
      destructive?: boolean;
      disabled?: boolean;
      disabledReason?: string;
    };

export interface WatchlistViewPrefs {
  /** Ticker and last price only — the header's own toggle mirrors this. */
  compact: boolean;
  columns: { last: boolean; change: boolean; changePct: boolean; volume: boolean };
  /** The 18px asset mark at the head of every row. */
  mark: boolean;
  /** `BTCUSDT` or `Bitcoin / TetherUS`. */
  display: "symbol" | "name";
}

export const WATCHLIST_VIEW_DEFAULTS: WatchlistViewPrefs = {
  compact: false,
  columns: { last: true, change: true, changePct: true, volume: false },
  mark: true,
  display: "symbol",
};

export function watchlistSettingsMenu(prefs: WatchlistViewPrefs): WatchlistPanelEntry[] {
  return [
    { kind: "item", id: "view:compact", label: "Compact list", checked: prefs.compact },
    { kind: "separator", id: "sep-columns" },
    { kind: "heading", id: "head-columns", label: "Customize columns" },
    { kind: "item", id: "view:column:last", label: "Last", checked: prefs.columns.last },
    { kind: "item", id: "view:column:change", label: "Change", checked: prefs.columns.change },
    { kind: "item", id: "view:column:changePct", label: "Change %", checked: prefs.columns.changePct },
    /* Not "Volume": the venue is 24/7, so the figure is a 24-hour rolling one
       and the reference's session-scoped `Volume` would be the wrong label for
       it. The field already rides `useWatchlistTickers`. */
    { kind: "item", id: "view:column:volume", label: "Volume (24h)", checked: prefs.columns.volume },
    { kind: "separator", id: "sep-display" },
    { kind: "heading", id: "head-display", label: "Symbol display" },
    { kind: "item", id: "view:mark", label: "Mark", checked: prefs.mark },
    { kind: "item", id: "view:display:symbol", label: "Symbol", radio: true,
      checked: prefs.display === "symbol" },
    { kind: "item", id: "view:display:name", label: "Name", radio: true,
      checked: prefs.display === "name" },
  ];
}

export function watchlistListsMenu(ctx: {
  lists: readonly { id: string; name: string }[];
  activeId: string | null;
}): WatchlistPanelEntry[] {
  const only = ctx.lists.length <= 1;
  return [
    { kind: "item", id: "list:copy", label: "Make a copy…", disabled: ctx.activeId === null,
      disabledReason: "No list is selected" },
    { kind: "item", id: "list:rename", label: "Rename…", disabled: ctx.activeId === null,
      disabledReason: "No list is selected" },
    { kind: "item", id: "list:clear", label: "Clear list", disabled: ctx.activeId === null,
      disabledReason: "No list is selected" },
    { kind: "separator", id: "sep-create" },
    { kind: "item", id: "list:new", label: "Create new list…" },
    { kind: "separator", id: "sep-lists" },
    { kind: "heading", id: "head-lists", label: "My watchlists" },
    ...ctx.lists.map((list): WatchlistPanelEntry => ({
      kind: "item", id: `list:select:${list.id}`, label: list.name, radio: true,
      checked: list.id === ctx.activeId,
    })),
    { kind: "separator", id: "sep-delete" },
    { kind: "item", id: "list:delete", label: "Delete list", destructive: true, disabled: only,
      disabledReason: "A workspace keeps at least one list" },
  ];
}
