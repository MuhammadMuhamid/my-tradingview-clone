/*
 * TVP8: this was `max-w-[1200px]` under a `max-w-[1100px]` page, so the shell
 * jumped a hundred pixels wider the moment the data landed. A loading state
 * exists to hold the page's shape; one that holds a different shape is worse
 * than none. It is `PageShell width="narrow"`'s own measurements now, which is
 * what the page itself renders.
 */
export default function JournalLoading() {
  return (
    <div
      className="ts-app mx-auto w-full max-w-[1100px] space-y-4 px-3 py-4 sm:px-4"
      role="status"
      aria-label="Loading Trade Journal"
    >
      <div className="h-5 w-36 animate-pulse rounded bg-surface-2" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="h-40 animate-pulse rounded-md border border-border bg-surface" />
        <div className="h-40 animate-pulse rounded-md border border-border bg-surface" />
      </div>
      <span className="sr-only">Loading Trade Journal evidence…</span>
    </div>
  );
}
