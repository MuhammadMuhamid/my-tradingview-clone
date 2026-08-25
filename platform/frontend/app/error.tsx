"use client";
import { useEffect } from "react";

/**
 * FE-08: the application had no error boundary anywhere.
 *
 * A render error in any component — a malformed candle response, an indicator
 * dividing by an empty series, a chart library throwing on a resize — unmounted
 * the whole route and left the user on a blank page with no way back except the
 * browser's reload button. On the chart, which is where the user spends their
 * time and which holds unsaved drawings and layout state, that is the worst
 * possible failure mode: everything gone, nothing said.
 *
 * This does not hide the error. It says what happened, gives the route a way to
 * re-render without a full reload, and keeps the rest of the application
 * reachable.
 */
export default function RouteError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only place this can go — there is no error
    // reporting service in this deployment, and inventing one would be a
    // production change.
    console.error("[route error]", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold text-ink">This page stopped working</h1>
      <p className="text-sm text-ink-muted">
        Something in the page threw an error. Nothing was sent to your bot and no orders were
        affected — this is a display failure.
      </p>
      <pre className="max-h-40 w-full overflow-auto rounded-md border border-border bg-surface-2 px-3 py-2 text-left text-xs text-ink-muted">
        {error.message || "Unknown error"}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={reset}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
        >
          Try again
        </button>
        <a
          href="/chart"
          className="rounded-md border border-border bg-surface-2 px-4 py-1.5 text-sm font-medium text-ink hover:bg-border"
        >
          Back to the chart
        </a>
      </div>
    </div>
  );
}
