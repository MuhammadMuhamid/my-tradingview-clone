"use client";
/**
 * Taking a chart down before its container leaves the page.
 *
 * ── The crash this exists to prevent ───────────────────────────────────────
 *
 * `baseChartOptions` sets `autoSize: true`, which makes lightweight-charts
 * install its own `ResizeObserver` on the chart's container. React unmounts a
 * component in two stages: the container is removed from the DOM during the
 * commit, but a `useEffect` cleanup — where `chart.remove()` lives — is a
 * PASSIVE effect and runs afterwards. In the gap, the detached container
 * reports 0 × 0 to a chart that is still alive, and the library throws inside
 * its own resize path:
 *
 *   TypeError: Cannot read properties of undefined (reading 'fp')
 *     at ResizeObserver.<anonymous>
 *
 * With one chart on the page that was a rare, invisible error. Closing a
 * sixteen-pane layout raises it sixteen times at once, and every pane that
 * moves position in the grid on maximise or restore raises it too.
 *
 * A LAYOUT-effect cleanup runs before the host node is removed, which is early
 * enough: switching `autoSize` off there uninstalls the observer, so nothing
 * measures the container on its way out. The chart is still destroyed by its
 * own passive cleanup, exactly as before.
 */
import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";

/**
 * `useLayoutEffect`, except on the server, where it does nothing and warns.
 *
 * Chosen once at module load rather than per render, so the hook order is
 * constant — which is the only thing that makes this pattern safe.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** A chart handle with the one method this needs. Deliberately structural. */
interface AutoSizedChart {
  applyOptions: (options: { autoSize: boolean }) => void;
}

/**
 * Stop the library measuring this chart as soon as its component starts to
 * unmount. Call it once, beside the effect that creates the chart.
 */
export function useDetachChartObserver(
  chartRef: MutableRefObject<AutoSizedChart | null>
): void {
  const ref = useRef(chartRef);
  ref.current = chartRef;
  useIsomorphicLayoutEffect(() => () => {
    try { ref.current.current?.applyOptions({ autoSize: false }); }
    catch { /* the chart is already gone; there is nothing left to detach */ }
  }, []);
}
