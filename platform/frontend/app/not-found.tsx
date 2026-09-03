import Link from "next/link";

/** A mistyped or stale URL should offer a way on, not a bare 404. */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-lg font-semibold text-ink">Page not found</h1>
      <p className="text-sm text-ink-muted">
        That address does not match any page in this application.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {/* Every destination the global nav has — four of them used to be
            missing here, so a stale /journal link dead-ended. */}
        {[["/chart", "Chart"], ["/scanner", "Scanner"], ["/alerts", "Alerts"],
          ["/optimizers", "Optimizers"], ["/backtests", "Backtests"],
          ["/deployments", "Live trading"], ["/journal", "Journal"],
          ["/operations", "Operations"], ["/shariah", "Shariah"],
          ["/getting-started", "Getting started"]].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-ink hover:bg-border"
          >
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}
