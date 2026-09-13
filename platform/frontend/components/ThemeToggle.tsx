"use client";

import { useEffect, useState } from "react";

export type ThemeName = "light" | "dark";
export const THEME_KEY = "trading-scene-theme";

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * The theme control, wherever the shell keeps its other controls.
 *
 * It used to be `position: fixed` in the bottom-right corner of every page —
 * blurred, drop-shadowed, 10px radius — which is to say a Material FAB parked
 * on top of the price axis. No workstation floats a chrome control over its
 * own canvas, and 10px was a fourth radius in a product whose contract says 6.
 * It was the first non-chart pixel the eye landed on, and on a phone it sat
 * squarely on the "Automate" tab until a `:has()` rule was written to lift it.
 *
 * There is nowhere it needs to float: the chart has `ProductMenu` and every
 * other page has `Nav`'s right-hand cluster, and both already hold controls of
 * exactly this kind.
 */
export function ThemeToggle({ className = "", role, withLabel = false }: {
  className?: string;
  role?: string;
  /** Menu rows say what they do in words; an icon button does not. */
  withLabel?: boolean;
} = {}) {
  const [theme, setTheme] = useState<ThemeName>("dark");
  useEffect(() => setTheme(currentTheme()), []);
  const toggle = () => {
    const next: ThemeName = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage can be disabled */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content", next === "dark" ? "#2e2e2e" : "#ebebeb"
    );
    window.dispatchEvent(new CustomEvent("trading-scene-theme", { detail: next }));
    setTheme(next);
  };
  const next = theme === "dark" ? "Light" : "Dark";
  return (
    <button className={className} type="button" onClick={toggle}
      role={role}
      aria-label={`Use ${next} theme`} title={`Use ${next} theme`}>
      {withLabel && <span className="flex-1 text-left">{`Use ${next} theme`}</span>}
      {theme === "dark" ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M20.5 14.2A8 8 0 019.8 3.5 8.5 8.5 0 1020.5 14.2z"/>
        </svg>
      )}
    </button>
  );
}
