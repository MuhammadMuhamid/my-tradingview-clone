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
}

export interface ShariahUniverse {
  policyVersion: string;
  prohibitedCategories: string[];
  counts: { total: number; active: number; eligible: number; review: number; excluded: number };
  assets: ShariahAssetState[];
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
}

export interface ShariahImportPreview {
  policyVersion: string;
  researchCompletedAt: string;
  assetCount: number;
  counts: Record<ShariahClassification, number>;
  results: Array<{
    assetId: string;
    baseAsset: string;
    classification: ShariahClassification;
    prohibitedCategories: string[];
    evidenceCount: number;
    unresolvedUncertainties: string[];
  }>;
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
  constructor(message: string, readonly issues: ShariahImportIssue[]) {
    super(message);
    this.name = "ShariahImportError";
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
    throw new ShariahImportError(message, issues);
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
  createSnapshot: () => req<ShariahSnapshotMeta>("/api/shariah/snapshots", { method: "POST" }),

  /** The next batch to research. Defaults to 20 server-side; `size` is an override. */
  reviewPack: (size?: number) =>
    req<ShariahReviewPack>(`/api/shariah/review-pack${size ? `?size=${size}` : ""}`),
  previewResults: (document: unknown) =>
    reqWithIssues<ShariahImportPreview>("/api/shariah/review-results/preview", document),
  importResults: (document: unknown) =>
    reqWithIssues<ShariahImportSummary>("/api/shariah/review-results/import", document),

  mode: () => req<ShariahModeResponse>("/api/shariah/mode"),
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
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const stamp = pack.generatedAt.replace(/[:.]/g, "-");
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `shariah-review-pack-${stamp}.json`;
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
  if (trimmed.length === 0) throw new Error("paste or choose a results file first");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      "that is not valid JSON. Paste only the JSON document ChatGPT returned — " +
      "no markdown fence, no commentary."
    );
  }
}
