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

import { COLUMNS, GROUPS, GROUP_INDICATOR, type GroupName } from "@/lib/scanner/columns";
import { TIMEFRAMES } from "@/lib/scanner/types";
import type { IndicatorKey, ScreenerRow, Snapshot } from "@/lib/scanner/types";
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
  onRemoveSymbol?: (symbol: string) => void;
}

/** Group open/closed state, so the header carries a name rather than a verb. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <path d="M2 4.5L6 8.5l4-4" /> : <path d="M4.5 2l4 4-4 4" />}
    </svg>
  );
}

export function ScreenerTable({
  snapshot,
  filters,
  hiddenGroups,
  showExtras,
  onToggleGroup,
  onTimeframeChange,
  busy,
  onRemoveSymbol,
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
    [specs, seriesFor],
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
    <div className="relative flex-1 overflow-auto overflow-x-auto">
      <table className="dense min-w-max w-full border-collapse">
        <thead className="sticky top-0 z-[3] bg-[var(--color-surface-2)]">
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
                      className="flex items-center gap-1 text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]"
                      title={`Expand ${group}`}
                      aria-expanded={false}
                      aria-label={`Expand the ${group} columns`}
                    >
                      <Chevron open={false} />
                      {group}
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
                    {/*
                      The group's NAME, with a chevron for its state. These read
                      "Collapse EMA" — an instruction where a column-group label
                      belongs, so the header row of a dense table said what
                      clicking would do four times over and never said what the
                      columns underneath were. The action is still announced,
                      on the control.
                    */}
                    <button
                      onClick={() => onToggleGroup(group)}
                      className="flex items-center gap-1 font-semibold text-[var(--color-ink)] hover:text-[var(--color-ink-dim)]"
                      title={`Collapse ${group}`}
                      aria-expanded
                      aria-label={`Collapse the ${group} columns`}
                    >
                      <Chevron open />
                      {group}
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
                  title={spec.title ?? spec.header}
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                  className={`select-none text-right font-medium text-[var(--color-ink-dim)] ${
                    spec.group === "Symbol" ? "sticky-col text-left" : ""
                  }`}
                >
                  <button onClick={header.column.getToggleSortingHandler()}
                    className="cursor-pointer hover:text-[var(--color-ink)]"
                    aria-label={`Sort by ${spec.header}${sorted ? `, currently ${sorted}` : ""}`}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sorted === "asc" ? " ↑" : sorted === "desc" ? " ↓" : ""}
                  </button>
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
                    {onRemoveSymbol && (
                      <button disabled={busy} onClick={() => onRemoveSymbol(data.symbol)}
                        className="ml-3 rounded border border-[var(--color-line)] px-2 text-[var(--color-neg)] disabled:opacity-50">
                        Remove symbol
                      </button>
                    )}
                  </td>
                </tr>
              );
            }

            return (
              <Fragment key={data.symbol}>
                <tr
                  className="cursor-pointer hover:bg-[var(--color-surface-2)]"
                  onClick={() => setExpanded(isOpen ? null : data.symbol)}
                  tabIndex={0}
                  aria-expanded={isOpen}
                  aria-label={`${data.symbol}, ${data.state}. ${isOpen ? "Collapse" : "Expand"} details`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setExpanded(isOpen ? null : data.symbol);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => {
                    const spec = specs.find((s) => s.id === cell.column.id)!;
                    if (spec.id === "symbol") {
                      return (
                        <td key={cell.id} className="sticky-col font-medium">
                          <span className="mr-1 text-[var(--color-ink-dim)]">
                            {isOpen ? "−" : "+"}
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
                {isOpen && <RowDetail row={data} span={colCount} busy={busy} onRemove={onRemoveSymbol} />}
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
