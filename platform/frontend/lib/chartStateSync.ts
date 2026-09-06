"use client";
/**
 * Bringing browser-local chart state up to the server, once and safely.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * Drawings and applied studies have always lived in `localStorage`. That is
 * fine for one machine and useless for two: the chart a trader set up at their
 * desk is not the chart they open on the laptop, and clearing site data loses
 * work that took real time to place. The server now holds both — but a user
 * already HAS local state, and the whole difficulty is moving it without
 * destroying anything on either side.
 *
 * ── The rules, and what each one prevents ──────────────────────────────────
 *
 * Every one of these exists because the obvious implementation gets it wrong:
 *
 *   A server row that already has content is never overwritten by local state
 *   that has not synced. Otherwise opening the laptop for the first time
 *   flattens the desk's chart with whatever the laptop happened to have.
 *
 *   Local data is never cleared because a fetch or a save failed. A failed
 *   sync must leave the user exactly as they were, including offline.
 *
 *   The import runs once per instrument and records that it ran. Otherwise
 *   deleting a drawing on one device and reloading resurrects it from that
 *   device's own untouched localStorage — a deletion that will not stay
 *   deleted is worse than no sync at all.
 *
 *   A write carries the version it last read. A stale write is refused and the
 *   server hands back what is actually stored; the client adopts that. This is
 *   the whole conflict rule, and it is one sentence on purpose.
 *
 * There is no CRDT and no merge. Two devices editing the same instrument at
 * the same second is not a case this product has; two devices editing it a
 * minute apart is, and last-adopted-then-written handles that correctly.
 */
import { api } from "@/lib/api";
import { loadDrawings, saveDrawings, type Drawing } from "@/lib/drawings";
import {
  loadStoredNative, saveStoredNative, PRIMARY_SCOPE, type StoredNativeStudy,
} from "@/lib/native/storage";

/** Which instruments and panes have already been imported, per browser. */
const IMPORTED_KEY = "tv.chartState.imported.v1";

interface ImportLog {
  /** Instrument keys — `BINANCE:BTCUSDT` — that have been imported. */
  drawings?: string[];
  /** Pane scopes that have been imported. */
  panes?: string[];
}

function readImportLog(): ImportLog {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(IMPORTED_KEY);
    const parsed = raw ? (JSON.parse(raw) as ImportLog) : {};
    return {
      drawings: Array.isArray(parsed.drawings) ? parsed.drawings.map(String) : [],
      panes: Array.isArray(parsed.panes) ? parsed.panes.map(String) : [],
    };
  } catch {
    // A corrupt log means "we do not know what has been imported". Treating
    // that as "nothing" is safe: an import that runs again still cannot
    // overwrite a populated server row.
    return {};
  }
}

function noteImported(kind: "drawings" | "panes", id: string): void {
  if (typeof window === "undefined") return;
  const log = readImportLog();
  const list = new Set(log[kind] ?? []);
  list.add(id);
  try {
    window.localStorage.setItem(IMPORTED_KEY, JSON.stringify({ ...log, [kind]: [...list] }));
  } catch { /* quota: the import may run again, which is safe by construction */ }
}

export function hasImported(kind: "drawings" | "panes", id: string): boolean {
  return (readImportLog()[kind] ?? []).includes(id);
}

/** Reset the log. Exported for tests and for a deliberate "import again". */
export function resetImportLog(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(IMPORTED_KEY); } catch { /* nothing to do */ }
}

// ── the decision, as a pure function ───────────────────────────────────────

export type SyncDecision =
  /** The server has content; adopt it and leave local state alone. */
  | { action: "adopt"; reason: "server-has-state" }
  /** Nothing on the server and nothing worth sending. */
  | { action: "nothing"; reason: "both-empty" | "already-imported" }
  /** Local state has never been imported and the server is empty; send it. */
  | { action: "import"; reason: "first-sync" }
  /** Ordinary save of an edit the user just made. */
  | { action: "push"; reason: "local-edit" };

/**
 * What to do on load, given both sides.
 *
 * Pure so it can be reasoned about and tested without a network or a browser —
 * this is the function that decides whether a user's work survives, and it
 * should not be discoverable only by running the app.
 */
export function decideSync(input: {
  serverVersion: number;
  serverCount: number;
  localCount: number;
  alreadyImported: boolean;
}): SyncDecision {
  // The server having anything at all wins. It may be a second device's work,
  // and this device has no basis for believing its own copy is newer.
  if (input.serverVersion > 0 && input.serverCount > 0) {
    return { action: "adopt", reason: "server-has-state" };
  }
  if (input.localCount === 0) return { action: "nothing", reason: "both-empty" };
  // A server row that exists but is EMPTY is a deliberate "the user deleted
  // everything", so re-importing would resurrect it.
  if (input.alreadyImported || input.serverVersion > 0) {
    return { action: "nothing", reason: "already-imported" };
  }
  return { action: "import", reason: "first-sync" };
}

// ── drawings ───────────────────────────────────────────────────────────────

export interface DrawingSync {
  drawings: Drawing[];
  version: number;
  /** What happened, so the caller can say so rather than guess. */
  decision: SyncDecision;
  /** True when the server could not be reached; local state is authoritative. */
  offline: boolean;
}

/**
 * Reconcile one instrument's drawings with the server.
 *
 * Total: every failure path returns the LOCAL list, because a sync that cannot
 * reach the server must leave the user exactly as they were.
 */
export async function syncDrawings(symbol: string): Promise<DrawingSync> {
  const local = loadDrawings(symbol);
  let server: { drawings: unknown[]; version: number };
  try {
    server = await api.getChartDrawings(symbol);
  } catch {
    return {
      drawings: local, version: 0, offline: true,
      decision: { action: "nothing", reason: "both-empty" },
    };
  }

  const decision = decideSync({
    serverVersion: server.version,
    serverCount: server.drawings.length,
    localCount: local.length,
    alreadyImported: hasImported("drawings", symbol),
  });

  if (decision.action === "adopt") {
    const adopted = server.drawings as Drawing[];
    // Written through the local store too, so an offline reload still has it.
    saveDrawings(symbol, adopted);
    noteImported("drawings", symbol);
    return { drawings: adopted, version: server.version, decision, offline: false };
  }

  if (decision.action === "import") {
    try {
      const saved = await api.putChartDrawings(symbol, local, server.version);
      noteImported("drawings", symbol);
      // A 409 comes back as the CURRENT state, which is the right answer:
      // another device got there first, so adopt rather than retry.
      const drawings = saved.drawings as Drawing[];
      saveDrawings(symbol, drawings);
      return { drawings, version: saved.version, decision, offline: false };
    } catch {
      // The import failed. Local state is untouched and will be tried again.
      return { drawings: local, version: server.version, decision, offline: true };
    }
  }

  return { drawings: local, version: server.version, decision, offline: false };
}

/**
 * Save an edit, adopting the server's state if this client was stale.
 *
 * Returns what is now true — which after a conflict is the SERVER's list, not
 * the one that was passed in. A caller that ignored that would keep trying to
 * write a version that no longer exists.
 */
export async function pushDrawings(
  symbol: string, drawings: Drawing[], baseVersion: number
): Promise<{ drawings: Drawing[]; version: number; conflicted: boolean; offline: boolean }> {
  saveDrawings(symbol, drawings);
  try {
    const saved = await api.putChartDrawings(symbol, drawings, baseVersion);
    const conflicted = saved.version !== baseVersion + 1;
    const next = saved.drawings as Drawing[];
    if (conflicted) saveDrawings(symbol, next);
    return { drawings: next, version: saved.version, conflicted, offline: false };
  } catch {
    // Offline. The edit is in localStorage and will go up on the next sync.
    return { drawings, version: baseVersion, conflicted: false, offline: true };
  }
}

// ── pane studies ───────────────────────────────────────────────────────────

export interface PaneSync {
  native: StoredNativeStudy[];
  pine: unknown[];
  version: number;
  decision: SyncDecision;
  offline: boolean;
}

export async function syncPaneStudies(
  scope: string = PRIMARY_SCOPE, localPine: unknown[] = []
): Promise<PaneSync> {
  const localNative = loadStoredNative(scope);
  let server: { pine: unknown[]; native: unknown[]; version: number };
  try {
    server = await api.getChartPaneStudies(scope);
  } catch {
    return {
      native: localNative, pine: localPine, version: 0, offline: true,
      decision: { action: "nothing", reason: "both-empty" },
    };
  }

  const decision = decideSync({
    serverVersion: server.version,
    serverCount: server.native.length + server.pine.length,
    localCount: localNative.length + localPine.length,
    alreadyImported: hasImported("panes", scope),
  });

  if (decision.action === "adopt") {
    const native = server.native as StoredNativeStudy[];
    // `saveStoredNative` drops rows whose study id this build does not have,
    // which is what makes a layout written by a newer build degrade to a
    // working chart rather than an empty one.
    saveStoredNative(native, scope);
    noteImported("panes", scope);
    return { native, pine: server.pine, version: server.version, decision, offline: false };
  }

  if (decision.action === "import") {
    try {
      const saved = await api.putChartPaneStudies(
        scope, localPine, localNative, server.version);
      noteImported("panes", scope);
      const native = saved.native as StoredNativeStudy[];
      saveStoredNative(native, scope);
      return { native, pine: saved.pine, version: saved.version, decision, offline: false };
    } catch {
      return { native: localNative, pine: localPine, version: server.version, decision, offline: true };
    }
  }

  return {
    native: localNative, pine: localPine, version: server.version, decision, offline: false,
  };
}

export async function pushPaneStudies(
  scope: string, pine: unknown[], native: StoredNativeStudy[], baseVersion: number
): Promise<{ native: StoredNativeStudy[]; pine: unknown[]; version: number; conflicted: boolean; offline: boolean }> {
  saveStoredNative(native, scope);
  try {
    const saved = await api.putChartPaneStudies(scope, pine, native, baseVersion);
    const conflicted = saved.version !== baseVersion + 1;
    const next = saved.native as StoredNativeStudy[];
    if (conflicted) saveStoredNative(next, scope);
    return {
      native: next, pine: saved.pine, version: saved.version, conflicted, offline: false,
    };
  } catch {
    return { native, pine, version: baseVersion, conflicted: false, offline: true };
  }
}
