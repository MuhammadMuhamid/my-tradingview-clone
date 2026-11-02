"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MAX_REVIEW_PACK_ASSETS, ResultsFileError, SHARIAH_ANSWER_LABELS, ShariahImportError, UNIVERSE_FILTERS,
  UNIVERSE_FILTER_EMPTY, comparePreviewToPack, describeShariahSync, downloadReviewPack,
  downloadSnapshot, filterUniverse, normalizeShariahMode, parseResultsFile,
  countLabel, evidenceCitedLabel, formatUniverseSync, publicationSourceLabel, shariahApi,
  SHARIAH_SIGN_IN_HREF, assetsNeedingAttention, identityRefusal, namedAssetList, sessionEnded,
  type ShariahAssetDetail, type ShariahAssetState, type ShariahClassification, type ShariahImportIssue,
  type ShariahImportPreview, type ShariahImportPreviewResult, type ShariahLastPack,
  type ShariahMode, type ShariahModeChange, type ShariahModeState, type ShariahReviewPackRequest,
  type ShariahSnapshotMeta, type ShariahSyncLevel, type ShariahUniverse, type ShariahUniverseFilter,
} from "@/lib/shariah";
import {
  Button, Card, CardHeader, Checkbox, Dropdown, Empty, Field, Notice, PageShell, Select,
  TextInput, Textarea, PageHeader,
} from "@/components/ui";
import { fmtUtcStamp } from "@/lib/format";
import { failureReason, ownRefusal } from "@/lib/errorCopy";
import { refreshSession, useSessionRole } from "@/lib/session";

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

/*
 * An UNSCREENED asset has no decision, so it has no age: this read "Research
 * age: unknown days. No advisory reminder due." — a non-answer followed by
 * reassurance about a decision that does not exist.
 */
function researchAgeLine(asset: ShariahAssetState): string {
  const age = asset.decisionAgeDays == null ? null
    : `Research age: ${countLabel(asset.decisionAgeDays, "day", "days")}.`;
  if (asset.lifecycle === "STALE") {
    return [age, "STALE: requires fresh screening; new BUY exposure is blocked when Mode is ON."]
      .filter(Boolean).join(" ");
  }
  if (age === null && asset.lifecycle === "UNSCREENED") return "Never researched.";
  const reminder = asset.dueForReReview
    ? "Due for re-review — advisory; the decision still stands." : "No advisory reminder due.";
  return `${age ?? "Research age not recorded."} ${reminder}`;
}

/*
 * Whether a new BUY of this asset is permitted right now, said where the
 * decision is read. It restates what the page already shows — the server's
 * mode and the server's effectiveStatus, under the rule the enforcement banner
 * states ("refused unless the asset is ELIGIBLE") — and decides nothing: the
 * backend gate is still the only thing that refuses an order.
 */
function buyPermissionLine(mode: ShariahMode | null, baseAsset: string,
  status: ShariahClassification, hasDecision = true): string {
  const symbol = `${baseAsset}USDT`;
  const head = mode === "enforce"
    ? (status === "ELIGIBLE"
      ? `Mode ON: a new BUY of ${symbol} is allowed (status ELIGIBLE).`
      : `Mode ON: a new BUY of ${symbol} is refused (status ${status}).`)
    : mode === "off"
      // With nothing published there is no decision to call "recorded".
      ? (hasDecision ? "Mode OFF: BUYs are not screened; this decision is recorded but not enforced."
        : "Mode OFF: BUYs are not screened.")
      // Unread is unknown, never off — the same rule the Bot floor panel keeps.
      : `Mode unknown: whether a new BUY of ${symbol} is allowed cannot be stated.`;
  return `${head} Selling or reducing a position is never blocked.`;
}

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
  if (/\b401\b|not authenticated|unauthor/i.test(raw)) {
    return "Your session has ended — sign in again (you will return here).";
  }
  if (/\b403\b|forbidden|administrator only/i.test(raw)) return "Only the administrator can do this.";
  if (/\b(404|no route)/i.test(raw)) return "This environment does not serve it.";
  if (/\b(5\d\d|timeout|fetch failed|network)/i.test(raw)) return "The service did not answer. Try again shortly.";
  if (/reason|evidence|classification|categor|reviewed|retrieved|fresh|timestamp|must |required|invalid/i.test(raw) && !/\b(src|stack|SELECT|INSERT|UPDATE)\b/i.test(raw)) return raw;
  return "Open the reported detail or retry after checking the service.";
}

/**
 * The page's one error slot: what did not happen, and the cause verbatim.
 *
 * C-03: the slot used to hold only the cause and always said "The Shariah
 * universe could not be read" in front of it, so a failed mode change, a
 * failed pack download or a pasted file that was not JSON all claimed the
 * universe was unreadable. Each failure now says what it was; a problem with
 * the pasted results is not here at all, but under the paste box.
 */
interface PageFailure { headline: string; cause: string; sessionEnded?: boolean }

const failed = (headline: string, e: unknown): PageFailure =>
  ({ headline, cause: e instanceof Error ? e.message : String(e), sessionEnded: sessionEnded(e) });

/*
 * The way back after a session ends: the login page's own `next`, pointed at
 * this tab. Plain navigation, offered — never automatic, because leaving the
 * page discards anything pasted into it and the reader decides when.
 */
function SignInAgainLink() {
  return <a className="ml-1 font-medium underline" href={SHARIAH_SIGN_IN_HREF}>Sign in again</a>;
}

export default function ShariahPage() {
  const [view, setView] = useState<"status" | "screening">("status");
  const [universe, setUniverse] = useState<ShariahUniverse | null>(null);
  const [snapshots, setSnapshots] = useState<ShariahSnapshotMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShariahAssetDetail | null>(null);
  const [search, setSearch] = useState("");
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
  const [error, setError] = useState<PageFailure | null>(null);
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
  /*
   * An ordinary account may READ this screen (`GET /api/shariah/*`) and every
   * write is refused with a 403. Offering it Turn on, Sync, the batch review
   * and the publish form was a set of controls that appear to work and end in
   * a refusal; for a known user they are not rendered. While the session is
   * still being read they are not rendered either, so they never flash: the
   * read-only view is the neutral one (no control, no refusal, and copy that
   * is true for any account). A session that could not be read gets the same
   * neutral, read-only view — the backend is still what refuses. The header's
   * copy is role-free in that window too, so neither the operator's "by you"
   * nor the user's "by the administrator" is a guess.
   */
  const role = useSessionRole();
  const canManage = role === "admin";
  /*
   * Neither a known administrator nor a known user — still being read, or the
   * read failed. Written as "not admin and not user" rather than naming the
   * other states, so a new one (a failed read) gets the role-free copy and
   * the read-only view without this page having to know its name.
   */
  const roleUnknown = role !== "admin" && role !== "user";
  /*
   * Turning enforcement ON asks first. One click used to refuse every BUY on
   * the Platform — on a fresh install with nothing ELIGIBLE that is a total
   * BUY stop — and the consequence was printed only after it had happened.
   * Turning it OFF loosens nothing that protects a position, so it stays one
   * click.
   */
  const [confirmingOn, setConfirmingOn] = useState(false);

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
      setError(failed("The Shariah universe could not be read.", e));
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
      setError(failed("This asset's record could not be read.", e));
    }
  }, []);

  useEffect(() => { void loadUniverse(); }, [loadUniverse]);
  useEffect(() => { if (selected) void loadDetail(selected); else setDetail(null); }, [selected, loadDetail]);

  const assets = useMemo(() => filterUniverse(universe?.assets ?? [], filter).filter((a) =>
    `${a.baseAsset} ${a.projectName ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())), [universe, filter, search]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("view") === "screening" || query.has("asset") || query.has("symbol")) setView("screening");
    if (query.has("asset")) { setSelected(query.get("asset")); setFilter("all"); }
    else if (query.has("symbol") && universe) {
      const ticker = query.get("symbol")!.toUpperCase().replace(/USDT$/, "");
      const found = universe.assets.find((a) => a.baseAsset === ticker);
      if (found) { setSelected(found.assetId); setFilter("all"); }
    }
  }, [universe]);

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
      setError(failed("The snapshot could not be downloaded.", e));
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
    setConfirmingOn(false);
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
      setError(failed("The Shariah Mode change did not complete.", e));
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
      setError(failed("The universe snapshot was not created.", e));
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
      setNotice(formatUniverseSync(r));
      await loadUniverse();
    } catch (e) {
      setError(failed("The universe could not be synced.", e));
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
            description={canManage
              ? `Policy ${universe?.policyVersion ?? "TS_SHARIAH_V1"} · every classification is published deliberately by you. Nothing here is decided automatically.`
              : roleUnknown
              ? `Policy ${universe?.policyVersion ?? "TS_SHARIAH_V1"} · Screening decisions are published deliberately; nothing here is decided automatically.`
              : `Policy ${universe?.policyVersion ?? "TS_SHARIAH_V1"} · Screening decisions and enforcement are managed by the administrator. This screen shows the current universe and, for each asset, the published decision, its evidence and whether a BUY is allowed under the current mode.`}
          />
          <p className="mt-2 max-w-3xl text-xs leading-5 text-ink-muted">{canManage ? "You publish evidence-backed screening decisions"
            : roleUnknown ? "Screening decisions are evidence-backed"
            : "The administrator publishes evidence-backed screening decisions"}; Trading Scene does not issue religious rulings. Mode ON permits new BUY exposure only for ELIGIBLE assets. Mode OFF removes this screening gate. SELL remains available and existing positions are never automatically liquidated.</p>
          <details className="mt-1 text-xs text-ink-muted"><summary className="cursor-pointer">Understand screening statuses</summary>
            <p className="mt-1">ELIGIBLE: approved under a published decision. REVIEW: evidence needs further review. EXCLUDED: excluded under the published policy. UNSCREENED: no decision yet. UNKNOWN: registry identity cannot be established. STALE: a prior decision was invalidated and fresh review is required. UNSCREENED and STALE are lifecycle states, not classifications; both count as REVIEW for enforcement. All except ELIGIBLE block new BUY when Mode is ON.</p>
            <p>Due for re-review is an advisory reminder: the existing decision still stands. It is different from STALE.</p>
            <a className="text-accent underline" href="/getting-started">Read the screening workflow in the Manual</a>
          </details>
          <div role="tablist" aria-label="Shariah views" className="mt-2 flex gap-1">
            {/* A reader who cannot publish is shown what is there, not offered a workflow. */}
            {([["status", "Status"], ["screening", canManage ? "Screening & publication" : "Universe & decisions"]] as const).map(([id, label]) => (
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
        {/*
          The same controls on both tabs, so nothing moves when the tab
          changes: the snapshot action that used to appear here on one tab
          (and push Turn on / Sync ~200px sideways) lives in the Snapshots
          card. At phone width the mode chip takes its own row instead of
          wrapping onto three lines beside the buttons.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="basis-full sm:basis-auto">
          <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${
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
          </span>
          {canManage && (<>
            <Button onClick={() => (mode === "enforce" ? void toggleMode() : setConfirmingOn(true))}
              disabled={busy || mode === null}>
              {mode === "enforce" ? "Turn off" : "Turn on"}
            </Button>
            <Button onClick={syncUniverse} disabled={busy}
              title="Ask Binance which USDT spot base assets this install tracks, and add any it has not seen. Discovery only — nothing is classified and nothing becomes buyable.">
              Sync universe
            </Button>
          </>)}
        </div>
      </div>

      {canManage && confirmingOn && mode !== "enforce" && (
        <div className="mb-3">
          <Notice tone="warn" role="alert">
            <span className="block font-semibold">Turn on Shariah enforcement?</span>
            <span className="block">
              {universe ? countLabel(universe.counts.eligible, "ELIGIBLE asset", "ELIGIBLE assets")
                : "An unknown number of ELIGIBLE assets"} right now; every other BUY on this
              Platform will be refused until you publish ELIGIBLE decisions. SELL is never blocked.
              Nothing you hold is sold.
            </span>
            <span className="mt-2 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void toggleMode()} disabled={busy}>
                Turn on enforcement
              </Button>
              <Button onClick={() => setConfirmingOn(false)} disabled={busy}>Cancel</Button>
            </span>
          </Notice>
        </div>
      )}

      <BotFloorPanel state={modeState} unreadable={loaded} />

      {role === "unreadable" && (
        <Notice tone="warn" role="alert">
          <span className="mr-2">Your account could not be checked — the server did not answer. The screen stays
            read-only until it can be read; nothing here is refused.</span>
          <Button onClick={() => void refreshSession()}>Retry</Button>
        </Notice>
      )}

      {/*
        The append-only record of who changed enforcement, when, and whether
        the Bot's floor moved with it. `app_settings` held this switch as one
        mutable row with a single `updated_at`, so "someone turned it off at
        some point" was the only recoverable fact about the control that
        governs religious compliance for the whole installation.
      */}
      {modeHistory !== null && modeHistory.length > 0 && (
        <details className="mb-3 rounded-md border border-border bg-surface-2/40">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-faint hover:text-ink">
            Enforcement history — {modeHistory.length} change{modeHistory.length === 1 ? "" : "s"}
          </summary>
          <ul className="border-t border-border px-3 py-2 text-xs text-ink-muted">
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
          <span title={error.cause}>{error.headline} {shortReason(error.cause)}</span>
          {error.sessionEnded && <SignInAgainLink />}
        </Notice>
      )}
      {notice && <Notice tone="success" role="status">{notice}</Notice>}

      {!screeningView && (
        <Card>
          <CardHeader title="Universe at a glance" right={
            <Button onClick={() => setView("screening")}>{canManage ? "Open screening & publication" : "Open universe & decisions"}</Button>
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
                    <div className="text-xs text-ink-faint">{label}</div>
                  </div>
                ))}
            </div>
          ) : (
            <Empty>{loaded
              ? "The screening universe could not be read, so this is not a statement that it is empty."
              : "Loading the screening universe…"}</Empty>
          )}
          {universe && universe.counts.active === 0 && (
            <div className="border-b border-border bg-warn/10 px-4 py-2 text-sm leading-5 text-warn">
              {/* The legend's word for an asset with no decision, so the two never disagree. */}
              {canManage ? (<>
                This registry is empty, so every asset counts as REVIEW (UNSCREENED) until a decision
                is published, and turning enforcement on would refuse every BUY.{" "}
                <span className="font-medium">Sync universe</span> discovers the assets this install
                tracks; it classifies nothing.
              </>) : (
                // A user has no Sync control, so the warning must not name one.
                "This registry is empty, so every asset counts as REVIEW (UNSCREENED) until a decision "
                + "is published and, with enforcement on, every BUY is refused. Only the administrator "
                + "can populate it."
              )}
            </div>
          )}
          {universe && universe.counts.dueForReReview > 0 && (
            <div className="border-b border-border px-4 py-2 text-xs leading-5 text-ink-muted">
              {universe.counts.dueForReReview} settled decision(s) were researched more than{" "}
              {universe.reviewPolicy.reviewMaxAgeDays} days ago. They still stand and are still
              enforced — age withdraws nothing — but they join after unresolved assets in the next review pack
              so a project that has changed since gets looked at again.
            </div>
          )}
          {universe && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs text-ink-muted">
              <span>Re-review a settled decision after</span>
              {/* The horizon is stated to a user, not offered as a control the server refuses. */}
              {!canManage && (
                <span className="text-ink">{universe.reviewPolicy.reviewMaxAgeDays
                  ? `${universe.reviewPolicy.reviewMaxAgeDays} days` : "never (off)"}</span>
              )}
              {canManage && <Select
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
                    .catch((e) => setError(failed("The re-review horizon was not changed.", e)))
                    .finally(() => setBusy(false));
                }}
              >
                <option value={180}>180 days</option>
                <option value={365}>365 days</option>
                <option value={730}>730 days</option>
                <option value={0}>never (off)</option>
              </Select>}
              <span className="text-ink-faint">
                Advisory only — an aged decision still stands and is still enforced.
              </span>
            </div>
          )}
          <p className="px-4 py-2 text-xs leading-5 text-ink-faint">
            With enforcement on, only ELIGIBLE assets can be bought; REVIEW, UNSCREENED and STALE are refused.
            {canManage
              ? " Screening, evidence and publication — the work that moves an asset between these states — live under Screening & publication."
              : " Each asset's published decision and its evidence are under Universe & decisions."}
          </p>
        </Card>
      )}

      {universe && (() => {
        /*
         * "Needs attention" and the control that acts on it count the same
         * assets. The button used to select re-review-DUE decisions only, so on
         * a freshly synced install it sat disabled beside "4 unscreened".
         */
        const attention = assetsNeedingAttention(universe.assets);
        const forPack = attention.slice(0, MAX_REVIEW_PACK_ASSETS);
        const unscreened = universe.assets.filter((a) => a.lifecycle === "UNSCREENED").length;
        const stale = universe.assets.filter((a) => a.lifecycle === "STALE").length;
        return (
          <Card className="mb-3"><div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs text-ink-muted">
            <span>Needs attention: {unscreened} unscreened · {stale} stale · {universe.counts.dueForReReview} due for re-review</span>
            {canManage && (
              <Button disabled={forPack.length === 0}
                title={`Ticks them in the universe list for "Download pack for selected". STALE first, then UNSCREENED, then settled decisions due for re-review; at most ${MAX_REVIEW_PACK_ASSETS} per pack.`}
                onClick={() => { setView("screening"); setFilter("all"); setChosen(new Set(forPack.map((a) => a.assetId))); }}>
                {attention.length > forPack.length
                  ? `Select the first ${forPack.length} of ${attention.length} assets needing review`
                  : `Select the ${countLabel(forPack.length, "asset", "assets")} needing review`}
              </Button>
            )}
            <Button onClick={() => { setView("screening"); setFilter("needs-review"); }}>{canManage ? "Review unresolved assets" : "Show unresolved"}</Button>
            <Button onClick={() => { setView("screening"); setFilter("due"); }}>{canManage ? "Review today" : "Show due today"} — {universe.counts.dueForReReview} advisory reminders</Button>
          </div></Card>
        );
      })()}
      {/* Every step of the batch review ends in a write: the admin's workflow only. */}
      {screeningView && canManage && (
      <BatchReviewCard
        currentAssets={universe?.assets ?? []}
        categoryOptions={universe?.prohibitedCategories ?? []}
        needsReview={universe ? universe.counts.review : null}
        universeLoaded={loaded}
        chosenIds={[...chosen]}
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
            {universe && canManage && (
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
                  Clear selection
                </Button>
              </div>
            )}
            <div className="px-3 py-2"><Field label="Find an asset"><TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ticker or project name" /></Field></div>
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
                  {canManage && <Checkbox
                    checked={chosen.has(asset.assetId)}
                    onChange={(on) => toggleChosen(asset.assetId, on)}
                    label={`Choose ${asset.baseAsset} for the next review pack`}
                  />}
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
                      <p className="mt-1">{researchAgeLine(asset)}</p>
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
            <CardHeader title="Snapshots" right={canManage ? (
              <Button onClick={createSnapshot} disabled={busy}>Create universe snapshot</Button>
            ) : undefined} />
            {canManage && (
              <p className="border-b border-border px-3 py-2 text-xs text-ink-muted">
                Optional: freezes the current universe list with a content hash for Research runs.
                Not required to publish.
              </p>
            )}
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
              mode={mode}
              canManage={canManage}
              onChanged={async () => { await loadDetail(detail.asset.assetId); await loadUniverse(); }}
              onError={setError}
              onNotice={setNotice}
            />
          : <Card><Empty>{canManage ? "Select an asset to review." : "Select an asset to see its published decision."}</Empty></Card>}
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
 * hands the pack to an external reviewer — a ChatGPT session they already pay
 * for, or a person — and brings the results JSON back. Nothing here cares who
 * filled the file; the backend validates its shape and never issues a ruling.
 *
 * The final confirmation is the approval. One deliberate confirmation publishes
 * the whole researched batch after Check results and summary review. The preview
 * is the last look
 * before a batch of real, immutable publications. So it shows each decision
 * whole (reason, answers, evidence, open questions) one expandable row per
 * asset, and an ELIGIBLE that lists unresolved uncertainties must be
 * acknowledged row by row before the button will publish — a rule the backend
 * enforces too, so this card collects the acknowledgement and decides nothing.
 */
/* Labels short enough for the 100px dropdown would be bare numbers; the menu is widened instead. */
const PACK_SIZES = [
  { value: "10", label: "10 assets" },
  { value: "20", label: "20 assets" },
  { value: "50", label: "50 assets" },
] as const;

function BatchReviewCard({
  currentAssets, categoryOptions, needsReview, universeLoaded, chosenIds, onError, onNotice, onImported,
}: {
  currentAssets: ShariahUniverse["assets"];
  categoryOptions: string[];
  needsReview: number | null;
  /** The universe read has come back — so a null count is unknown, not pending. */
  universeLoaded: boolean;
  /** Assets the operator ticked in the universe list, for "Download pack for selected". */
  chosenIds: readonly string[];
  onError: (failure: PageFailure | null) => void;
  onNotice: (message: string | null) => void;
  onImported: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [resultsText, setResultsText] = useState("");
  const [preview, setPreview] = useState<ShariahImportPreview | null>(null);
  const [issues, setIssues] = useState<ShariahImportIssue[]>([]);
  /** A check/import failure that is not a per-row issue; said under the paste box. */
  const [fileProblem, setFileProblem] = useState<
    { text: string; title?: string; service: boolean; signIn?: boolean } | null>(null);
  /* The OS-drawn file control is hidden; this opens it from a product Button. */
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [correction, setCorrection] = useState<ShariahImportPreviewResult | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionStatus, setCorrectionStatus] = useState<ShariahClassification>("REVIEW");
  const [correctionCategories, setCorrectionCategories] = useState("");
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
    setConfirming(false);
    setCorrection(null);
    setPreview(null);
    setIssues([]);
    setFileProblem(null);
    setAcknowledged(new Set());
  };

  const download = async (request: ShariahReviewPackRequest) => {
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
      /*
       * The ticks stay: clearing them was the only visible change, so the
       * download read as a no-op. The notice names what went into the file and
       * says plainly that nothing about those assets has changed yet.
       */
      onNotice(`Downloaded ${namedAssetList(pack.assets.map((a) => a.baseAsset))}. `
        + "Their status does not change until you publish results — "
        + `${pack.needsReviewTotal} still need review. Give the file to your reviewer, `
        + "then paste or load the results JSON below.");
    } catch (e) {
      onError(failed("The review pack could not be downloaded.", e));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    editResults(await file.text());
  };

  /*
   * C-03: a check or an import that fails is said HERE, under the paste box,
   * and never in the page's slot. Pasting text that was not JSON used to put
   * "The Shariah universe could not be read" across the top of the page — the
   * universe was fine; the paste was not.
   *
   *   - the text is not a results file at all: the parser's finding;
   *   - the backend refused the FILE (4xx): its per-row issues, or its own
   *     sentence when it sent no rows;
   *   - the service failed (5xx, network): what that means, with the cause
   *     verbatim in the tooltip, never as the row's words.
   */
  const reportFileFailure = (e: unknown, action: string) => {
    if (e instanceof ResultsFileError) { setFileProblem({ text: e.message, service: false }); return; }
    /*
     * WHO is asking, said apart from what is wrong with the file: an ended
     * session is not "You may need to sign in again" (said even when the
     * session was valid), it is a fact with a way back to this tab.
     */
    const identity = identityRefusal(e);
    if (identity) {
      setFileProblem({ text: identity, title: e instanceof Error ? e.message : String(e),
        service: true, signIn: sessionEnded(e) });
      return;
    }
    if (e instanceof ShariahImportError && e.status !== null && e.status >= 400 && e.status < 500) {
      setIssues(e.issues);
      if (e.issues.length === 0) {
        const own = ownRefusal({ status: e.status, detail: e.message });
        setFileProblem({
          text: own ?? `The results could not be ${action}. ${failureReason(e)}`,
          title: e.message, service: own === null,
        });
      }
      return;
    }
    setFileProblem({
      text: `The results could not be ${action}. ${failureReason(e)}`,
      title: e instanceof Error ? e.message : String(e), service: true,
    });
  };

  const check = async () => {
    setConfirming(false); setBusy(true); onError(null); onNotice(null); setPreview(null); setIssues([]); setFileProblem(null);
    setAcknowledged(new Set());
    try {
      setPreview(await shariahApi.previewResults(parseResultsFile(resultsText)));
    } catch (e) {
      reportFileFailure(e, "checked");
    } finally {
      setBusy(false);
    }
  };

  const needingAck = preview ? preview.results.filter((r) => r.requiresAcknowledgement) : [];
  const unacknowledged = needingAck.filter((r) => !acknowledged.has(r.assetId));

  const publish = async () => {
    if (!preview || !confirming) return;
    setBusy(true); onError(null); onNotice(null); setIssues([]); setFileProblem(null);
    try {
      // Only the rows that need one, so a stale tick from an earlier preview
      // can never ride along — the backend refuses a surplus acknowledgement.
      const acks = needingAck.map((r) => r.assetId).filter((id) => acknowledged.has(id));
      const summary = await shariahApi.importResults(parseResultsFile(resultsText), acks);
      onNotice(`Published ${summary.importedCount} decision${summary.importedCount === 1 ? "" : "s"} `
        + `— ${summary.counts.ELIGIBLE} ELIGIBLE, ${summary.counts.EXCLUDED} EXCLUDED, `
        + `${summary.counts.REVIEW} REVIEW. Each one is an immutable publication with its own evidence. `
        + "Optional: create a universe snapshot (Snapshots card) for Research runs.");
      editResults("");
      await onImported();
    } catch (e) {
      reportFileFailure(e, "imported");
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
        title="Batch review by an external reviewer (ChatGPT or a person)"
        right={
          <span className="text-xs text-ink-muted">
            Needs review: <span className="font-semibold text-ink">{needsReview ?? (universeLoaded ? "unknown" : "…")}</span>
          </span>
        }
      />
      <div className="px-3 py-3">
        <ol className="mb-3 grid gap-1 text-xs text-ink-muted sm:grid-cols-3">
          <li><span className="font-semibold text-ink">1.</span> Download a pack — the next assets in the queue, or the ones you ticked below.</li>
          <li><span className="font-semibold text-ink">2.</span> Give that file to your reviewer — upload it to ChatGPT, or hand it to a person.</li>
          <li><span className="font-semibold text-ink">3.</span> Paste or load the results JSON here, read each decision, and publish.</li>
        </ol>
        <p className="mb-2 text-xs text-ink-muted">Research happens outside Trading Scene; any reviewer may fill the results file — this app only validates its shape and never issues a ruling.</p>

        <p className="mb-2 text-xs text-ink-muted">Queue order: STALE, UNSCREENED, published REVIEW, then due settled decisions. Downloading does not advance or reserve the queue; unchanged decisions produce the same next pack. Verify external sources: an AI assertion alone is not evidence.</p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Dropdown label="Assets per pack" width={150} value={size} options={PACK_SIZES}
            onChange={setSize} disabled={busy} />
          <label className="flex items-center gap-2 text-xs text-ink-muted"
            title="Settled ELIGIBLE/EXCLUDED decisions join the queue after everything unsettled. Nothing is demoted by being researched again.">
            <Checkbox checked={includeSettled} onChange={setIncludeSettled} disabled={busy}
              label="Include settled decisions" />
            Include settled decisions
          </label>
          <Button variant="primary" disabled={busy}
            onClick={() => void download({ size: Number(size), includeSettled })}>
            Download next {size}
          </Button>
          <Button disabled={busy || chosenIds.length === 0 || tooManyChosen}
            onClick={() => void download({ assetIds: chosenIds })}
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
          {/*
            The OS-drawn "Choose File" was a ~22px system control beside 34px
            product buttons. The input stays in the document — named, so it is
            still a labelled file control for assistive technology and tests —
            and a product Button opens it.
          */}
          <input
            ref={fileInput}
            id="shariah-results-file"
            type="file"
            accept="application/json,.json"
            aria-label="Load a results JSON file"
            tabIndex={-1}
            onChange={(e) => { void chooseFile(e.target.files?.[0]); e.target.value = ""; }}
            className="sr-only"
          />
          <Button disabled={busy} onClick={() => fileInput.current?.click()}>Load a results JSON file</Button>
        </div>

        <Field label="Review results (TS_SHARIAH_REVIEW_RESULTS_V1)"
          help="Paste only the JSON document — no markdown fence, no commentary. Check results, review the summary, then confirm publication.">
          <Textarea
            value={resultsText}
            onChange={(e) => editResults(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder='{ "format": "TS_SHARIAH_REVIEW_RESULTS_V1", ... }'
            className="font-mono text-xs"
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
                  onCorrect={() => { setCorrection(r); setCorrectionStatus(r.classification); setCorrectionReason(""); setCorrectionCategories(r.prohibitedCategories.join(", ")); setConfirming(false); }}
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

        {(issues.length > 0 || fileProblem) && (
          <div className="mt-3 rounded-md border border-down/30 bg-down/10 px-3 py-2">
            <div className="mb-1 text-xs font-semibold text-down">
              {fileProblem?.service
                ? "Nothing was published."
                : "Nothing was published. Fix the file and check again."}
            </div>
            <ul aria-label="Problems with the pasted results" className="max-h-40 overflow-y-auto text-[11px] text-down">
              {fileProblem && (
                <li className="border-t border-down/20 py-1" title={fileProblem.title}>
                  {fileProblem.text}{fileProblem.signIn && <SignInAgainLink />}
                </li>
              )}
              {issues.map((issue, i) => (
                <li key={i} className="border-t border-down/20 py-1">
                  {issue.baseAsset ? `${issue.baseAsset}: ` : issue.index !== null ? `results[${issue.index}]: ` : ""}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {correction && <section className="mt-3 rounded-md border border-border p-3" aria-label="Correct draft decision">
          <p className="mb-2 text-xs font-medium">Correct {correction.baseAsset} — original research remains recorded in the reason</p>
          <Field label="Your classification"><Select value={correctionStatus} onChange={(e) => setCorrectionStatus(e.target.value as ShariahClassification)}><option>ELIGIBLE</option><option>REVIEW</option><option>EXCLUDED</option></Select></Field>
          <Field label="Correction reason" help="Explain your explicit change. The original classification and researcher reason are preserved."><textarea className="w-full rounded-md border border-border bg-surface-2 p-2 text-xs" value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} /></Field>
          <Field label="Prohibited categories" help="EXCLUDED requires at least one. Validation checks the policy categories."><div className="flex flex-wrap gap-3">{categoryOptions.map((c) => <label className="flex gap-1 text-xs" key={c}><input type="checkbox" checked={correctionCategories.split(", ").includes(c)} onChange={(e) => { const next = new Set(correctionCategories.split(", ").filter(Boolean)); if (e.target.checked) next.add(c); else next.delete(c); setCorrectionCategories([...next].join(", ")); }} />{c.replaceAll("_", " ").toLowerCase()}</label>)}</div></Field>
          <div className="mt-2 flex gap-2"><Button disabled={busy || !correctionReason.trim()} onClick={() => {
            const doc = parseResultsFile(resultsText) as { results: Array<Record<string, unknown>> };
            const updated = { ...doc, results: doc.results.map((r) => r.assetId !== correction.assetId ? r : { ...r,
              classification: correctionStatus,
              prohibitedCategories: correctionStatus === "ELIGIBLE" ? [] : correctionCategories.split(",").map((v) => v.trim()).filter(Boolean),
              reason: `Operator correction (${new Date().toISOString()}): ${correctionReason.trim()}\nOriginal researcher classification: ${r.classification}\nOriginal researcher reason: ${r.reason}`,
            }) };
            editResults(JSON.stringify(updated, null, 2));
          }}>Apply correction — then Check results again</Button><Button onClick={() => setCorrection(null)}>Cancel correction</Button></div>
        </section>}
        {confirming && preview && <section className="mt-3 rounded-md border border-warn/30 bg-warn/10 p-3 text-xs" aria-label="Final publication summary">
          <p className="font-semibold">Final review: {preview.assetCount} decisions — {preview.counts.ELIGIBLE} ELIGIBLE · {preview.counts.REVIEW} REVIEW · {preview.counts.EXCLUDED} EXCLUDED</p>
          <p>Append-only publication. When Mode is ON, only ELIGIBLE permits new exposure. Exits remain possible.</p>
          <ul className="mt-2 max-h-48 overflow-auto">{preview.results.map((r) => {
            const prior = currentAssets.find((a) => a.assetId === r.assetId);
            // An UNSCREENED asset's REVIEW is a default, not a decision; and "1 citations" read as a typo.
            const before = prior && prior.lifecycle !== "UNSCREENED" ? prior.effectiveStatus : "no prior decision";
            return <li key={r.assetId}>{r.baseAsset}: {before} → {r.classification} · {countLabel(r.evidenceCount, "citation", "citations")} · {countLabel(r.unresolvedUncertainties.length, "uncertainty", "uncertainties")}{prior?.lifecycle === "STALE" ? " · fresh review required" : ""}</li>;
          })}</ul>
          <p className="mt-2">Validation passed. {needingAck.length} uncertain ELIGIBLE decision(s) require individual acknowledgement; {unacknowledged.length} remain unacknowledged. Read the sources and grounds before publishing.</p>
          <Button variant="primary" disabled={busy || unacknowledged.length > 0} onClick={publish}>Confirm publication of {preview.assetCount} decisions</Button> <Button onClick={() => setConfirming(false)}>Back to review</Button>
        </section>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={check} disabled={busy || resultsText.trim().length === 0}>
            Check results
          </Button>
          <Button variant="primary" onClick={() => setConfirming(true)}
            disabled={busy || preview === null || unacknowledged.length > 0}
            title={unacknowledged.length > 0
              ? `Acknowledge the open questions on ${unacknowledged.map((r) => r.baseAsset).join(", ")} first.`
              : undefined}>
            Review publication summary {preview ? `${preview.assetCount} decisions` : ""}
          </Button>
          <span className="text-[11px] text-ink-faint">
            Review the summary, then confirm publication for the whole batch. A STALE asset always needs a full
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
function PreviewRow({ result: r, notInLastPack, acknowledged, onAcknowledge, onCorrect, disabled }: {
  result: ShariahImportPreviewResult;
  notInLastPack: boolean;
  acknowledged: boolean;
  onAcknowledge: (on: boolean) => void;
  onCorrect: () => void;
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
          <Button disabled={disabled} onClick={onCorrect}>Correct draft decision</Button>
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

function ReviewPanel({ detail, categories, mode, canManage, onChanged, onError, onNotice }: {
  detail: ShariahAssetDetail;
  categories: string[];
  mode: ShariahMode | null;
  /** False for a known ordinary user: the decision and its evidence are read, never written. */
  canManage: boolean;
  onChanged: () => Promise<void>;
  onError: (failure: PageFailure | null) => void;
  onNotice: (message: string | null) => void;
}) {
  const { asset } = detail;
  const [classification, setClassification] = useState<ShariahClassification | "">("");
  const [reason, setReason] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [reviewedAt, setReviewedAt] = useState(nowIso());
  const [busy, setBusy] = useState(false);
  /*
   * What happened to the last "Publish", said under the button that sent it.
   *
   * A refusal used to go only to the page's error slot, which sits at the top
   * of the page — above the batch card and the universe list, far out of view
   * of a reader at this form. Measured: a 401 left the form filled, the
   * history at "Never published" and nothing visible anywhere near the
   * button, so publication failed silently.
   */
  const [publishResult, setPublishResult] = useState<
    { ok: true; text: string } | { ok: false; text: string; title: string; signIn: boolean } | null>(null);
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
      onError(failed("The evidence was not added.", e));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!classification) return;
    setBusy(true); onError(null); onNotice(null); setPublishResult(null);
    try {
      const published = await shariahApi.publish(asset.assetId, {
        classification, reason,
        prohibitedCategories: selectedCategories,
        evidenceIds: selectedEvidence,
        reviewedAt,
      });
      setPublishResult({ ok: true, text: `Published ${published.classification} for ${asset.baseAsset} `
        + `(decision #${published.publicationId}).` });
      setClassification(""); setReason(""); setSelectedCategories([]); setSelectedEvidence([]);
      await onChanged();
    } catch (e) {
      // The same sentence the batch path uses: who is asking first, then the
      // server's own refusal of the decision, then what a failure means.
      setPublishResult({
        ok: false,
        text: identityRefusal(e) ?? failureReason(e),
        title: e instanceof Error ? e.message : String(e),
        signIn: sessionEnded(e),
      });
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
          <p className="mt-1 text-ink" data-buy-permission>{buyPermissionLine(mode, asset.baseAsset, asset.effectiveStatus, detail.publications.length > 0)}</p>
          {!canManage && detail.publications.length === 0 && (
            <p className="mt-1">No decision yet — evidence recorded by the administrator is shown for transparency.</p>
          )}
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
        <CardHeader title={canManage ? "Evidence — select citations for the new decision" : "Evidence"} />
        {detail.evidence.length === 0 && <Empty>No evidence recorded.</Empty>}
        {detail.evidence.map((e) => (
          <label key={e.id} className="flex items-start gap-2 border-b border-border px-4 py-2 text-xs">
            {canManage && <input
              type="checkbox"
              className="mt-0.5"
              checked={selectedEvidence.includes(e.id)}
              onChange={() => setSelectedEvidence((prev) => toggle(prev, e.id))}
            />}
            <span className="min-w-0">
              <span className="font-medium text-ink">{e.title ?? e.url ?? `Evidence #${e.id}`}</span>
              {e.publisher && <span className="text-ink-faint"> · {e.publisher}</span>}
              {e.excerpt && <span className="block text-ink-muted">{e.excerpt}</span>}
              {/* accent-is-meaning: a source citation is a navigable link. */}
              {e.url && /^https?:\/\//i.test(e.url) && <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="block break-all text-accent underline">{e.url}</a>}
              <span className="block text-ink-faint">Retrieved: {e.retrievedAt ? fmtUtcStamp(e.retrievedAt) : "Not recorded"}</span>
            </span>
          </label>
        ))}
        {canManage && <div className="grid gap-2 px-4 py-3 sm:grid-cols-2">
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
        </div>}
      </Card>

      {canManage && <Card>
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
                    {category.replaceAll("_", " ").toLowerCase()}
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
          {publishResult && (publishResult.ok
            ? <Notice tone="success" role="status">{publishResult.text}</Notice>
            : (
              <Notice tone="error" role="alert">
                <span title={publishResult.title}>Nothing was published. {publishResult.text}</span>
                {publishResult.signIn && <SignInAgainLink />}
              </Notice>
            ))}
        </div>
      </Card>}

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
              <p className="text-ink-faint">Categories: {p.prohibitedCategories.map((c) => c.replaceAll("_", " ").toLowerCase()).join(", ")}</p>
            )}
            <p className="text-ink-faint">
              Research completed: {fmtUtcStamp(p.reviewedAt)} · {evidenceCitedLabel(p.evidenceIds)}
            </p>
            <details className="mt-1"><summary className="cursor-pointer">Citations for publication #{p.publicationId}</summary>
              {/* accent-is-meaning: publication citations are navigable links. */}
              {p.evidenceIds.map((id) => { const e = detail.evidence.find((v) => v.id === id); return <p key={id} className="mt-1 break-all">{e ? <>{e.title ?? `Evidence #${id}`} · {e.publisher ?? "Publisher not recorded"} · retrieved {e.retrievedAt ? fmtUtcStamp(e.retrievedAt) : "not recorded"}{e.url && /^https?:\/\//i.test(e.url) && <> · <a className="text-accent underline" href={e.url} target="_blank" rel="noopener noreferrer nofollow">Open source</a></>}{e.excerpt && <span className="block">{e.excerpt}</span>}</> : `Evidence #${id} is not available in this response.`}</p>; })}
            </details>
          </div>
        ))}
        <p className="px-4 py-2 text-[11px] text-ink-faint">
          Published decisions are append-only. A later decision adds a row; it never rewrites one.
        </p>
      </Card>
    </div>
  );
}
