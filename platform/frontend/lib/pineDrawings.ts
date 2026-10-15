import type { PineDrawings } from "@/lib/api";

/**
 * Several studies' drawings as one, for the one drawing layer.
 *
 * Pine studies and drawing native studies (Pivot Points, S&R MTF) both paint
 * through `PineDrawingLayer`, which takes a single set. Order is kept, so a
 * study added later paints over one added earlier, as on TradingView.
 */
export function mergeDrawings(parts: readonly (PineDrawings | null | undefined)[]): PineDrawings {
  const out: PineDrawings = { lines: [], boxes: [], labels: [], tables: [] };
  for (const d of parts) {
    if (!d) continue;
    out.lines.push(...d.lines);
    out.boxes.push(...d.boxes);
    out.labels.push(...d.labels);
    out.tables.push(...d.tables);
  }
  return out;
}
