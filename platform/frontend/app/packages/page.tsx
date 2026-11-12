"use client";
import { AdminOnlyPage } from "@/components/AdminOnlyPage";

/**
 * Investor packages, for the administrator: packages and their coins, cohorts,
 * members, and the money the administrator records after checking it arrived.
 *
 * Nothing here moves funds. Recording a deposit or withdrawal, and changing a
 * package's status, go through the same confirmation dialog the Bot commands
 * use, and each money form carries an idempotency key made when it opens, so a
 * retried submission is recorded once.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Button, Card, Empty, ErrorNotice, Field, Loading, Notice, PageHeader, PageShell, Select, StatusBadge, TextInput,
} from "@/components/ui";
import { StepUpDialog } from "@/components/bot/StepUpDialog";
import type { DialogResult } from "@/components/bot/commandRunner";
import {
  api, packagesAdminApi, type AdminPackage, type BotCredential, type CohortDetail, type CohortMember,
  type PackageCohortSummary, type PackageTerm,
} from "@/lib/api";
import { failureReason } from "@/lib/errorCopy";
import type { Deployment } from "@/lib/types";

const TERM_LABEL: Record<PackageTerm, string> = {
  half_month: "Half-month (1st–15th, 16th–end)", month: "Calendar month", quarter: "3 months", half_year: "6 months",
};

/** Cohort dates are Karachi calendar dates, so they're shown in Karachi time whatever the reader's clock. */
const karachi = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" });
const karachiDay = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium" });
const atKarachi = (iso: string) => `${karachi.format(new Date(iso))} PKT`;
/** The last day of a half-open window: the day before `endsAt`. */
const lastDay = (endsIso: string) => karachiDay.format(new Date(new Date(endsIso).getTime() - 1));

/** "1,234.5" from "1234.50000000": money as the ledger states it, trailing zeros trimmed. */
function usdt(value: string | null): string {
  if (value === null) return "—";
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const cents = fraction.replace(/0+$/, "");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value.startsWith("-") ? "−" : ""}${grouped}${cents ? `.${cents}` : ""} USDT`;
}

const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");

const sent = async (action: () => Promise<unknown>): Promise<DialogResult> => {
  try { await action(); return { close: true }; }
  catch (error) { return { close: false, error: failureReason(error) }; }
};

// ── creating a package ──────────────────────────────────────────────────────

function NewPackageForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [term, setTerm] = useState<PackageTerm>("month");
  const [minAmount, setMinAmount] = useState("100");
  const [tradePercent, setTradePercent] = useState("25");
  const [description, setDescription] = useState("");
  const [joinInstructions, setJoinInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await packagesAdminApi.create({ name, term, minAmount, tradePercent, description, joinInstructions });
      setName(""); setDescription(""); setJoinInstructions("");
      onCreated();
    } catch (e) { setError(failureReason(e)); }
    setBusy(false);
  };

  return (
    <Card>
      <form onSubmit={submit} className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></Field>
        <Field label="Term">
          <Select value={term} onChange={(e) => setTerm(e.target.value as PackageTerm)}>
            {(Object.keys(TERM_LABEL) as PackageTerm[]).map((t) => <option key={t} value={t}>{TERM_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="Minimum deposit (USDT)"><TextInput inputMode="decimal" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} /></Field>
        <Field label="Each BUY spends (% of free equity)" help="Above 0, at most 100.">
          <TextInput inputMode="decimal" value={tradePercent} onChange={(e) => setTradePercent(e.target.value)} />
        </Field>
        <Field label="Description"><TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} /></Field>
        <Field label="How to deposit" help="Shown to members. Nothing is sent from the app.">
          <TextInput value={joinInstructions} onChange={(e) => setJoinInstructions(e.target.value)} maxLength={4000} />
        </Field>
        <div className="sm:col-span-2">
          <p className="mb-2 text-xs text-ink-faint">A new package starts paused. Members can't see it until you activate it.</p>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create package"}</Button>
          {error && <p role="alert" title={error} className="mt-2 text-[13px] text-down">{error}</p>}
        </div>
      </form>
    </Card>
  );
}

// ── one package ─────────────────────────────────────────────────────────────

function PackageCard({ pkg, deployments, attachedIds, selectedCohort, onSelectCohort, onChanged }: {
  pkg: AdminPackage;
  deployments: Deployment[];
  attachedIds: Set<string>;
  selectedCohort: string | null;
  onSelectCohort: (id: string) => void;
  onChanged: () => void;
}) {
  const [statusTarget, setStatusTarget] = useState<AdminPackage["status"] | null>(null);
  const [coin, setCoin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const free = deployments.filter((d) => !attachedIds.has(d.id));

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await action(); onChanged(); } catch (e) { setError(failureReason(e)); }
    setBusy(false);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">{pkg.name}</h2>
            <StatusBadge status={pkg.status === "closed" ? "stopped" : pkg.status} />
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">
            {TERM_LABEL[pkg.term]} · minimum {usdt(pkg.minAmount)} · each BUY {Number(pkg.tradePercent)}% of free equity
          </p>
          {pkg.description && <p className="mt-0.5 text-xs text-ink-faint">{pkg.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {pkg.status !== "active" && pkg.status !== "closed" && <Button onClick={() => setStatusTarget("active")}>Activate</Button>}
          {pkg.status === "active" && <Button onClick={() => setStatusTarget("paused")}>Pause</Button>}
          {pkg.status !== "closed" && <Button variant="danger" onClick={() => setStatusTarget("closed")}>Close</Button>}
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold text-ink-muted">Coins</h3>
          <p className="mt-1 text-[13px] text-ink">
            {pkg.deployments.length ? pkg.deployments.map((d) => d.symbol).join(", ") : "None yet. Add the deployments this package trades."}
          </p>
          {pkg.status !== "closed" && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Select aria-label={`Add a coin to ${pkg.name}`} value={coin} onChange={(e) => setCoin(e.target.value)}>
                <option value="">Choose a deployment…</option>
                {free.map((d) => <option key={d.id} value={d.id}>{d.symbol} · {d.timeframe} · {d.status}</option>)}
              </Select>
              <Button disabled={!coin || busy} onClick={() => void act(async () => {
                await packagesAdminApi.attachDeployment(pkg.id, coin); setCoin("");
              })}>Add coin</Button>
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-ink-muted">Cohorts</h3>
            {pkg.status !== "closed" && (
              <Button variant="ghost" disabled={busy} onClick={() => void act(() => packagesAdminApi.scheduleCohort(pkg.id))}>
                Schedule next cohort
              </Button>
            )}
          </div>
          {pkg.cohorts.length === 0
            ? <p className="mt-1 text-[13px] text-ink-faint">No cohorts yet.</p>
            : <ul className="mt-1 divide-y divide-border">
                {pkg.cohorts.map((c) => <CohortRow key={c.id} cohort={c} selected={c.id === selectedCohort} onSelect={() => onSelectCohort(c.id)} />)}
              </ul>}
        </div>
      </div>
      {error && <div className="px-4 pb-3"><p role="alert" title={error} className="text-[13px] text-down">{error}</p></div>}

      <StepUpDialog open={statusTarget !== null} title={`${statusTarget === "active" ? "Activate" : statusTarget === "paused" ? "Pause" : "Close"} ${pkg.name}`}
        intro={statusTarget === "active" ? "Members will see this package and can ask to join its next cohort."
          : statusTarget === "paused" ? "Members stop seeing this package. Running cohorts are not affected."
          : "Closing is permanent: no new cohorts can be scheduled."}
        confirmLabel={statusTarget === "closed" ? "Close package" : "Confirm"} danger={statusTarget === "closed"}
        allowsPassword onCancel={() => setStatusTarget(null)}
        onConfirm={(credential) => sent(async () => {
          await packagesAdminApi.setStatus(pkg.id, statusTarget!, credential); onChanged();
        })} />
    </Card>
  );
}

function CohortRow({ cohort, selected, onSelect }: { cohort: PackageCohortSummary; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button type="button" onClick={onSelect} aria-pressed={selected}
        className={`flex w-full flex-wrap items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-state-hover ${selected ? "bg-state-active" : ""}`}>
        <span className="text-ink">{karachiDay.format(new Date(cohort.startsAt))} – {lastDay(cohort.endsAt)}</span>
        <span className="flex items-center gap-2 text-xs text-ink-muted">
          {cohort.members} member{cohort.members === 1 ? "" : "s"}
          {cohort.requests > 0 && <span className="text-warn">{cohort.requests} waiting</span>}
          <StatusBadge status={cohort.status} />
        </span>
      </button>
    </li>
  );
}

// ── one cohort ──────────────────────────────────────────────────────────────

type MoneyAction = { kind: "deposit" | "withdraw"; member: CohortMember; key: string };

function CohortPanel({ cohortId, onChanged }: { cohortId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<CohortDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [money, setMoney] = useState<MoneyAction | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [lateReason, setLateReason] = useState("");

  const load = useCallback(async () => {
    try { setDetail(await packagesAdminApi.cohort(cohortId)); setError(null); }
    catch (e) { setError(e); }
  }, [cohortId]);
  useEffect(() => { setDetail(null); void load(); }, [load]);

  const changed = () => { void load(); onChanged(); };
  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try { await action(); changed(); } catch (e) { setActionError(failureReason(e)); }
  };
  const openMoney = (kind: MoneyAction["kind"], member: CohortMember) => {
    setAmount(""); setReference(""); setNote(""); setLateReason("");
    setMoney({ kind, member, key: newKey() });
  };

  if (error) return <ErrorNotice error={String((error as Error).message ?? error)} what="this cohort" />;
  if (!detail) return <Loading>Reading the cohort…</Loading>;

  const pastCutoff = Date.now() >= new Date(detail.depositCutoffAt).getTime();
  const total = detail.members.filter((m) => m.status === "approved")
    .reduce((sum, m) => sum + Number(m.value), 0);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            Cohort {karachiDay.format(new Date(detail.startsAt))} – {lastDay(detail.endsAt)}
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Deposits until {atKarachi(new Date(new Date(detail.depositCutoffAt).getTime() - 60_000).toISOString())} · equity {usdt(detail.equity)}
            {detail.openingCapital !== null && ` · opened with ${usdt(detail.openingCapital)}`}
            {detail.closingValue !== null && ` · closed at ${usdt(detail.closingValue)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={detail.status} />
          <Button variant="ghost" onClick={() => void act(() => packagesAdminApi.advanceCohort(cohortId))}>Update status</Button>
        </div>
      </div>

      {detail.status === "open" && (
        <form className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-3"
          onSubmit={(e) => { e.preventDefault(); void act(async () => { await packagesAdminApi.addMember(cohortId, email); setEmail(""); }); }}>
          <Field label="Add a member by email"><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" disabled={!email.trim()}>Add</Button>
        </form>
      )}
      {actionError && <div className="px-4 pt-3"><p role="alert" title={actionError} className="text-[13px] text-down">{actionError}</p></div>}

      {detail.members.length === 0 ? <Empty>No members yet. Members ask to join from their portfolio, or you add them here.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px] tabular">
            <thead>
              <tr className="border-b border-border text-left text-xs text-ink-muted">
                <th className="px-3 py-1.5">Member</th><th className="px-3 py-1.5">Status</th>
                <th className="px-3 py-1.5 text-right">Put in</th><th className="px-3 py-1.5 text-right">Value</th>
                <th className="px-3 py-1.5 text-right">Paid out</th><th className="px-3 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {detail.members.map((m) => (
                <tr key={m.membershipId} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1.5"><span className="text-ink">{m.displayName}</span>
                    <span className="block text-xs text-ink-faint">{m.email ?? "deleted account"}</span></td>
                  <td className="px-3 py-1.5"><StatusBadge status={m.status === "requested" ? "pending" : m.status === "approved" ? "active" : m.status} /></td>
                  <td className="px-3 py-1.5 text-right">{usdt(m.capitalIn)}</td>
                  <td className="px-3 py-1.5 text-right">{usdt(m.value)}</td>
                  <td className="px-3 py-1.5 text-right">{usdt(m.paidOut)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <span className="inline-flex gap-1">
                      {m.status === "requested" && <>
                        <Button onClick={() => void act(() => packagesAdminApi.decide(m.membershipId, true))}>Approve</Button>
                        <Button variant="ghost" onClick={() => void act(() => packagesAdminApi.decide(m.membershipId, false))}>Reject</Button>
                      </>}
                      {m.status === "approved" && detail.status === "open" &&
                        <Button onClick={() => openMoney("deposit", m)}>Record deposit</Button>}
                      {m.status === "approved" && detail.status === "settled" &&
                        <Button onClick={() => openMoney("withdraw", m)}>Record payout</Button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-ink-faint">Members&apos; values add up to {total.toLocaleString(undefined, { maximumFractionDigits: 8 })} USDT.</p>
        </div>
      )}

      {detail.status === "settling" && (
        <div className="px-4 py-3"><Notice tone="warn">
          Settling: waiting for {detail.trades.filter((t) => t.status === "open").length} open trade(s) to close.
          Payouts open once it has settled.
        </Notice></div>
      )}

      <details className="border-t border-border px-4 py-3 text-[13px]">
        <summary className="cursor-pointer text-ink-muted">Ledger ({detail.entries.length} entries) and trades ({detail.trades.length})</summary>
        <ul className="mt-2 space-y-1">
          {detail.entries.map((e) => (
            <li key={e.id} className="flex flex-wrap justify-between gap-2 text-xs">
              <span className="text-ink">{e.kind} {e.sourceId ? `· ${e.sourceId}` : ""} {e.note ? `· ${e.note}` : ""}</span>
              <span className="text-ink-muted">{usdt(e.amount)} · {atKarachi(e.recordedAt)}</span>
            </li>
          ))}
          {detail.trades.map((t) => (
            <li key={`t-${t.id}`} className="flex flex-wrap justify-between gap-2 text-xs">
              <span className="text-ink">{t.symbol} · {t.status}</span>
              <span className="text-ink-muted">{usdt(t.quoteSpent)} · {atKarachi(t.openedAt)}</span>
            </li>
          ))}
        </ul>
      </details>

      <StepUpDialog open={money !== null}
        title={money?.kind === "deposit" ? `Record a deposit for ${money.member.displayName}` : `Record a payout to ${money?.member.displayName ?? ""}`}
        intro={money?.kind === "deposit"
          ? "Record only money you've checked arrived. The entry can't be edited afterwards."
          : `Record only money you've already sent. At most ${usdt(money ? (Number(money.member.value) - Number(money.member.paidOut)).toFixed(8) : null)} is left.`}
        confirmLabel={money?.kind === "deposit" ? "Record deposit" : "Record payout"}
        allowsPassword canConfirm={!!amount.trim() && !!reference.trim() && (money?.kind !== "deposit" || !pastCutoff || !!lateReason.trim())}
        onCancel={() => setMoney(null)}
        onConfirm={(credential: BotCredential) => sent(async () => {
          const body = { amount: amount.trim(), reference: reference.trim(), note: note.trim() || undefined,
            idempotencyKey: money!.key, ...credential };
          if (money!.kind === "deposit") {
            await packagesAdminApi.deposit(money!.member.membershipId, { ...body, lateReason: lateReason.trim() || undefined });
          } else {
            await packagesAdminApi.withdraw(money!.member.membershipId, body);
          }
          changed();
        })}>
        <div className="grid gap-3">
          <Field label="Amount (USDT)"><TextInput inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label={money?.kind === "deposit" ? "Transaction reference" : "Payout reference"} help="A transaction hash or bank reference.">
            <TextInput value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Note (optional)"><TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
          {money?.kind === "deposit" && pastCutoff && (
            <Field label="Reason for a late deposit" help="The deadline has passed. A reason is required and is kept in the audit log.">
              <TextInput value={lateReason} onChange={(e) => setLateReason(e.target.value)} maxLength={500} />
            </Field>
          )}
        </div>
      </StepUpDialog>
    </Card>
  );
}

// ── the page ────────────────────────────────────────────────────────────────

function PackagesView() {
  const [packages, setPackages] = useState<AdminPackage[] | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [cohortId, setCohortId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, deps] = await Promise.all([packagesAdminApi.list(), api.listDeployments().catch(() => [] as Deployment[])]);
      setPackages(list.packages); setDeployments(deps); setError(null);
    } catch (e) { setError(e); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const attached = useMemo(() => new Set((packages ?? []).flatMap((p) => p.deployments.map((d) => d.id))), [packages]);

  return (
    <PageShell width="narrow">
      <PageHeader title="Packages"
        description="Strategies members can join for a fixed term. You record each member's money after checking it arrived; nothing here moves funds. Dates are in Pakistan time."
        actions={<Button variant="primary" onClick={() => setCreating(!creating)}>{creating ? "Cancel" : "New package"}</Button>} />
      <Notice tone="warn">
        Packages aren&apos;t connected to live trading yet. Orders aren&apos;t sized from cohort equity, and trade results
        aren&apos;t recorded here automatically.
      </Notice>
      {creating && <NewPackageForm onCreated={() => { setCreating(false); void load(); }} />}
      {!!error && <ErrorNotice error={String((error as Error).message ?? error)} what="the packages" />}
      {!packages && !error && <Loading>Reading the packages…</Loading>}
      {packages?.length === 0 && <Empty>No packages yet. Create one to start.</Empty>}
      {packages?.map((p) => (
        <PackageCard key={p.id} pkg={p} deployments={deployments} attachedIds={attached}
          selectedCohort={cohortId} onSelectCohort={setCohortId} onChanged={() => void load()} />
      ))}
      {cohortId && <CohortPanel cohortId={cohortId} onChanged={() => void load()} />}
    </PageShell>
  );
}

/** An ordinary account is told this page is the administrator's; the page is not mounted. */
export default function PackagesPage() {
  return <AdminOnlyPage title="Packages" width="narrow"><PackagesView /></AdminOnlyPage>;
}
