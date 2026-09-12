"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import type { DrawingTool } from "@/lib/drawings";

const DRAWING_FAVOURITES_KEY = "tv.drawing-tools.favourites.v1";

/**
 * Icon set — 24x24 stroked paths in the TradingView left-rail style.
 *
 * Drawn at 24px with a 1.8px stroke (FC2-M1). They were 19px at 1.5px inside
 * 36px buttons on a 48px rail, against TradingView's 28px FILLED glyphs in
 * 52x38 buttons on a 52px rail — roughly half the visual weight, which is why
 * the rail read as decoration beside the chart rather than as the drawing
 * surface it is. The family itself was already consistent and optically
 * centred; only its weight and the geometry around it were wrong.
 */
const ICONS: Record<string, JSX.Element> = {
  cursor: <><path d="M12 3v6M12 15v6M3 12h6M15 12h6" /></>,
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" />,
  eraser: <><path d="M4 16l7-7 6 6-4 4H7z" /><path d="M3 21h18" /></>,
  trend: <><circle cx="6" cy="18" r="1.6" /><circle cx="18" cy="6" r="1.6" /><path d="M7.3 16.7l9.4-9.4" /></>,
  trendAngle: <><path d="M4 19L20 5" /><path d="M8 19a8 8 0 018-8" /></>,
  infoline: <><path d="M4 19L20 5" /><path d="M4 19h16M4 19V5" /></>,
  ray: <><circle cx="6" cy="17" r="1.6" /><path d="M7.4 15.9L21 4" /><circle cx="13" cy="10" r="1.6" /></>,
  extended: <><path d="M3 20L21 4" /><circle cx="9" cy="15" r="1.6" /><circle cx="15" cy="9" r="1.6" /></>,
  arrow: <><path d="M4 19L18 6" /><path d="M12 5h7v7" /></>,
  hline: <><path d="M3 12h18" /><circle cx="12" cy="12" r="1.8" /></>,
  hray: <><path d="M8 12h13" /><circle cx="6" cy="12" r="1.8" /></>,
  vline: <><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></>,
  crossline: <><path d="M3 12h18M12 3v18" /><circle cx="12" cy="12" r="1.8" /></>,
  parallel: <><path d="M3 15L15 5" /><path d="M9 19l12-10" /><circle cx="9" cy="10" r="1.4" /><circle cx="15" cy="14" r="1.4" /></>,
  disjointChannel: <><path d="M3 15L15 5M9 19l12-10" /><path d="M4 20h16" /></>,
  pitchfork: <><path d="M4 20L12 9M12 9L20 4M12 9v11" /><circle cx="4" cy="20" r="1.4" /><circle cx="20" cy="4" r="1.4" /></>,
  fib: <><path d="M3 5h18M3 10h18M3 15h18M3 20h18" /><circle cx="7" cy="5" r="1.3" /><circle cx="17" cy="20" r="1.3" /></>,
  fibext: <><path d="M3 19h18M3 13h18M3 7h18" /><path d="M6 21l6-16" /></>,
  rect: <><rect x="4" y="6" width="16" height="12" rx="1" /></>,
  ellipse: <><ellipse cx="12" cy="12" rx="8" ry="6" /></>,
  circle: <><circle cx="12" cy="12" r="7" /></>,
  triangle: <><path d="M12 5l8 14H4z" /></>,
  path: <><path d="M4 18l5-7 4 4 7-9" /><circle cx="4" cy="18" r="1.4" /><circle cx="20" cy="6" r="1.4" /></>,
  polyline: <><path d="M4 18l5-7 4 4 7-9" /><circle cx="4" cy="18" r="1.4" /><circle cx="20" cy="6" r="1.4" /></>,
  brush: <><path d="M4 18c4 0 3-8 7-8s3 6 6 6" /><path d="M17 16l3-3" /></>,
  highlighter: <><path d="M4 18c4 0 3-8 7-8s3 6 6 6" /><path d="M5 20h14" /></>,
  arrowMarker: <><path d="M5 19L19 5" /><path d="M13 5h6v6" /></>,
  arrowUp: <><path d="M12 20V6M6 12l6-6 6 6" /></>,
  arrowDown: <><path d="M12 4v14M6 12l6 6 6-6" /></>,
  arc: <><path d="M4 18a8 8 0 0116 0" /></>,
  curve: <><path d="M4 18c4-12 12 12 16-6" /></>,
  doubleCurve: <><path d="M4 18c4-12 12 12 16-6M4 14c4-8 12 8 16-4" /></>,
  text: <><path d="M5 6h14M12 6v13" /></>,
  note: <><path d="M4 4h16v12H9l-5 4z" /></>,
  priceNote: <><path d="M3 12h9l3-4h6v8h-6l-3-4" /><path d="M7 12h.01" /></>,
  pin: <><path d="M8 4h8l-2 6 3 3H7l3-3z" /><path d="M12 13v7" /></>,
  comment: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>,
  callout: <><path d="M4 5h16v10H12l-4 4v-4H4z" /></>,
  pricelabel: <><path d="M3 12h9l3-4h6v8h-6l-3-4" /></>,
  signpost: <><path d="M12 20V4M5 6h14l-3 4 3 4H5l3-4z" /></>,
  flagMark: <><path d="M6 21V4M6 5h11l-3 4 3 4H6" /></>,
  ruler: <><path d="M3 15l12-12 6 6-12 12z" /><path d="M7 11l2 2M10 8l2 2M13 5l2 2" /></>,
  pricerange: <><path d="M12 4v16" /><path d="M8 7l4-3 4 3M8 17l4 3 4-3" /></>,
  // An anchor point with a curve running rightwards from it: where it starts
  // is the whole idea.
  avwap: <><circle cx="5" cy="18" r="2" /><path d="M5 18c4 0 5-9 9-11s6 1 7 3" /></>,
  // Two range edges with a histogram growing leftwards from the right one:
  // the two things a fixed range IS.
  vprange: <><path d="M5 4v16M19 4v16" /><path d="M19 7h-6M19 11h-9M19 15h-4" /></>,
  avprofile: <><circle cx="5" cy="18" r="2" /><path d="M5 18h15M20 7h-6M20 11h-9M20 15h-4" /></>,
  daterange: <><path d="M4 12h16" /><path d="M7 8L4 12l3 4M17 8l3 4-3 4" /></>,
  long: <><rect x="4" y="5" width="16" height="6" /><rect x="4" y="13" width="16" height="6" /><path d="M12 19v-14" /></>,
  short: <><rect x="4" y="5" width="16" height="6" /><rect x="4" y="13" width="16" height="6" /><path d="M12 5v14" /></>,
  magnet: <><path d="M7 4v8a5 5 0 0010 0V4" /><path d="M7 8h4M13 8h4" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  unlock: <><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 017-2.6" /></>,
  eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" /></>,
  eyeOff: <><path d="M2 12s3.5-6 10-6c2 0 3.7.6 5.1 1.4M22 12s-3.5 6-10 6c-2 0-3.7-.6-5.1-1.4" /><path d="M3 3l18 18" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /></>,
};

const Icon = ({ name, size = 24 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {ICONS[name] ?? ICONS.trend}
  </svg>
);

interface ToolDef { tool: DrawingTool; icon: string; label: string }

/** Tool groups, mirroring the TradingView rail order. */
const GROUPS: { id: string; tools: ToolDef[] }[] = [
  {
    id: "cursors",
    tools: [
      { tool: "cursor", icon: "cursor", label: "Cross" },
      { tool: "dot", icon: "dot", label: "Dot" },
      { tool: "eraser", icon: "eraser", label: "Eraser — click a drawing to delete it" },
    ],
  },
  {
    id: "lines",
    tools: [
      { tool: "trend", icon: "trend", label: "Trend line" },
      { tool: "trendAngle", icon: "trendAngle", label: "Trend angle" },
      { tool: "infoline", icon: "infoline", label: "Info line" },
      { tool: "ray", icon: "ray", label: "Ray" },
      { tool: "extended", icon: "extended", label: "Extended line" },
      { tool: "arrow", icon: "arrow", label: "Arrow" },
    ],
  },
  {
    id: "levels",
    tools: [
      { tool: "hline", icon: "hline", label: "Horizontal line" },
      { tool: "hray", icon: "hray", label: "Horizontal ray" },
      { tool: "vline", icon: "vline", label: "Vertical line" },
      { tool: "crossline", icon: "crossline", label: "Crossline" },
    ],
  },
  {
    id: "channels",
    tools: [
      { tool: "parallel", icon: "parallel", label: "Parallel channel" },
      { tool: "disjointChannel", icon: "disjointChannel", label: "Disjoint channel" },
      { tool: "pitchfork", icon: "pitchfork", label: "Pitchfork" },
    ],
  },
  {
    id: "advanced",
    tools: [
      { tool: "regression", icon: "trend", label: "Regression trend" },
      { tool: "flatTopBottom", icon: "parallel", label: "Flat top/bottom" },
      { tool: "schiffPitchfork", icon: "pitchfork", label: "Schiff pitchfork" },
      { tool: "modifiedSchiffPitchfork", icon: "pitchfork", label: "Modified Schiff pitchfork" },
      { tool: "insidePitchfork", icon: "pitchfork", label: "Inside pitchfork" },
      { tool: "fibChannel", icon: "fib", label: "Fib channel" },
      { tool: "fibTimeZone", icon: "fib", label: "Fib time zone" },
      { tool: "trendFibTime", icon: "fibext", label: "Trend-based Fib time" },
      { tool: "fibSpeedResistanceFan", icon: "fibext", label: "Fib speed resistance fan" },
      { tool: "fibSpeedResistanceArcs", icon: "fibext", label: "Fib speed resistance arcs" },
      { tool: "fibCircles", icon: "circle", label: "Fib circles" },
      { tool: "fibSpiral", icon: "arc", label: "Fib spiral" },
      { tool: "fibWedge", icon: "triangle", label: "Fib wedge" },
      { tool: "pitchfan", icon: "pitchfork", label: "Pitchfan" },
      { tool: "gannBox", icon: "rect", label: "Gann box" },
      { tool: "gannSquareFixed", icon: "rect", label: "Gann square fixed" },
      { tool: "gannSquare", icon: "rect", label: "Gann square" },
      { tool: "gannFan", icon: "trend", label: "Gann fan" },
      { tool: "xabcd", icon: "polyline", label: "XABCD pattern" },
      { tool: "cypher", icon: "polyline", label: "Cypher pattern" },
      { tool: "headAndShoulders", icon: "polyline", label: "Head and shoulders" },
      { tool: "abcdPattern", icon: "polyline", label: "ABCD pattern" },
      { tool: "trianglePattern", icon: "triangle", label: "Triangle pattern" },
      { tool: "threeDrives", icon: "polyline", label: "Three drives pattern" },
      { tool: "elliottImpulse", icon: "polyline", label: "Elliott impulse" },
      { tool: "elliottCorrection", icon: "polyline", label: "Elliott correction" },
      { tool: "elliottTriangle", icon: "triangle", label: "Elliott triangle" },
      { tool: "elliottDoubleCombo", icon: "polyline", label: "Elliott double combo" },
      { tool: "elliottTripleCombo", icon: "polyline", label: "Elliott triple combo" },
      { tool: "cyclicLines", icon: "daterange", label: "Cyclic lines" },
      { tool: "timeCycles", icon: "daterange", label: "Time cycles" },
      { tool: "sineLine", icon: "curve", label: "Sine line" },
      { tool: "positionForecast", icon: "arrow", label: "Position forecast" },
      { tool: "barsPattern", icon: "bars", label: "Bars pattern" },
      { tool: "sector", icon: "arc", label: "Sector" },
      { tool: "rotatedRectangle", icon: "rect", label: "Rotated rectangle" },
      { tool: "table", icon: "rect", label: "Table" },
    ],
  },
  {
    id: "fib",
    tools: [
      { tool: "fib", icon: "fib", label: "Fib retracement" },
      { tool: "fibext", icon: "fibext", label: "Trend-based fib extension" },
    ],
  },
  {
    id: "shapes",
    tools: [
      { tool: "rect", icon: "rect", label: "Rectangle" },
      { tool: "ellipse", icon: "ellipse", label: "Ellipse" },
      { tool: "circle", icon: "circle", label: "Circle" },
      { tool: "triangle", icon: "triangle", label: "Triangle" },
      { tool: "path", icon: "path", label: "Path — click points, double-click to finish" },
      { tool: "polyline", icon: "polyline", label: "Polyline — click points, double-click to finish" },
      { tool: "arc", icon: "arc", label: "Arc" },
      { tool: "curve", icon: "curve", label: "Curve" },
      { tool: "doubleCurve", icon: "doubleCurve", label: "Double curve" },
    ],
  },
  {
    id: "brush",
    tools: [
      { tool: "brush", icon: "brush", label: "Brush — freehand" },
      { tool: "highlighter", icon: "highlighter", label: "Highlighter — translucent freehand" },
      { tool: "arrowMarker", icon: "arrowMarker", label: "Arrow marker" },
      { tool: "arrowUp", icon: "arrowUp", label: "Arrow mark up" },
      { tool: "arrowDown", icon: "arrowDown", label: "Arrow mark down" },
    ],
  },
  {
    id: "text",
    tools: [
      { tool: "text", icon: "text", label: "Text" },
      { tool: "note", icon: "note", label: "Note" },
      { tool: "priceNote", icon: "priceNote", label: "Price note" },
      { tool: "pin", icon: "pin", label: "Pin" },
      { tool: "comment", icon: "comment", label: "Comment" },
      { tool: "callout", icon: "callout", label: "Callout" },
      { tool: "pricelabel", icon: "pricelabel", label: "Price label" },
      { tool: "signpost", icon: "signpost", label: "Signpost" },
      { tool: "flagMark", icon: "flagMark", label: "Flag mark" },
    ],
  },
  {
    /*
     * Anchored VWAP is a drawing tool, not a study, because its input is a
     * point on the chart: click the bar to start from, drag to move it. It
     * gets its own group rather than joining "levels" because it is the only
     * drawing here that computes a series rather than describing a shape.
     */
    id: "anchored",
    tools: [
      { tool: "avwap", icon: "avwap", label: "Anchored VWAP — click a bar to anchor" },
      {
        tool: "vprange", icon: "vprange",
        label: "Fixed Range Volume Profile — drag across the bars to profile",
      },
      { tool: "avprofile", icon: "avprofile", label: "Anchored Volume Profile — click a bar to anchor" },
    ],
  },
  {
    id: "measure",
    tools: [
      { tool: "ruler", icon: "ruler", label: "Measure" },
      { tool: "pricerange", icon: "pricerange", label: "Price range" },
      { tool: "daterange", icon: "daterange", label: "Date range" },
      { tool: "datePriceRange", icon: "ruler", label: "Date and price range" },
      { tool: "long", icon: "long", label: "Long position" },
      { tool: "short", icon: "short", label: "Short position" },
    ],
  },
];

/**
 * The left icon rail. Each group remembers the variant you last used, so the
 * rail shows that icon and a caret opens the rest — TradingView's behaviour.
 */
export function DrawingToolbar({
  tool, onTool, magnet, onMagnet, locked, onLocked, hidden, onHidden, onDeleteAll, count,
  floating = false, onClose,
}: {
  tool: DrawingTool;
  onTool: (t: DrawingTool) => void;
  magnet: boolean;
  onMagnet: (v: boolean) => void;
  locked: boolean;
  onLocked: (v: boolean) => void;
  hidden: boolean;
  onHidden: (v: boolean) => void;
  onDeleteAll: () => void;
  count: number;
  /** Phone drawer: the rail floats over the chart instead of taking a column. */
  floating?: boolean;
  onClose?: () => void;
}) {
  const [active, setActive] = useState<Record<string, DrawingTool>>(() =>
    Object.fromEntries(GROUPS.map((g) => [g.id, g.tools[0]!.tool]))
  );
  const [favourites, setFavourites] = useState<DrawingTool[]>([]);
  /*
   * The tool flyout, through the same registry as every other popover.
   *
   * It carries WHICH group is open rather than a boolean, so the registry
   * holds the open/closed half and this holds the identity — opening a
   * different group is still one state change, and opening any of them still
   * closes the chart-type and timeframe menus.
   */
  const [flyoutOpen, setFlyoutOpen] = useExclusivePopover("drawing-flyout");
  const [flyoutGroup, setFlyoutGroup] = useState<string | null>(null);
  const flyout = flyoutOpen ? flyoutGroup : null;
  const setFlyout = useCallback((id: string | null) => {
    setFlyoutGroup(id);
    setFlyoutOpen(id !== null);
  }, [setFlyoutOpen]);
  const railRef = useRef<HTMLDivElement>(null);

  // TradingView keeps drawing-tool favourites across chart reloads. Keep the
  // same muscle-memory affordance locally without coupling it to drawings or
  // server state (favourites are a device preference, not chart data).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAWING_FAVOURITES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const known = new Set(GROUPS.flatMap((g) => g.tools.map((t) => t.tool)));
        setFavourites(parsed.filter((v): v is DrawingTool => typeof v === "string" && known.has(v as DrawingTool)));
      }
    } catch { /* unavailable storage is a valid first-run state */ }
  }, []);

  const toggleFavourite = useCallback((candidate: DrawingTool) => {
    setFavourites((current) => {
      const next = current.includes(candidate)
        ? current.filter((t) => t !== candidate)
        : [...current, candidate];
      try { window.localStorage.setItem(DRAWING_FAVOURITES_KEY, JSON.stringify(next)); } catch { /* best effort */ }
      return next;
    });
  }, []);

  // Remember which variant of a group is in use, so the rail icon follows it.
  useEffect(() => {
    const group = GROUPS.find((g) => g.tools.some((t) => t.tool === tool));
    if (group) setActive((a) => ({ ...a, [group.id]: tool }));
  }, [tool]);

  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: MouseEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setFlyout(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [flyout, setFlyout]);

  /*
   * A rail button is the full width of the rail (FC2-M1, FC2-L1).
   *
   * 52x38 and square-cornered, like TradingView's, rather than a 36px pill
   * inset in a 48px column: a drawing tool is aimed at from muscle memory
   * dozens of times an hour, and an inset pill throws away a third of the hit
   * area it could have had for the sake of looking like a web control. No
   * hover transition, for the reason given on the toolbar.
   */
  const btn = (on: boolean): string =>
    `flex h-[38px] w-[52px] items-center justify-center ${
      on ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
    }`;

  return (
    <div
      ref={railRef}
      data-drawing-rail="true"
      className={`relative flex w-[52px] shrink-0 flex-col items-center border-r border-border bg-surface py-1 ${
        // Floating: scrolls independently and casts a shadow so it reads as a
        // layer above the chart rather than part of it.
        floating ? "h-full overflow-y-auto shadow-2xl" : ""
      }`}
    >
      {floating && onClose && (
        <button
          onClick={onClose}
          aria-label="Close drawing tools"
          className="mb-1 flex h-[38px] w-[52px] items-center justify-center text-ink-faint hover:bg-surface-2 hover:text-ink"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4l16 16M20 4L4 20" />
          </svg>
        </button>
      )}
      {GROUPS.map((group) => {
        const current = group.tools.find((t) => t.tool === active[group.id]) ?? group.tools[0]!;
        const groupOn = group.tools.some((t) => t.tool === tool);
        return (
          <div key={group.id} className="relative">
            <button
              onClick={() => onTool(current.tool)}
              onContextMenu={(e) => { e.preventDefault(); if (group.tools.length > 1) setFlyout(group.id); }}
              className={btn(groupOn)}
              /*
               * A tool button is a toggle, and until now the only thing that
               * said which one was armed was a colour. That is invisible to a
               * screen reader and to anything that is not a human eye — the
               * timeframe strip has said `aria-pressed` all along, and this is
               * the same control in a different rail.
               */
              aria-pressed={groupOn}
              title={current.label}
            >
              <Icon name={current.icon} />
            </button>
            {group.tools.length > 1 && (
              // The corner triangle stays a 10px marker, as it is in
              // TradingView, but the thing you press is 24px. Measured at
              // 10x10, it was the smallest control in the application and the
              // only route to two thirds of the drawing tools.
              <button
                onClick={() => setFlyout(flyout === group.id ? null : group.id)}
                title="More tools"
                aria-label={`More ${group.id} tools`}
                className="absolute bottom-0 right-0 flex h-6 w-6 items-end justify-end p-[3px] text-ink-faint hover:text-ink"
              >
                <svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true">
                  <path d="M10 10L0 10L10 0z" />
                </svg>
              </button>
            )}
            {flyout === group.id && (
              <div className="absolute left-[51px] top-0 z-50 w-[248px] rounded-sm border border-border bg-surface py-1 shadow-2xl">
                {group.tools.map((t) => {
                  const starred = favourites.includes(t.tool);
                  return (
                    <div key={t.tool} className={`flex w-full items-center hover:bg-surface-2 ${t.tool === tool ? "text-accent" : "text-ink"}`}>
                      <button
                        onClick={() => { onTool(t.tool); setActive((a) => ({ ...a, [group.id]: t.tool })); setFlyout(null); }}
                        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-1.5 text-left text-sm"
                      >
                        <Icon name={t.icon} size={20} />
                        <span className="truncate">{t.label}</span>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleFavourite(t.tool); }}
                        aria-label={starred ? "Remove from favourites" : "Add to favourites"}
                        aria-pressed={starred}
                        title={starred ? "Remove from favourites" : "Add to favourites"}
                        className={`mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded text-[15px] ${starred ? "text-warn" : "text-ink-faint hover:text-ink"}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"}
                          stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                          <path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.8z" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="my-1 h-px w-8 bg-border" />

      <button onClick={() => onMagnet(!magnet)} className={btn(magnet)}
        title={magnet ? "Magnet on — anchors snap to OHLC" : "Magnet off"}>
        <Icon name="magnet" />
      </button>
      <button onClick={() => onLocked(!locked)} className={btn(locked)}
        title={locked ? "Drawings locked" : "Lock all drawings"}>
        <Icon name={locked ? "lock" : "unlock"} />
      </button>
      <button onClick={() => onHidden(!hidden)} className={btn(hidden)}
        title={hidden ? "Drawings hidden" : "Hide all drawings"}>
        <Icon name={hidden ? "eyeOff" : "eye"} />
      </button>

      <div className="my-1 h-px w-8 bg-border" />

      <button
        onClick={onDeleteAll}
        disabled={count === 0}
        className={`${btn(false)} disabled:cursor-not-allowed disabled:opacity-30 hover:!text-down`}
        title={count === 0 ? "No drawings" : `Remove all ${count} drawings`}
      >
        <Icon name="trash" />
      </button>
      {count > 0 && <span className="text-[10px] tabular text-ink-faint">{count}</span>}
    </div>
  );
}
