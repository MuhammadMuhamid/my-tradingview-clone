"use client";
/**
 * The workspace's global controls.
 *
 * ── What belongs here and what does not ────────────────────────────────────
 *
 * This bar acts on the WORKSPACE, or on the focused pane as the workspace's
 * current subject. Anything that is genuinely one chart's own — its symbol,
 * its timeframe strip, its maximise button — lives on the pane, where it can
 * be reached without first focusing something.
 *
 * The symbol and interval controls here are the focused pane's, deliberately:
 * they were the page's only symbol controls before this workspace existed, and
 * a user reaching for the top of the screen means "the chart I am looking at".
 * Whether that reaches other panes is the Sync menu's business, not this file's.
 *
 * ── TVP8 owner veto (OV-B): composition, not just height ───────────────────
 *
 * This row was 38px tall like the reference's and still looked nothing like
 * it: the account entry was a glyph+chevron IN the row; Alert lived far to the
 * right of Replay; the chart style was a single dropdown where the reference
 * shows favourite styles as icon radios beside a caret; Trade was an icon;
 * `Last close 77,799 · 9,999 bars · Unnamed` sat in prime toolbar space; the
 * row itself ended where the watchlist began instead of spanning the window.
 *
 * The composition is now the reference's, measured live on 2026-09-14
 * (`measurements/tv-shell-live-inventory-20260914.md` in the campaign folder):
 *
 *   [BTCUSDT] [⊕] │ 1m 5m 15m 1h 4h 1D [⌄] │ [style][style][style] [⌄] │
 *   [indicators] │ [alert] [replay] │ [undo] [redo]   … ml-auto …
 *   [layout] [Unnamed ☁] [⌄] [sync*] │ [search] [settings] [fullscreen]
 *   [camera] [⋯] [ Trade ]
 *
 *   * only with two or more panes — a disabled Sync on a one-pane chart is a
 *     control that teaches "this is broken".
 *
 * Every control is icon-only at every width. The only words on the row are
 * the ticker, the interval chips, the saved layout's name and `Trade`. The
 * price readout and the bar count are gone from the bar: the price is in the
 * legend already, and the bar count is the History-depth group's tooltip in
 * the secondary strip. The account entry is the 52×38 cell at the top of the
 * left-rail column, rendered by the page — the row starts after it.
 *
 * ── The hierarchy ──────────────────────────────────────────────────────────
 *
 * The tier is a property of the CONTROL, declared in `lib/toolbarLayout`:
 *
 *   primary row  — chart context, then the workspace cluster pushed right.
 *   ⋯ menu       — whatever the row has no room for at this width, one
 *                  labelled row per control, and — last, by name — the
 *                  secondary strip.
 *   secondary    — history depth, read-only trading overlays, server-side
 *   strip          automation, strategy properties, the optimizer's best
 *                  config. Opened by name from ⋯, never by a breakpoint.
 *
 * Overflow is PROGRESSIVE: each control leaves the row on its own, lowest
 * priority first, at the width below which it no longer fits
 * (`TOOLBAR_OVERFLOW_FROM` in `lib/toolbarLayout`, the classes in
 * `toolbarDensity.ts`). Each is ONE component rendered in both places with
 * mirrored classes, so at every width it is on the row or in ⋯ — never both,
 * never neither — and the placements cannot drift apart.
 *
 * ── FC2-B1: which element absorbs pressure ─────────────────────────────────
 *
 * Nothing wraps, so the row is always one row. At desktop widths the row is
 * wider than its content. Below `sm` the timeframe strip is not rendered and
 * the SYMBOL pill truncates — a shortened instrument is legible and
 * recoverable; an overlapped control is neither. The invariant, asserted by a
 * pairwise sweep at 320 / 360 / 390 / 430: no two interactive boxes on this
 * bar intersect.
 */
import { useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { type Resolution } from "@/lib/resolution";
import { Separator } from "@/components/ui";
import { ChartTypeMenu } from "@/components/tv/ChartTypeMenu";
import { IndicatorTemplatesMenu, type TemplateStudies } from "@/components/tv/IndicatorTemplatesMenu";
import type { IndicatorTemplate, TemplateApplication } from "@/lib/indicatorTemplates";
import { LayoutSelector } from "@/components/tv/LayoutSelector";
import { LayoutMenu } from "@/components/tv/LayoutMenu";
import { SyncMenu } from "@/components/tv/SyncMenu";
import { TradingOverlayMenu } from "@/components/tv/TradingOverlays";
import type { ChartType } from "@/lib/chartType";
import type { ChartSettings } from "@/lib/chartSettings";
import type { SyncOptions } from "@/lib/paneSync";
import type { Layout } from "@/lib/layouts";
import {
  SEPARATOR, TOOL_BUTTON, TOOL_ICON_BUTTON, TOOL_ICON_SIZE, TOOL_ICON_STROKE,
  TOOL_PILL_OUTLINE, TOOLBAR_ROW_H,
} from "@/components/tv/toolbarChrome";
import { TimeframePicker, type ResolutionPreferences } from "@/components/tv/TimeframePicker";
import {
  TOOLBAR_OVERFLOW_FROM, toolbarGroup, type OverflowControlId, type ToolbarControlId,
} from "@/lib/toolbarLayout";
import { BINDINGS, isMacPlatform } from "@/lib/shortcuts";
import { TOOLBAR_SEPARATOR_TIERS, TOOLBAR_TIERS } from "@/components/tv/toolbarDensity";
import { displaySymbol, displayTicker } from "@/lib/instrument";
import type {
  TradingOverlayItem, TradingOverlayPreferences, TradingOverlayResponse,
} from "@/lib/tradingOverlays";
import {
  FAVOURITES_CHANGED_EVENT, loadFavourites, studyById,
} from "@/lib/native/catalog";

export { SEPARATOR, TOOL_BUTTON, TOOL_ICON_BUTTON, TOOLBAR_H, TOOLBAR_ROW_H } from "@/components/tv/toolbarChrome";
export { TOOLBAR_SEPARATOR_TIERS, TOOLBAR_TIERS } from "@/components/tv/toolbarDensity";

const HISTORY_OPTIONS = [
  { label: "2K", bars: 2000 },
  { label: "10K", bars: 10000 },
  { label: "50K", bars: 50000 },
  { label: "All", bars: 200000 },
];

/**
 * The tier marker every control carries.
 *
 * Spread onto the control itself, so the registry in `lib/toolbarLayout` is
 * what the bar is actually built from rather than a description of it that can
 * drift. It is also what lets a test assert the hierarchy without a DOM.
 */
function ctl(id: ToolbarControlId): { "data-toolbar-control": string; "data-toolbar-group": string } {
  return { "data-toolbar-control": id, "data-toolbar-group": toolbarGroup(id) };
}

/**
 * One glyph frame for every icon on the bar (OV-K, R1c-02).
 *
 * The reference's toolbar icons share a size, a stroke and a GRID; ours were
 * drawn one at a time and read as a different family. The frame is the family;
 * the children are the silhouette.
 *
 * ── Why the viewBox is 28 and the stroke is 1 ──────────────────────────────
 *
 * So that one user unit is one CSS pixel. At 24 units rendered at 22px every
 * coordinate was scaled by 0.917 and every 1.5-wide stroke landed 1.375px
 * across two pixel columns, half-lighting both: our layout glyph carried 128
 * ink px where the reference's carries 68, and the difference was entirely
 * blur rather than shape. At 1:1 a segment on an `x.5` coordinate covers
 * exactly one column. See `toolbarChrome.TOOL_ICON_SIZE`.
 *
 * `crisp` is for the rectilinear glyphs — the ones made only of horizontal and
 * vertical runs, where `crispEdges` plus butt caps and mitred joins removes
 * the last half-pixel of antialiasing at the ends and corners. A glyph with a
 * curve in it keeps round caps, because `crispEdges` would stair-step the arc.
 */
function Glyph(props: {
  children: React.ReactNode; size?: number; stroke?: number; crisp?: boolean;
}) {
  const size = props.size ?? TOOL_ICON_SIZE;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${TOOL_ICON_SIZE} ${TOOL_ICON_SIZE}`}
      fill="none" stroke="currentColor"
      strokeWidth={props.stroke ?? TOOL_ICON_STROKE}
      strokeLinecap={props.crisp ? "butt" : "round"}
      strokeLinejoin={props.crisp ? "miter" : "round"}
      vectorEffect="non-scaling-stroke"
      {...(props.crisp ? { shapeRendering: "crispEdges" as const } : {})}
      aria-hidden="true">
      {props.children}
    </svg>
  );
}

export interface ChartToolbarProps {
  /** The focused pane's instrument and timeframe. */
  symbol: string;
  interval: Resolution;
  onOpenSearch: () => void;
  /** Open the focused pane's comparison dialog. */
  onOpenCompare: () => void;
  onInterval: (interval: Resolution) => void;
  /**
   * The browser's favourite / recent / custom resolutions.
   *
   * Owned by the page rather than by this bar so the pane legend's own
   * timeframe control shows the same favourites and records the same recents:
   * two pickers reading two lists would be two products.
   */
  resolutions: ResolutionPreferences;

  chartType: ChartType;
  onChartType: (type: ChartType) => void;
  /** The focused pane's settings, for the chart-style control's disclosure text. */
  chartSettings?: ChartSettings;

  presetId: string;
  onPreset: (presetId: string) => void;

  sync: SyncOptions;
  onSync: (next: SyncOptions) => void;
  /** One pane: Sync has nothing to act on and is not rendered. */
  syncDisabled: boolean;

  bars: number;
  onBars: (bars: number) => void;
  /** How many bars the focused pane has actually loaded — the History group's tooltip. */
  loadedBars?: number;

  indicatorCount: number;
  onOpenIndicators: () => void;
  /** Insert one persisted favourite into the focused pane. */
  onAddFavoriteIndicator: (id: string) => void;
  /** The focused pane's studies — what `Save indicator template…` captures. */
  indicatorTemplateStudies: TemplateStudies;
  /** Apply a template to the focused pane, and report what landed. */
  onApplyIndicatorTemplate: (t: IndicatorTemplate) => TemplateApplication;

  /** Drawing-history actions, on the primary row like the reference. */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;

  replayActive: boolean;
  replayPickerOpen: boolean;
  onToggleReplayPicker: () => void;
  replayBlocksLiveActions: boolean;

  /** The chart workspace is fullscreen right now. */
  fullscreen: boolean;
  /** The browser permits fullscreen at all; false hides the control entirely. */
  fullscreenSupported: boolean;
  onToggleFullscreen: () => void;
  onOpenChartSettings: () => void;
  onOpenCommandPalette: () => void;
  /** Save or copy a picture of the focused chart. */
  onSnapshot: (mode: "save" | "copy") => void;

  overlayMenuOpen: boolean;
  onOverlayMenuOpen: (open: boolean) => void;
  overlayPrefs: TradingOverlayPreferences;
  onOverlayPrefs: (next: TradingOverlayPreferences) => void;
  overlayData: TradingOverlayResponse | null;
  overlaysLoading: boolean;
  overlayError: string | null;
  overlayItems: TradingOverlayItem[];
  onSelectOverlay: (id: string) => void;

  onOpenPriceAlert: () => void;
  onOpenAutomation: () => void;
  onOpenManual: () => void;
  onOpenStrategy: () => void;
  onApplyBest: () => void;
  loadingBest: boolean;

  layouts: Layout[];
  /** TVP8 F-07: layout ids most-recently-opened first. */
  layoutRecents?: string[];
  currentLayoutId: string | null;
  autosave: boolean;
  layoutDirty: boolean;
  autosaveError: string | null;
  layoutHandlers: {
    onSelect: (id: string) => void;
    onSaveNow: () => void;
    onToggleAutosave: () => void;
    onCreate: () => void;
    onCopy: () => void;
    onRename: () => void;
    onDelete: (id: string) => void;
    onDownload: () => void;
  };

  moreOpen: boolean;
  onMoreOpen: (open: boolean) => void;
}

/**
 * Where a control is being drawn: on the primary row, or as a row of the ⋯
 * menu. Every overflowable control is ONE component rendered in both places,
 * each copy carrying the mirrored half of its tier (`TOOLBAR_TIERS`), so at any
 * width exactly one copy is displayed and the two cannot drift apart.
 */
type Placement = "row" | "menu";

/** What a two-placement cluster is handed: the bar's props, where it is, and what has overflowed. */
type ClusterProps = ChartToolbarProps & {
  placement: Placement;
  /** Null while ⋯ is closed; then only the row copies exist. See `placed`. */
  overflowed: ReadonlySet<OverflowControlId> | null;
};

const tier = (id: OverflowControlId, placement: Placement): string => TOOLBAR_TIERS[id][placement];

/**
 * One row of the ⋯ menu: the control's own cell, then its name.
 *
 * The cell IS the control — the same button, the same popover — so a row that
 * opens a menu (the layout grid, the saved layouts, Sync, the camera) opens
 * the real one, anchored where it is drawn. The name is what makes this a
 * list a reader can scan rather than a second toolbar of unlabelled glyphs;
 * clicking it presses the cell, so the whole row is the target. It is
 * `aria-hidden` because the cell already carries the control's accessible
 * name, and a row that announced itself twice would say it twice.
 */
function OverflowRow({ label, className, children }: {
  label: string; className: string; children: React.ReactNode;
}) {
  return (
    <div data-overflow-row
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button, [role='menu'], [role='dialog']")) return;
        e.currentTarget.querySelector<HTMLButtonElement>("button")?.click();
      }}
      className={`h-[38px] cursor-pointer items-center gap-1 rounded-md pr-3 hover:bg-state-hover ${className}`}>
      <span className="flex shrink-0 items-center">{children}</span>
      <span aria-hidden="true" className="min-w-0 flex-1 truncate text-sm text-ink">{label}</span>
    </div>
  );
}

/**
 * Which overflowable controls this viewport puts in ⋯ — the same media
 * queries the tier classes compile to, read when ⋯ opens and on resize while
 * it is open.
 */
function overflowedNow(): ReadonlySet<OverflowControlId> {
  const ids = Object.keys(TOOLBAR_OVERFLOW_FROM) as OverflowControlId[];
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return new Set(ids);
  return new Set(ids.filter((id) =>
    !window.matchMedia(`(min-width: ${TOOLBAR_OVERFLOW_FROM[id]}px)`).matches));
}

/**
 * A control in its placement: a labelled ⋯ row, or a bare cell on the row with
 * its tier.
 *
 * ── Why the hidden twin is UNMOUNTED while ⋯ is open ──────────────────────
 *
 * The CSS alone decides which copy is displayed, and that is enough while ⋯
 * is closed — only the row copies exist. With ⋯ open, a control that has
 * overflowed exists twice, and the popovers inside it are exclusive BY ID:
 * the camera, the layout grid, the saved layouts and Sync opened in the menu
 * open their `display: none` twin on the row as well, and that twin's
 * outside-click handler then closes the shared popover on the very mousedown
 * that was choosing a row in it. So while ⋯ is open, `overflowed` says which
 * copy exists at all, and exactly one of each is mounted.
 */
function placed(
  placement: Placement, id: OverflowControlId, label: string, node: React.ReactNode,
  overflowed: ReadonlySet<OverflowControlId> | null,
) {
  if (overflowed && overflowed.has(id) === (placement === "row")) return null;
  return placement === "menu"
    ? <OverflowRow label={label} className={tier(id, "menu")}>{node}</OverflowRow>
    : <div className={`shrink-0 items-center ${tier(id, "row")}`}>{node}</div>;
}

/**
 * Layout, saved layout, sync, and the utilities — the right-hand group.
 *
 * Rendered twice, once per placement. On the row each control leaves at its
 * own width; in the ⋯ menu the same control is a labelled row from exactly
 * that width down. See `TOOLBAR_OVERFLOW_FROM` for the order and the numbers.
 */
function WorkspaceActions(props: ClusterProps) {
  const { placement } = props;
  const place = (id: OverflowControlId, label: string, node: React.ReactNode) =>
    placed(placement, id, label, node, props.overflowed);
  return (
    <div className={placement === "menu" ? "flex flex-col" : "flex min-w-0 items-center"}>
      {place("layout", "Chart layout",
        <div {...ctl("layout")} className="flex shrink-0 items-center">
          <LayoutSelector presetId={props.presetId} onChange={props.onPreset} />
        </div>)}

      {/*
        The saved layout's name is the row's one ABSORBER: it truncates rather
        than pushing ⋯ off the edge, so it is not wrapped in a `shrink-0` box.
      */}
      {props.overflowed && props.overflowed.has("savedLayouts") === (placement === "row")
        ? null
        : placement === "menu"
          ? <OverflowRow label="Saved layouts" className={tier("savedLayouts", "menu")}>
            <SavedLayoutIdentity {...props} className="flex" />
          </OverflowRow>
          : <SavedLayoutIdentity {...props} className={tier("savedLayouts", "row")} />}

      {/*
        Sync is Trading Scene's own: the reference has no multi-chart sync
        control on the bar. It sits beside the layout controls it belongs with,
        and only exists when there are two or more panes to synchronise.
      */}
      {!props.syncDisabled && place("sync", "Sync panes",
        <div {...ctl("sync")} className="flex shrink-0 items-center">
          <SyncMenu value={props.sync} onChange={props.onSync} disabled={false} />
        </div>)}

      {placement === "row" && (
        <Separator className={`${SEPARATOR} ${TOOLBAR_SEPARATOR_TIERS.beforeUtilities}`} />
      )}

      {/* The reference's order: quick search, settings, fullscreen, snapshot. */}
      {place("commandPalette", "Search tool or function",
        <button {...ctl("commandPalette")} onClick={props.onOpenCommandPalette}
          data-tooltip="Search tool or function"
          aria-label="Search tool or function" className={TOOL_ICON_BUTTON}>
          {/*
            R1b-03: a plain magnifier was the blind reviewer's first clue. The
            reference's quick-search glyph is a lens with a LIGHTNING BOLT in it,
            the bolt breaking the ring at the top — 18×21, not 16×16.
            R1c-02: same silhouette, redrawn at 1px on the 28-unit grid.
          */}
          <Glyph>
            {/*
              The ring is an ARC with a gap where the bolt enters and leaves. It
              used to be a closed circle with the bolt laid over it, so ring and
              bolt crossed twice and the centre of the glyph turned to mush — 54%
              more ink than the reference in the same space.
            */}
            <path d="M15.4 6.3A7 7 0 1 0 13.1 19.9" />
            <path d="M17.2 18.2L22.5 23.5" />
            <path d="M14.5 4L9.5 13.5h4.5l-1.5 7 5.5-9.5h-4.5z" />
          </Glyph>
        </button>)}

      {place("chartSettings", "Chart settings",
        <button {...ctl("chartSettings")} onClick={props.onOpenChartSettings}
          data-tooltip="Chart settings — symbol, status, scales, canvas, trading and events"
          aria-label="Chart settings" className={TOOL_ICON_BUTTON}>
          {/*
            R1b-03: ours was a narrow POINTY-TOP hexagon at 16×18; the
            reference's is a wide FLAT-TOP one at 22×18 with a ring inside.
          */}
          <Glyph>
            <path d="M9 5.5h10l5.5 8.5-5.5 8.5H9L3.5 14z" />
            <circle cx="14" cy="14" r="4" />
          </Glyph>
        </button>)}

      {/*
        Hidden rather than disabled when the browser will not allow it: an inert
        fullscreen button teaches the user the feature is broken, and
        `fullscreenEnabled` is false for reasons the page cannot fix (an iframe
        without the permission, a locked-down policy).
      */}
      {props.fullscreenSupported && place("fullscreen", props.fullscreen ? "Exit fullscreen" : "Fullscreen",
        <button
          {...ctl("fullscreen")}
          onClick={props.onToggleFullscreen}
          aria-pressed={props.fullscreen}
          data-tooltip={props.fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen the chart workspace"}
          aria-label={props.fullscreen ? "Exit fullscreen" : "Fullscreen"}
          className={TOOL_ICON_BUTTON}
        >
          {/* R1c-02: four 13px brackets, 52 ink px, on the pixel grid. */}
          <Glyph crisp>
            {props.fullscreen
              ? <><path d="M12.5 6.5v6h-6" /><path d="M15.5 21.5v-6h6" /><path d="M21.5 12.5h-6v-6" /><path d="M6.5 15.5h6v6" /></>
              : <><path d="M6.5 12.5v-6h6" /><path d="M21.5 15.5v6h-6" /><path d="M15.5 6.5h6v6" /><path d="M12.5 21.5h-6v-6" /></>}
          </Glyph>
        </button>)}

      {place("snapshot", "Chart image", <SnapshotMenu onSnapshot={props.onSnapshot} />)}
    </div>
  );
}

/**
 * The two rows the camera menu offers, and the hotkeys that reach them.
 *
 * The glyphs are drawn in a 17-unit box at 17px for the same 1:1 reason the
 * toolbar's are drawn in 28 at 28 (R1c-02): an arrow into a tray, and two
 * overlapping sheets. The caps are the reference's own bindings, wired in
 * `lib/shortcuts`.
 */
const SNAPSHOT_ROWS = [
  {
    mode: "save" as const,
    action: "snapshot-save" as const,
    label: "Download image",
    glyph: (
      <>
        <path d="M8.5 2.5v7.5" />
        <path d="M5.5 7.5l3 3 3-3" />
        <path d="M2.5 11.5v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" />
      </>
    ),
  },
  {
    mode: "copy" as const,
    action: "snapshot-copy" as const,
    label: "Copy image",
    glyph: (
      <>
        <rect x="5.5" y="2.5" width="9" height="9" rx="1.5" />
        <path d="M11.5 14.5h-8a1 1 0 0 1-1-1v-8" />
      </>
    ),
  },
];

/**
 * The cap a snapshot row prints, read from the keyboard table itself.
 *
 * Never a literal. A menu that prints `⌥⌘S` beside a row the app does not
 * bind teaches the user the feature is broken the first time they press it,
 * and the review's own repair for the alert dialog is the same rule applied to
 * a different lie. `lib/shortcuts.BINDINGS` is the one place a chord exists,
 * so if a binding is removed this cap disappears with it.
 */
function snapshotCap(action: "snapshot-save" | "snapshot-copy"): string {
  const mac = isMacPlatform();
  const binding = BINDINGS.find((b) => b.action === action && !b.chordless);
  if (!binding) return "";
  const parts: string[] = [];
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) parts.push(mac ? "⌥" : "Alt");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join(mac ? "" : "+");
}

/** The camera: Download image / Copy image, as the reference's own camera offers. */
function SnapshotMenu({ onSnapshot }: { onSnapshot: (mode: "save" | "copy") => void }) {
  const [open, setOpen] = useExclusivePopover("toolbar:snapshot");
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // The camera's menu had no Escape at all; every other menu on the bar
    // closes on it and hands the keyboard back to the button that opened it.
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative">
      <button {...ctl("snapshot")}
        ref={buttonRef}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip="Chart image"
        aria-label="Chart image" className={TOOL_ICON_BUTTON}>
        {/*
          R1b-03: 21×17, not 18×14 — the reference's camera nearly fills its
          cell. R1c-02: a 21×15 body with a 3px lens ring and a 6×2 hump at the
          top-left, at 1px on the grid.
        */}
        <Glyph>
          <rect x="3.5" y="7.5" width="20" height="14" rx="1.5" />
          <path d="M6.5 7.5v-2h5v2" />
          <circle cx="13.5" cy="14.5" r="3" />
        </Glyph>
      </button>
      {open && (
        /*
          ── TVP8 R1c-12: the camera's menu, measured ───────────────────────

          `tradingview/tv-snapshot-menu-1440-dark.png` +
          `measurements/tv-snapshot-menu-20260914.md`: 212 wide, right-aligned
          under the cell, top 2px below the 38px bar, a `CHART SNAPSHOT`
          heading in 11px caps, then 32px rows each carrying a 17px glyph in
          the left gutter, a 14px FULL-INK label and a hotkey cap at the right.

          Ours was 196 wide, two 40px rows, no glyphs, no hotkeys, no heading,
          and — the part that made it read as disabled — every label at
          rgb(168). A menu whose entire contents are muted says "none of this
          is available"; muted is the grammar for a row that is genuinely not
          actionable, not for a row you are being offered.

          Copy link / Open in new tab / Tweet image are TradingView's hosted
          snapshot service and are deliberately absent (R1c-24).
        */
        <div role="menu" aria-label="Chart image"
          className="tvc-menu tvc-menu--compact absolute right-0 top-full z-50 mt-[2px] w-[212px]">
          <div className="flex h-[22px] items-center px-2.5 text-[11px] uppercase tracking-wide text-ink-faint">
            Chart snapshot
          </div>
          {SNAPSHOT_ROWS.map(({ mode, action, label, glyph }) => (
            <button
              key={mode}
              role="menuitem"
              onClick={() => { setOpen(false); onSnapshot(mode); }}
              className="tvc-menu-row w-full gap-2.5 px-2.5 text-left text-sm text-ink"
            >
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor"
                strokeWidth={TOOL_ICON_STROKE} strokeLinecap="round" strokeLinejoin="round"
                className="shrink-0" aria-hidden="true">
                {glyph}
              </svg>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="shrink-0 text-[12px] text-ink-faint">{snapshotCap(action)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compare, in the two places it has to be.
 *
 * Beside the symbol at `sm` and above, where the reference puts it and where a
 * comparison is started from; in the ⋯ menu below, one tap away. Showing
 * it at every width was tried first and MEASURED: at 320px it pushes `More`
 * 41px past the right edge.
 */
function CompareButton(props: ChartToolbarProps & { className: string }) {
  return (
    <button
      {...ctl("compare")}
      onClick={props.onOpenCompare}
      data-tooltip="Compare this chart with another instrument"
      aria-label="Compare with another instrument"
      className={`${TOOL_ICON_BUTTON} ${props.className}`}
    >
      {/*
        R1b-03: 19×19. Ours drew the same ⊕ two pixels small in every
        direction. R1c-02: a thin ring with a 1px plus, ink box 19×19 at (9,10)
        inside the 38px cell.
      */}
      <Glyph><circle cx="13.5" cy="14.5" r="9" /><path d="M13.5 9.5v10M8.5 14.5h10" /></Glyph>
    </button>
  );
}

/**
 * The word beside a glyph, at the one width the reference prints one (R1c-17).
 *
 * Measured at 1920×1080 on `tradingview/tv-shell-1920x1080-dark.png`: the bar
 * grows a LABEL on exactly three cells — `Indicators` (x 654–715, 62px),
 * `Alert` (811–840) and `Replay` (889–930) — and on nothing else. The
 * favourite intervals and the chart styles stay icon-only, the toolbar stays
 * 38px, the rails stay 52 and 45, and the chart absorbs every other pixel of
 * the extra width. It is a density step, not a responsive layout.
 *
 * `2xl` (1536) is the breakpoint because the reference shows the words at 1920
 * and does not show them at 1440, and 1536 is the only stop between the two.
 * The cell gives up its fixed 38px width at the same breakpoint, or the word
 * would be drawn outside the button it belongs to.
 */
function WideLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="hidden shrink-0 pl-1 pr-2 text-sm leading-[18px] text-ink 2xl:inline">
      {children}
    </span>
  );
}

/** An icon cell that grows a word at `2xl`. See `WideLabel`. */
const TOOL_LABELLED_BUTTON = `${TOOL_ICON_BUTTON} 2xl:w-auto`;

/** The split-button half beside Indicators: persisted built-in favourites. */
function FavoriteIndicatorsMenu({ onAdd }: { onAdd: (id: string) => void }) {
  const [open, setOpen] = useExclusivePopover("toolbar-favorite-indicators");
  const [ids, setIds] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const refresh = () => setIds(loadFavourites());

  useEffect(() => {
    refresh();
    const changed = () => refresh();
    window.addEventListener(FAVOURITES_CHANGED_EVENT, changed);
    return () => window.removeEventListener(FAVOURITES_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    if (!open) return;
    refresh();
    const down = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, setOpen]);

  const favourites = ids.flatMap((id) => {
    const def = studyById(id);
    return def ? [def] : [];
  });
  return (
    <div ref={boxRef} className="relative flex h-[38px] w-6 shrink-0 items-center">
      <button type="button" aria-label="Favorite indicators" aria-haspopup="menu"
        aria-expanded={open} data-tooltip="Favorite indicators"
        onClick={() => setOpen(!open)}
        className="tvc-control flex h-[38px] w-6 items-center justify-center text-ink">
        <svg width="8" height="6" viewBox="0 0 8 6" fill="none" stroke="currentColor"
          strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 1.5L4 4.5L7 1.5" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label="Favorite indicators"
          className="tvc-menu absolute left-0 top-full z-50 mt-1 min-w-[220px]">
          {favourites.length === 0 ? (
            <button type="button" role="menuitem" disabled
              className="tvc-menu-row px-3 text-left text-sm text-ink-faint disabled:cursor-default">
              No favourites yet
            </button>
          ) : favourites.map((def) => (
            <button key={def.id} type="button" role="menuitem"
              className="tvc-menu-row px-3 text-left text-sm text-ink"
              onClick={() => { onAdd(def.id); setOpen(false); }}>
              {def.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Studies, templates, Alert and Replay — chart context, and the part of it a
 * narrow row gives up first. Same one-component-two-placements shape as
 * `WorkspaceActions`, for the same reason.
 */
function ContextActions(props: ClusterProps) {
  const { replayActive, replayBlocksLiveActions, placement } = props;
  const place = (id: OverflowControlId, label: string, node: React.ReactNode) =>
    placed(placement, id, label, node, props.overflowed);
  return (
    <div className={placement === "menu" ? "flex flex-col" : "flex items-center"}>
      {place("indicators", "Indicators", <>
        <button
          {...ctl("indicators")}
          onClick={props.onOpenIndicators}
          data-tooltip="Indicators, metrics, and strategies"
          aria-label={props.indicatorCount > 0
            ? `Indicators — ${props.indicatorCount} on the focused chart`
            : "Indicators"}
          className={TOOL_LABELLED_BUTTON}
        >
          {/*
            R1b-03 / BLIND clue 3: a rising line over three HOLLOW bars and NO
            baseline. Ours drew a peaked line over four filled ticks sitting on a
            solid rule, which is the generic "chart" glyph the blind reviewer
            named as a tell.
          */}
          {/*
            Scaled into the family's safe margin. The polyline used to terminate
            at y=0 — the top edge of the 28-unit box — so at stroke width 1 the
            ink began at y=-0.5 and the glyph was CLIPPED, while also sitting
            about 5px above the optical baseline of every neighbour on the row.
            Ink is now 16.2x18 inset at (5.9, 5), which is the reference's.
          */}
          <Glyph>
            <path d="M5.9 16.4L10.3 12.0L13.6 14.9L16.6 10.9L21.3 5.0" strokeLinejoin="miter" />
            <rect x="5.9" y="18.6" width="4.4" height="4.4" />
            <rect x="11.8" y="17.1" width="4.4" height="5.9" />
            <rect x="17.7" y="14.9" width="4.4" height="8.1" />
          </Glyph>
          {placement === "row" && <WideLabel>Indicators</WideLabel>}
        </button>
        {/* The favourites caret travels with Indicators; it is that button's other half. */}
        <FavoriteIndicatorsMenu onAdd={props.onAddFavoriteIndicator} />
      </>)}

      {/* The reference's 2×2-grid Indicator templates button, beside Indicators. */}
      {place("templates", "Indicator templates",
        <IndicatorTemplatesMenu studies={props.indicatorTemplateStudies} onApply={props.onApplyIndicatorTemplate} />)}

      {placement === "row" && (
        <Separator className={`${SEPARATOR} ${TOOLBAR_SEPARATOR_TIERS.beforeAlert}`} />
      )}

      {/*
        FE-01: this bell used to open the deployment dialog, which created AND
        activated a live 800 USDT strategy. An alert means "tell me when";
        automation has its own button in the secondary strip that says what it does.
      */}
      {place("alert", "Create alert",
        <button
          {...ctl("alert")}
          onClick={props.onOpenPriceAlert} disabled={replayBlocksLiveActions}
          data-tooltip={replayActive ? "Exit Replay to create live alerts" : "Create alert"}
          aria-label="Create alert"
          className={TOOL_LABELLED_BUTTON}
        >
          {/*
            R1b-03 / BLIND clue 2: a clock DIAL whose ring is broken at the lower
            right by the `+`, with the alarm arcs over the top — 21×21. Ours put
            the plus INSIDE a closed ring with two bells on top, which reads as a
            stopwatch.
          */}
          {/* R1c-02: ink box 21×21 at (8,9) in the cell — a 17px ring, a dashed
              upper-right arc, two hands, and a 7×7 plus breaking the ring. */}
          <Glyph>
            {/* the dial, opened at the lower right so the plus breaks the ring */}
            <path d="M19.3 16.7A8 8 0 1 0 15.7 20.3" />
            {/* the hands */}
            <path d="M11.5 7.5v5h3.5" />
            {/* the alarm's arc, over the upper right */}
            <path d="M14.2 4.2a9 9 0 0 1 5.4 3.9" strokeDasharray="2 2" />
            {/* the plus, sitting in the gap */}
            <path d="M20.5 18.5v6M17.5 21.5h6" />
          </Glyph>
          {placement === "row" && <WideLabel>Alert</WideLabel>}
        </button>)}

      {place("replay", "Bar replay",
        <button
          {...ctl("replay")}
          onClick={props.onToggleReplayPicker}
          aria-pressed={replayActive || props.replayPickerOpen}
          aria-label="Bar replay"
          data-tooltip={replayActive ? "Replay is active" : "Bar replay — start from a historical point"}
          className={TOOL_LABELLED_BUTTON}
        >
          {/*
            Double rewind. R1c-02: the reference's is 15×13 at (12,13) — two
            unfilled left-pointing triangles 7 wide sharing the vertical centre,
            and no bars beside them (74 ink px, not 149).
          */}
          <Glyph>
            <path d="M14 8.5L7.5 14.5 14 20.5Z" />
            <path d="M21.5 8.5L15 14.5 21.5 20.5Z" />
          </Glyph>
          {placement === "row" && <WideLabel>Replay</WideLabel>}
        </button>)}
    </div>
  );
}

/** Undo and redo — on the row from `TOOLBAR_OVERFLOW_FROM.undo` up, in ⋯ below it. */
function EditHistory(props: ClusterProps) {
  const { placement } = props;
  const place = (id: OverflowControlId, label: string, node: React.ReactNode) =>
    placed(placement, id, label, node, props.overflowed);
  return (
    <div className={placement === "menu" ? "flex flex-col" : "flex shrink-0 items-center"}
      aria-label="Edit history">
      {place("undo", "Undo",
        <button
          {...ctl("undo")}
          onClick={props.onUndo}
          disabled={!props.canUndo}
          aria-label="Undo"
          data-tooltip="Undo last drawing change"
          className={TOOL_ICON_BUTTON}
        >
          {/*
            A long open arc into a clear arrowhead. The radius-3 return this
            replaces curled the tail back under itself, closing the shape into
            something that read as a small circle at 1x rather than as a
            reversal. Ink is 13x11 with the head well clear of the tail.
          */}
          <Glyph><path d="M11 9L7 13l4 4" /><path d="M7 13h9a3.5 3.5 0 0 1 0 7h-2" /></Glyph>
        </button>)}
      {place("redo", "Redo",
        <button
          {...ctl("redo")}
          onClick={props.onRedo}
          disabled={!props.canRedo}
          aria-label="Redo"
          data-tooltip="Redo last drawing change"
          className={TOOL_ICON_BUTTON}
        >
          {/* The same box, mirrored about the cell's centre. */}
          <Glyph><path d="M17 9l4 4-4 4" /><path d="M21 13h-9a3.5 3.5 0 0 0 0 7h2" /></Glyph>
        </button>)}
    </div>
  );
}

/** The saved layout this workspace is on, and whether it is behind. */
function SavedLayoutIdentity(props: ChartToolbarProps & { className: string }) {
  return (
    <div {...ctl("savedLayouts")} className={`min-w-0 items-center ${props.className}`}>
      <LayoutMenu
        autosaveError={props.autosaveError}
        layouts={props.layouts}
        recents={props.layoutRecents}
        currentId={props.currentLayoutId}
        autosave={props.autosave}
        dirty={props.layoutDirty}
        {...props.layoutHandlers}
      />
    </div>
  );
}

/**
 * The Trade pill — the row's last control, as the reference's bar ends in
 * one. The paper / demo / testnet order ticket; nothing here can reach a
 * live exchange.
 */
function TradeButton(props: ChartToolbarProps & { className: string }) {
  return (
    <button
      {...ctl("trade")}
      onClick={props.onOpenManual} disabled={props.replayBlocksLiveActions}
      data-tooltip={props.replayActive ? "Exit Replay to trade" : "Paper / demo / testnet order ticket"}
      aria-label="Trade"
      className={`${TOOL_PILL_OUTLINE} ${props.className}`}
    >
      Trade
    </button>
  );
}

export function ChartToolbar(props: ChartToolbarProps) {
  const { symbol, interval, replayActive } = props;
  /*
   * TVP7. The pill used to read `OANDA:EUR/USD · FX` — a venue, a
   * separator and an asset-class tag, in the one control a user aims at first.
   * That is the canonical identity, and it is genuinely useful, but it is not
   * what names an instrument on a workstation: TradingView's pill says
   * `BTCUSDT` and the venue, the product type and the long name live in the
   * chart's status line and in the symbol dialog, where there is room to read
   * them. So the pill carries the ticker and the FULL identity stays in the
   * control's tooltip and accessible name.
   */
  const symbolLabel = displaySymbol(symbol);
  const tickerLabel = displayTicker(symbol);
  const { moreOpen, onMoreOpen } = props;
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  /*
   * The ⋯ menu's own state. Not an exclusive popover: the layout grid, the
   * saved-layout menu, Sync and the camera open FROM inside it, and each of
   * those is exclusive — registering this one too would close the menu the
   * moment any of its rows opened.
   */
  const [overflowed, setOverflowed] = useState<ReadonlySet<OverflowControlId> | null>(null);
  const overflowOpen = overflowed !== null;
  const setOverflowOpen = (open: boolean): void => setOverflowed(open ? overflowedNow() : null);

  // A resize while ⋯ is open moves controls between the row and the menu.
  useEffect(() => {
    if (!overflowOpen) return;
    const onResize = (): void => setOverflowed(overflowedNow());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [overflowOpen]);

  useEffect(() => {
    if (!overflowOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!overflowRef.current?.contains(e.target as Node)) setOverflowed(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [overflowOpen]);

  /*
   * Escape closes the TOP layer only (B-23).
   *
   * This listener is registered on the window like every other overlay's, and
   * window listeners run in registration order — so it would run BEFORE the
   * listener of a menu opened later from inside the ⋯ menu, and close both. It
   * therefore stands aside while a menu is open inside its own panel. A layer
   * that sits ABOVE the bar altogether — the phone's More sheet — takes the
   * key in the capture phase and stops it, so it never arrives here.
   *
   * Not `defaultPrevented`: the shortcut layer, registered first, claims
   * Escape for `tool:cursor` on every press, and honouring that would mean the
   * dropdown could never be closed from the keyboard.
   */
  useEffect(() => {
    if (!overflowOpen && !moreOpen) return;
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (overflowOpen) {
        if (overflowRef.current?.querySelector("[id='chart-toolbar-overflow'] [role='menu']")) return;
        e.preventDefault();
        setOverflowed(null);
        moreButtonRef.current?.focus();
        return;
      }
      e.preventDefault();
      onMoreOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [overflowOpen, moreOpen, onMoreOpen]);

  const loaded = props.loadedBars;

  return (
    <div className="min-w-0 flex-1 bg-surface">
      {/* ── primary row: chart context, then the workspace cluster pushed right ── */}
      <div
        data-toolbar-row="primary"
        className={`flex ${TOOLBAR_ROW_H} flex-nowrap items-center pl-1 pr-1.5`}
      >
        {/*
          The instrument keeps its pill. TradingView's symbol control is also
          the one rounded, filled thing on an otherwise square bar — it is the
          subject the whole workspace is about, and it is the control a user
          aims at first, so it is allowed to be the one that stands out.

          The truncating label is what makes the mobile row safe: this is the
          element that gives width back when the viewport cannot hold the row.
          `min-w-[44px]` and not `min-w-0`, because the touch rule in
          `globals.css` sets a 44px minimum WIDTH without `!important` and a
          utility class outranks it.
        */}
        <button
          {...ctl("symbol")}
          onClick={props.onOpenSearch}
          data-tooltip={`${symbolLabel} — change symbol (/)`}
          aria-label={`Change symbol — currently ${symbolLabel}`}
          /*
            ── R1c-04: the ticker is SEMIBOLD, and the pixels say so ─────────

            Wave 2 set this to 400 on the blind reviewer's clue 8. Round 3
            measured it instead: the reference's `BTCUSDT` is a 64px glyph run
            carrying 306 ink px at 10px caps, and ours at 400 measured 61px and
            286. Three pixels over seven glyphs is exactly the 400→600 step of
            this font stack, and round 2 had already measured semibold in BOTH
            products. Where a clue and a measurement disagree the measurement
            wins.

            R1c-18, PARTIAL and deliberately so: from `sm` up the pill no
            longer shortens anything — `sm:shrink-0` with the ellipsis turned
            off, so `BTCUSDT` is `BTCUSDT` at every width this product targets.
            BELOW `sm` it still truncates, because this element is the row's
            only compressible one (FC2-B1) and the alternative the reference
            uses — letting the primary row scroll sideways — cannot be adopted
            here: four of this row's controls open popovers, and an
            `overflow-x-auto` ancestor clips every one of them. Removing the
            truncation outright at 320px would put two interactive boxes on top
            of each other, which is the defect the pairwise sweep exists to
            prevent. Recorded for the owner in the round-4 report.
          */
          className="flex h-7 min-w-[44px] shrink items-center rounded-full bg-state-active px-3 text-sm font-semibold text-ink hover:brightness-110 sm:shrink-0"
        >
          <span className="min-w-0 truncate sm:overflow-visible sm:text-clip">{tickerLabel}</span>
        </button>

        {!overflowed?.has("compare") && <CompareButton {...props} className={tier("compare", "row")} />}

        <Separator className={`${SEPARATOR} ${TOOLBAR_SEPARATOR_TIERS.context}`} />

        {/*
          The timeframe control: favourites as text chips, then a caret that
          opens the full list. What resolutions exist, which are favourites and
          how a custom one is entered all belong to `TimeframePicker`; this bar
          only decides where the control sits and what tier it is in. Below
          `sm` the strip is not rendered and the wrapper must not shrink below
          the caret it holds (FC2-B1).
        */}
        <div {...ctl("timeframe")} className="flex shrink-0 items-center">
          <TimeframePicker
            interval={interval}
            onInterval={props.onInterval}
            preferences={props.resolutions}
          />
        </div>

        <Separator className={`${SEPARATOR} ${TOOLBAR_SEPARATOR_TIERS.context}`} />

        {/*
          The chart-style control is a slot: favourite styles as icon radios
          and a caret that opens the full list. What presentations exist, and
          how the main series draws them, belongs to the chart-type system.
        */}
        <div {...ctl("chartType")} className="flex shrink-0 items-center">
          <ChartTypeMenu value={props.chartType} onChange={props.onChartType}
            settings={props.chartSettings} />
        </div>

        <Separator className={`${SEPARATOR} ${TOOLBAR_SEPARATOR_TIERS.context}`} />

        <ContextActions {...props} placement="row" overflowed={overflowed} />

        <Separator className={`${SEPARATOR} ${TOOLBAR_SEPARATOR_TIERS.beforeUndo}`} />

        <EditHistory {...props} placement="row" overflowed={overflowed} />

        {/* ── the right-hand group ── */}
        <div className="ml-auto flex min-w-0 shrink items-center">
          <WorkspaceActions {...props} placement="row" overflowed={overflowed} />

          {/*
            ⋯ — the way in to everything the row is too narrow for, so it is on
            the row at every width and never shrinks.

            It opens a DROPDOWN of exactly the controls the row is not drawing
            at this width, each a labelled row, and — last, by name — the
            history / overlays / automation strip. It used to open that strip
            itself: a second 38px row of HISTORY 2K 10K 50K All · Overlays ·
            Automate · Strategy · Best config that appeared under the bar at
            every width, including 1440 where nothing had overflowed at all.
          */}
          <div ref={overflowRef} className="relative flex shrink-0 items-center">
            <button
              {...ctl("more")}
              ref={moreButtonRef}
              onClick={() => setOverflowOpen(!overflowOpen)}
              aria-haspopup="true"
              aria-expanded={overflowOpen}
              aria-controls="chart-toolbar-overflow"
              aria-label="More controls"
              data-tooltip="More controls"
              className={TOOL_ICON_BUTTON}
            >
              <Glyph stroke={2.6}><path d="M6.5 14h.01M14 14h.01M21.5 14h.01" /></Glyph>
            </button>
            {overflowOpen && (
              /*
                A `group` on the popover SURFACE, not a `menu`: its rows are the
                real controls, several of which open menus of their own, and a
                screen reader must not be promised `menuitem` children it will
                not find. No `overflow` on the panel — a clipped panel would
                clip the menus its rows open.
              */
              <div
                id="chart-toolbar-overflow"
                data-toolbar-overflow
                role="group"
                aria-label="More controls"
                onClick={(e) => {
                  /*
                    An action closes the menu once it has run. A row that opens
                    a menu of its own (`aria-haspopup`) keeps it open so that
                    menu can be used, and a checkbox row in it (Sync's options)
                    keeps it open so several can be ticked; choosing anything
                    else in such a menu is an action, and closes it.
                  */
                  const pressed = (e.target as HTMLElement).closest("button");
                  if (!pressed) return;
                  const role = pressed.getAttribute("role");
                  if (role === "menuitemcheckbox") return;
                  if (pressed.hasAttribute("aria-haspopup") && !pressed.closest("[role='menu']")) return;
                  setOverflowOpen(false);
                }}
                className="tvc-popover absolute right-0 top-full z-50 mt-[2px] flex w-[248px] flex-col p-1.5"
              >
                {overflowed?.has("compare") && (
                  <OverflowRow label="Compare symbol" className={tier("compare", "menu")}>
                    <CompareButton {...props} className="flex" />
                  </OverflowRow>
                )}
                <ContextActions {...props} placement="menu" overflowed={overflowed} />
                <EditHistory {...props} placement="menu" overflowed={overflowed} />
                <WorkspaceActions {...props} placement="menu" overflowed={overflowed} />
                {overflowed?.has("trade") && (
                  <TradeButton {...props} className={`my-1 ml-1 self-start ${tier("trade", "menu")}`} />
                )}
                {/* Always present, so ⋯ never opens an empty panel: the strip, by name. */}
                <div aria-hidden="true" className="mx-1 my-1 h-px bg-border" />
                <button
                  type="button"
                  onClick={() => { onMoreOpen(!moreOpen); }}
                  aria-expanded={moreOpen}
                  aria-controls="chart-toolbar-more"
                  className="flex h-[38px] w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-ink hover:bg-state-hover"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {moreOpen ? "Hide history, overlays & automation" : "History, overlays & automation"}
                  </span>
                </button>
              </div>
            )}
          </div>

          {!overflowed?.has("trade") && <TradeButton {...props} className={`ml-1.5 ${tier("trade", "row")}`} />}
        </div>
      </div>

      {/*
        ── The secondary tier: history, overlays, automation, strategy, best ──
        Opened by name from the ⋯ menu — "History, overlays & automation" —
        never by a breakpoint and never as a side effect of looking for
        something that did not fit. A full-width strip rather than a popover
        because the overlay control inside it opens its own menu downward,
        which a scrolling popover would clip.

        ── TVP8 R1c-13: it has to be a row the layout can SEE ────────────────

        It was rendered exactly here and was still invisible, because the page
        wrapped this whole component in a hard `h-[38px]`: the strip laid out
        at y=43 inside a 38px box, the chart canvas painted over it, and
        `elementFromPoint` on every one of its buttons returned the CANVAS.
        The container is a `min-h-[38px]` now (`app/chart/page.tsx`), so
        opening the strip moves the workspace down by the strip's own height
        instead of hiding it.

        38px and not 47: the same row height as the bar above it, which is what
        stops the two from reading as a toolbar and a tray. The chips inside it
        are the bar's own 38px controls for the same reason.
      */}
      {moreOpen && (
        <div
          id="chart-toolbar-more"
          data-toolbar-row="secondary"
          role="group"
          aria-label="History, overlays and automation"
          className="flex min-h-[38px] flex-wrap items-center gap-1 border-t border-border px-1"
        >
          <div {...ctl("history")} role="group" aria-label="History depth"
            data-tooltip={loaded !== undefined
              ? `${loaded.toLocaleString()} bars loaded on the focused chart`
              : undefined}
            className="flex items-center gap-0.5">
            <span className="mr-1 hidden text-[10px] uppercase tracking-wide text-ink-faint sm:inline">
              History
            </span>
            {HISTORY_OPTIONS.map((h) => (
              <button key={h.label} onClick={() => props.onBars(h.bars)}
                data-tooltip={`Show up to ${h.bars.toLocaleString()} bars`}
                aria-pressed={props.bars === h.bars}
                className={`tvc-control flex h-[38px] items-center px-2 text-[13px] ${
                  props.bars === h.bars ? "font-semibold text-ink" : "text-ink-muted hover:text-ink"
                }`}>
                {h.label}
              </button>
            ))}
          </div>

          <Separator />

          <div {...ctl("overlays")} className="flex shrink-0 items-center">
            <TradingOverlayMenu open={props.overlayMenuOpen} onOpen={props.onOverlayMenuOpen}
              value={props.overlayPrefs} onChange={props.onOverlayPrefs}
              data={props.overlayData} loading={props.overlaysLoading} error={props.overlayError}
              items={props.overlayItems} onSelect={props.onSelectOverlay} />
          </div>

          <button
            {...ctl("automate")}
            onClick={props.onOpenAutomation} disabled={props.replayBlocksLiveActions}
            data-tooltip={replayActive ? "Exit Replay to invoke Bot automation" : "Run this strategy server-side and send live orders to your bot"}
            className={TOOL_BUTTON}>
            <Glyph size={18}><path d="M15.2 2.3L4.7 16.3h8.2l-1.2 9.3 10.5-14h-8.2z" /></Glyph>
            Automate
          </button>

          <button
            {...ctl("strategy")}
            onClick={props.onOpenStrategy}
            data-tooltip="Strategy properties for the tester"
            className={TOOL_BUTTON}>
            <Glyph size={18}><path d="M3.5 14h4.7l2.3-8.2 4.7 16.3 2.3-8.2h7" /></Glyph>
            Strategy
          </button>

          <button
            {...ctl("best")}
            onClick={props.onApplyBest} disabled={props.loadingBest || replayActive}
            data-tooltip={replayActive ? "Exit Replay to apply a full-range optimizer result" : `Apply the local optimizer's best saved config for ${displayTicker(symbol)}`}
            /*
              A toolbar control, not a call to action: 38px, transparent, the
              inset chip — `warn` is reserved for a state whose outcome is not
              yet known (§2), not for drawing the eye to a feature.
            */
            className={`${TOOL_BUTTON} shrink-0 gap-1.5 disabled:cursor-not-allowed disabled:opacity-40`}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M7 1l1.8 3.9 4.2.5-3.1 2.9.8 4.2L7 10.5 3.3 12.5l.8-4.2L1 5.4l4.2-.5L7 1Z" />
            </svg>
            {props.loadingBest ? "Loading…" : "Best config"}
          </button>

          <button
            type="button"
            onClick={() => onMoreOpen(false)}
            aria-label="Hide history, overlays and automation"
            data-tooltip="Hide this row"
            className={`${TOOL_ICON_BUTTON} ml-auto`}
          >
            <Glyph><path d="M9 9l10 10M19 9L9 19" /></Glyph>
          </button>
        </div>
      )}
    </div>
  );
}
