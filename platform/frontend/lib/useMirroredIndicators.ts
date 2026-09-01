"use client";
/**
 * Runs the chart's applied indicators a second time, for a split pane on a
 * different timeframe.
 *
 * The primary list stays the single source of truth: this hook never adds,
 * removes or persists anything, it only re-runs what pane 1 already holds
 * against pane 2's context. That keeps one visible list of studies in the
 * panel while both panes draw them at their own resolution.
 *
 * Runs are deliberately serialised rather than fired in parallel: a heavy
 * script is already seconds of CPU on the API, and a split view would
 * otherwise double the concurrent load the moment it opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartMarker } from "@/components/CandleChart";
import {
  mergeBarColorLayers, type ChartBarColor, type ChartDecoration, type ChartOverlay,
} from "@/lib/chartSeries";
import type { PineDrawings } from "@/lib/api";
import type { Interval } from "@/lib/types";
import { NO_DRAWINGS, runIndicator, type AppliedIndicator } from "@/lib/indicators";

export function useMirroredIndicators(
  list: AppliedIndicator[],
  ctx: { symbol: string; timeframe: Interval; startTime: string; endTime: string },
  enabled: boolean,
  revision = 0
) {
  const [resultSet, setResultSet] = useState<{ contextKey: string; items: AppliedIndicator[] }>({
    contextKey: "", items: [],
  });
  const token = useRef(0);

  /**
   * Identity of what actually needs re-running. Re-running on every `list`
   * reference change would loop, because pane 1 replaces instances as their
   * own runs settle.
   */
  const signature = useMemo(
    () => list
      .filter((i) => i.visible)
      .map((i) => `${i.key}:${JSON.stringify(i.params)}:${i.source}`)
      .join("|"),
    [list]
  );

  const ctxKey = `${ctx.symbol}|${ctx.timeframe}|${ctx.startTime}|${ctx.endTime}|${revision}`;

  useEffect(() => {
    if (!enabled) { setResultSet({ contextKey: ctxKey, items: [] }); return; }
    const visible = list.filter((i) => i.visible);
    if (visible.length === 0) { setResultSet({ contextKey: ctxKey, items: [] }); return; }

    const mine = ++token.current;
    setResultSet({ contextKey: ctxKey, items: [] });
    let cancelled = false;
    (async () => {
      const out: AppliedIndicator[] = [];
      for (const ind of visible) {
        // Mirror pane 2's own key namespace so overlay ids never collide with
        // pane 1's series on the same chart instance.
        const res = await runIndicator({ ...ind, key: `mirror_${ind.key}` }, ctx);
        if (cancelled || token.current !== mine) return;
        out.push(res);
        setResultSet({ contextKey: ctxKey, items: [...out] });
      }
    })();
    return () => { cancelled = true; };
    // ctx is covered by ctxKey; list by signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, ctxKey]);

  const results = useMemo(
    () => resultSet.contextKey === ctxKey ? resultSet.items : [],
    [resultSet, ctxKey]
  );

  const overlays = useMemo<ChartOverlay[]>(
    () => results.flatMap((i) => i.overlays), [results]
  );
  const decorations = useMemo<ChartDecoration[]>(
    () => results.flatMap((i) => i.decorations), [results]
  );
  const barColors = useMemo<ChartBarColor[]>(
    () => mergeBarColorLayers(results.map((i) => i.barColors)), [results]
  );
  const markers = useMemo<ChartMarker[]>(
    () => results.flatMap((i) => i.markers), [results]
  );
  const drawings = useMemo<PineDrawings>(() => {
    if (results.length === 0) return NO_DRAWINGS;
    return {
      lines: results.flatMap((i) => i.drawings.lines),
      boxes: results.flatMap((i) => i.drawings.boxes),
      labels: results.flatMap((i) => i.drawings.labels),
      tables: results.flatMap((i) => i.drawings.tables),
    };
  }, [results]);

  const loading = enabled && results.length < list.filter((i) => i.visible).length;

  return { overlays, decorations, barColors, markers, drawings, loading };
}
