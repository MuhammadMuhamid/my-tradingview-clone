"use client";
/**
 * "Classic Bot appearance": an opt-in, per-browser, purely visual preference.
 *
 * It recolours the `/bot` page body with the standalone Bot dashboard's
 * navy-and-teal palette, by overriding the `--ts-*` tokens on one wrapper
 * (`[data-bot-appearance="classic"]` in `app/globals.css`, dark theme only).
 * No second styling framework, no component forks; the Nav and every other
 * page keep the Platform skin. It is a documented exception to the neutral
 * rule (UI contract §2), opted into by the person who sees it.
 *
 * Default OFF. One key in localStorage; every read and write is guarded, so a
 * browser that refuses storage simply shows the standard look.
 */
import { useCallback, useEffect, useState } from "react";
import { forget, recall, remember } from "@/lib/browserStorage";

export const BOT_APPEARANCE_KEY = "trading-scene-bot-appearance";

export function readClassicAppearance(): boolean {
  try {
    return recall(BOT_APPEARANCE_KEY) === "classic";
  } catch {
    return false;
  }
}

export function writeClassicAppearance(on: boolean): void {
  try {
    if (on) remember(BOT_APPEARANCE_KEY, "classic");
    else forget(BOT_APPEARANCE_KEY);
  } catch {
    // Not remembered; the choice still applies until the page is left.
  }
}

/** Starts off on the server and on first paint, then reads the stored choice. */
export function useClassicBotAppearance(): [boolean, (on: boolean) => void] {
  const [classic, setClassic] = useState(false);
  useEffect(() => { setClassic(readClassicAppearance()); }, []);
  const set = useCallback((on: boolean) => {
    setClassic(on);
    writeClassicAppearance(on);
  }, []);
  return [classic, set];
}

/**
 * Whether the light theme is showing, read after mount and kept current.
 *
 * The classic palette is dark-only, so in light it does nothing; the toggle
 * says so instead of looking broken. Read from `<html data-theme>`, which both
 * theme toggles set, through an observer rather than one event name.
 */
export function useLightTheme(): boolean {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setLight(root.dataset.theme === "light");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return light;
}
