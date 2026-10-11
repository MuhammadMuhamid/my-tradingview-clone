"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  MAX_REVIEW_PACK_ASSETS, SHARIAH_ANSWER_LABELS, ShariahImportError, UNIVERSE_FILTERS,
  UNIVERSE_FILTER_EMPTY, comparePreviewToPack, describeShariahSync, downloadReviewPack,
  downloadSnapshot, filterUniverse, normalizeShariahMode, parseResultsFile,
  publicationSourceLabel, shariahApi,
  type ShariahAssetDetail, type ShariahClassification, type ShariahImportIssue,
  type ShariahImportPreview, type ShariahImportPreviewResult, type ShariahLastPack,
  type ShariahMode, type ShariahModeChange, type ShariahModeState, type ShariahReviewPackRequest,
  type ShariahSnapshotMeta, type ShariahSyncLevel, type ShariahUniverse, type ShariahUniverseFilter,
} from "@/lib/shariah";
import {
  Button, Card, CardHeader, Checkbox, Dropdown, Empty, Field, Notice, PageShell, Select,
  TextInput, PageHeader,
} from "@/components/ui";
import { fmtUtcStamp } from "@/lib/format";

/**
 * The private Shariah review console.
 *
 * `SH-2`: an asset could only leave UNSCREENED/STALE through a deliberate,
 * evidence-backed publication, and there was no way to perform one except by
 * curl. This is the smallest surface that makes the real workflow possible —
 * inspect the asset and its evidence, record a fact, publish a decision — and
 * nothing more. It is not a compliance dashboard.
 *
 * Two things this page deliberately does NOT do:
 *
 * - It does not classify. There is no suggestion, no score, no default
 *   selection: the reviewer picks the classification and writes the reason.
 * - It does not decide what is publishable. The backend refuses an incomplete
 *   review and this page shows that refusal verbatim, so the rule has exactly
 *   one home.
 */

const STATUS_STYLE: Record<ShariahClassification, string> = {
  ELIGIBLE: "bg-up/15 text-up border-up/30",
  EXCLUDED: "bg-down/15 text-down border-down/30",
  REVIEW: "bg-warn/15 text-warn border-warn/30",
};

const LIFECYCLE_NOTE: Record<string, string> = {
  UNSCREENED: "Never screened. Effective status is REVIEW.",
  STALE: "Previously screened, then invalidated (ticker reuse or delisting). "
    + "Effective status is REVIEW and a full fresh review is required — the old "
    + "classification cannot be reconfirmed.",
  SCREENED: "Screened under a published decision.",
};

function StatusPill({ status }: { status: ShariahClassification }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

/**
 * How the four Platform/Bot enforcement states look.
 *
 * Each carries a SHAPE as well as a colour, because "is the executing side
 * armed" is exactly the kind of state that must not be told by a shade of
 * green: an operator who cannot separate these two greens would read an
 * unknown Bot floor as a confirmed one. Drawn rather than typed, so the mark
 * is one size at one weight whatever font the platform substitutes.
 */
const SYNC_STYLE: Record<ShariahSyncLevel, { box: string; mark: ReactNode }> = {
  confirmed: {
    box: "border-up/30 bg-up/10 text-up",
    mark: <path d="M3 8.5l3.5 3.5L13 4" />,
  },
  drift: {
    box: "border-down/30 bg-down/10 text-down",
    mark: <><path d="M4 4l8 8M12 4l-8 8" /></>,
  },
  unknown: {
    box: "border-warn/30 bg-warn/10 text-warn",
    mark: <><path d="M5.6 5.6a2.4 2.4 0 113.2 2.3c-.6.3-1 .8-1 1.5v.3" /><path d="M8 12.4h.01" /></>,
  },
  off: {
    box: "border-border bg-surface-2 text-ink-muted",
    mark: <path d="M4 8h8" />,
  },
};

/**
 * Whether the execution Bot is enforcing, stated rather than assumed.
 *
 * ── Why this panel exists ──────────────────────────────────────────────────
 *
 * "Shariah Mode: ON" describes THIS PLATFORM's stored setting. The Bot also
 * accepts signals the Platform never sees, on its own webhook, and only the
 * Bot's own floor gates those. The backend already reports the Bot's answer
 * (`botMode`, `inSync`, and `botFloorPushed` on a change) precisely so that an
 * operator is never shown a green ON over an executing side that is not armed
 * — this renders it. `describeShariahSync` owns the rules; nothing is decided
 * here.
 *
 * Read once, when the page loads and after a mode change. There is no poll:
 * the answer only moves when someone changes it, and a background loop
 * hammering a Bot control channel would be a cost with no reader.
 */
function BotFloorPanel({ state, unreadable }: {
  state: ShariahModeState | null;
  /*
   * The mode read came back and did not produce a state.
   *
   * `describeShariahSync(null)` says "Bot floor: checking", which is true for
   * the first second and a lie thereafter — after a failure this panel sat on
   * "checking" indefinitely, on the one card that answers whether real-money
   * enforcement is armed. "Checking" is a claim that an answer is coming.
   */
  unreadable: boolean;
}) {
  const view = describeShariahSync(state);
  const style = SYNC_STYLE[view.level];
  if (!state && unreadable) {
    return (
      <div role="alert" className={`mb-3 rounded-md border px-3 py-2 text-xs ${SYNC_STYLE.unknown.box}`}>
        <span className="block font-semibold">Bot floor: could not be read</span>
        <span className="mt-0.5 block leading-snug opacity-90">
          This Platform could not read the enforcement state, so it cannot tell you whether the
          execution Bot&apos;s floor is armed. Treat it as unknown, not as off.
        </span>
      </div>
    );
  }
  return (
    <div
      role={view.level === "drift" ? "alert" : "status"}
      className={`mb-3 flex items-start gap-2.5 rounded-md border px-3 py-2 text-xs ${style.box}`}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        className="mt-px shrink-0" aria-hidden="true">
        {style.mark}
      </svg>
      <span className="min-w-0">
        <span className="block font-semibold">{view.label}</span>
        <span className="mt-0.5 block leading-snug opacity-90">{view.detail}</span>
      </span>
    </div>
  );
}

/** ISO date-time for the reviewed_at field, defaulted to now but always editable. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A backend failure, said the way a reader needs it.
 *
 * The raw cause is kept — it is the tooltip, and it is what a support request
 * needs — but it is not the headline. A route path, a stack frame or a status
 * code as the most prominent line on a page tells the reader nothing they can
 * do and everything about our plumbing.
 */
function shortReason(raw: string): string {
  if (/\b(401|403|unauthor|forbidden)/i.test(raw)) return "You may need to sign in again.";
  if (/\b(404|no route)/i.test(raw)) return "This environment does not serve it.";
  if (/\b(5\d\d|timeout|fetch failed|network)/i.test(raw)) return "The service did not answer. Try again shortly.";
  return "Hover for the reason reported.";
}

export default function ShariahPage() {
  const [view, setView] = useState<"status" | "screening">("status");
  const [universe, setUniverse] = useState<ShariahUniverse | null>(null);
  const [snapshots, setSnapshots] = useState<ShariahSnapshotMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShariahAssetDetail | null>(null);
  const [filter, setFilter] = useState<ShariahUniverseFilter>("needs-review");
  /*
   * The assets the operator has chosen to research, by id.
   *
   * The only way to get a pack used to be "the next 20", in queue order. An
   * operator who wanted to re-research one project they had read news about,
   * or finish a particular sector, could not say so. Kept apart from
   * `selected` (the asset open in the review panel): choosing an asset for a
   * pack and opening it to read are different acts.
   */
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The whole enforcement answer, not just this Platform's stored setting.
   *
   * It used to be `ShariahMode | null` — one field of the four the backend
   * reports — so the console could say ON while the execution Bot's floor was
   * unknown, out of sync, or never armed at all.
   */
  const [modeState, setModeState] = useState<ShariahModeState | null>(null);
  /*
   * The mode history and the re-review horizon were added to the API and to
   * nothing else — `GET /api/shariah/mode/history` and
   * `PUT /api/shariah/review-policy` were curl-only, which is precisely the
   * defect the universe-sync button had just been added to fix, one commit
   * earlier. A control that exists only in an HTTP client does not exist.
   */
  const [modeHistory, setModeHistory] = useState<ShariahModeChange[] | null>(null);
  /** False until the first universe/mode read has come back, either way. */
  const [loaded, setLoaded] = useState(false);
  const mode: ShariahMode | null = modeState?.mode ?? null;

  const loadUniverse = useCallback(async () => {
    try {
      const [u, s, m, h] = await Promise.all([
        shariahApi.universe(), shariahApi.snapshots(), shariahApi.mode(),
        shariahApi.modeHistory().catch(() => ({ changes: [] as ShariahModeChange[] })),
      ]);
      setUniverse(u);
      setSnapshots(s.snapshots);
      setModeState(normalizeShariahMode(m));
      setModeHistory(h.changes);
    } catch (e) {
      /*
       * `loaded` is what separates "not answered yet" from "answered, and the
       * answer is nothing". Without it every placeholder on this page was a
       * permanent one: the mode badge sat on "…", the review count sat on "…",
       * the Bot floor sat on "checking", and the two lists claimed "Nothing to
       * review" / "No snapshot has been created yet" — a confident empty state
       * for a question that failed. On the page that says whether the product
       * is enforcing Shariah, that is the worst place in the product to guess.
       */
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  /**
   * Re-read the mode after a change, success or failure.
   *
   * A PUT answers with `botFloorPushed` but not with the Bot's own current
   * floor, and a REFUSED change leaves this page holding whatever it had
   * before — which is the exact moment drift becomes possible. One extra read,
   * triggered by an operator action. Not a poll, and not a loop.
   */
  const rereadMode = useCallback(async (fallback: ShariahModeState | null) => {
    try {
      const fresh = normalizeShariahMode(await shariahApi.mode());
      // The PUT's `botFloorPushed` is the only place that field is ever
      // reported, so it is carried onto the fresh read rather than dropped:
      // "no control channel is configured" stays true until it is not.
      setModeState({ ...fresh, botFloorPushed: fallback?.botFloorPushed ?? fresh.botFloorPushed });
    } catch {
      // The mode endpoint is unreachable. Keep what the mutation itself said
      // rather than inventing a state; it is the more recent of the two.
      if (fallback) setModeState(fallback);
    }
  }, []);

  const loadDetail = useCallback(async (assetId: string) => {
    try {
      setDetail(await shariahApi.asset(assetId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void loadUniverse(); }, [loadUniverse]);
  useEffect(() => { if (selected) void loadDetail(selected); else setDetail(null); }, [selected, loadDetail]);

  const assets = useMemo(() => filterUniverse(universe?.assets ?? [], filter), [universe, filter]);

  const toggleChosen = (assetId: string, on: boolean) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(assetId); else next.delete(assetId);
      return next;
    });
  };
  /** Adds what the current filter shows; it never silently drops an earlier choice. */
  const chooseAllVisible = () => {
    setChosen((prev) => new Set([...prev, ...assets.map((a) => a.assetId)]));
  };

  /**
   * A snapshot, as the file Research cites.
   *
   * `GET /api/shariah/snapshots/:id` is the Research-facing contract and had
   * no caller in the product: the list showed an id and a hash, and getting
   * the membership those describe meant curl.
   */
  const downloadSnapshotJson = async (snapshotId: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const snapshot = await shariahApi.snapshot(snapshotId);
      downloadSnapshot(snapshot);
      setNotice(`Downloaded snapshot ${snapshot.snapshotId} — ${snapshot.entries.length} assets, `
        + `content hash ${snapshot.contentHash.slice(0, 12)}…`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * The toggle writes to the server and then renders what the server reports
   * back. The browser never holds the authoritative value — the gate that
   * actually refuses a BUY runs in the backend and reads the same setting.
   */
  const toggleMode = async () => {
    const next: ShariahMode = mode === "enforce" ? "off" : "enforce";
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = normalizeShariahMode(await shariahApi.setMode(next));
      setModeState(saved);
      setNotice(saved.mode === "enforce"
        ? "Shariah Mode is ON. New exposure (BUY) is allowed only for ELIGIBLE assets. "
          + "Selling or reducing a position is always allowed, and no position was changed."
        : "Shariah Mode is OFF. Trading behaviour is unchanged.");
      // The PUT does not report the Bot's own floor, so ask for it once.
      await rereadMode(saved);
    } catch (e) {
      setError((e as Error).message);
      // A refusal is exactly when the two sides can disagree — the 502 and the
      // 500 drift error both mean "one side moved and the other did not". Show
      // what the server says now rather than the stale value this page held.
      await rereadMode(modeState);
    } finally {
      setBusy(false);
    }
  };

  const createSnapshot = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const snapshot = await shariahApi.createSnapshot();
      setNotice(`Snapshot ${snapshot.snapshotId} created — ${snapshot.entryCount} assets, `
        + `content hash ${snapshot.contentHash.slice(0, 12)}…`);
      await loadUniverse();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Discover which assets this install actually tracks.
   *
   * `POST /api/shariah/universe/sync` called itself the registry's only
   * production entry point and had no caller anywhere — no button, no client
   * method, no script. A fresh install therefore had an EMPTY registry, every
   * symbol resolved to REVIEW, and turning Shariah Mode on was a total BUY stop
   * with nothing inside the product able to lift it.
   *
   * Discovery is not classification, which is what makes this safe to put
   * behind a button: the route creates newly seen assets UNSCREENED (it reads
   * as REVIEW) and has no path that writes ELIGIBLE or EXCLUDED. Running it can
   * only ever widen what needs reviewing, never what may be bought.
   */
  const syncUniverse = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await shariahApi.syncUniverse();
      setNotice(
        `Universe synced against ${r.qualifying} qualifying Binance Spot USDT base asset(s): `
        + `${r.created} newly discovered, ${r.reactivated} relisted, ${r.deactivated} no longer `
        + "tracked. Newly discovered assets are UNSCREENED, which counts as REVIEW — nothing "
        + "here has been classified, and nothing new can be bought until you publish a decision.");
      await loadUniverse();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * Two altitudes on one route. STATUS is the everyday question — is
   * enforcement on, what does the Bot floor say, how many assets are in each
   * state — and it is the default. SCREENING is the rare operator workflow:
   * the batch review pack, the universe list, evidence, publication and
   * history. The methodology and the fail-closed behaviour are untouched;
   * only what a visitor sees first has changed.
   */
  const screeningView = view === "screening";

  return (
    <PageShell>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <PageHeader
            title="Shariah"
            description={`Policy ${universe?.policyVersion ?? "TS_SHARIAH_V1"} · every classification is published deliberately by you. Nothing here is decided automatically.`}
          />
          <div role="tablist" aria-label="Shariah views" className="mt-2 flex gap-1">
            {([["status", "Status"], ["screening", "Screening & publication"]] as const).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                /* `.tvc-control` reads `aria-selected` above, so the chip and
                   the announced state are the same fact. Selection used to be
                   `bg-surface-2` and hover `hover:text-ink` — two different
                   kinds of signal for one choice. */
                className={`tvc-control flex h-7 items-center rounded-md px-2.5 text-sm ${
                  view === id ? "font-medium text-ink" : "text-ink-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${
            mode === "enforce" ? "bg-up/15 text-up border-up/30" : "bg-surface-2 text-ink-muted border-border"
          }`}>
            {/*
              This badge is about THIS PLATFORM only, and now says so. It used
              to be the page's single answer to "are we enforcing", which is a
              question one installation cannot answer alone — the Bot floor
              panel below carries the other half.
            */}
            Platform mode: {mode !== null ? (mode === "enforce" ? "ON" : "OFF")
              : loaded ? "unknown" : "…"}
          </span>
          <Button onClick={toggleMode} disabled={busy || mode === null}>
            {mode === "enforce" ? "Turn off" : "Turn on"}
          </Button>
          <Button onClick={syncUniverse} disabled={busy}
            title="Ask Binance which USDT spot base assets this install tracks, and add any it has not seen. Discovery only — nothing is classified and nothing becomes buyable.">
            Sync universe
          </Button>
          {screeningView && (
            <Button variant="primary" onClick={createSnapshot} disabled={busy}>
              Create universe snapshot
            </Button>
          )}
        </div>
      </div>

      <BotFloorPanel state={modeState} unreadable={loaded} />

      {/*
        The append-only record of who changed enforcement, when, and whether
        the Bot's floor moved with it. `app_settings` held this switch as one
        mutable row with a single `updated_at`, so "someone turned it off at
        some point" was the only recoverable fact about the control that
        governs religious compliance for the whole installation.
      */}
      {modeHistory !== null && modeHistory.length > 0 && (
        <details className="mb-3 rounded-md border border-border bg-surface-2/40">
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint hover:text-ink">
            Enforcement history — {modeHistory.length} change{modeHistory.length === 1 ? "" : "s"}
          </summary>
          <ul className="border-t border-border px-3 py-2 text-[11px] text-ink-muted">
            {modeHistory.slice(0, 20).map((change) => (
              <li key={change.id} className="flex flex-wrap items-center gap-x-3 py-0.5">
                <span className="tabular text-ink-faint">
                  {new Date(change.changedAt).toISOString().replace("T", " ").slice(0, 19)}Z
                </span>
                <span className="text-ink">
                  {change.fromMode === "enforce" ? "ON" : "OFF"} &rarr;{" "}
                  {change.toMode === "enforce" ? "ON" : "OFF"}
                </span>
                <span>by {change.changedBy}</span>
                <span className={change.botFloorPushed ? "text-ink-faint" : "text-warn"}>
                  {change.botFloorPushed
                    ? "Bot floor moved"
                    : "Bot floor NOT moved — no control channel"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {mode === "enforce" && (
        <div className="mb-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          Enforcement is on. A BUY is refused unless the asset is ELIGIBLE; UNSCREENED and STALE
          count as REVIEW and are refused. SELL, reduce and exit are never blocked, and turning
          this on never sells anything you already hold.
        </div>
      )}

      {/*
        The sentence a reader can act on; the provider's own words in the
        tooltip. This printed the raw cause straight across the page — on the
        QA fixture, literally "fixture server has no route for GET
        /api/shariah/universe" as the page's most prominent line.
      */}
      {error && (
        <Notice tone="error" role="alert">
          <span title={error}>The Shariah universe could not be read. {shortReason(error)}</span>
        </Notice>
      )}
      {notice && <Notice tone="success" role="status">{notice}</Notice>}

      {!screeningView && (
        <Card>
          <CardHeader title="Universe at a glance" right={
            <Button onClick={() => setView("screening")}>Open screening &amp; publication</Button>
          } />
          {universe ? (
            <div className="grid grid-cols-5 gap-px border-b border-border bg-border text-center">
              {([["Active", universe.counts.active], ["Eligible", universe.counts.eligible],
                ["Review", universe.counts.review], ["Excluded", universe.counts.excluded],
                /*
                 * Advisory, and labelled as such in the note below. An aged
                 * decision still stands and is still enforced; what it has lost
                 * is only the claim to be current, and the operator decides
                 * what to do about that. Nothing demotes it, and the exposure
                 * gate never reads this number.
                 */
                ["Due for re-review", universe.counts.dueForReReview]] as const)
                .map(([label, value]) => (
                  <div key={label} className="bg-surface px-2 py-2">
                    <div className="text-sm font-semibold text-ink">{value}</div>
                    <div className="text-[11px] text-ink-faint">{label}</div>
                  </div>
                ))}
            </div>
          ) : (
            <Empty>{loaded
              ? "The screening universe could not be read, so this is not a statement that it is empty."
              : "Loading the screening universe…"}</Empty>
          )}
          {universe && universe.counts.active === 0 && (
            <div className="border-b border-border bg-warn/10 px-4 py-2 text-[11px] leading-5 text-warn">
              This registry is empty, so every symbol reads as REVIEW and turning enforcement on
              would refuse every BUY. <span className="font-medium">Sync universe</span> discovers the
              assets this install tracks; it classifies nothing.
            </div>
          )}
          {universe && universe.counts.dueForReReview > 0 && (
            <div className="border-b border-border px-4 py-2 text-[11px] leading-5 text-ink-muted">
              {universe.counts.dueForReReview} settled decision(s) were researched more than{" "}
              {universe.reviewPolicy.reviewMaxAgeDays} days ago. They still stand and are still
              enforced — age withdraws nothing — but they reach the front of the next review pack
              so a project that has changed since gets looked at again.
            </div>
          )}
          {universe && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[11px] text-ink-muted">
              <span>Re-review a settled decision after</span>
              <select
                aria-label="Days after which a settled decision is surfaced as due for re-review"
                disabled={busy}
                value={universe.reviewPolicy.reviewMaxAgeDays ?? 0}
                onChange={(e) => {
                  const days = Number(e.target.value);
                  setBusy(true); setError(null); setNotice(null);
                  void shariahApi.setReviewPolicy(days === 0 ? null : days)
                    .then(() => loadUniverse())
                    .then(() => setNotice(days === 0
                      ? "Time-based re-review is off. Decisions are surfaced only when a delisted ticker reappears."
                      : `Settled decisions older than ${days} days are now surfaced as due. Nothing is demoted by age.`))
                    .catch((e) => setError((e as Error).message))
                    .finally(() => setBusy(false));
                }}
                className="rounded border border-control-border bg-transparent px-1.5 py-0.5"
              >
                <option value={180}>180 days</option>
                <option value={365}>365 days</option>
                <option value={730}>730 days</option>
                <option value={0}>never (off)</option>
              </select>
              <span className="text-ink-faint">
                Advisory only — an aged decision still stands and is still enforced.
              </span>
            </div>
          )}
          <p className="px-4 py-2 text-[11px] leading-5 text-ink-faint">
            With enforcement on, only ELIGIBLE assets can be bought; REVIEW, UNSCREENED and STALE are refused.
            Screening, evidence and publication — the work that moves an asset between these states — live
            under Screening &amp; publication.
          </p>
        </Card>
      )}

      {screeningView && (
      <BatchReviewCard
        needsReview={universe ? universe.counts.review : null}
        universeLoaded={loaded}
        chosenIds={[...chosen]}
        onClearChosen={() => setChosen(new Set())}
        onError={setError}
        onNotice={setNotice}
        onImported={loadUniverse}
      />
      )}

      {screeningView && (
      <div className="grid gap-3 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader
              title="Universe"
              right={
                <Dropdown label="Filter the screening universe" width={180}
                  value={filter} options={UNIVERSE_FILTERS}
                  onChange={(next) => setFilter(next as ShariahUniverseFilter)} />
              }
            />
            {universe && (
              <div className="grid grid-cols-4 gap-px border-b border-border bg-border text-center">
                {([["Active", universe.counts.active], ["Eligible", universe.counts.eligible],
                  ["Review", universe.counts.review], ["Excluded", universe.counts.excluded]] as const)
                  .map(([label, value]) => (
                    <div key={label} className="bg-surface px-2 py-2">
                      <div className="text-sm font-semibold text-ink">{value}</div>
                      <div className="text-[11px] text-ink-faint">{label}</div>
                    </div>
                  ))}
              </div>
            )}
            {universe && (
              /*
               * Choosing what to research. "Select all" adds what this filter
               * shows — so "Stale" then "Select all" is one way to ask for
               * every STALE asset — and never clears an earlier choice behind
               * the operator's back.
               */
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-ink-muted">
                <span aria-live="polite">
                  <span className="font-semibold text-ink">{chosen.size}</span> chosen for a pack
                </span>
                <Button variant="ghost" className="h-7 px-2 text-xs" onClick={chooseAllVisible}
                  disabled={assets.length === 0}>
                  Select all shown
                </Button>
                <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setChosen(new Set())}
                  disabled={chosen.size === 0}>
                  Clear
                </Button>
              </div>
            )}
            <div className="max-h-[520px] overflow-y-auto">
              {assets.length === 0 && (universe
                ? <Empty>{UNIVERSE_FILTER_EMPTY[filter]}</Empty>
                : <Empty>{loaded
                    ? "The screening universe could not be read, so this is not a statement that it is empty."
                    : "Loading the screening universe…"}</Empty>)}
              {assets.map((asset) => (
                /*
                 * A checkbox beside the row's button, not inside it: an input
                 * nested in a button is invalid markup and is announced as
                 * neither. Opening an asset and choosing it for a pack stay two
                 * separate controls with two separate names.
                 */
                <div key={asset.assetId}
                  className={`flex items-center gap-2 border-b border-border pl-3 ${
                    selected === asset.assetId ? "bg-state-active" : "hover:bg-state-hover"
                  }`}>
                  <Checkbox
                    checked={chosen.has(asset.assetId)}
                    onChange={(on) => toggleChosen(asset.assetId, on)}
                    label={`Choose ${asset.baseAsset} for the next review pack`}
                  />
                  <button
                    onClick={() => setSelected(asset.assetId)}
                    aria-current={selected === asset.assetId ? "true" : undefined}
                    /*
                     * Selected and hover used to be the same value —
                     * `bg-surface-2` both — so running the pointer down this
                     * list made every row look like the chosen one. They are now
                     * the product's two state neutrals, one step apart, on the
                     * row that holds both controls.
                     */
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 py-2 pr-3 text-left text-sm text-ink"
                  >
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{asset.baseAsset}</span>
                      {!asset.binanceAvailable && (
                        <span className="ml-2 text-[11px] text-ink-faint">delisted</span>
                      )}
                      <span className="block text-[11px] text-ink-faint">
                        {asset.lifecycle}{asset.dueForReReview ? " · due for re-review" : ""}
                      </span>
                    </span>
                    <StatusPill status={asset.effectiveStatus} />
                  </button>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Snapshots" />
            {snapshots.length === 0 && (universe
              ? <Empty>No snapshot has been created yet.</Empty>
              : <Empty>{loaded
                  ? "Snapshots could not be read, so this is not a statement that there are none."
                  : "Loading snapshots…"}</Empty>)}
            {snapshots.slice(0, 8).map((s) => (
              <div key={s.snapshotId} className="border-b border-border px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">#{s.snapshotId}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-ink-faint">{s.entryCount} assets</span>
                    <Button variant="ghost" className="h-7 px-2 text-xs" disabled={busy}
                      onClick={() => void downloadSnapshotJson(s.snapshotId)}
                      label={`Download snapshot ${s.snapshotId} as JSON`}
                      title="The frozen membership with its content hash — the file a Research run cites.">
                      Download JSON
                    </Button>
                  </span>
                </div>
                <div className="truncate font-mono text-[11px] text-ink-muted" title={s.contentHash}>
                  {s.contentHash}
                </div>
                <div className="text-[11px] text-ink-faint">{fmtUtcStamp(s.createdAt)}</div>
              </div>
            ))}
            <p className="px-3 py-2 text-[11px] text-ink-faint">
              A snapshot is immutable. Later publications and ticker changes never rewrite one.
            </p>
          </Card>
        </div>

        {detail
          ? <ReviewPanel
              key={detail.asset.assetId}
              detail={detail}
              categories={universe?.prohibitedCategories ?? []}
              onChanged={async () => { await loadDetail(detail.asset.assetId); await loadUniverse(); }}
              onError={setError}
              onNotice={setNotice}
            />
          : <Card><Empty>Select an asset to review.</Empty></Card>}
      </div>
      )}
    </PageShell>
  );
}

/**
 * The batch review workflow: export a pack, research it elsewhere, import the
 * results.
 *
 * The whole point of this card is that the research step costs nothing. Trading
 * Scene calls no model API, no paid search API and no crawler; the operator
 * uploads the pack to a ChatGPT session they already pay for, and brings the
 * JSON back.
 *
 * Importing IS the approval. One "Import & publish" click publishes the whole
 * researched batch, rather than making the operator approve twenty assets one
 * at a time — which is why the preview above it exists: it is the last look
 * before a batch of real, immutable publications. So it shows each decision
 * whole (reason, answers, evidence, open questions) one expandable row per
 * asset, and an ELIGIBLE that lists unresolved uncertainties must be
 * acknowledged row by row before the button will publish — a rule the backend
 * enforces too, so this card collects the acknowledgement and decides nothing.
 */
const PACK_SIZES = [
  { value: "10", label: "10 assets" },
  { value: "20", label: "20 assets" },
  { value: "50", label: "50 assets" },
] as const;

function BatchReviewCard({
  needsReview, universeLoaded, chosenIds, onClearChosen, onError, onNotice, onImported,
}: {
  needsReview: number | null;
  /** The universe read has come back — so a null count is unknown, not pending. */
  universeLoaded: boolean;
  /** Assets the operator ticked in the universe list, for "Download pack for selected". */
  chosenIds: readonly string[];
  onClearChosen: () => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onImported: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [resultsText, setResultsText] = useState("");
  const [preview, setPreview] = useState<ShariahImportPreview | null>(null);
  const [issues, setIssues] = useState<ShariahImportIssue[]>([]);
  const [size, setSize] = useState("20");
  const [includeSettled, setIncludeSettled] = useState(false);
  /*
   * The last pack downloaded on this page, so a pasted file can be checked
   * against it. Memory only: the Shariah surface keeps no browser storage, so
   * after a reload this is null and the preview says it cannot compare.
   */
  const [lastPack, setLastPack] = useState<ShariahLastPack | null>(null);
  /** Per-asset acknowledgements of ELIGIBLE-with-uncertainties rows. Never bulk-set. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());

  /** Any edit invalidates a checked preview: you cannot approve text you did not check. */
  const editResults = (text: string) => {
    setResultsText(text);
    setPreview(null);
    setIssues([]);
    setAcknowledged(new Set());
  };

  const download = async (request: ShariahReviewPackRequest, chosen: boolean) => {
    setBusy(true); onError(null); onNotice(null);
    try {
      const pack = await shariahApi.reviewPack(request);
      if (pack.assetCount === 0) {
        onNotice(includeSettled
          ? "The registry has no active asset to put in a pack."
          : "Nothing needs review — every active asset carries a settled classification. "
            + "Tick “Include settled decisions” to re-research one anyway.");
        return;
      }
      downloadReviewPack(pack);
      setLastPack({ generatedAt: pack.generatedAt, assetIds: pack.assets.map((a) => a.assetId) });
      if (chosen) onClearChosen();
      onNotice(`Downloaded ${pack.assetCount} asset${pack.assetCount === 1 ? "" : "s"} `
        + `(${pack.needsReviewTotal} still need review). Upload the file to ChatGPT and ask it to `
        + "follow the instructions inside, then paste the JSON it returns below.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    editResults(await file.text());
  };

  const check = async () => {
    setBusy(true); onError(null); onNotice(null); setPreview(null); setIssues([]);
    setAcknowledged(new Set());
    try {
      setPreview(await shariahApi.previewResults(parseResultsFile(resultsText)));
    } catch (e) {
      if (e instanceof ShariahImportError) setIssues(e.issues);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needingAck = preview ? preview.results.filter((r) => r.requiresAcknowledgement) : [];
  const unacknowledged = needingAck.filter((r) => !acknowledged.has(r.assetId));

  const publish = async () => {
    if (!preview) return;
    setBusy(true); onError(null); onNotice(null); setIssues([]);
    try {
      // Only the rows that need one, so a stale tick from an earlier preview
      // can never ride along — the backend refuses a surplus acknowledgement.
      const acks = needingAck.map((r) => r.assetId).filter((id) => acknowledged.has(id));
      const summary = await shariahApi.importResults(parseResultsFile(resultsText), acks);
      onNotice(`Published ${summary.importedCount} decision${summary.importedCount === 1 ? "" : "s"} `
        + `— ${summary.counts.ELIGIBLE} ELIGIBLE, ${summary.counts.EXCLUDED} EXCLUDED, `
        + `${summary.counts.REVIEW} REVIEW. Each one is an immutable publication with its own evidence. `
        + "Create a universe snapshot when you have finished importing for now.");
      editResults("");
      await onImported();
    } catch (e) {
      if (e instanceof ShariahImportError) setIssues(e.issues);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const packCheck = preview ? comparePreviewToPack(preview, lastPack) : null;
  const notInPack = new Set(packCheck?.notInPack ?? []);
  const tooManyChosen = chosenIds.length > MAX_REVIEW_PACK_ASSETS;

  return (
    <Card className="mb-3">
      <CardHeader
        title="Batch review with ChatGPT"
        right={
          <span className="text-xs text-ink-muted">
            Needs review: <span className="font-semibold text-ink">{needsReview ?? (universeLoaded ? "unknown" : "…")}</span>
          </span>
        }
      />
      <div className="px-3 py-3">
        <ol className="mb-3 grid gap-1 text-xs text-ink-muted sm:grid-cols-3">
          <li><span className="font-semibold text-ink">1.</span> Download a pack — the next assets in the queue, or the ones you ticked below.</li>
          <li><span className="font-semibold text-ink">2.</span> Upload that file to ChatGPT and let it research.</li>
          <li><span className="font-semibold text-ink">3.</span> Paste the JSON back here, read each decision, and publish.</li>
        </ol>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Dropdown label="Assets per pack" width={100} value={size} options={PACK_SIZES}
            onChange={setSize} disabled={busy} />
          <label className="flex items-center gap-2 text-xs text-ink-muted"
            title="Settled ELIGIBLE/EXCLUDED decisions join the queue after everything unsettled. Nothing is demoted by being researched again.">
            <Checkbox checked={includeSettled} onChange={setIncludeSettled} disabled={busy}
              label="Include settled decisions" />
            Include settled decisions
          </label>
          <Button variant="primary" disabled={busy}
            onClick={() => void download({ size: Number(size), includeSettled }, false)}>
            Download next {size} for ChatGPT
          </Button>
          <Button disabled={busy || chosenIds.length === 0 || tooManyChosen}
            onClick={() => void download({ assetIds: chosenIds }, true)}
            title={tooManyChosen
              ? `One pack carries at most ${MAX_REVIEW_PACK_ASSETS} assets.`
              : "Exactly the assets ticked in the universe list, whatever their state."}>
            Download pack for selected ({chosenIds.length})
          </Button>
          {tooManyChosen && (
            <span className="text-[11px] text-warn">
              {chosenIds.length} ticked — one pack carries at most {MAX_REVIEW_PACK_ASSETS}.
            </span>
          )}
        </div>

        <div className="mb-3">
          {/* Announced as a bare "file upload button" until it was named. */}
          <input
            id="shariah-results-file"
            type="file"
            accept="application/json,.json"
            aria-label="Load a ChatGPT review results JSON file"
            onChange={(e) => void chooseFile(e.target.files?.[0])}
            className="text-xs text-ink-muted file:mr-2 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-2 file:py-1 file:text-xs file:text-ink"
          />
        </div>

        <Field label="ChatGPT results (TS_SHARIAH_REVIEW_RESULTS_V1)"
          help="Paste only the JSON document — no markdown fence, no commentary. Nothing is published until you press Import & publish.">
          <textarea
            value={resultsText}
            onChange={(e) => editResults(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder='{ "format": "TS_SHARIAH_REVIEW_RESULTS_V1", ... }'
            className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
          />
        </Field>

        {preview && (
          <div className="mt-3 rounded-md border border-border bg-surface-2 px-3 py-2">
            <div className="mb-1 text-xs text-ink-muted">
              {preview.assetCount} asset{preview.assetCount === 1 ? "" : "s"} · researched{" "}
              {fmtUtcStamp(preview.researchCompletedAt)}
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <span className="text-up">{preview.counts.ELIGIBLE} ELIGIBLE</span>
              <span className="text-down">{preview.counts.EXCLUDED} EXCLUDED</span>
              <span className="text-warn">{preview.counts.REVIEW} REVIEW</span>
            </div>

            {/*
              Which pack this answers. Advisory: the backend checks every
              result against the live registry whatever pack it came from. What
              this catches is the human slip — last week's file, a colleague's
              pack — that a registry check cannot, because the assets are real.
            */}
            {packCheck && !packCheck.known && (
              <p className="mt-1 text-[11px] text-ink-faint">
                No pack was downloaded on this page since it loaded, so these results cannot be
                matched to one.
              </p>
            )}
            {packCheck?.differentPack && (
              <p role="status" className="mt-1 text-[11px] text-warn">
                This file says it answers the pack generated{" "}
                {fmtUtcStamp(preview.packGeneratedAt)}, not the one you last
                downloaded ({fmtUtcStamp(lastPack?.generatedAt)}).
              </p>
            )}
            {packCheck && packCheck.notInPack.length > 0 && (
              <p role="status" className="mt-1 text-[11px] text-warn">
                {packCheck.notInPack.length} result{packCheck.notInPack.length === 1 ? " is" : "s are"} for
                an asset that was not in the pack you last downloaded. Check the file is the one you meant.
              </p>
            )}
            {needingAck.length > 0 && (
              <p role="status" className="mt-1 text-[11px] text-warn">
                {needingAck.length} ELIGIBLE result{needingAck.length === 1 ? " lists" : "s list"} unresolved
                uncertainties. TS_SHARIAH_V1 resolves unclear materiality to REVIEW, so each one must be
                read and acknowledged below before this batch can publish.
              </p>
            )}

            <ul aria-label="Researched decisions" className="mt-2 max-h-[420px] overflow-y-auto text-[11px] text-ink-muted">
              {preview.results.map((r) => (
                <PreviewRow key={r.assetId} result={r}
                  notInLastPack={notInPack.has(r.assetId)}
                  acknowledged={acknowledged.has(r.assetId)}
                  onAcknowledge={(on) => setAcknowledged((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(r.assetId); else next.delete(r.assetId);
                    return next;
                  })}
                  disabled={busy}
                />
              ))}
            </ul>
          </div>
        )}

        {issues.length > 0 && (
          <div className="mt-3 rounded-md border border-down/30 bg-down/10 px-3 py-2">
            <div className="mb-1 text-xs font-semibold text-down">
              Nothing was published. Fix the file and check again.
            </div>
            <ul className="max-h-40 overflow-y-auto text-[11px] text-down">
              {issues.map((issue, i) => (
                <li key={i} className="border-t border-down/20 py-1">
                  {issue.baseAsset ? `${issue.baseAsset}: ` : issue.index !== null ? `results[${issue.index}]: ` : ""}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={check} disabled={busy || resultsText.trim().length === 0}>
            Check results
          </Button>
          <Button variant="primary" onClick={publish}
            disabled={busy || preview === null || unacknowledged.length > 0}
            title={unacknowledged.length > 0
              ? `Acknowledge the open questions on ${unacknowledged.map((r) => r.baseAsset).join(", ")} first.`
              : undefined}>
            Import &amp; publish {preview ? `${preview.assetCount} decisions` : ""}
          </Button>
          <span className="text-[11px] text-ink-faint">
            This one action is your approval for the whole batch. A STALE asset always needs a full
            fresh screening — its old classification can never be reconfirmed.
          </span>
        </div>
      </div>
    </Card>
  );
}

/**
 * One researched decision, expandable to its full grounds.
 *
 * Collapsed it is the line the preview always had — symbol, evidence count,
 * verdict — plus any warning that needs the operator's eye. Expanded it is
 * everything the researcher said: reason, the six answers, each citation and
 * the open questions. Text only; nothing in it is interpreted, and an evidence
 * link is rendered only for an http(s) URL (the backend refuses anything else,
 * this is the belt to that brace).
 */
function PreviewRow({ result: r, notInLastPack, acknowledged, onAcknowledge, disabled }: {
  result: ShariahImportPreviewResult;
  notInLastPack: boolean;
  acknowledged: boolean;
  onAcknowledge: (on: boolean) => void;
  disabled: boolean;
}) {
  const needsAck = r.requiresAcknowledgement;
  return (
    <li className="border-t border-border py-1">
      {/* A row that needs acknowledging starts open: its open questions are the point. */}
      <details open={needsAck}>
        <summary className="flex cursor-pointer select-none items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="font-medium text-ink">{r.baseAsset}</span>
            {needsAck && (
              <span className={acknowledged ? "text-ink-faint" : "text-warn"}>
                {acknowledged ? "uncertainties acknowledged" : `ELIGIBLE with ${r.unresolvedUncertainties.length} open question${r.unresolvedUncertainties.length === 1 ? "" : "s"}`}
              </span>
            )}
            {notInLastPack && <span className="text-warn">not in the last pack</span>}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span>{r.evidenceCount} evidence</span>
            <StatusPill status={r.classification} />
          </span>
        </summary>
        <div className="mt-1 grid gap-2 pb-1 pl-2">
          <p className="whitespace-pre-wrap text-ink">{r.reason}</p>
          <dl className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[max-content_minmax(0,1fr)]">
            {SHARIAH_ANSWER_LABELS.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-ink-faint">{label}</dt>
                <dd className="whitespace-pre-wrap">{r.answers[key] ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {r.prohibitedCategories.length > 0 && (
            <p>Categories: {r.prohibitedCategories.join(", ")}</p>
          )}
          <div>
            <div className="text-ink-faint">Evidence</div>
            {r.evidence.length === 0 && <p>None cited.</p>}
            <ul className="grid gap-1">
              {r.evidence.map((e, i) => (
                <li key={i}>
                  {/^https?:\/\//i.test(e.url)
                    ? <a href={e.url} target="_blank" rel="noopener noreferrer nofollow"
                        className="font-medium text-ink underline decoration-border underline-offset-2 hover:decoration-ink">
                        {e.title}
                      </a>
                    : <span className="font-medium text-ink">{e.title}</span>}
                  <span className="text-ink-faint"> · {e.publisher} · retrieved {fmtUtcStamp(e.retrievedAt)}</span>
                  <span className="block break-all text-ink-faint">{e.url}</span>
                  {e.note && <span className="block">{e.note}</span>}
                </li>
              ))}
            </ul>
          </div>
          {r.unresolvedUncertainties.length > 0 && (
            <div>
              <div className={needsAck ? "text-warn" : "text-ink-faint"}>Unresolved uncertainties</div>
              <ul className="list-disc pl-4">
                {r.unresolvedUncertainties.map((u, i) => <li key={i}>{u}</li>)}
              </ul>
            </div>
          )}
          {needsAck && (
            <label className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-warn">
              <Checkbox checked={acknowledged} onChange={onAcknowledge} disabled={disabled}
                label={`Acknowledge ${r.baseAsset}'s unresolved uncertainties and publish it as ELIGIBLE`} />
              <span>
                I have read {r.baseAsset}&apos;s unresolved uncertainties and judge that none of them is
                unclear materiality under TS_SHARIAH_V1. Publish it as ELIGIBLE. This acknowledgement is
                recorded with the decision.
              </span>
            </label>
          )}
        </div>
      </details>
    </li>
  );
}

function ReviewPanel({ detail, categories, onChanged, onError, onNotice }: {
  detail: ShariahAssetDetail;
  categories: string[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const { asset } = detail;
  const [classification, setClassification] = useState<ShariahClassification | "">("");
  const [reason, setReason] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [reviewedAt, setReviewedAt] = useState(nowIso());
  const [busy, setBusy] = useState(false);
  const [evidenceDraft, setEvidenceDraft] = useState({
    url: "", title: "", publisher: "", retrievedAt: "", excerpt: "",
  });

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const addEvidence = async () => {
    setBusy(true); onError(null); onNotice(null);
    try {
      await shariahApi.addEvidence(asset.assetId, {
        url: evidenceDraft.url || null,
        title: evidenceDraft.title || null,
        publisher: evidenceDraft.publisher || null,
        retrievedAt: evidenceDraft.retrievedAt || null,
        excerpt: evidenceDraft.excerpt || null,
      });
      setEvidenceDraft({ url: "", title: "", publisher: "", retrievedAt: "", excerpt: "" });
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!classification) return;
    setBusy(true); onError(null); onNotice(null);
    try {
      const published = await shariahApi.publish(asset.assetId, {
        classification, reason,
        prohibitedCategories: selectedCategories,
        evidenceIds: selectedEvidence,
        reviewedAt,
      });
      onNotice(`Published ${published.classification} for ${asset.baseAsset} `
        + `(decision #${published.publicationId}).`);
      setClassification(""); setReason(""); setSelectedCategories([]); setSelectedEvidence([]);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2">{asset.baseAsset}
            <span className="text-xs font-normal text-ink-faint">asset #{asset.assetId}</span></span>}
          right={<StatusPill status={asset.effectiveStatus} />}
        />
        <div className="px-4 py-3 text-xs text-ink-muted">
          <p><span className="font-medium text-ink">{asset.lifecycle}</span> — {LIFECYCLE_NOTE[asset.lifecycle]}</p>
          {/*
            An imported decision's reason is STRUCTURED text — the researcher's
            reason, then "TS_SHARIAH_V1 review answers:" and one line per
            answer (`composeReason` on the server). Rendered as an ordinary
            paragraph its line breaks collapsed and six answers ran together
            into one block; `pre-line` keeps the lines and still wraps them.
          */}
          {asset.reason && <p className="mt-1 whitespace-pre-line">Current reason: {asset.reason}</p>}
          {!asset.binanceAvailable && <p className="mt-1">Not currently a qualifying Binance Spot USDT base asset.</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Evidence" />
        {detail.evidence.length === 0 && <Empty>No evidence recorded.</Empty>}
        {detail.evidence.map((e) => (
          <label key={e.id} className="flex items-start gap-2 border-b border-border px-4 py-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={selectedEvidence.includes(e.id)}
              onChange={() => setSelectedEvidence((prev) => toggle(prev, e.id))}
            />
            <span className="min-w-0">
              <span className="font-medium text-ink">{e.title ?? e.url ?? `Evidence #${e.id}`}</span>
              {e.publisher && <span className="text-ink-faint"> · {e.publisher}</span>}
              {e.excerpt && <span className="block text-ink-muted">{e.excerpt}</span>}
              {e.url && <span className="block truncate text-ink-faint">{e.url}</span>}
            </span>
          </label>
        ))}
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-2">
          <Field label="URL"><TextInput value={evidenceDraft.url}
            onChange={(ev) => setEvidenceDraft({ ...evidenceDraft, url: ev.target.value })} /></Field>
          <Field label="Title"><TextInput value={evidenceDraft.title}
            onChange={(ev) => setEvidenceDraft({ ...evidenceDraft, title: ev.target.value })} /></Field>
          <Field label="Publisher"><TextInput value={evidenceDraft.publisher}
            onChange={(ev) => setEvidenceDraft({ ...evidenceDraft, publisher: ev.target.value })} /></Field>
          <Field label="Retrieved at (ISO)"><TextInput value={evidenceDraft.retrievedAt}
            onChange={(ev) => setEvidenceDraft({ ...evidenceDraft, retrievedAt: ev.target.value })} /></Field>
          <div className="sm:col-span-2">
            <Field label="Factual excerpt / note"
              help="Source material only. This is a fact you recorded, not a verdict.">
              <textarea
                value={evidenceDraft.excerpt}
                onChange={(ev) => setEvidenceDraft({ ...evidenceDraft, excerpt: ev.target.value })}
                rows={2}
                className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Button onClick={addEvidence} disabled={busy}>Record evidence</Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Publish a decision" />
        <div className="grid gap-2 px-4 py-3">
          <Field label="Classification"
            help="Nothing is preselected. ELIGIBLE and EXCLUDED both require cited evidence; a published REVIEW records that the evidence is insufficient, conflicting or ambiguous.">
            <Select value={classification}
              onChange={(e) => setClassification(e.target.value as ShariahClassification | "")}>
              <option value="">Choose…</option>
              <option value="ELIGIBLE">ELIGIBLE</option>
              <option value="REVIEW">REVIEW</option>
              <option value="EXCLUDED">EXCLUDED</option>
            </Select>
          </Field>
          <Field label="Reason" help="Required for every classification, REVIEW included.">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
          </Field>
          {classification !== "ELIGIBLE" && (
            <Field label="Prohibited categories" help="At least one is required for EXCLUDED.">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {categories.map((category) => (
                  <label key={category} className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={selectedCategories.includes(category)}
                      onChange={() => setSelectedCategories((prev) => toggle(prev, category))}
                    />
                    {category}
                  </label>
                ))}
              </div>
            </Field>
          )}
          <Field label="Review completed at (ISO)">
            <TextInput value={reviewedAt} onChange={(e) => setReviewedAt(e.target.value)} />
          </Field>
          <div>
            <Button variant="primary" onClick={publish} disabled={busy || !classification}>
              Publish under TS_SHARIAH_V1
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Published decision history" />
        {detail.publications.length === 0 && <Empty>Never published.</Empty>}
        {detail.publications.map((p) => (
          <div key={p.publicationId} className="border-b border-border px-4 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={p.classification} />
              <span className="text-ink-faint">
                {fmtUtcStamp(p.publishedAt)} · {p.publishedBy} · {p.policyVersion}
              </span>
              {/*
                How the decision got here. The operator's name is on a typed
                decision and an imported one alike, and the backend recorded
                which was which on every publication — and nothing read it.
                A neutral chip: it is provenance, not a verdict.
              */}
              <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">
                {publicationSourceLabel(p.source)}
              </span>
              {p.baseAssetAtPublication && p.baseAssetAtPublication !== asset.baseAsset && (
                <span className="text-warn">ticker then: {p.baseAssetAtPublication}</span>
              )}
            </div>
            <p className="mt-1 whitespace-pre-line text-ink-muted" data-publication-reason>{p.reason}</p>
            {p.prohibitedCategories.length > 0 && (
              <p className="text-ink-faint">Categories: {p.prohibitedCategories.join(", ")}</p>
            )}
            <p className="text-ink-faint">
              Evidence: {p.evidenceIds.length > 0 ? p.evidenceIds.join(", ") : "none cited"}
            </p>
          </div>
        ))}
        <p className="px-4 py-2 text-[11px] text-ink-faint">
          Published decisions are append-only. A later decision adds a row; it never rewrites one.
        </p>
      </Card>
    </div>
  );
}
