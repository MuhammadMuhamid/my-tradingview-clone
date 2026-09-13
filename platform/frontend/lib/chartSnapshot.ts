/**
 * A picture of the chart.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * TVP8: the reference has a camera in its top toolbar — Save chart image, Copy
 * chart image, Copy link to the chart — and this product had none of the
 * three. Screenshotting a chart is how a trader asks a question about one, and
 * the alternative here was the operating system's own screen capture, which
 * takes the browser chrome and the desktop with it.
 *
 * ── What it captures, and what it does not ─────────────────────────────────
 *
 * The pane is not one canvas. Lightweight-charts owns one; the drawing layer
 * has its own; the volume-profile and footprint layers have more. They are
 * stacked in DOM order and composited here in that order, so a drawing is over
 * the candles in the file exactly as it is on screen.
 *
 * What is NOT captured is the HTML on top of the canvases — the OHLC legend,
 * the study legend, the amber disclosure chip. `<canvas>` cannot read them,
 * and the alternatives (an SVG foreignObject round trip, or a DOM-to-canvas
 * library) either taint the canvas or redraw the page approximately, which is
 * worse than a clean picture of the chart. The image is therefore the PLOT.
 * `snapshotCaption` puts the symbol, interval and timestamp back on it, so the
 * file still says what it is a picture of — which is the part of the legend a
 * shared screenshot actually needs.
 */

import { chartSurface } from "./chartTheme";

export interface SnapshotCaption {
  symbol: string;
  interval: string;
  /** Drawn bottom-right, small, like the reference's own watermark line. */
  at?: Date;
}

/**
 * Every canvas in the pane, drawn into one, at the device's pixel ratio.
 *
 * Returns null when the host holds no canvas at all — a pane that has not
 * finished mounting — so the caller can say "not yet" rather than saving a
 * blank rectangle.
 */
export function compositePane(
  host: HTMLElement, caption?: SnapshotCaption,
): HTMLCanvasElement | null {
  const canvases = [...host.querySelectorAll("canvas")];
  if (canvases.length === 0) return null;

  const box = host.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  const out = document.createElement("canvas");
  out.width = Math.round(box.width * dpr);
  out.height = Math.round(box.height * dpr);
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  /*
   * The pane's own ground first. The chart's layout background is transparent
   * so the surface shows through on screen; a PNG with a transparent ground
   * renders as whatever the viewer's chat client uses, which for a dark chart
   * is usually white.
   */
  const ground = getComputedStyle(host).backgroundColor;
  // The fallback is the THEME's surface, not a dark literal: a transparent
  // host on a light chart would otherwise hand back a black PNG.
  ctx.fillStyle = ground && ground !== "rgba(0, 0, 0, 0)" ? ground : chartSurface();
  ctx.fillRect(0, 0, box.width, box.height);

  for (const canvas of canvases) {
    const at = canvas.getBoundingClientRect();
    if (at.width <= 0 || at.height <= 0) continue;
    try {
      ctx.drawImage(canvas, at.left - box.left, at.top - box.top, at.width, at.height);
    } catch {
      // A tainted canvas would throw here. None of ours is — every pixel is
      // drawn by this application — but one bad layer must not lose the rest.
    }
  }

  if (caption) drawCaption(ctx, box.width, box.height, caption);
  return out;
}

function drawCaption(
  ctx: CanvasRenderingContext2D, width: number, height: number, caption: SnapshotCaption,
): void {
  const when = (caption.at ?? new Date()).toISOString().replace("T", " ").slice(0, 16);
  const text = `${caption.symbol} · ${caption.interval} · ${when} UTC`;
  ctx.font = "500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  const pad = 8;
  const measured = ctx.measureText(text).width;
  // Deliberately theme-INDEPENDENT: the caption paints its own dark chip and
  // writes on that, so it is legible over a white chart and a black one alike.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(width - measured - pad * 2, height - 24, measured + pad * 2, 24);
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fillText(text, width - measured - pad, height - 6);
}

/** A filename a person can find again: `BTCUSDT-4h-2026-09-13T15-40.png`. */
export function snapshotFilename(symbol: string, interval: string, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const safe = symbol.replace(/[^A-Za-z0-9._-]+/g, "");
  return `${safe || "chart"}-${interval}-${stamp}.png`;
}

/** Hand the canvas to the browser as a download. Resolves when it has been offered. */
export async function downloadCanvas(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The chart image could not be encoded.");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next frame rather than immediately: Safari has not finished
  // reading the blob when `click()` returns.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/**
 * Put the canvas on the clipboard.
 *
 * Throws with a sentence the user can act on rather than a DOMException.
 * `ClipboardItem` is absent in Firefox and the permission can be refused in
 * any browser, and "copy failed" with no reason is the worst possible answer
 * to a button the user just pressed.
 */
export async function copyCanvasToClipboard(canvas: HTMLCanvasElement): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("This browser cannot copy an image. Use Save image instead.");
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The chart image could not be encoded.");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    throw new Error("The clipboard refused the image. Use Save image instead.");
  }
}
