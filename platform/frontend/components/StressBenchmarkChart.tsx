"use client";
/**
 * The benchmark over the period discovery searched, with the chosen windows
 * shaded on it.
 *
 * A table of "the three worst windows" asks to be taken on trust; the same
 * three drawn over the whole period show what they were chosen FROM, and
 * whether "worst" meant one crash or three ordinary dips. That is the point
 * of the chart, so it is deliberately plain: one line of closes, one neutral
 * band per window numbered by severity rank. Colour stays neutral — a window
 * is not a direction, and the contract keeps chroma for meaning.
 *
 * A small SVG rather than the workstation's chart: this is a static picture
 * of a few hundred thinned points, and it must not carry the chart's feed,
 * crosshair or theme plumbing onto a research page.
 */
import { displayTicker } from "@/lib/instrument";
import { fmtPrice } from "@/lib/format";
import type { StressBenchmarkPath } from "@/lib/types";

const W = 1000;
const H = 160;

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function StressBenchmarkChart({ symbol, interval, path, windows, range }: {
  symbol: string;
  interval: string;
  path: StressBenchmarkPath;
  windows: readonly { rank: number; startMs: number; endMs: number }[];
  /** The period searched; the x axis spans it even where the store has gaps. */
  range: { startMs: number; endMs: number };
}) {
  if (path.length < 2 || !(range.endMs > range.startMs)) return null;
  const closes = path.map(([, close]) => close);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const x = (t: number): number => ((t - range.startMs) / (range.endMs - range.startMs)) * W;
  const y = (close: number): number => H - ((close - lo) / span) * H;
  const line = path.map(([t, close], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(close).toFixed(1)}`)
    .join("");
  const ticker = displayTicker(symbol);
  const summary = `${ticker} ${interval} closes from ${day(range.startMs)} to ${day(range.endMs)}, `
    + `${fmtPrice(lo)} to ${fmtPrice(hi)}, with ${windows.length} stress window`
    + `${windows.length === 1 ? "" : "s"} shaded: `
    + windows.map((w) => `#${w.rank} ${day(w.startMs)} to ${day(w.endMs)}`).join(", ");

  return (
    <figure className="m-0 border-b border-border px-4 py-3" data-stress-benchmark-chart>
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 text-xs text-ink-muted">
        <span>{ticker} · {interval} · the period searched, with the windows chosen from it</span>
        <span className="tabular text-ink-faint">{fmtPrice(lo)} – {fmtPrice(hi)}</span>
      </figcaption>
      <div className="relative h-40 w-full">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}
          className="absolute inset-0 h-full w-full overflow-visible">
          {windows.map((w) => (
            <rect key={w.rank} data-stress-window={w.rank}
              x={x(w.startMs)} y={0} width={Math.max(2, x(w.endMs) - x(w.startMs))} height={H}
              className="fill-ink/10" />
          ))}
          <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5}
            vectorEffect="non-scaling-stroke" className="text-ink-muted" />
        </svg>
        {/* Rank labels are HTML so the stretched SVG cannot distort the type. */}
        {windows.map((w) => (
          <span key={w.rank} aria-hidden
            className="absolute top-0 -translate-x-1/2 text-xs font-medium text-ink tabular"
            style={{ left: `${(x((w.startMs + w.endMs) / 2) / W) * 100}%` }}>
            {w.rank}
          </span>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-faint tabular">
        <span>{day(range.startMs)}</span>
        <span>{day(range.endMs)}</span>
      </div>
    </figure>
  );
}
