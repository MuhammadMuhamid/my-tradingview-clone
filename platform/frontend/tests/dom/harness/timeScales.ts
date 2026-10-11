/**
 * What every chart on screen is actually showing, read from the charts.
 *
 * ── Why this reads the component tree ─────────────────────────────────────
 *
 * The viewport is the one fact this harness cannot see from the DOM: the time
 * axis, the candles and the study lines are all canvas, and the fake 2D
 * context here draws nothing. Every defect in the "a fit that ran while data
 * was in flight" family — Range blank, Replay not redrawing, Compare
 * collapsing the chart, the price pane and its studies describing two
 * different weeks — was invisible to this layer for exactly that reason, and
 * each was found by a person looking at a screenshot instead.
 *
 * So this is an ORACLE, not a gesture: it finds the `IChartApi` objects the
 * components hold in their refs and asks each one, through the library's own
 * public API, which bars it is showing. Nothing is changed; a test drives the
 * product the usual way and reads the outcome here. The price chart is the
 * `CandleChart` that owns it; a study pane is named by the `IndicatorPane`'s
 * own `id` prop, which is the pane id the overlays were grouped by.
 */
import type { IChartApi } from "lightweight-charts";

export interface ChartView {
  /** `price` for the main chart, otherwise the study pane's id. */
  id: string;
  /** First and last visible bar, in seconds — the library's `getVisibleRange`. */
  from: number;
  to: number;
  /** Visible logical range — bar offsets, including whitespace past the end. */
  logicalFrom: number;
  logicalTo: number;
  barSpacing: number;
}

interface Fiber {
  child: Fiber | null;
  sibling: Fiber | null;
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: { memoizedState: unknown; next: unknown } | null;
}

const isChart = (value: unknown): value is IChartApi =>
  !!value && typeof (value as IChartApi).timeScale === "function"
  && typeof (value as IChartApi).chartElement === "function";

function rootFiber(container: Element): Fiber | null {
  // The container RTL rendered into carries the root; any rendered node
  // carries its own fiber, which is enough to climb to it.
  for (const node of [container, ...container.querySelectorAll("*")]) {
    const key = Object.keys(node).find((k) =>
      k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"));
    if (!key) continue;
    let fiber = (node as unknown as Record<string, Fiber & { return?: Fiber | null }>)[key]!;
    // `__reactContainer$` holds the HostRoot itself.
    while ((fiber as { return?: Fiber | null }).return) {
      fiber = (fiber as { return: Fiber }).return as Fiber & { return?: Fiber | null };
    }
    return fiber;
  }
  return null;
}

/** Every chart the workspace has mounted, by the pane it draws. */
export function chartsIn(container: Element): Map<string, IChartApi> {
  const found = new Map<string, IChartApi>();
  const root = rootFiber(container);
  const stack: Fiber[] = root ? [root] : [];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    const name = typeof fiber.type === "function" ? (fiber.type as { name?: string }).name : null;
    if (name === "CandleChart" || name === "IndicatorPane") {
      let hook = fiber.memoizedState as { memoizedState: unknown; next: unknown } | null;
      while (hook) {
        const ref = hook.memoizedState as { current?: unknown } | null;
        if (ref && typeof ref === "object" && "current" in ref && isChart(ref.current)) {
          const id = name === "CandleChart" ? "price" : String(fiber.memoizedProps?.id ?? "pane");
          // The price chart's FIRST chart ref is its own chart; later refs are
          // maps or copies, and a copy is the same object anyway.
          if (!found.has(id)) found.set(id, ref.current);
          break;
        }
        hook = hook.next as typeof hook;
      }
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return found;
}

/** What every chart is showing right now; a chart with no data is omitted. */
export function chartViews(container: Element): ChartView[] {
  const views: ChartView[] = [];
  for (const [id, chart] of chartsIn(container)) {
    const scale = chart.timeScale();
    const range = scale.getVisibleRange();
    const logical = scale.getVisibleLogicalRange();
    if (!range || !logical) continue;
    views.push({
      id,
      from: Number(range.from), to: Number(range.to),
      logicalFrom: logical.from, logicalTo: logical.to,
      barSpacing: scale.options().barSpacing,
    });
  }
  return views;
}

/**
 * The prices the main chart's plot spans, top to bottom, read through its
 * price series — the vertical counterpart of `chartViews`.
 */
export function pricePlotRange(container: Element): { low: number; high: number } {
  const root = rootFiber(container);
  const stack: Fiber[] = root ? [root] : [];
  let chart: IChartApi | null = null;
  let series: { coordinateToPrice: (y: number) => number | null; seriesType: () => string } | null = null;
  while (stack.length > 0 && !series) {
    const fiber = stack.pop()!;
    const name = typeof fiber.type === "function" ? (fiber.type as { name?: string }).name : null;
    if (name === "CandleChart") {
      let hook = fiber.memoizedState as { memoizedState: unknown; next: unknown } | null;
      while (hook) {
        const current = (hook.memoizedState as { current?: unknown } | null)?.current as
          Record<string, unknown> | undefined;
        if (current && !chart && isChart(current)) chart = current as unknown as IChartApi;
        if (current && typeof current.coordinateToPrice === "function"
          && typeof current.seriesType === "function"
          && (current.seriesType as () => string)() !== "Histogram" && !series) {
          series = current as unknown as typeof series;
        }
        hook = hook.next as typeof hook;
      }
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  if (!chart || !series) throw new Error("the price chart has no price series");
  const height = chart.paneSize().height;
  const priceSeries = series as unknown as { coordinateToPrice: (y: number) => number | null };
  const top = priceSeries.coordinateToPrice(0);
  const bottom = priceSeries.coordinateToPrice(height);
  if (top === null || bottom === null) throw new Error("the price scale has no range");
  return { low: Math.min(top, bottom), high: Math.max(top, bottom) };
}

/** The main chart's view. Throws when it has none, which is itself a failure. */
export function priceView(container: Element): ChartView {
  const view = chartViews(container).find((v) => v.id === "price");
  if (!view) throw new Error("the price chart is showing no bars at all");
  return view;
}
