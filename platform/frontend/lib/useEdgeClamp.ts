"use client";
/**
 * Keep an anchored menu inside the window.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * TVP8 round two. The chart-type menu is `absolute left-0 top-full` with a
 * fixed `w-[264px]`, anchored to a trigger that sits in the middle of the
 * toolbar. At 390×844 — the campaign's own phone viewport — the trigger is at
 * x=208, so the menu runs from 208 to 472 in a 390px window: 82px of every row
 * hangs off the right edge, and there is no horizontal scroll to reach it.
 * "Session volume profi…", "Time Price Opportun…" and "Volume footprint" were
 * cut mid-word. Measured on the production build, not inferred.
 *
 * ── Why a hook and not a class ─────────────────────────────────────────────
 *
 * CSS cannot express this. The menu is positioned against its TRIGGER, and
 * whether that overflows depends on where the trigger happens to be in the
 * viewport — which no media query knows. `right-0` fixes this one toolbar at
 * one width and breaks the menus anchored near the left edge.
 *
 * So it is measured, once per opening and again on resize, and corrected with
 * a transform. A transform rather than `left`, because the menu's own
 * positioning stays declarative in the class list: this only nudges what is
 * already placed, and removing the hook leaves a menu that still opens in the
 * right place on a wide window.
 */
import { useLayoutEffect, useState, type RefObject } from "react";

/** Breathing room at the window's edge, matching the workstation's gutter. */
export const EDGE_GUTTER = 8;

/**
 * How far this element must move horizontally to sit inside the window.
 *
 * Zero when it already does, which is the overwhelmingly common case and
 * produces no transform at all.
 */
export function clampOffset(
  rect: { left: number; right: number }, viewportWidth: number, gutter = EDGE_GUTTER,
): number {
  const overflowRight = rect.right - (viewportWidth - gutter);
  if (overflowRight > 0) {
    /*
     * Pull it left, but never past the gutter on the other side: a menu wider
     * than the window is a different problem, and dragging its left edge off
     * screen to save its right one makes it strictly worse.
     */
    // `|| 0` normalises NEGATIVE ZERO. `Math.min(6, 0)` negated is `-0`, and
    // `Object.is(-0, 0)` is false — so a caller comparing strictly against 0,
    // which the tests do and a memo might, would see a change that is not one.
    return -Math.min(overflowRight, Math.max(0, rect.left - gutter)) || 0;
  }
  const overflowLeft = gutter - rect.left;
  if (overflowLeft > 0) {
    return Math.min(overflowLeft, Math.max(0, (viewportWidth - gutter) - rect.right));
  }
  return 0;
}

/**
 * `style` for an anchored menu, keeping it inside the window.
 *
 * Applied in a layout effect so the correction lands in the same frame the
 * menu appears in — measured after paint, the user sees it jump.
 */
export function useEdgeClamp(
  ref: RefObject<HTMLElement | null>, open: boolean,
): { transform?: string } {
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    if (!open) { setOffset(0); return; }
    const measure = (): void => {
      const el = ref.current;
      if (!el) return;
      /*
       * Measured with the current correction removed, so a resize that gives
       * the menu room again lets it come back rather than compounding the
       * offset it applied last time.
       */
      el.style.transform = "";
      const rect = el.getBoundingClientRect();
      setOffset(clampOffset(rect, window.innerWidth));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // `offset` is deliberately not a dependency: it is the OUTPUT, and
    // depending on it would re-measure a menu already corrected. The linter
    // agrees — `measure` reads it through neither closure nor state.
  }, [open, ref]);

  return offset === 0 ? {} : { transform: `translateX(${offset}px)` };
}
