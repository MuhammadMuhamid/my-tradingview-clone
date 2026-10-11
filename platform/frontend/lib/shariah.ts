/**
 * Client for the private Shariah review/publication API.
 *
 * Everything here is a thin pass-through. No classification logic lives in the
 * browser: the operator's decision travels to the backend intact, and the
 * backend's publication authority is the only thing that accepts or refuses
 * it. The page must never be able to make an asset ELIGIBLE by itself.
 */
export type ShariahClassification = "ELIGIBLE" | "EXCLUDED" | "REVIEW";
export type ShariahLifecycle = "SCREENED" | "UNSCREENED" | "STALE";

export interface ShariahAssetState {
  assetId: string;
  baseAsset: string;
  projectName: string | null;
  binanceAvailable: boolean;
  classification: ShariahClassification;
  lifecycle: ShariahLifecycle;
  effectiveStatus: ShariahClassification;
  policyVersion: string;
  reason: string | null;
  prohibitedCategories: string[];
  reviewedAt: string | null;
  publishedAt: string | null;
  /** Days since the research behind this decision was carried out, or null. */
  decisionAgeDays?: number | null;
  /** Settled, and older than the advisory policy. Never demoted by it. */
  dueForReReview?: boolean;
}

export interface ShariahUniverse {
  policyVersion: string;
  prohibitedCategories: string[];
  /** The advisory re-review interval. Null means time-based surfacing is off. */
  reviewPolicy: ShariahReviewPolicy;
  counts: {
    total: number; active: number; eligible: number; review: number; excluded: number;
    /**
     * Settled decisions older than the review policy.
     *
     * Advisory, always: an aged decision still stands, is still enforced, and is
     * never demoted by its age. It simply reaches the front of the review queue.
     * Nothing in the exposure gate reads this.
     */
    dueForReReview: number;
  };
  assets: ShariahAssetState[];
}

export interface ShariahReviewPolicy {
  reviewMaxAgeDays: number | null;
}

/** One entry in the append-only record of Shariah Mode changes. */
export interface ShariahModeChange {
  id: string;
  fromMode: ShariahMode;
  toMode: ShariahMode;
  changedBy: string;
  /** Whether the execution Bot's floor actually moved with the change. */
  botFloorPushed: boolean;
  policyVersion: string;
  changedAt: string;
}

export interface ShariahEvidence {
  id: string;
  assetId: string;
  url: string | null;
  title: string | null;
  publisher: string | null;
  retrievedAt: string | null;
  excerpt: string | null;
  createdAt: string;
}

export interface ShariahPublication {
  publicationId: string;
  assetId: string;
  policyVersion: string;
  classification: ShariahClassification;
  lifecycle: "SCREENED";
  reason: string;
  prohibitedCategories: string[];
  baseAssetAtPublication: string | null;
  reviewedAt: string;
  publishedAt: string;
  publishedBy: string;
  evidenceIds: string[];
  /**
   * How the decision reached the product. `null` on decisions published before
   * the backend recorded it — unknown, not "manual". Optional so an older
   * backend that omits the field reads the same way.
   */
  source?: ShariahPublicationSource | null;
}

export type ShariahPublicationSource = "manual" | "review_import";

/**
 * The history chip's words. The operator's name is on both kinds of decision,
 * so without this the history could not say which came out of a research pack.
 */
export function publicationSourceLabel(source: ShariahPublicationSource | null | undefined): string {
  if (source === "review_import") return "Imported from review pack";
  if (source === "manual") return "Entered by hand";
  return "Source not recorded";
}

/**
 * A decision's cited evidence, counted, with the ids marked as ids.
 *
 * C-10: the history printed the ids bare — "Evidence: 3" — so one entry whose
 * id is 3 read as three pieces of evidence, on the record of what a decision
 * rested on.
 */
export function evidenceCitedLabel(ids: readonly string[]): string {
  if (ids.length === 0) return "No evidence cited";
  return `${ids.length} evidence (${ids.map((id) => `#${id}`).join(", ")})`;
}

export interface ShariahAssetDetail {
  asset: ShariahAssetState;
  evidence: ShariahEvidence[];
  publications: ShariahPublication[];
}

export interface ShariahSnapshotMeta {
  snapshotId: string;
  policyVersion: string;
  contentHash: string;
  entryCount: number;
  createdAt: string;
  createdBy: string | null;
}

/** A frozen snapshot with its membership — the Research-facing read contract. */
export interface ShariahSnapshot extends ShariahSnapshotMeta {
  entries: Array<{
    assetId: string;
    baseAsset: string;
    effectiveStatus: ShariahClassification;
    classification: ShariahClassification;
    lifecycle: ShariahLifecycle;
    binanceAvailable: boolean;
    policyVersion: string;
    publicationId: string | null;
  }>;
}

// ── The universe list's filters ─────────────────────────────────────────────

export type ShariahUniverseFilter = "needs-review" | "stale" | "due" | "all";

export const UNIVERSE_FILTERS: ReadonlyArray<{ value: ShariahUniverseFilter; label: string }> = [
  { value: "needs-review", label: "Needs review" },
  { value: "stale", label: "Stale" },
  { value: "due", label: "Due for re-review" },
  { value: "all", label: "All assets" },
];

/**
 * Which assets each filter shows.
 *
 * "Needs review" is the BACKEND's definition (`needsReview` in
 * `shariah/reviewPack.ts`, and the universe's `counts.review`): an active asset
 * whose effective status is REVIEW — never screened, STALE, or deliberately
 * published as REVIEW. It used to be "not yet screened" only, so an asset a
 * reviewer had published as REVIEW vanished from the list while still being
 * counted under Review beside it, and the two numbers on one card disagreed.
 *
 * "Due for re-review" matches `counts.dueForReReview`: active and settled, but
 * researched longer ago than the advisory policy. Age demotes nothing; this
 * only finds them.
 */
export function filterUniverse(
  assets: readonly ShariahAssetState[],
  filter: ShariahUniverseFilter
): ShariahAssetState[] {
  switch (filter) {
    case "needs-review": return assets.filter((a) => a.binanceAvailable && a.effectiveStatus === "REVIEW");
    case "stale": return assets.filter((a) => a.lifecycle === "STALE");
    case "due": return assets.filter((a) => a.binanceAvailable && a.dueForReReview === true);
    case "all": return [...assets];
  }
}

/** What an empty list means under each filter, so "none" is never misread as "unread". */
export const UNIVERSE_FILTER_EMPTY: Record<ShariahUniverseFilter, string> = {
  "needs-review": "Nothing needs review — every active asset carries a settled classification.",
  stale: "No asset is STALE.",
  due: "No settled decision is due for re-review under the current policy.",
  all: "The registry holds no assets yet.",
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ── Batch review workflow (SH-3) ────────────────────────────────────────────

export type ShariahMode = "off" | "enforce";

export interface ShariahReviewPackAsset {
  assetId: string;
  baseAsset: string;
  projectName: string | null;
  lifecycle: ShariahLifecycle;
  effectiveStatus: ShariahClassification;
  reviewReason: string;
  requiresFullFreshScreening: boolean;
  staleSince: string | null;
}

export interface ShariahReviewPack {
  format: string;
  policyVersion: string;
  generatedAt: string;
  batchSize: number;
  assetCount: number;
  needsReviewTotal: number;
  assets: ShariahReviewPackAsset[];
}

export interface ShariahImportIssue {
  index: number | null;
  assetId: string | null;
  baseAsset: string | null;
  message: string;
  /** The field to act on, when the problem is one field (e.g. `unresolvedUncertainties`). */
  field?: string;
}

/** The six researched answers, keyed as the results contract keys them. */
export const SHARIAH_ANSWER_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["project", "Project"],
  ["tokenFunction", "Token function"],
  ["rightsExposure", "Rights / economic exposure"],
  ["coreActivities", "Core / material activities"],
  ["prohibitedEvidence", "Prohibited-category evidence"],
  ["evidenceSufficiency", "Evidence sufficiency"],
];

export interface ShariahImportPreviewResult {
  assetId: string;
  baseAsset: string;
  classification: ShariahClassification;
  /** The researcher's own grounds. Shown, never interpreted. */
  reason: string;
  answers: Record<string, string>;
  prohibitedCategories: string[];
  evidenceCount: number;
  evidence: Array<{ url: string; title: string; publisher: string; retrievedAt: string; note: string }>;
  unresolvedUncertainties: string[];
  /**
   * ELIGIBLE while listing unresolved uncertainties. The backend refuses the
   * import unless the operator acknowledges this asset by id; the browser only
   * collects that acknowledgement, it does not decide that one is needed.
   */
  requiresAcknowledgement: boolean;
}

export interface ShariahImportPreview {
  policyVersion: string;
  researchCompletedAt: string;
  /** The pack the file says it answers, when it echoes one. */
  packGeneratedAt?: string | null;
  assetCount: number;
  counts: Record<ShariahClassification, number>;
  /** Asset ids the import request must acknowledge, in file order. */
  acknowledgementRequired?: string[];
  results: ShariahImportPreviewResult[];
}

/** The last pack downloaded in this page session — what an import is checked against. */
export interface ShariahLastPack {
  generatedAt: string;
  assetIds: readonly string[];
}

/**
 * Whether a results file answers the pack the operator last downloaded.
 *
 * Advisory, and deliberately browser-side: the backend validates every result
 * against the live registry whatever pack it came from, so this cannot make
 * anything publishable that would not be. What it catches is the human
 * mistake — pasting last week's file, or one researched from a colleague's
 * pack — that the registry check cannot see because the assets are all real.
 *
 * Held in page memory only (the Shariah surface keeps no browser storage), so
 * after a reload there is nothing to compare against and it says so.
 */
export function comparePreviewToPack(
  preview: Pick<ShariahImportPreview, "packGeneratedAt" | "results">,
  lastPack: ShariahLastPack | null
): { known: boolean; notInPack: string[]; differentPack: boolean } {
  if (!lastPack) return { known: false, notInPack: [], differentPack: false };
  const inPack = new Set(lastPack.assetIds);
  const notInPack = preview.results.filter((r) => !inPack.has(r.assetId)).map((r) => r.assetId);
  const echoed = preview.packGeneratedAt ?? null;
  const differentPack = echoed !== null && Date.parse(echoed) !== Date.parse(lastPack.generatedAt);
  return { known: true, notInPack, differentPack };
}

/** How the next pack is chosen: the queue (optionally sized / widened), or by hand. */
export type ShariahReviewPackRequest =
  | { size?: number; includeSettled?: boolean }
  | { assetIds: readonly string[] };

/** The most assets one pack (and one import) can carry — `MAX_REVIEW_BATCH_SIZE`. */
export const MAX_REVIEW_PACK_ASSETS = 100;

/**
 * The review-pack URL for a request. An explicit selection sends ONLY
 * `assetIds`: the backend refuses `size` beside it, because a size smaller than
 * the selection would silently drop assets chosen by name.
 */
export function reviewPackPath(request: ShariahReviewPackRequest = {}): string {
  const params = new URLSearchParams();
  if ("assetIds" in request) {
    params.set("assetIds", request.assetIds.join(","));
  } else {
    if (request.size) params.set("size", String(request.size));
    if (request.includeSettled) params.set("includeSettled", "true");
  }
  const query = params.toString();
  return `/api/shariah/review-pack${query ? `?${query}` : ""}`;
}

/** The import URL, carrying the operator's per-asset acknowledgements beside the document. */
export function importResultsPath(acknowledgedAssetIds: readonly string[] = []): string {
  return acknowledgedAssetIds.length === 0
    ? "/api/shariah/review-results/import"
    : `/api/shariah/review-results/import?acknowledgedAssetIds=${acknowledgedAssetIds.map(encodeURIComponent).join(",")}`;
}

export interface ShariahImportSummary {
  policyVersion: string;
  researchCompletedAt: string;
  importedCount: number;
  counts: Record<ShariahClassification, number>;
  publishedBy: string;
  outcomes: Array<{
    assetId: string; baseAsset: string;
    classification: ShariahClassification; publicationId: string; evidenceIds: string[];
  }>;
}

/**
 * The one status answer every trading surface reads.
 *
 * It is the BACKEND GATE's own decision, not raw registry fields for a
 * component to interpret: `buyAllowed` is what the backend would actually do
 * with a BUY right now, so a screener cell, a chart badge and the order panel
 * cannot disagree with enforcement or with each other. `sellAllowed` is always
 * true and is stated rather than inferred.
 */
export interface ShariahSymbolStatus {
  symbol: string;
  mode: ShariahMode;
  shariah: {
    mode: ShariahMode;
    policyVersion: string | null;
    assetId: string | null;
    baseAsset: string | null;
    effectiveStatus: ShariahClassification;
    publicationId: string | null;
  };
  buyAllowed: boolean;
  buyBlockedReason: string | null;
  sellAllowed: true;
}

// ── Shariah Mode, and whether the executing side agrees ─────────────────────

/**
 * What `/api/shariah/mode` answers, in full.
 *
 * ── The gap this type closes ───────────────────────────────────────────────
 *
 * The backend reports four things about enforcement, and the browser used to
 * be typed for one of them: `{ mode }`. So a console that read "Shariah Mode:
 * ON" was reporting THIS PLATFORM's stored setting and nothing else, while the
 * three fields that say whether the executing Bot is actually enforcing —
 * `botMode`, `inSync`, and `botFloorPushed` on a mutation — were fetched over
 * the wire, discarded by the type, and never rendered.
 *
 * That is not a cosmetic omission. The Bot accepts direct TradingView webhook
 * signals this Platform never sees, and only the Bot's own floor gates those.
 * An operator shown a green "ON" while the Bot's floor was unknown, off, or
 * never armed at all would believe the installation was protected on a path it
 * was not. The backend already refuses to claim otherwise (see
 * `shariah/botEnforcement.ts`); this is the browser catching up.
 *
 * Every field beyond `mode` is optional, because the GET and the PUT answer
 * with different subsets and an error body answers with fewer still.
 */
export interface ShariahModeResponse {
  mode: ShariahMode;
  policyVersion?: string | null;
  /** The Bot's own floor. `null` means unreachable — which is unknown, not off. */
  botMode?: ShariahMode | null;
  /** Whether the two agree. `null` when the Bot's answer is unknown. */
  inSync?: boolean | null;
  /**
   * Mutations only: whether a floor was actually pushed to a Bot.
   *
   * `false` means this installation has no Bot control channel configured, so
   * nothing was armed. It is a real deployment and a truthful answer — and it
   * must never be rendered as confirmed enforcement.
   */
  botFloorPushed?: boolean;
}

/** The same answer with every field present, so readers never branch on undefined. */
export interface ShariahModeState {
  mode: ShariahMode;
  policyVersion: string | null;
  botMode: ShariahMode | null;
  inSync: boolean | null;
  botFloorPushed: boolean | null;
}

/**
 * Widen a response into a total state.
 *
 * An absent field becomes `null` — "not stated" — never `false` and never
 * `off`. Inventing agreement is the exact failure this whole path exists to
 * prevent, and a defaulted `false` reads as a claim.
 */
export function normalizeShariahMode(
  response: ShariahModeResponse | null | undefined,
  previous: ShariahModeState | null = null
): ShariahModeState {
  if (!response) return previous ?? { mode: "off", policyVersion: null, botMode: null, inSync: null, botFloorPushed: null };
  const mode: ShariahMode = response.mode === "enforce" ? "enforce" : "off";
  const botMode = response.botMode === "enforce" || response.botMode === "off"
    ? response.botMode : null;
  return {
    mode,
    policyVersion: typeof response.policyVersion === "string" ? response.policyVersion : null,
    botMode,
    inSync: typeof response.inSync === "boolean" ? response.inSync : null,
    botFloorPushed: typeof response.botFloorPushed === "boolean" ? response.botFloorPushed : null,
  };
}

export type ShariahSyncLevel =
  /** Platform enforcement is off, so no Bot floor is claimed or required. */
  | "off"
  /** Platform enforces and the Bot confirms the same floor. */
  | "confirmed"
  /** Platform enforces; the Bot's floor could not be established. */
  | "unknown"
  /** Platform and Bot disagree. */
  | "drift";

export interface ShariahSyncView {
  level: ShariahSyncLevel;
  /** Short badge text. Never colour alone — the word carries the state. */
  label: string;
  /** The sentence an operator can act on. */
  detail: string;
  /** True ONLY when the Bot's floor is confirmed armed. Nothing else sets it. */
  botEnforcing: boolean;
}

/**
 * What to show the operator about Platform/Bot enforcement agreement.
 *
 * The order of the checks is the safety argument:
 *
 *   1. Not enforcing here → nothing to confirm.
 *   2. A mutation that reported `botFloorPushed: false` → no channel, no floor.
 *      This is checked before anything else because it is the one case that
 *      returns 200 with nothing armed, and it must never reach "confirmed".
 *   3. The Bot's answer is missing → unknown. Not off, not confirmed.
 *   4. The two disagree → drift, named on both sides.
 *   5. Only then, and only when both fields positively agree → confirmed.
 */
export function describeShariahSync(state: ShariahModeState | null): ShariahSyncView {
  if (!state) {
    return {
      level: "unknown",
      label: "Bot floor: checking",
      detail: "The execution Bot's enforcement floor has not been read yet.",
      botEnforcing: false,
    };
  }

  if (state.mode !== "enforce") {
    return {
      level: "off",
      label: "Bot floor: not required",
      detail: "Shariah Mode is OFF on this Platform, so no Bot enforcement floor is claimed. "
        + "Trading behaviour is unchanged.",
      botEnforcing: false,
    };
  }

  if (state.botFloorPushed === false) {
    return {
      level: "unknown",
      label: "Bot floor: not armed",
      detail: "This Platform enforces, but no execution Bot control channel is configured, so "
        + "no floor was pushed to a Bot. Every path this Platform originates is gated; a signal "
        + "sent straight to a Bot webhook is not gated by this Platform.",
      botEnforcing: false,
    };
  }

  if (state.botMode === null || state.inSync === null) {
    return {
      level: "unknown",
      label: "Bot floor: unknown",
      detail: "This Platform enforces. The execution Bot could not be reached, so its floor is "
        + "unknown — which is not the same as off, and not a confirmation. Re-apply the mode "
        + "change once the Bot is reachable.",
      botEnforcing: false,
    };
  }

  if (state.inSync !== true || state.botMode !== state.mode) {
    return {
      level: "drift",
      label: "Bot floor: out of sync",
      detail: `This Platform enforces but the execution Bot reports its floor as `
        + `"${state.botMode}". The two must agree before either can be trusted — re-apply the `
        + "mode change to converge them.",
      botEnforcing: false,
    };
  }

  return {
    level: "confirmed",
    label: "Bot floor: enforcing",
    detail: "This Platform enforces and the execution Bot confirms the same floor, so a signal "
      + "sent straight to a Bot webhook is gated too.",
    botEnforcing: true,
  };
}

/** An import rejection carries every problem in the file, not just the first. */
export class ShariahImportError extends Error {
  constructor(
    message: string,
    readonly issues: ShariahImportIssue[],
    /** The HTTP status, so a refusal of the FILE is told apart from a failed service. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ShariahImportError";
  }
}

/**
 * The pasted or chosen text could not be read as a results file at all.
 *
 * Its own class because it is the operator's paste that is wrong, not the
 * service and not the universe: it is said under the paste box, as one of the
 * file's problems, and was being shown as "The Shariah universe could not be
 * read" across the top of the page.
 */
export class ResultsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultsFileError";
  }
}

async function reqWithIssues<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let issues: ShariahImportIssue[] = [];
    try {
      const parsed = (await res.json()) as { error?: string; issues?: ShariahImportIssue[] };
      if (parsed.error) message = parsed.error;
      if (Array.isArray(parsed.issues)) issues = parsed.issues;
    } catch { /* keep status text */ }
    throw new ShariahImportError(message, issues, res.status);
  }
  return res.json() as Promise<T>;
}

export interface PublishRequest {
  classification: ShariahClassification;
  reason: string;
  prohibitedCategories: string[];
  evidenceIds: string[];
  reviewedAt: string;
}

export const shariahApi = {
  universe: () => req<ShariahUniverse>("/api/shariah/universe"),

  /*
   * Discover which Binance Spot USDT base assets this install tracks.
   *
   * `POST /api/shariah/universe/sync` describes itself as "the registry's only
   * production entry point" and had NO caller — no button, no client method,
   * no script. So a fresh install had an empty registry, every symbol resolved
   * to REVIEW, and turning Shariah Mode on was a total BUY stop with no action
   * inside the product that could lift it. The whole feature was unreachable
   * without curl.
   *
   * Discovery is not classification: the route creates every newly seen asset
   * UNSCREENED, which reads as REVIEW, and has no path that writes ELIGIBLE or
   * EXCLUDED. Running it can never widen what may be bought.
   */
  syncUniverse: () => req<{
    policyVersion: string; qualifying: number;
    created: number; reactivated: number; deactivated: number;
  }>("/api/shariah/universe/sync", { method: "POST" }),
  asset: (assetId: string) => req<ShariahAssetDetail>(`/api/shariah/assets/${assetId}`),
  addEvidence: (assetId: string, body: Omit<ShariahEvidence, "id" | "assetId" | "createdAt">) =>
    req<ShariahEvidence>(`/api/shariah/assets/${assetId}/evidence`, {
      method: "POST", body: JSON.stringify(body),
    }),
  publish: (assetId: string, body: PublishRequest) =>
    req<ShariahPublication>(`/api/shariah/assets/${assetId}/publications`, {
      method: "POST", body: JSON.stringify(body),
    }),
  snapshots: () => req<{ snapshots: ShariahSnapshotMeta[] }>("/api/shariah/snapshots"),
  /** One frozen snapshot with its full membership — what Research consumes. */
  snapshot: (snapshotId: string) =>
    req<ShariahSnapshot>(`/api/shariah/snapshots/${encodeURIComponent(snapshotId)}`),
  createSnapshot: () => req<ShariahSnapshotMeta>("/api/shariah/snapshots", { method: "POST" }),

  /** The next batch to research (20 by default, server-side), or exactly the assets chosen. */
  reviewPack: (request: ShariahReviewPackRequest = {}) =>
    req<ShariahReviewPack>(reviewPackPath(request)),
  previewResults: (document: unknown) =>
    reqWithIssues<ShariahImportPreview>("/api/shariah/review-results/preview", document),
  importResults: (document: unknown, acknowledgedAssetIds: readonly string[] = []) =>
    reqWithIssues<ShariahImportSummary>(importResultsPath(acknowledgedAssetIds), document),

  mode: () => req<ShariahModeResponse>("/api/shariah/mode"),
  /* Append-only: who changed the mode, when, and whether the Bot floor moved. */
  modeHistory: () => req<{ changes: ShariahModeChange[] }>("/api/shariah/mode/history"),
  reviewPolicy: () => req<ShariahReviewPolicy>("/api/shariah/review-policy"),
  setReviewPolicy: (reviewMaxAgeDays: number | null) =>
    req<ShariahReviewPolicy>("/api/shariah/review-policy", {
      method: "PUT", body: JSON.stringify({ reviewMaxAgeDays }),
    }),
  setMode: (mode: ShariahMode) =>
    req<ShariahModeResponse>("/api/shariah/mode", { method: "PUT", body: JSON.stringify({ mode }) }),

  status: (symbol: string) =>
    req<ShariahSymbolStatus>(`/api/shariah/status?symbol=${encodeURIComponent(symbol)}`),
};

/**
 * Saves a review pack as a file the operator uploads to ChatGPT.
 *
 * A Blob + object URL rather than a data: URL because a 20-asset pack with
 * prior context comfortably exceeds what some browsers accept in a navigable
 * data: URL. Returns false when there is no DOM (SSR), so callers can render
 * without branching on it.
 */
export function downloadReviewPack(pack: ShariahReviewPack): boolean {
  return downloadJsonFile(`shariah-review-pack-${pack.generatedAt.replace(/[:.]/g, "-")}.json`, pack);
}

/**
 * Saves a frozen universe snapshot as JSON, for Research.
 *
 * The read contract existed (`GET /api/shariah/snapshots/:id`) and nothing in
 * the product reached it, so getting the one artefact Research runs are meant
 * to cite meant curl. The file is the backend's answer byte-for-byte —
 * content hash included — so a run that records the snapshot id and hash can
 * be checked against it.
 */
export function downloadSnapshot(snapshot: ShariahSnapshot): boolean {
  return downloadJsonFile(
    `shariah-snapshot-${snapshot.snapshotId}-${snapshot.contentHash.slice(0, 12)}.json`, snapshot);
}

/** The one Blob-download path both files use. False without a DOM (SSR). */
export function downloadJsonFile(filename: string, data: unknown): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Parses a pasted or uploaded results file.
 *
 * Deliberately does NOTHING but `JSON.parse`: the browser never validates the
 * contract, never repairs a field and never decides what is publishable. The
 * backend import boundary owns all of that, and a preview that disagreed with
 * it would be worse than no preview at all.
 */
export function parseResultsFile(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new ResultsFileError("Paste or choose a results file first.");
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // The parser's own finding — where it stopped — is what tells the
    // operator whether they pasted a markdown fence, commentary or half a file.
    const where = e instanceof Error ? e.message.replace(/\.$/, "") : "it could not be parsed";
    throw new ResultsFileError(
      `The pasted text is not a JSON document: ${where}. Paste only the JSON document ChatGPT `
      + "returned — no markdown fence, no commentary."
    );
  }
}
