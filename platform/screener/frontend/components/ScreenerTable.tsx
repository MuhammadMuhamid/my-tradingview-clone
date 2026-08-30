"use client";

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Fragment, useMemo, useState } from "react";

import { COLUMNS, GROUPS, GROUP_INDICATOR, type ColumnSpec, type GroupName } from "@/lib/columns";
import { TIMEFRAMES } from "@/lib/types";
import type { IndicatorKey, ScreenerRow, Snapshot } from "@/lib/types";
import { Cell } from "./Cell";
import { RowDetail } from "./RowDetail";
import { applyFilters, type Filters } from "./FilterPanel";

interface Props {
  snapshot: Snapshot;
  filters: Filters;
  hiddenGroups: Set<string>;
  /** Show the secondary columns each group hides by default. */
  showExtras: boolean;
  onToggleGroup: (group: string) => void;
  onTimeframeChange: (indicator: IndicatorKey, timeframe: string) => void;
  busy: boolean;
}

export function ScreenerTable({
  snapshot,
  filters,
  hiddenGroups,
  showExtras,
  onToggleGroup,
  onTimeframeChange,
  busy,
}: Props) {
  // The MTF checklist is why this screen exists now, so it leads the sort.
  // Confluence Score remains one click away in its own group header.
  const [sorting, setSorting] = useState<SortingState>([{ id: "mtf_bull_pct", desc: true }]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const specs = useMemo(
    () =>
      COLUMNS.filter(
        (s) => !hiddenGroups.has(s.group) && (showExtras || !s.hiddenByDefault),
      ),
    [hiddenGroups, showExtras],
  );

  /** Which timeframe each single-timeframe indicator's values came from. */
  const tfByIndicator = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [key, spec] of Object.entries(snapshot.indicators)) {
      map[key] = spec.timeframe;
    }
    return map;
  }, [snapshot.indicators]);

  /**
   * Provenance for one cell. Slot-scoped columns take it from the strategy's
   * own per-timeframe series; the few remaining single-timeframe columns take
   * it from that indicator's configured timeframe.
   */
  const seriesFor = useMemo(
    () => (row: ScreenerRow, spec: typeof COLUMNS[number]) => {
      if (spec.slot) return row.strategy?.series?.[spec.slot];
      if (spec.indicator) return row.series[tfByIndicator[spec.indicator]];
      return undefined;
    },
    [tfByIndicator],
  );

  const rows = useMemo(
    () => applyFilters(snapshot.rows, COLUMNS, filters, (spec, row) => spec.accessor(row)),
    [snapshot.rows, filters],
  );

  const columns = useMemo<ColumnDef<ScreenerRow>[]>(
    () =>
      specs.map((spec) => ({
        id: spec.id,
        accessorFn: (row) => spec.accessor(row),
        header: spec.header,
        sortUndefined: "last",
        sortingFn: spec.kind === "text" || spec.kind === "category" ? "alphanumeric" : "basic",
        cell: ({ row }) => (
          <Cell
            spec={spec}
            row={row.original}
            series={seriesFor(row.original, spec)}
          />
        ),
      })),
    [specs, tfByIndicator],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.symbol,
  });

  const visibleGroups = GROUPS;
  const colCount = specs.length;

  return (
    <div className="relative flex-1 overflow-auto">
      <table className="dense w-full border-collapse">
        <thead className="sticky top-0 z-3 bg-[var(--color-surface-2)]">
          {/* Group header row: collapse toggle + per-indicator timeframe selector. */}
          <tr>
            {visibleGroups.map((group) => {
              const groupSpecs = specs.filter((s) => s.group === group);
              const hidden = hiddenGroups.has(group);
              const indicator = GROUP_INDICATOR[group as GroupName];
              if (hidden) {
                return (
                  <th
                    key={group}
                    className={group === "Symbol" ? "sticky-col text-left" : "text-left"}
                  >
                    <button
                      onClick={() => onToggleGroup(group)}
                      className="text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
                      title={`Expand ${group}`}
                    >
                      ▸ {group}
                    </button>
                  </th>
                );
              }
              if (groupSpecs.length === 0) return null;
              return (
                <th
                  key={group}
                  colSpan={groupSpecs.length}
                  className={`border-l border-[var(--color-line)] text-left ${
                    group === "Symbol" ? "sticky-col" : ""
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <button
                      onClick={() => onToggleGroup(group)}
                      className="hover:text-[var(--color-ink-dim)]"
                      title={`Collapse ${group}`}
                    >
                      ▾ {group}
                    </button>
                    {indicator && (
                      <select
                        aria-label={`${group} timeframe`}
                        value={snapshot.indicators[indicator]?.timeframe ?? "1h"}
                        disabled={busy}
                        onChange={(e) => onTimeframeChange(indicator, e.target.value)}
                        title={
                          `Timeframe for ${group}. Changing it refetches only the ` +
                          `newly-required (symbol, timeframe) pairs.`
                        }
                        className="rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1 text-[11px]"
                      >
                        {TIMEFRAMES.map((tf) => (
                          <option key={tf} value={tf}>
                            {tf}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>

          {/* Column header row. */}
          <tr>
            {table.getHeaderGroups()[0].headers.map((header) => {
              const spec = specs.find((s) => s.id === header.id)!;
              const sorted = header.column.getIsSorted();
              return (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  title={spec.title ?? spec.header}
                  className={`cursor-pointer select-none text-right font-medium text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] ${
                    spec.group === "Symbol" ? "sticky-col text-left" : ""
                  }`}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : ""}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {table.getRowModel().rows.map((row) => {
            const data = row.original;
            const isOpen = expanded === data.symbol;

            if (data.state === "unresolved") {
              return (
                <tr key={data.symbol} className="text-[var(--color-ink-dim)]">
                  <td className="sticky-col">{data.symbol}</td>
                  <td colSpan={colCount - 1} className="italic" title={data.note ?? ""}>
                    unresolved — {data.note}
                  </td>
                </tr>
              );
            }

            return (
              <Fragment key={data.symbol}>
                <tr
                  className="hover:bg-[var(--color-surface-2)]"
                  onClick={() => setExpanded(isOpen ? null : data.symbol)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const spec = specs.find((s) => s.id === cell.column.id)!;
                    if (spec.id === "symbol") {
                      return (
                        <td key={cell.id} className="sticky-col font-medium">
                          <span className="mr-1 text-[var(--color-ink-dim)]">
                            {isOpen ? "▾" : "▸"}
                          </span>
                          {data.symbol.replace("/USDT", "")}
                        </td>
                      );
                    }
                    return (
                      <Fragment key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </Fragment>
                    );
                  })}
                </tr>
                {isOpen && <RowDetail row={data} span={colCount} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {table.getRowModel().rows.length === 0 && (
        <p className="p-6 text-sm text-[var(--color-ink-dim)]">
          No rows match the active filters.
        </p>
      )}
    </div>
  );
}
