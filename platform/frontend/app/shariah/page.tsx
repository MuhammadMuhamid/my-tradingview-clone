"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ShariahImportError, downloadReviewPack, parseResultsFile, shariahApi,
  type ShariahAssetDetail, type ShariahClassification, type ShariahImportIssue,
  type ShariahImportPreview, type ShariahMode, type ShariahSnapshotMeta,
  type ShariahUniverse,
} from "@/lib/shariah";
import { Button, Card, CardHeader, Empty, Field, Select, TextInput } from "@/components/ui";

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

/** ISO date-time for the reviewed_at field, defaulted to now but always editable. */
function nowIso(): string {
  return new Date().toISOString();
}

export default function ShariahPage() {
  const [universe, setUniverse] = useState<ShariahUniverse | null>(null);
  const [snapshots, setSnapshots] = useState<ShariahSnapshotMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ShariahAssetDetail | null>(null);
  const [filter, setFilter] = useState<"needs-review" | "all">("needs-review");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ShariahMode | null>(null);

  const loadUniverse = useCallback(async () => {
    try {
      const [u, s, m] = await Promise.all([
        shariahApi.universe(), shariahApi.snapshots(), shariahApi.mode(),
      ]);
      setUniverse(u);
      setSnapshots(s.snapshots);
      setMode(m.mode);
    } catch (e) {
      setError((e as Error).message);
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

  const assets = useMemo(() => {
    const all = universe?.assets ?? [];
    return filter === "all"
      ? all
      : all.filter((a) => a.binanceAvailable && a.lifecycle !== "SCREENED");
  }, [universe, filter]);

  /**
   * The toggle writes to the server and then renders what the server reports
   * back. The browser never holds the authoritative value — the gate that
   * actually refuses a BUY runs in the backend and reads the same setting.
   */
  const toggleMode = async () => {
    const next: ShariahMode = mode === "enforce" ? "off" : "enforce";
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await shariahApi.setMode(next);
      setMode(saved.mode);
      setNotice(saved.mode === "enforce"
        ? "Shariah Mode is ON. New exposure (BUY) is allowed only for ELIGIBLE assets. "
          + "Selling or reducing a position is always allowed, and no position was changed."
        : "Shariah Mode is OFF. Trading behaviour is unchanged.");
    } catch (e) {
      setError((e as Error).message);
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

  return (
    <main className="mx-auto max-w-[1400px] px-3 py-4 sm:px-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-ink">Shariah review</h1>
          <p className="text-xs text-ink-muted">
            Policy {universe?.policyVersion ?? "TS_SHARIAH_V1"} · every classification is published
            deliberately by you. Nothing here is decided automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${
            mode === "enforce" ? "bg-up/15 text-up border-up/30" : "bg-surface-2 text-ink-muted border-border"
          }`}>
            Shariah Mode: {mode === null ? "…" : mode === "enforce" ? "ON" : "OFF"}
          </span>
          <Button onClick={toggleMode} disabled={busy || mode === null}>
            {mode === "enforce" ? "Turn off" : "Turn on"}
          </Button>
          <Button variant="primary" onClick={createSnapshot} disabled={busy}>
            Create universe snapshot
          </Button>
        </div>
      </div>

      {mode === "enforce" && (
        <div className="mb-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-ink-muted">
          Enforcement is on. A BUY is refused unless the asset is ELIGIBLE; UNSCREENED and STALE
          count as REVIEW and are refused. SELL, reduce and exit are never blocked, and turning
          this on never sells anything you already hold.
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-md border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{error}</div>
      )}
      {notice && (
        <div className="mb-3 rounded-md border border-up/30 bg-up/10 px-3 py-2 text-sm text-up">{notice}</div>
      )}

      <BatchReviewCard
        needsReview={universe ? universe.counts.review : null}
        onError={setError}
        onNotice={setNotice}
        onImported={loadUniverse}
      />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader
              title="Universe"
              right={
                <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                  <option value="needs-review">Needs review</option>
                  <option value="all">All assets</option>
                </Select>
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
            <div className="max-h-[520px] overflow-y-auto">
              {assets.length === 0 && <Empty>Nothing to review.</Empty>}
              {assets.map((asset) => (
                <button
                  key={asset.assetId}
                  onClick={() => setSelected(asset.assetId)}
                  aria-current={selected === asset.assetId ? "true" : undefined}
                  className={`flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-sm hover:bg-surface-2 ${
                    selected === asset.assetId ? "bg-surface-2" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{asset.baseAsset}</span>
                    {!asset.binanceAvailable && (
                      <span className="ml-2 text-[11px] text-ink-faint">delisted</span>
                    )}
                    <span className="block text-[11px] text-ink-faint">{asset.lifecycle}</span>
                  </span>
                  <StatusPill status={asset.effectiveStatus} />
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Snapshots" />
            {snapshots.length === 0 && <Empty>No snapshot has been created yet.</Empty>}
            {snapshots.slice(0, 8).map((s) => (
              <div key={s.snapshotId} className="border-b border-border px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">#{s.snapshotId}</span>
                  <span className="text-ink-faint">{s.entryCount} assets</span>
                </div>
                <div className="truncate font-mono text-[11px] text-ink-muted" title={s.contentHash}>
                  {s.contentHash}
                </div>
                <div className="text-[11px] text-ink-faint">{new Date(s.createdAt).toLocaleString()}</div>
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
    </main>
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
 * before a batch of real, immutable publications.
 */
function BatchReviewCard({ needsReview, onError, onNotice, onImported }: {
  needsReview: number | null;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onImported: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [resultsText, setResultsText] = useState("");
  const [preview, setPreview] = useState<ShariahImportPreview | null>(null);
  const [issues, setIssues] = useState<ShariahImportIssue[]>([]);

  /** Any edit invalidates a checked preview: you cannot approve text you did not check. */
  const editResults = (text: string) => {
    setResultsText(text);
    setPreview(null);
    setIssues([]);
  };

  const download = async () => {
    setBusy(true); onError(null); onNotice(null);
    try {
      const pack = await shariahApi.reviewPack();
      if (pack.assetCount === 0) {
        onNotice("Nothing needs review — every active asset carries a settled classification.");
        return;
      }
      downloadReviewPack(pack);
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
    try {
      setPreview(await shariahApi.previewResults(parseResultsFile(resultsText)));
    } catch (e) {
      if (e instanceof ShariahImportError) setIssues(e.issues);
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true); onError(null); onNotice(null); setIssues([]);
    try {
      const summary = await shariahApi.importResults(parseResultsFile(resultsText));
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

  return (
    <Card className="mb-3">
      <CardHeader
        title="Batch review with ChatGPT"
        right={
          <span className="text-xs text-ink-muted">
            Needs review: <span className="font-semibold text-ink">{needsReview ?? "…"}</span>
          </span>
        }
      />
      <div className="px-3 py-3">
        <ol className="mb-3 grid gap-1 text-xs text-ink-muted sm:grid-cols-3">
          <li><span className="font-semibold text-ink">1.</span> Download the next 20 assets.</li>
          <li><span className="font-semibold text-ink">2.</span> Upload that file to ChatGPT and let it research.</li>
          <li><span className="font-semibold text-ink">3.</span> Paste the JSON back here and publish.</li>
        </ol>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={download} disabled={busy}>
            Download next 20 for ChatGPT
          </Button>
          <input
            type="file"
            accept="application/json,.json"
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
              {new Date(preview.researchCompletedAt).toLocaleString()}
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <span className="text-up">{preview.counts.ELIGIBLE} ELIGIBLE</span>
              <span className="text-down">{preview.counts.EXCLUDED} EXCLUDED</span>
              <span className="text-warn">{preview.counts.REVIEW} REVIEW</span>
            </div>
            <div className="mt-2 max-h-40 overflow-y-auto text-[11px] text-ink-muted">
              {preview.results.map((r) => (
                <div key={r.assetId} className="flex items-center justify-between gap-2 border-t border-border py-1">
                  <span className="font-medium text-ink">{r.baseAsset}</span>
                  <span>{r.evidenceCount} evidence</span>
                  <StatusPill status={r.classification} />
                </div>
              ))}
            </div>
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
          <Button variant="primary" onClick={publish} disabled={busy || preview === null}>
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
          {asset.reason && <p className="mt-1">Current reason: {asset.reason}</p>}
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
                {new Date(p.publishedAt).toLocaleString()} · {p.publishedBy} · {p.policyVersion}
              </span>
              {p.baseAssetAtPublication && p.baseAssetAtPublication !== asset.baseAsset && (
                <span className="text-warn">ticker then: {p.baseAssetAtPublication}</span>
              )}
            </div>
            <p className="mt-1 text-ink-muted">{p.reason}</p>
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
