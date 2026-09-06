"use client";
/**
 * "This chart is on a resolution this dialog cannot arm."
 *
 * ── Why a component and not a sentence in four places ──────────────────────
 *
 * A chart can sit on `45m`, which is three stored 15-minute bars added up. The
 * alert runner, the backtester and the optimizer all read the candle store, so
 * none of them can act on `45m` — and the tempting thing to do about that is to
 * open the dialog on `15m` and say nothing, because `15m` is where the numbers
 * came from and the alert would work.
 *
 * That is the one behaviour this product must not have. An alert armed from a
 * 45-minute chart and evaluated on 15-minute bars is not a slightly different
 * alert; it fires three times as often, at prices the chart never drew, and the
 * user has no way to know. The rule the resolution work is built on is that an
 * interval identity never changes without being told, so when a dialog cannot
 * honour the chart's resolution it says so, names what it is doing instead, and
 * leaves the control right there for the user to change.
 *
 * One component so all four dialogs say it the same way, and so a test can
 * assert that they do.
 */

export interface ResolutionNoticeProps {
  /** From `nativeOnlyNotice`. Null when the chart's resolution is usable. */
  notice: string | null;
  /** The timeframe the dialog opened on instead. */
  using: string;
}

export function ResolutionNotice({ notice, using }: ResolutionNoticeProps) {
  if (notice === null) return null;
  return (
    <p
      role="status"
      data-resolution-notice="true"
      className="rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] leading-relaxed text-warn"
    >
      {notice}. This alert is set to <strong className="font-semibold">{using}</strong>.
    </p>
  );
}
