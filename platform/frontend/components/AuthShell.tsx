"use client";
/**
 * The frame every account page sits in: the product mark on a plain field and
 * one card, as TradingView's sign-in and account screens are drawn.
 */
import type { ReactNode } from "react";
import { PRODUCT_NAME } from "@/lib/navigation";

export function ProductMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-ink">
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 15.5l3.5-4 2.8 2.2L18 8.5" stroke="currentColor" strokeWidth="1.7"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AuthShell({ children, width = 400 }: { children: ReactNode; width?: number }) {
  return (
    <div className="ts-app flex min-h-screen flex-col items-center bg-surface px-4 py-10 sm:py-16">
      <a href="/chart" className="mb-8 flex items-center gap-2 text-ink" aria-label={PRODUCT_NAME}>
        <ProductMark />
        <span className="text-[18px] font-semibold tracking-tight">{PRODUCT_NAME}</span>
      </a>
      <div style={{ maxWidth: width }}
        className="w-full rounded-xl border border-border bg-surface-2 px-6 py-7 shadow-2xl sm:px-8">
        {children}
      </div>
    </div>
  );
}

/** The Google "G", in Google's own four colours — the brand mark, unmodified. */
export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function Avatar({ name, url, size = 32 }: { name: string; url: string | null; size?: number }) {
  const initials = (name.trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("") || "?")
    .toUpperCase();
  if (url) {
    return <img src={url} alt="" width={size} height={size} referrerPolicy="no-referrer"
      className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-white">
      {initials}
    </span>
  );
}

export const AUTH_FIELD = "block h-10 w-full rounded-md border border-control-border bg-surface px-3 "
  + "text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-accent";

export const PRIMARY_BUTTON = "flex h-10 w-full items-center justify-center rounded-md bg-accent px-3 "
  + "text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-40";

export const SECONDARY_BUTTON = "flex h-10 w-full items-center justify-center gap-2.5 rounded-md border "
  + "border-control-border bg-surface px-3 text-[14px] font-medium text-ink hover:bg-state-hover "
  + "disabled:opacity-40";
