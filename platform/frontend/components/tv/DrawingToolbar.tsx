"use client";
import { useEffect, useRef, useState } from "react";
import type { DrawingTool } from "@/lib/drawings";

/** Icon set — 24×24 stroked paths in the TradingView left-rail style. */
const ICONS: Record<string, JSX.Element> = {
  cursor: <><path d="M12 3v6M12 15v6M3 12h6M15 12h6" /></>,
  eraser: <><path d="M4 16l7-7 6 6-4 4H7z" /><path d="M3 21h18" /></>,
  trend: <><circle cx="6" cy="18" r="1.6" /><circle cx="18" cy="6" r="1.6" /><path d="M7.3 16.7l9.4-9.4" /></>,
  ray: <><circle cx="6" cy="17" r="1.6" /><path d="M7.4 15.9L21 4" /><circle cx="13" cy="10" r="1.6" /></>,
  extended: <><path d="M3 20L21 4" /><circle cx="9" cy="15" r="1.6" /><circle cx="15" cy="9" r="1.6" /></>,
  arrow: <><path d="M4 19L18 6" /><path d="M12 5h7v7" /></>,
  hline: <><path d="M3 12h18" /><circle cx="12" cy="12" r="1.8" /></>,
  hray: <><path d="M8 12h13" /><circle cx="6" cy="12" r="1.8" /></>,
  vline: <><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></>,
  parallel: <><path d="M3 15L15 5" /><path d="M9 19l12-10" /><circle cx="9" cy="10" r="1.4" /><circle cx="15" cy="14" r="1.4" /></>,
  pitchfork: <><path d="M4 20L12 9M12 9L20 4M12 9v11" /><circle cx="4" cy="20" r="1.4" /><circle cx="20" cy="4" r="1.4" /></>,
  fib: <><path d="M3 5h18M3 10h18M3 15h18M3 20h18" /><circle cx="7" cy="5" r="1.3" /><circle cx="17" cy="20" r="1.3" /></>,
  fibext: <><path d="M3 19h18M3 13h18M3 7h18" /><path d="M6 21l6-16" /></>,
  rect: <><rect x="4" y="6" width="16" height="12" rx="1" /></>,
  ellipse: <><ellipse cx="12" cy="12" rx="8" ry="6" /></>,
  triangle: <><path d="M12 5l8 14H4z" /></>,
  path: <><path d="M4 18l5-7 4 4 7-9" /><circle cx="4" cy="18" r="1.4" /><circle cx="20" cy="6" r="1.4" /></>,
  brush: <><path d="M4 18c4 0 3-8 7-8s3 6 6 6" /><path d="M17 16l3-3" /></>,
  text: <><path d="M5 6h14M12 6v13" /></>,
  callout: <><path d="M4 5h16v10H12l-4 4v-4H4z" /></>,
  pricelabel: <><path d="M3 12h9l3-4h6v8h-6l-3-4" /></>,
  ruler: <><path d="M3 15l12-12 6 6-12 12z" /><path d="M7 11l2 2M10 8l2 2M13 5l2 2" /></>,
  pricerange: <><path d="M12 4v16" /><path d="M8 7l4-3 4 3M8 17l4 3 4-3" /></>,
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

const Icon = ({ name }: { name: string }) => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {ICONS[name]}
  </svg>
);

interface ToolDef { tool: DrawingTool; icon: string; label: string }

/** Tool groups, mirroring the TradingView rail order. */
const GROUPS: { id: string; tools: ToolDef[] }[] = [
  {
    id: "cursors",
    tools: [
      { tool: "cursor", icon: "cursor", label: "Cross" },
      { tool: "eraser", icon: "eraser", label: "Eraser — click a drawing to delete it" },
    ],
  },
  {
    id: "lines",
    tools: [
      { tool: "trend", icon: "trend", label: "Trend line" },
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
    ],
  },
  {
    id: "channels",
    tools: [
      { tool: "parallel", icon: "parallel", label: "Parallel channel" },
      { tool: "pitchfork", icon: "pitchfork", label: "Pitchfork" },
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
      { tool: "triangle", icon: "triangle", label: "Triangle" },
      { tool: "path", icon: "path", label: "Path — click points, double-click to finish" },
    ],
  },
  {
    id: "brush",
    tools: [{ tool: "brush", icon: "brush", label: "Brush — freehand" }],
  },
  {
    id: "text",
    tools: [
      { tool: "text", icon: "text", label: "Text" },
      { tool: "callout", icon: "callout", label: "Callout" },
      { tool: "pricelabel", icon: "pricelabel", label: "Price label" },
    ],
  },
  {
    id: "measure",
    tools: [
      { tool: "ruler", icon: "ruler", label: "Measure" },
      { tool: "pricerange", icon: "pricerange", label: "Price range" },
      { tool: "daterange", icon: "daterange", label: "Date range" },
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
  const [flyout, setFlyout] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

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
  }, [flyout]);

  const btn = (on: boolean): string =>
    `flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
      on ? "bg-surface-2 text-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
    }`;

  return (
    <div
      ref={railRef}
      className={`relative flex w-12 shrink-0 flex-col items-center gap-0.5 border-r border-border bg-surface py-2 ${
        // Floating: scrolls independently and casts a shadow so it reads as a
        // layer above the chart rather than part of it.
        floating ? "h-full overflow-y-auto shadow-2xl" : ""
      }`}
    >
      {floating && onClose && (
        <button
          onClick={onClose}
          aria-label="Close drawing tools"
          className="mb-1 flex h-8 w-8 items-center justify-center rounded-md text-ink-faint hover:bg-surface-2 hover:text-ink"
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
                onClick={() => setFlyout((f) => (f === group.id ? null : group.id))}
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
              <div className="absolute left-[46px] top-0 z-50 w-[240px] rounded-md border border-border bg-surface py-1 shadow-2xl">
                {group.tools.map((t) => (
                  <button
                    key={t.tool}
                    onClick={() => { onTool(t.tool); setActive((a) => ({ ...a, [group.id]: t.tool })); setFlyout(null); }}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-surface-2 ${
                      t.tool === tool ? "text-accent" : "text-ink"
                    }`}
                  >
                    <Icon name={t.icon} />
                    <span className="truncate">{t.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="my-1 h-px w-6 bg-border" />

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

      <div className="my-1 h-px w-6 bg-border" />

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
