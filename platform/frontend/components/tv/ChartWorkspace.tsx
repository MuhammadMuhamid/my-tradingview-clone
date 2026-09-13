"use client";
/**
 * Where the panes go.
 *
 * One CSS grid renders every layout from a single pane to a 4×4, because a
 * preset is data — a column count, a row count and a cell per pane — rather
 * than a component. Adding a shape therefore never touches this file, and
 * neither does changing what a pane contains: this host knows only that panes
 * have ids and occupy cells.
 *
 * A maximised pane is rendered on its own. The others are not hidden, they are
 * unmounted, and their state is untouched in the workspace record — symbol,
 * interval, moving averages, applied studies (per-pane storage) and drawings
 * (per-symbol storage) all survive, so restoring puts back exactly what was
 * there. Unmounting rather than hiding is deliberate: a zero-height chart
 * canvas is a source of layout bugs, and the panes come back off a warm
 * history cache.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  cellGridStyle, evenFractions, presetGridStyle, resizeTrack,
  type GridFractions, type LayoutPreset, type PaneCell,
} from "@/lib/layoutPresets";
import {
  workspacePreset, type ChartWorkspace as Workspace, type PaneState,
} from "@/lib/workspace";

export interface ChartWorkspaceProps {
  workspace: Workspace;
  /** Renders one pane. The host supplies only its geometry and its state. */
  renderPane: (pane: PaneState, context: { maximized: boolean }) => ReactNode;
}

/*
 * ── TVP8: the line between two charts ──────────────────────────────────────
 *
 * The grid was `repeat(cols, 1fr)`: every chart exactly the same size, for
 * ever. The reference lets you drag the line between two charts, and a two-up
 * layout is very often one chart you are working in and one you are glancing
 * at — equal halves is the wrong answer to that, and it was the only answer.
 *
 * Kept per preset id, so going 2-up → 4-up → 2-up returns to the split you
 * left rather than to even thirds. In localStorage rather than in the
 * workspace record because it is a view preference of THIS screen: the same
 * layout on a laptop and on a monitor wants different splits, and the
 * workspace record syncs.
 */
const FRACTIONS_KEY = "tv.paneFractions.v1";

function readFractions(presetId: string, preset: LayoutPreset): GridFractions {
  try {
    const raw = window.localStorage.getItem(FRACTIONS_KEY);
    const all: unknown = raw === null ? {} : JSON.parse(raw);
    const stored = (all as Record<string, unknown>)[presetId];
    const ok = (v: unknown, n: number): v is number[] =>
      Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && x > 0);
    const cols = (stored as { cols?: unknown })?.cols;
    const rows = (stored as { rows?: unknown })?.rows;
    if (ok(cols, preset.cols) && ok(rows, preset.rows)) return { cols, rows };
  } catch { /* unreadable: even tracks, which is the default anyway */ }
  return evenFractions(preset);
}

function writeFractions(presetId: string, fractions: GridFractions): void {
  try {
    const raw = window.localStorage.getItem(FRACTIONS_KEY);
    const all: Record<string, unknown> = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>;
    all[presetId] = fractions;
    window.localStorage.setItem(FRACTIONS_KEY, JSON.stringify(all));
  } catch { /* private window: the split still works, it just forgets */ }
}

/** One interior grid line, draggable and operable from the keyboard. */
function PaneSeparator({
  axis, offset, onMove, onCommit,
}: {
  axis: "cols" | "rows";
  /** Where the line sits, as a share of the container. */
  offset: number;
  onMove: (delta: number) => void;
  onCommit: () => void;
}) {
  const from = useRef<{ x: number; y: number; box: DOMRect } | null>(null);
  const vertical = axis === "cols";
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={vertical ? "Resize the charts either side" : "Resize the charts above and below"}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        from.current = { x: e.clientX, y: e.clientY, box };
      }}
      onPointerMove={(e) => {
        const start = from.current;
        if (!start) return;
        const span = vertical ? start.box.width : start.box.height;
        if (span <= 0) return;
        const moved = vertical ? e.clientX - start.x : e.clientY - start.y;
        onMove(moved / span);
        from.current = { ...start, x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => { if (from.current) { from.current = null; onCommit(); } }}
      onPointerCancel={() => { from.current = null; }}
      onKeyDown={(e) => {
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const forward = vertical ? "ArrowRight" : "ArrowDown";
        if (e.key !== back && e.key !== forward) return;
        e.preventDefault();
        onMove((e.key === forward ? 1 : -1) * (e.shiftKey ? 0.05 : 0.01));
        onCommit();
      }}
      style={vertical
        ? { left: `${offset * 100}%`, top: 0, bottom: 0, width: 9, marginLeft: -4 }
        : { top: `${offset * 100}%`, left: 0, right: 0, height: 9, marginTop: -4 }}
      className={`absolute z-10 bg-transparent transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 ${
        vertical ? "cursor-col-resize" : "cursor-row-resize"}`}
    />
  );
}

/** The full-bleed cell a maximised pane occupies. */
const SOLO_CELL: PaneCell = { col: 1, row: 1, colSpan: 1, rowSpan: 1 };

export function ChartWorkspace({ workspace, renderPane }: ChartWorkspaceProps) {
  const preset = workspacePreset(workspace);
  const [fractions, setFractions] = useState<GridFractions>(() => evenFractions(preset));
  // Read on the client only: `localStorage` does not exist while this renders
  // on the server, and an even grid is the right first paint either way.
  useEffect(() => {
    setFractions(readFractions(workspace.presetId, preset));
    // `preset` is derived from `presetId`, so one of them is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.presetId]);
  const fractionsRef = useRef(fractions);
  fractionsRef.current = fractions;
  const maximized = workspace.maximizedPaneId === null
    ? null
    : workspace.panes.find((p) => p.id === workspace.maximizedPaneId) ?? null;

  if (maximized) {
    return (
      <div
        className="grid min-h-0 flex-1 gap-px bg-border p-px"
        style={presetGridStyle({ ...preset, cols: 1, rows: 1, cells: [SOLO_CELL] })}
      >
        <div style={cellGridStyle(SOLO_CELL)} className="flex min-h-0 min-w-0">
          {renderPane(maximized, { maximized: true })}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative grid min-h-0 flex-1 gap-px bg-border p-px"
      style={presetGridStyle(preset, fractions)}
    >
      {/*
        The interior lines. A 1x1 has none, which is why nothing renders for a
        single pane and why the offsets are cumulative shares rather than
        indexes — the line between two tracks sits where their sizes put it,
        not at an even fraction of the axis.
      */}
      {(["cols", "rows"] as const).flatMap((axis) => {
        const tracks = fractions[axis];
        const total = tracks.reduce((sum, v) => sum + v, 0);
        let running = 0;
        return tracks.slice(0, -1).map((value, index) => {
          running += value;
          return (
            <PaneSeparator
              key={`${axis}-${index}`}
              axis={axis}
              offset={running / total}
              onMove={(delta) => setFractions((current) => ({
                ...current, [axis]: resizeTrack(current[axis], index, delta),
              }))}
              onCommit={() => writeFractions(workspace.presetId, fractionsRef.current)}
            />
          );
        });
      })}
      {workspace.panes.map((pane, index) => {
        // The preset always has a cell per pane — `parseWorkspace` rejects a
        // record where it does not — but a defensive fallback keeps a bad
        // record from blanking the workspace instead of showing the charts.
        const cell = preset.cells[index] ?? SOLO_CELL;
        return (
          <div key={pane.id} style={cellGridStyle(cell)} className="flex min-h-0 min-w-0">
            {renderPane(pane, { maximized: false })}
          </div>
        );
      })}
    </div>
  );
}
