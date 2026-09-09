"use client";

import { useEffect, useState } from "react";

export type ThemeName = "light" | "dark";
export const THEME_KEY = "trading-scene-theme";

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeName>("dark");
  useEffect(() => setTheme(currentTheme()), []);
  const toggle = () => {
    const next: ThemeName = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage can be disabled */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content", next === "dark" ? "#0b0e14" : "#f8f9fd"
    );
    window.dispatchEvent(new CustomEvent("trading-scene-theme", { detail: next }));
    setTheme(next);
  };
  const next = theme === "dark" ? "Light" : "Dark";
  return (
    <button className="theme-toggle" type="button" onClick={toggle}
      aria-label={`Use ${next} theme`} title={`Use ${next} theme`}>
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
