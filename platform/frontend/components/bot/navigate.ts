"use client";
/**
 * Leaving Trading Scene for the Bot's own page (key enrollment, the one-time
 * webhook-secret reveal). One seam so a test can see where the browser would
 * have gone without jsdom pretending to navigate.
 *
 * Only an http(s) URL carrying a `#t=` ticket fragment is followed: the
 * Platform already checked its origin against BOT_PUBLIC_ORIGIN, and the
 * fragment never reaches a server log. The URL is not stored anywhere.
 */
let navigate: (url: string) => void = (url) => { window.location.assign(url); };

export function setNavigateForTests(fn: ((url: string) => void) | null): void {
  navigate = fn ?? ((url) => { window.location.assign(url); });
}

export function openBotPage(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol) || !/^#t=[A-Za-z0-9_-]{20,}$/.test(parsed.hash)) return false;
  navigate(url);
  return true;
}
