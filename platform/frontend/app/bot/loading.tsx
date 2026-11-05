import { PageShell } from "@/components/ui";

export default function BotLoading() {
  return (
    <PageShell width="narrow" role="status" aria-label="Loading the Bot">
      <div className="h-5 w-36 animate-pulse rounded bg-surface-2" />
      <div className="mt-4 h-24 animate-pulse rounded-md border border-border bg-surface" />
      <div className="mt-3 h-40 animate-pulse rounded-md border border-border bg-surface" />
    </PageShell>
  );
}
