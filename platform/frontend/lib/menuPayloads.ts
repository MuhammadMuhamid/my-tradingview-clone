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
import { CHART_TIME_ZONES } from "./chartClock";
import type { ChartTimeZone } from "./chartSettings";
import type { IntervalVisibility } from "./drawings";

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
  /** Number of studies currently on the focused pane. */
  indicatorCount?: number;
}

export const CHART_MENU_IDS = [
  "chart:reset-view", "chart:copy-price", "chart:paste", "chart:add-alert",
  "chart:trade-at-price", "chart:table-view", "chart:object-tree",
  "chart:toggle-candle-patterns", "chart:toggle-classical-patterns",
  "chart:remove-indicators", "chart:chart-settings",
  "chart:add-to-watchlist",
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
  const at = hasPrice ? ` at ${ctx.priceLabel}` : "";
  const ticker = displayTicker(ctx.ticker);
  const on = ` on ${ticker}${at}`;
  const count = ctx.indicatorCount ?? 0;
  return [
    { id: "chart:reset-view", label: "Reset chart view", glyph: "reset", hint: menuCap("reset-view", ctx.mac) },
    { id: "sep-clipboard", separator: true },
    { id: "chart:copy-price", label: hasPrice ? `Copy price ${ctx.priceLabel}` : "Copy price", glyph: "copy", disabled: !hasPrice, disabledReason: noPrice },
    { id: "chart:paste", label: "Paste", glyph: "paste", hint: menuCap("paste", ctx.mac), disabled: !ctx.canPaste, disabledReason: "Copy a drawing first — there is nothing on the clipboard" },
    { id: "sep-alert", separator: true },
    {
      id: "chart:add-alert", label: `Add alert${on}…`, glyph: "alarm",
      hint: menuCap("add-alert", ctx.mac),
      disabled: !hasPrice || ctx.replayActive,
      disabledReason: ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    ...(ctx.tradingEnabled ? [{
      id: "chart:trade-at-price", label: `Add order${on}…`, glyph: "order",
      disabled: !hasPrice || ctx.replayActive || !ctx.tradingEnabled,
      disabledReason: !ctx.tradingEnabled
        ? "Manual trading is not enabled on this installation"
        : ctx.replayActive ? REPLAY_REASON : noPrice,
    } as MenuEntry] : []),
    { id: "sep-table", separator: true },
    { id: "chart:table-view", label: "Table view" },
    { id: "chart:object-tree", label: "Object tree", glyph: "tree" },
    /*
     * Phase 3P: the two pattern overlays. Both engines, both panels and both
     * handlers (`chart:toggle-candle-patterns`, `chart:toggle-classical-
     * patterns`) existed, and nothing in the product emitted the ids — the
     * overlays could be switched on only by hand-editing localStorage. A
     * capability with no entry point is not a capability the user has.
     *
     * The rows that were here — "Lock vertical cursor line by time" and the
     * "Chart template" pair — did nothing but raise a toast that claimed
     * success. A control that moves nothing must not exist (§6 of the UI
     * contract), and the current live reference no longer carries them
     * either.
     */
    { id: "sep-patterns", separator: true },
    { id: "chart:toggle-candle-patterns", label: "Candlestick patterns", checked: ctx.candlePatterns },
    { id: "chart:toggle-classical-patterns", label: "Chart patterns", checked: ctx.classicalPatterns === true },
    { id: "sep-remove", separator: true },
    { id: "chart:remove-indicators", label: `Remove ${count} indicator${count === 1 ? "" : "s"}`, disabled: count === 0, disabledReason: "There are no indicators on this chart" },
    { id: "sep-settings", separator: true },
    { id: "chart:chart-settings", label: "Settings…", glyph: "gear", hint: menuCap("chart-settings", ctx.mac) },
  ];
}

/*
 * ── A4: the series legend's own menu ───────────────────────────────────────
 *
 * The `⋯` on the series legend opened the CHART's context menu. Measured on
 * live Premium, the series has a menu of its own, about the instrument rather
 * than the canvas: Add alert on BTCUSDT at <price>… (⌥A) · Add order on
 * BTCUSDT at <price>… · Add indicator/strategy on BTCUSDT… · Symbol info… ·
 * Metrics › · Copy price <price> · Paste · Table view · Visual order › ·
 * Move to › · Pin to scale › · Chart syncing › · Hide · Add BTCUSDT to
 * watchlist › · Add text note for BTCUSDT (⌥N) · Settings….
 *
 * This keeps the reference's order and marks for every row this product can
 * resolve, and leaves the rest ABSENT for the reason this file gives at the
 * top: `Metrics ›`, `Visual order ›`, `Move to ›`, `Pin to scale ›`,
 * `Chart syncing ›` and `Hide` have no engine route for the main series here,
 * and a row that opens nothing is the defect these payloads exist to prevent.
 */
export const SERIES_MENU_IDS = [
  "series:add-alert", "series:trade-at-price", "series:add-indicator", "series:symbol-info",
  "series:copy-price", "series:paste", "series:table-view",
  "series:add-to-watchlist", "series:text-note", "series:chart-settings",
] as const;
export type SeriesMenuId = (typeof SERIES_MENU_IDS)[number];

/** The prefix a series menu `Add {TICKER} to watchlist ›` child carries. */
export const SERIES_ADD_TO_LIST_PREFIX = "series:add-to-watchlist:";

export interface SeriesMenuContext {
  /** The pane's instrument; reduced to a ticker here, whatever is handed in. */
  ticker: string;
  mac: boolean;
  /** A drawing is on the workspace clipboard. */
  canPaste: boolean;
  lists: readonly { id: string; name: string }[];
  /** The series' last price — what the reference's rows name. */
  price: number | null;
  priceLabel: string;
  replayActive: boolean;
  /** Manual trading is available on this installation (the paper ticket). */
  tradingEnabled: boolean;
}

export function seriesLegendMenu(ctx: SeriesMenuContext): MenuEntry[] {
  const hasPrice = ctx.price !== null && Number.isFinite(ctx.price);
  const noPrice = "This series has no loaded price yet";
  const ticker = displayTicker(ctx.ticker);
  const on = ` on ${ticker}${hasPrice ? ` at ${ctx.priceLabel}` : ""}`;
  return [
    {
      id: "series:add-alert", label: `Add alert${on}…`, glyph: "alarm",
      hint: menuCap("add-alert", ctx.mac),
      disabled: !hasPrice || ctx.replayActive,
      disabledReason: ctx.replayActive ? REPLAY_REASON : noPrice,
    },
    // PREPARES the paper ticket, exactly as the chart menu's row does.
    ...(ctx.tradingEnabled ? [{
      id: "series:trade-at-price", label: `Add order${on}…`, glyph: "order" as const,
      disabled: !hasPrice || ctx.replayActive,
      disabledReason: ctx.replayActive ? REPLAY_REASON : noPrice,
    }] : []),
    { id: "sep-add", separator: true },
    { id: "series:add-indicator", label: `Add indicator/strategy on ${ticker}…`, glyph: "indicator" },
    // The watchlist panel's details block, which follows the focused symbol.
    { id: "series:symbol-info", label: "Symbol info…", glyph: "info" },
    { id: "sep-clipboard", separator: true },
    {
      id: "series:copy-price", label: hasPrice ? `Copy price ${ctx.priceLabel}` : "Copy price",
      glyph: "copy", disabled: !hasPrice, disabledReason: noPrice,
    },
    {
      id: "series:paste", label: "Paste", glyph: "paste", hint: menuCap("paste", ctx.mac),
      disabled: !ctx.canPaste, disabledReason: "Copy a drawing first — there is nothing on the clipboard",
    },
    { id: "sep-table", separator: true },
    // No mark, as on the reference; it opens the Object tree / Data window.
    { id: "series:table-view", label: "Table view" },
    { id: "sep-watchlist", separator: true },
    /*
     * One list makes the row the action; more than one makes it a door to
     * them, as the reference draws it. No list at all is absence — there is
     * nowhere to add the symbol to.
     */
    ...(ctx.lists.length > 0 ? [{
      id: "series:add-to-watchlist", label: `Add ${ticker} to watchlist`, glyph: "watchlist" as const,
      ...(ctx.lists.length > 1 ? {
        children: ctx.lists.map((list) => ({
          id: `${SERIES_ADD_TO_LIST_PREFIX}${list.id}`, label: list.name,
        })),
      } : {}),
    }] : []),
    // Arms the text tool; the next click places it (`chart:text-note`'s path).
    { id: "series:text-note", label: `Add text note for ${ticker}`, glyph: "note" },
    { id: "sep-settings", separator: true },
    // Chart settings, which open on their Symbol tab.
    {
      id: "series:chart-settings", label: "Settings…", glyph: "gear",
      hint: menuCap("chart-settings", ctx.mac),
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
   * W2A-10: the saved templates offered on this drawing's tool, by name
   * (`templatesForTool`), for the `Template ›` submenu. Optional so a caller
   * that has none to offer still gets Save as… and Apply default.
   */
  templates?: readonly string[];
  /**
   * W2A-10: which `Visibility on intervals ›` shortcut the drawing's
   * allow-list currently is on this interval (`intervalVisibilityOf`), or
   * null for a list made in the settings dialog that is none of the four.
   */
  intervalVisibility?: IntervalVisibility | null;
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
  "drawing:template-save", "drawing:template-default", "drawing:template-apply",
  "drawing:bring-front", "drawing:send-back",
  "drawing:visibility-above", "drawing:visibility-below",
  "drawing:visibility-only", "drawing:visibility-all",
  "drawing:object-tree",
  "drawing:clone", "drawing:copy",
  "drawing:toggle-lock", "drawing:toggle-hidden", "drawing:remove",
  "drawing:settings",
] as const;
export type DrawingMenuId = (typeof DRAWING_MENU_IDS)[number];

/**
 * A saved template's row emits this prefix plus the template's NAME — one
 * branch for every template, as `CHART_ADD_TO_LIST_PREFIX` is one branch for
 * every watchlist, rather than a case per thing the user has saved.
 */
export const DRAWING_TEMPLATE_APPLY_PREFIX = "drawing:template-apply:";

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
 * ── W2A-10: the reference's middle block, now that each row has a route ────
 *
 * `Template ›`, `Visibility on intervals ›` and `Object tree` were ABSENT,
 * rather than greyed, while nothing could answer them — this file's rule,
 * disabled WITH a reason, is for an action the product has and cannot take
 * right now. Each now reaches something real: drawing templates
 * (`lib/drawings`), the `visibleOn` allow-list the settings dialog's
 * Visibility tab already edits, and the objects panel the chart menu's own
 * `Object tree` opens. The reference's three sync rows stay absent: a drawing
 * here belongs to one instrument's list and there is no layout or global
 * scope to sync it into.
 */
export function drawingMenu(ctx: DrawingMenuContext): MenuEntry[] {
  const reorderReason = "Rendering order is not adjustable for this drawing";
  const visibility = ctx.intervalVisibility ?? null;
  const visibilityRow = (id: string, label: string, choice: IntervalVisibility): MenuEntry => ({
    id, label, radio: true, checked: visibility === choice,
    disabled: ctx.locked, disabledReason: LOCKED_REASON,
  });
  const templates = ctx.templates ?? [];
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
      // Save is offered on a locked drawing — it reads the style, it does
      // not change it. Applying one is an edit, and follows the lock.
      id: "drawing:template", label: "Template",
      children: [
        { id: "drawing:template-save", label: "Save as…" },
        {
          id: "drawing:template-default", label: "Apply default",
          disabled: ctx.locked, disabledReason: LOCKED_REASON,
        },
        ...(templates.length > 0 ? [{ id: "sep-templates", separator: true } as const] : []),
        ...templates.map((name): MenuEntry => ({
          id: `${DRAWING_TEMPLATE_APPLY_PREFIX}${name}`, label: name,
          disabled: ctx.locked, disabledReason: LOCKED_REASON,
        })),
      ],
    },
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
    {
      id: "drawing:visibility", label: "Visibility on intervals",
      children: [
        visibilityRow("drawing:visibility-above", "Current interval and above", "above"),
        visibilityRow("drawing:visibility-below", "Current interval and below", "below"),
        visibilityRow("drawing:visibility-only", "Current interval only", "only"),
        visibilityRow("drawing:visibility-all", "All intervals", "all"),
      ],
    },
    { id: "drawing:object-tree", label: "Object tree" },
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
 * `Add alert on …` joined once the legend could hand it somewhere: the
 * indicator alert dialog, for the six families the alert engine evaluates.
 *
 * The reference's own indicator menu (`measurements/tv-study-context-menu-
 * 20260914.md`) also carries `Visual order ›`,
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
  "study-legend:add-alert",
  "study-legend:settings", "study-legend:toggle-visible",
  "study-legend:object-tree", "study-legend:remove",
] as const;
export type LegendStudyMenuId = (typeof LEGEND_STUDY_MENU_IDS)[number];

export interface LegendStudyMenuContext {
  title: string;
  /**
   * `Add alert on {title}…`, when the alert engine watches this study's
   * family — RSI, MACD, Bollinger, Supertrend, Stochastic, ADX — and null when
   * it does not. During a Replay the row is DISABLED with the reason every
   * other alert row gives (the price is not the market); null is ABSENCE,
   * because an alert on a study the engine cannot evaluate is not a state, it
   * is a row with no route (see above).
   */
  alert?: { replayActive: boolean } | null;
}

export function legendStudyMenu(ctx: LegendStudyMenuContext): MenuEntry[] {
  return [
    /*
     * Premium leads its indicator menu with `Add alert on RSI…`, as the drawing
     * menu leads with its own alert (R8-21): the first row is the one the eye
     * lands on, and on a study the thing a trader does is arm it.
     */
    ...(ctx.alert ? [{
      id: "study-legend:add-alert", label: `Add alert on ${ctx.title}…`, glyph: "alarm" as const,
      disabled: ctx.alert.replayActive,
      disabledReason: REPLAY_REASON,
    }, { id: "sep-alert", separator: true as const }] : []),
    { id: "study-legend:settings", label: "Settings…", glyph: "gear" },
    // The legend only ever draws a study that is currently drawn, so this row
    // hides; the row for a hidden study lives on the legend's own hidden list.
    { id: "study-legend:toggle-visible", label: "Hide", glyph: "eye" },
    { id: "sep-tree", separator: true },
    /*
     * The one row from the reference's indicator menu that this product can
     * genuinely hand somewhere: the chart menu already ships `Object tree` and
     * resolves it to the objects panel, so the legend resolves it the same way
     * rather than opening a second, parallel idea of the same panel.
     */
    { id: "study-legend:object-tree", label: "Object tree", glyph: "tree" },
    { id: "sep-remove", separator: true },
    /*
     * `Remove`, not `Remove <every word of the study's title>`. The drawing
     * menu three functions up already says `Remove` with a trash glyph, so the
     * long form made this menu the odd one out in its own product as well as
     * against the reference — and the title is already the menu's own heading.
     */
    { id: "study-legend:remove", label: "Remove", glyph: "trash", destructive: true },
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
  /**
   * The `Plus button` setting — the axis's hover `+` that arms an alert at
   * the price under the pointer (Chart settings → Scales). Optional so a
   * caller that predates it reads as "on", the setting's own default.
   */
  plusButton?: boolean;
}

export const AXIS_MENU_IDS = [
  "axis:toggle-auto", "axis:toggle-invert",
  "axis:mode-regular", "axis:toggle-percent", "axis:toggle-indexed", "axis:toggle-log",
  "axis:move-left",
  "axis:label-last-value", "axis:label-indicator-value", "axis:label-day-of-week",
  "axis:line-last-value", "axis:line-bid-ask",
  "axis:toggle-plus-button",
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
 * tab.
 *
 * A6: `Plus button` is here now. It was left out when the `+` was always on;
 * since then Chart settings → Scales gained a real `Plus button` setting that
 * `CandleChart` honours, so the reference's row has something to switch.
 * `Lock price to bar ratio` and `Scale price chart only` stay recorded
 * omissions (contract §6): lightweight-charts 4.2 exposes no bar-ratio lock,
 * and nothing in this product keeps the studies out of the price scale's
 * autoscale, so either row would be a switch that does nothing.
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
    { id: "axis:toggle-plus-button", label: "Plus button", checked: ctx.plusButton !== false },
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
  /**
   * The flag this symbol already carries, or null (TVP8 F-05).
   *
   * It decides the first row's verb — `Flag` against `Unflag` — and which
   * swatch the palette announces as checked.
   */
  flag: string | null;
  /** Any symbol anywhere carries a flag, so `Unflag all symbols` has work to do. */
  anyFlagged: boolean;
  /** The seven the palette offers; the product's own `FLAG_COLOURS`. */
  flagColours: readonly { id: string; label: string; hex: string }[];
  /** Comparing needs a pane to compare ON. */
  canCompare: boolean;
  /** The list the row is on, which is not somewhere to add it TO. */
  activeListId: string | null;
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
  "time:reset-view", "time:time-zone", "time:go-to", "time:chart-settings",
] as const;
export type TimeAxisMenuId = (typeof TIME_AXIS_MENU_IDS)[number];

/** `Time zone ›`'s rows emit this prefix plus the zone, e.g. `time:time-zone:Asia/Tokyo`. */
export const TIME_ZONE_MENU_PREFIX = "time:time-zone:";

/**
 * The reference also offers "Lock price to bar ratio" here. It is absent for
 * the same reason `lib/chartSettings.ts` gives for leaving it out of the
 * settings model: lightweight-charts 4.2 exposes no equivalent, and this
 * product does not ship switches that do nothing.
 */
export function timeAxisMenu(ctx: {
  mac: boolean;
  /** The pane's display zone; omitted reads as UTC, the setting's default. */
  timeZone?: ChartTimeZone;
}): MenuEntry[] {
  const zone = ctx.timeZone ?? "UTC";
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
     * A6: `Time zone ›`, the reference's, over the pane's `timeZone` setting
     * (Chart settings → Symbol → Timezone). It was left out when every chart
     * was UTC and the submenu would have had one row; the setting has five
     * zones now and relabels the axis, the crosshair and the clock. The
     * candles never move — only how their instants are written.
     *
     * `Session breaks` stays a recorded omission: there is no session
     * primitive on a 24/7 venue. `Go to…` is this product's and has no
     * reference row.
     */
    {
      id: "time:time-zone", label: "Time zone",
      children: CHART_TIME_ZONES.map((item) => ({
        id: `${TIME_ZONE_MENU_PREFIX}${item.value}`, label: item.label,
        radio: true, checked: item.value === zone,
      })),
    },
    { id: "time:go-to", label: "Go to…", glyph: "calendar" },
    { id: "sep-settings", separator: true },
    { id: "time:chart-settings", label: "More settings…", glyph: "gear" },
  ];
}

export const WATCHLIST_MENU_IDS = [
  "watchlist:flag", "watchlist:flag-colours", "watchlist:unflag-all",
  "watchlist:add-to-list", "watchlist:add-compare", "watchlist:add-note",
  "watchlist:add-section", "watchlist:add-symbol",
  "watchlist:open-focused", "watchlist:open-new-pane", "watchlist:add-alert",
] as const;
export type WatchlistMenuId = (typeof WATCHLIST_MENU_IDS)[number];

/** The reference's exact row menu width, measured at 1440 (TVP8 F-05). */
export const WATCHLIST_MENU_WIDTH = 254;

export function watchlistMenu(ctx: WatchlistMenuContext): MenuEntry[] {
  const ticker = displayTicker(ctx.symbol);
  return [
    /*
     * ── TVP8 F-05: the reference's own row menu ──────────────────────────
     *
     * `08c_tv_watchlist_row_menu.png`: Flag/Unflag and its palette, Unflag
     * all, then the three things you can do WITH the symbol (add it to
     * another list, compare it, note it), then the two that act on the LIST
     * (add a section, add a symbol). This product's menu answered a different
     * question entirely — it opened charts and made alerts, and offered a red
     * `Remove from this list` the reference has no row for at all.
     *
     * The two Trading Scene rows that have no reference equivalent are kept,
     * last, in their own group: opening a row in a second pane and arming an
     * alert on it are real functions of this product, and the queue asks for
     * them to be retained rather than dropped for symmetry.
     */
    {
      id: "watchlist:flag",
      label: `${ctx.flag ? "Unflag" : "Flag"} ${ticker}`,
      glyph: "flag",
    },
    {
      id: "watchlist:flag-colours",
      label: `Flag colour for ${ticker}`,
      swatches: ctx.flagColours,
      selected: ctx.flag,
    },
    {
      id: "watchlist:unflag-all", label: "Unflag all symbols",
      disabled: !ctx.anyFlagged,
      disabledReason: "Nothing on any list is flagged",
    },
    { id: "sep-flags", separator: true },
    /*
     * R7b-18: absent — not greyed — with a single list. There is nowhere to
     * add the row TO until a second list exists, and "disabled with a reason"
     * is for an action that is temporarily unavailable.
     */
    ...(ctx.lists.length > 1 ? [{
      id: "watchlist:add-to-list", label: `Add ${ticker} to watchlist`,
      glyph: "watchlist" as const,
      children: watchlistAddToListMenu(ctx.lists, ctx.activeListId),
    }] : []),
    {
      id: "watchlist:add-compare", label: `Add ${ticker} to compare`,
      glyph: "indicator",
      disabled: !ctx.canCompare,
      disabledReason: "There is no chart pane to compare against",
    },
    { id: "watchlist:add-note", label: `Add note for ${ticker}`, glyph: "note" },
    { id: "sep-list", separator: true },
    { id: "watchlist:add-section", label: "Add section", glyph: "template" },
    { id: "watchlist:add-symbol", label: "Add symbol…", glyph: "copy" },
    { id: "sep-scene", separator: true },
    /* Trading Scene's own, and the reference has no row for either. */
    { id: "watchlist:open-focused", label: "Open in the focused chart", glyph: "eye" },
    {
      id: "watchlist:open-new-pane", label: "Open in a new pane", glyph: "clone",
      disabled: !ctx.canOpenNewPane,
      disabledReason: "The workspace is already at its maximum number of panes",
    },
    {
      id: "watchlist:add-alert", label: `Add alert on ${ticker}`, glyph: "alarm",
      disabled: ctx.replayActive, disabledReason: REPLAY_REASON,
    },
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
