"use client";
import { useEffect, useState } from "react";

/**
 * Phone-width detection for the handful of decisions CSS cannot make —
 * chart-library options, and which panels start closed. Layout itself should
 * still use Tailwind's `md:` breakpoint rather than this hook.
 *
 * Starts false so the server-rendered markup matches the client's first paint,
 * then corrects after mount.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [breakpoint]);

  return isMobile;
}
