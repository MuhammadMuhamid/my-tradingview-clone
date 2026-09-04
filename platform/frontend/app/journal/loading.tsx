export default function JournalLoading() {
  return (
    <div className="mx-auto max-w-[1200px] px-3 py-4 sm:px-4" role="status" aria-label="Loading Trade Journal">
      <div className="h-5 w-36 animate-pulse rounded bg-surface-2" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="h-40 animate-pulse rounded-lg border border-border bg-surface" />
        <div className="h-40 animate-pulse rounded-lg border border-border bg-surface" />
      </div>
      <span className="sr-only">Loading Trade Journal evidence…</span>
    </div>
  );
}
