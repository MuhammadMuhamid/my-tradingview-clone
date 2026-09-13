/*
 * TVP8: this was `max-w-[1200px]` under a `max-w-[1100px]` page, so the shell
 * jumped a hundred pixels wider the moment the data landed. A loading state
 * exists to hold the page's shape; one that holds a different shape is worse
 * than none.
 *
 * TVP8 round two: it now IS `PageShell width="narrow"` rather than a copy of
 * its measurements. The component gained `role` and `aria-label` for exactly
 * this — a loading shell has to announce itself, and having no way to say so
 * was why this one was hand-rolled in the first place.
 */
import { PageShell } from "@/components/ui";

export default function JournalLoading() {
  return (
    <PageShell width="narrow" role="status" aria-label="Loading Trade Journal">
      <div className="h-5 w-36 animate-pulse rounded bg-surface-2" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="h-40 animate-pulse rounded-md border border-border bg-surface" />
        <div className="h-40 animate-pulse rounded-md border border-border bg-surface" />
      </div>
      <span className="sr-only">Loading Trade Journal evidence…</span>
    </PageShell>
  );
}
