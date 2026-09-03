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

/**
 * Turn the library's own container measurement on or off.
 *
 * The same lever `useDetachChartObserver` pulls on unmount, exposed because
 * unmounting is not the only time a live chart's container stops having a
 * size. Maximising an indicator pane hides the price chart, which takes its
 * container to 0 × 0 while the chart is still alive — the exact shape of the
 * crash documented at the top of this file.
 *
 * Safe to call on a chart that has already gone.
 */
export function setChartMeasuring(chart: AutoSizedChart | null, enabled: boolean): void {
  try { chart?.applyOptions({ autoSize: enabled }); }
  catch { /* the chart is already gone; there is nothing left to measure */ }
}

/**
 * Keep a chart measured only while its container is on screen.
 *
 * A LAYOUT effect, for the ordering: React mutates the DOM, then runs layout
 * effects, and only then does the browser deliver `ResizeObserver` callbacks
 * at the end of the frame. Switching measurement off here therefore happens
 * strictly between the container being hidden and the library being told
 * about it — so it is never told.
 */
export function useChartMeasuring(
  chartRef: MutableRefObject<AutoSizedChart | null>, visible: boolean
): void {
  const ref = useRef(chartRef);
  ref.current = chartRef;
  useIsomorphicLayoutEffect(() => {
    setChartMeasuring(ref.current.current, visible);
  }, [visible]);
}

/**
 * A one-way "this chart is gone" flag.
 *
 * lightweight-charts subscriptions are torn down by `chart.remove()`, but the
 * callbacks we install also reach React state, other panes and a
 * `requestAnimationFrame` continuation — none of which the library knows
 * about. A disposal guard is checked at the top of each of those, so nothing
 * that was already in flight when the pane closed can run against a chart that
 * no longer exists.
 *
 * Deliberately not a React hook: the guard is created and disposed inside the
 * effect that creates and destroys the chart, so its lifetime is the chart's
 * and not the component's.
 */
export interface DisposalGuard {
  readonly disposed: boolean;
  dispose(): void;
  /** Run `fn` unless the chart has gone. Returns undefined when it has. */
  run<T>(fn: () => T): T | undefined;
}

export function createDisposalGuard(): DisposalGuard {
  let disposed = false;
  return {
    get disposed() { return disposed; },
    dispose() { disposed = true; },
    run<T>(fn: () => T): T | undefined {
      return disposed ? undefined : fn();
    },
  };
}
