"use client";
import type { ReactNode } from "react";

/** TradingView-style dark modal: dimmed backdrop, titled panel, footer slot. */
export function Modal({
  title, open, onClose, children, footer, wide = false,
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative flex max-h-[85vh] w-full ${wide ? "max-w-2xl" : "max-w-lg"} flex-col rounded-lg border border-border bg-surface shadow-2xl`}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
