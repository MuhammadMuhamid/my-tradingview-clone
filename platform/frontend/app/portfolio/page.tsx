"use client";
/**
 * A member's own packages: what they hold, what they've asked to join, and what
 * they can join next. Every account can open it; the server only ever returns
 * the signed-in member's own figures.
 *
 * Nothing here moves money. Joining asks the administrator, who records a
 * deposit only after checking it arrived. Values are realized results the
 * administrator's ledger holds, never a projection.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Empty, ErrorNotice, Loading, Notice, PageHeader, PageShell, StatusBadge } from "@/components/ui";
import { portfolioApi, type Holding, type OfferedPackage, type PackageTerm, type PortfolioResponse } from "@/lib/api";
import { failureReason } from "@/lib/errorCopy";
import { useSession } from "@/lib/session";

const TERM_LABEL: Record<PackageTerm, string> = {
  half_month: "Half a month", month: "One calendar month", quarter: "Three months", half_year: "Six months",
};

const karachi = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" });
const karachiDay = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium" });
const lastDay = (endsIso: string) => karachiDay.format(new Date(new Date(endsIso).getTime() - 1));
/** The last minute a deposit counts: the minute before the cohort starts. */
const deadline = (cutoffIso: string) => `${karachi.format(new Date(new Date(cutoffIso).getTime() - 60_000))} PKT`;

function usdt(value: string): string {
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const cents = fraction.replace(/0+$/, "");
  return `${value.startsWith("-") ? "−" : ""}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${cents ? `.${cents}` : ""} USDT`;
}

/** Realized change since the cohort started, from the ledger's own figures. */
function change(h: Holding): { text: string; className: string } | null {
  const capital = Number(h.capitalIn);
  if (!(capital > 0)) return null;
  const diff = Number(h.value) - capital;
  const pct = (diff / capital) * 100;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
  return { text: `${sign}${Math.abs(pct).toFixed(2)}%`, className: diff > 0 ? "text-up" : diff < 0 ? "text-down" : "text-ink-muted" };
}

const STATUS_COPY: Record<Holding["status"], string> = {
  open: "Waiting to start", running: "Running", settling: "Settling: waiting for its open trades to close",
  settled: "Settled: your payout can be arranged", cancelled: "Cancelled",
};

function HoldingCard({ h }: { h: Holding }) {
  const delta = change(h);
  const noMoneyYet = Number(h.capitalIn) === 0;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{h.packageName}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {karachiDay.format(new Date(h.startsAt))} – {lastDay(h.endsAt)} · {STATUS_COPY[h.status]}
          </p>
        </div>
        <StatusBadge status={h.status === "open" ? "pending" : h.status === "settling" ? "running" : h.status} />
      </div>
      {noMoneyYet ? (
        <p className="px-4 py-3 text-[13px] text-ink-muted">
          You&apos;re approved. Your deposit appears here once the administrator has recorded it.
        </p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-[13px] sm:grid-cols-4">
          <div><dt className="text-xs text-ink-muted">You put in</dt><dd className="tabular text-ink">{usdt(h.capitalIn)}</dd></div>
          <div><dt className="text-xs text-ink-muted">{h.status === "settled" ? "Final value" : "Value from closed trades"}</dt>
            <dd className="tabular text-ink">{usdt(h.value)}</dd></div>
          <div><dt className="text-xs text-ink-muted">Change</dt><dd className={`tabular ${delta?.className ?? "text-ink-muted"}`}>{delta?.text ?? "—"}</dd></div>
          <div><dt className="text-xs text-ink-muted">Paid out to you</dt><dd className="tabular text-ink">{usdt(h.paidOut)}</dd></div>
        </dl>
      )}
    </Card>
  );
}

function PackageOffer({ pkg, unlocked, requested, onJoined }: {
  pkg: OfferedPackage; unlocked: boolean; requested: boolean; onJoined: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cohort = pkg.nextCohort;
  const join = async () => {
    if (!cohort) return;
    setBusy(true); setError(null);
    try { await portfolioApi.join(cohort.id); onJoined(); } catch (e) { setError(failureReason(e)); }
    setBusy(false);
  };
  return (
    <Card>
      <div className="px-4 py-3">
        <h3 className="text-sm font-semibold text-ink">{pkg.name}</h3>
        {pkg.description && <p className="mt-1 text-[13px] text-ink-muted">{pkg.description}</p>}
        <p className="mt-1 text-xs text-ink-faint">{TERM_LABEL[pkg.term]} · minimum {usdt(pkg.minAmount)}</p>
        {cohort ? (
          <p className="mt-2 text-[13px] text-ink">
            Next term {karachiDay.format(new Date(cohort.startsAt))} – {lastDay(cohort.endsAt)}.
            Deposits must arrive by <span className="font-medium">{deadline(cohort.depositCutoffAt)}</span>.
          </p>
        ) : <p className="mt-2 text-[13px] text-ink-muted">No term is open for new members right now.</p>}
        {pkg.joinInstructions && (
          <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-[13px] text-ink">{pkg.joinInstructions}</p>
        )}
        <div className="mt-3">
          {requested
            ? <p className="text-[13px] text-ink-muted">You&apos;ve asked to join. The administrator will approve it.</p>
            : <Button variant="primary" disabled={!cohort || !unlocked || busy} onClick={() => void join()}>
                {busy ? "Asking…" : "Ask to join"}
              </Button>}
          {error && <p role="alert" title={error} className="mt-2 text-[13px] text-down">{error}</p>}
        </div>
      </div>
    </Card>
  );
}

export default function PortfolioPage() {
  const session = useSession();
  const user = session?.user ?? null;
  const [mine, setMine] = useState<PortfolioResponse | null>(null);
  const [offered, setOffered] = useState<OfferedPackage[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [m, o] = await Promise.all([portfolioApi.mine(), portfolioApi.offered()]);
      setMine(m); setOffered(o.packages); setError(null);
    } catch (e) { setError(e); }
  }, []);
  useEffect(() => { if (user) void load(); }, [user, load]);

  const unlocked = !!user?.moneyFeaturesUnlocked;
  const requestedCohorts = new Set((mine?.pending ?? []).filter((p) => p.status === "requested").map((p) => p.cohortId));
  const heldCohorts = new Set((mine?.holdings ?? []).map((h) => h.cohortId));

  return (
    <PageShell width="narrow">
      <PageHeader title="My portfolio"
        description="Your packages and what they're worth. Values are recorded by the administrator from closed trades. Past performance is not a guarantee of future results." />
      {!session && <Loading>Checking your account…</Loading>}
      {session && !user && <Notice>Sign in to see your portfolio. <Link href="/login?next=/portfolio" className="underline">Sign in</Link></Notice>}
      {user && !unlocked && (
        <Notice tone="warn">
          To join a package, verify your email and turn on two-factor sign-in.{" "}
          <Link href="/profile" className="underline">Open your profile</Link>
        </Notice>
      )}
      {!!error && <ErrorNotice error={String((error as Error).message ?? error)} what="your portfolio" />}
      {user && !mine && !error && <Loading>Reading your portfolio…</Loading>}

      {mine && (
        <section aria-label="Your holdings" className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Your holdings</h2>
          {mine.holdings.length === 0
            ? <Empty>You haven&apos;t joined a package yet.</Empty>
            : mine.holdings.map((h) => <HoldingCard key={h.cohortId} h={h} />)}
          {mine.pending.length > 0 && (
            <ul className="space-y-1 text-[13px]">
              {mine.pending.map((p) => (
                <li key={p.membershipId} className="text-ink-muted">
                  {p.packageName}: {p.status === "requested" ? "waiting for the administrator to approve" : "not approved"}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {offered && (
        <section aria-label="Packages you can join" className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Packages you can join</h2>
          {offered.length === 0 ? <Empty>No packages are open right now.</Empty> : offered.map((p) => (
            <PackageOffer key={p.id} pkg={p} unlocked={unlocked}
              requested={!!p.nextCohort && (requestedCohorts.has(p.nextCohort.id) || heldCohorts.has(p.nextCohort.id))}
              onJoined={() => void load()} />
          ))}
          <p className="text-xs text-ink-faint">
            Joining sends a request; it moves no money. Send your deposit as the instructions say, before the deadline.
            A deposit that arrives late goes into the next term.
          </p>
        </section>
      )}
    </PageShell>
  );
}
