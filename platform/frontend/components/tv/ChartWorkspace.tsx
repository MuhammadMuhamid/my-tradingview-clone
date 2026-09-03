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
import type { ReactNode } from "react";
import { cellGridStyle, presetGridStyle, type PaneCell } from "@/lib/layoutPresets";
import {
  workspacePreset, type ChartWorkspace as Workspace, type PaneState,
} from "@/lib/workspace";

export interface ChartWorkspaceProps {
  workspace: Workspace;
  /** Renders one pane. The host supplies only its geometry and its state. */
  renderPane: (pane: PaneState, context: { maximized: boolean }) => ReactNode;
}

/** The full-bleed cell a maximised pane occupies. */
const SOLO_CELL: PaneCell = { col: 1, row: 1, colSpan: 1, rowSpan: 1 };

export function ChartWorkspace({ workspace, renderPane }: ChartWorkspaceProps) {
  const preset = workspacePreset(workspace);
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
      className="grid min-h-0 flex-1 gap-px bg-border p-px"
      style={presetGridStyle(preset)}
    >
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
