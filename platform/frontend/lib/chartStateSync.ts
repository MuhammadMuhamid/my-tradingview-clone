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
  loadStoredNative, saveStoredNative, unknownStoredNative, PRIMARY_SCOPE,
  type StoredNativeStudy,
} from "@/lib/native/storage";
import type { StoredIndicator as StoredPineStudy } from "@/lib/indicators";

/** Which instruments and panes have already been imported, per browser. */
const IMPORTED_KEY = "tv.chartState.imported.v1";

interface ImportLog {
  /** Instrument keys — `BINANCE:BTCUSDT` — that have been imported. */
  drawings?: string[];
  /** Pane scopes whose BUILT-IN studies have been imported. */
  panes?: string[];
  /** Pane scopes whose PINE studies have been imported. */
  pine?: string[];
}

function readImportLog(): ImportLog {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(IMPORTED_KEY);
    const parsed = raw ? (JSON.parse(raw) as ImportLog) : {};
    return {
      drawings: Array.isArray(parsed.drawings) ? parsed.drawings.map(String) : [],
      panes: Array.isArray(parsed.panes) ? parsed.panes.map(String) : [],
      pine: Array.isArray(parsed.pine) ? parsed.pine.map(String) : [],
    };
  } catch {
    // A corrupt log means "we do not know what has been imported". Treating
    // that as "nothing" is safe: an import that runs again still cannot
    // overwrite a populated server row.
    return {};
  }
}

type ImportKind = "drawings" | "panes" | "pine";

function noteImported(kind: ImportKind, id: string): void {
  if (typeof window === "undefined") return;
  const log = readImportLog();
  const list = new Set(log[kind] ?? []);
  list.add(id);
  try {
    window.localStorage.setItem(IMPORTED_KEY, JSON.stringify({ ...log, [kind]: [...list] }));
  } catch { /* quota: the import may run again, which is safe by construction */ }
}

export function hasImported(kind: ImportKind, id: string): boolean {
  return (readImportLog()[kind] ?? []).includes(id);
}

/** Reset the log. Exported for tests and for a deliberate "import again". */
export type { StoredPineStudy };

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
  /** This device has an edit the server has not seen; send it. */
  | { action: "push"; reason: "local-edit" };

/**
 * What to do on load, given both sides.
 *
 * Pure so it can be reasoned about and tested without a network or a browser —
 * this is the function that decides whether a user's work survives, and it
 * should not be discoverable only by running the app.
 *
 * ── Why `localDirty` is not optional ───────────────────────────────────────
 *
 * Without it this function preferred a non-empty server UNCONDITIONALLY, and
 * `syncDrawings` writes the adopted list straight back through
 * `saveDrawings`. So an edit that had not yet reached the server — a symbol
 * switch inside the debounce window, a closed tab, a sleeping laptop, a
 * network stall — was destroyed on the next sync, including its local copy.
 * "Local data must not be discarded if a save fails" was honoured for a THROWN
 * failure and not for a save that simply never happened.
 *
 * The rule is now about MOVEMENT rather than about content: adopt only when
 * the server has genuinely moved past the version this device last saw. If it
 * has not, this device's unsent work is the newest thing in existence and is
 * pushed. If it has, another device really did write, and the conflict rule
 * applies — its version wins, which is the same rule a stale write hits.
 */
export function decideSync(input: {
  serverVersion: number;
  serverCount: number;
  localCount: number;
  alreadyImported: boolean;
  /**
   * Whether the server has ever held THIS list — even empty.
   *
   * Distinct from `serverVersion > 0`, which was doing this job and could not.
   * A pane's Pine studies and its built-in studies share one row and one
   * version, so once either half created the row the version was non-zero for
   * both — and each half then read the other's existence as proof that its own
   * empty list was a deliberate deletion. One half stopped uploading the
   * user's scripts forever; the other adopted an empty list over the top of
   * the user's studies and pushed that deletion to every device.
   *
   * For drawings there is only one list, so this IS `serverVersion > 0`. For a
   * pane half it is that half's own written flag, which migration 031 added
   * precisely because a concurrency token could not answer it.
   */
  serverEverWritten?: boolean;
  /** This device has edits it has not managed to send. */
  localDirty?: boolean;
  /** The server version this device last read or wrote; 0 if it has not. */
  lastSeenVersion?: number;
}): SyncDecision {
  const dirty = input.localDirty === true;
  const lastSeen = input.lastSeenVersion ?? 0;

  // Unsent work, and the server has not moved since this device last looked:
  // there is nothing to adopt that this device does not already have, and its
  // own edit is the newest thing anywhere.
  if (dirty && input.serverVersion <= lastSeen) {
    return { action: "push", reason: "local-edit" };
  }

  // The server having anything at all wins — it has moved past what this
  // device last saw, so it is another device's newer work.
  if (input.serverVersion > 0 && input.serverCount > 0) {
    return { action: "adopt", reason: "server-has-state" };
  }
  if (input.localCount === 0) return { action: "nothing", reason: "both-empty" };
  /*
   * A list the server has held before and that is now empty is a deliberate
   * "the user deleted everything", so re-importing would resurrect it.
   *
   * `serverEverWritten` rather than `serverVersion > 0`: see above. It falls
   * back to the version only for a caller with a single list, where the two
   * are the same statement.
   */
  const everWritten = input.serverEverWritten ?? input.serverVersion > 0;
  if (input.alreadyImported || everWritten) {
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
export async function syncDrawings(
  symbol: string,
  state: { localDirty?: boolean; lastSeenVersion?: number } = {}
): Promise<DrawingSync> {
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
    localDirty: state.localDirty,
    lastSeenVersion: state.lastSeenVersion,
  });

  if (decision.action === "push") {
    // An edit this device made and never managed to send. It is the newest
    // thing in existence, so it goes up rather than being replaced.
    const pushed = await pushDrawings(symbol, local, server.version);
    return {
      drawings: pushed.drawings, version: pushed.version,
      decision, offline: pushed.offline,
    };
  }

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
    // The server's own answer, not arithmetic over the version. A first write
    // refused because the row already exists comes back at version 1 with
    // `baseVersion` 0, and 0 + 1 is 1 — so the refusal used to be
    // indistinguishable from success, and the edit was silently not saved.
    const { conflicted } = saved;
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

/**
 * Reconcile one pane's studies.
 *
 * `localPine` is what the Pine hook holds. It is a parameter rather than
 * something read from storage here because the two engines' stores are owned
 * by two different hooks, and this module reading one of them behind its
 * owner's back is how the two come to disagree about what is applied.
 */
export async function syncPaneStudies(
  scope: string = PRIMARY_SCOPE, localPine: unknown[] = []
): Promise<PaneSync> {
  const localNative = loadStoredNative(scope);
  let server: {
    pine: unknown[]; native: unknown[]; version: number;
    pineWritten: boolean; nativeWritten: boolean;
  };
  try {
    server = await api.getChartPaneStudies(scope);
  } catch {
    return {
      native: localNative, pine: localPine, version: 0, offline: true,
      decision: { action: "nothing", reason: "both-empty" },
    };
  }

  /*
   * Decided on the BUILT-IN half alone.
   *
   * It used to count `server.native.length + server.pine.length`, so the Pine
   * half's studies were evidence that the built-in half had server state —
   * and the adopt branch then wrote the server's empty native list over the
   * user's own studies, locally and then everywhere.
   */
  const decision = decideSync({
    serverVersion: server.version,
    serverCount: server.native.length,
    serverEverWritten: server.nativeWritten,
    localCount: localNative.length,
    alreadyImported: hasImported("panes", scope),
  });

  if (decision.action === "adopt") {
    const native = server.native as StoredNativeStudy[];
    // `loadStoredNative` returns only the rows this build can run, and
    // `saveStoredNative` writes the unknown ones back beside them — so a
    // layout written by a NEWER build degrades to a working chart rather than
    // an empty one, and this build is never the thing that deletes a study it
    // simply did not recognise.
    saveStoredNative(native, scope);
    noteImported("panes", scope);
    return { native, pine: server.pine, version: server.version, decision, offline: false };
  }

  if (decision.action === "import") {
    try {
      // The built-in half only. `localPine` is this caller's view of somebody
      // else's list, and writing it here is how the Pine half's own import
      // came to be pre-empted by an empty one.
      const saved = await api.putChartPaneStudies(scope, {
        native: localNative, baseVersion: server.version,
      });
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

/**
 * How many times a write is repeated when the server refuses it for a half it
 * has never held.
 *
 * A refusal like that is not a conflict about this half's content (see
 * `pushPaneStudies`), so the write is simply re-based and sent again. It is
 * bounded because each attempt is one more round trip on a row that somebody
 * else is actively writing, and unbounded retrying against a busy row is a
 * spin rather than a save. Three is far past the case this exists for — a
 * pane's two halves saved a moment apart — and short enough to give up
 * politely, which is safe now that giving up no longer discards anything.
 */
const UNWRITTEN_HALF_ATTEMPTS = 3;

/**
 * Save this pane's BUILT-IN studies, leaving its Pine studies alone.
 *
 * The `pine` half is deliberately not sent. It belongs to another hook, and a
 * writer that sends `[]` for a list it does not own deletes it — which is what
 * this function used to do, and what would have destroyed every Pine study on
 * the pane the moment Pine sync existed.
 */
export async function pushPaneStudies(
  scope: string, native: StoredNativeStudy[], baseVersion: number
): Promise<{
  native: StoredNativeStudy[]; version: number; conflicted: boolean;
  /** The returned list is the SERVER's and replaces this device's. */
  adopted: boolean;
  offline: boolean;
}> {
  saveStoredNative(native, scope);
  try {
    /*
     * Including the rows this build cannot run.
     *
     * Sending only what this build understands would make an older client the
     * thing that deletes a newer one's study from the shared row — the same
     * loss `saveStoredNative` now prevents on disk, one layer out.
     */
    const payload = [...native, ...unknownStoredNative(scope)];
    let saved = await api.putChartPaneStudies(scope, { native: payload, baseVersion });
    /*
     * ── A conflict that is not this half's conflict ────────────────────────
     *
     * The status is the only thing that knows whether the write landed (see
     * `pushDrawings`), and for a PANE there are two writers on one row. The
     * first study of each kind is saved a moment apart, so the second one
     * arrives with `baseVersion: 0` — "I believe nothing is stored" — and
     * meets a row the OTHER half has just created. The server is right to
     * refuse it, and adopting the refusal would throw away the study the user
     * has just applied: the server's copy of this half is empty because this
     * half has never been written, not because anybody deleted anything.
     *
     * `nativeWritten` is what distinguishes those two, and it is already in
     * the 409 body. So: refused, and the server has never held this half —
     * write again against the version it just reported. Once, and only in that
     * case; a genuine conflict with another device's edit still adopts.
     */
    for (let attempt = 0;
      attempt < UNWRITTEN_HALF_ATTEMPTS && saved.conflicted && !saved.nativeWritten;
      attempt += 1
    ) {
      saved = await api.putChartPaneStudies(scope, { native: payload, baseVersion: saved.version });
    }
    const { conflicted } = saved;
    /*
     * Adopt only a half the server has actually held.
     *
     * The retries above answer the ordinary case, and a single retry answered
     * it — but if another writer lands during the retry too, the last refusal
     * STILL carries an empty list for a half nobody has ever written, and
     * saving that is the same silent deletion one race deeper. So the rule is
     * about the flag rather than about how many attempts were spent: an empty
     * list from a half the server has never written is the absence of a write,
     * never a deletion. This device keeps what the user applied, reports that
     * it adopted nothing, and writes again on the next edit — against the
     * version the server has just told it about, which is the one that lands.
     */
    const adopted = conflicted && saved.nativeWritten;
    const next = conflicted && !adopted ? native : (saved.native as StoredNativeStudy[]);
    if (adopted) saveStoredNative(next, scope);
    return { native: next, version: saved.version, conflicted, adopted, offline: false };
  } catch {
    return { native, version: baseVersion, conflicted: false, adopted: false, offline: true };
  }
}

/**
 * Reconcile this pane's PINE studies with the server.
 *
 * A separate entry point from `syncPaneStudies` because the two halves are
 * restored by two different hooks at two different moments, and each must be
 * able to reconcile without waiting for — or speaking for — the other.
 *
 * A row whose Pine list is empty while its native list is not is NOT "nothing
 * stored": the pane exists, the native half wrote it, and this half genuinely
 * has nothing. So the decision is made on the Pine list alone.
 */
export async function syncPanePine(
  scope: string, localPine: readonly StoredPineStudy[]
): Promise<{
  pine: StoredPineStudy[]; version: number; decision: SyncDecision; offline: boolean;
}> {
  let server: { pine: unknown[]; version: number; pineWritten: boolean };
  try {
    server = await api.getChartPaneStudies(scope);
  } catch {
    return {
      pine: [...localPine], version: 0, offline: true,
      decision: { action: "nothing", reason: "both-empty" },
    };
  }

  const decision = decideSync({
    serverVersion: server.version,
    serverCount: server.pine.length,
    serverEverWritten: server.pineWritten,
    localCount: localPine.length,
    alreadyImported: hasImported("pine", scope),
  });

  if (decision.action === "adopt") {
    noteImported("pine", scope);
    return {
      pine: server.pine as StoredPineStudy[], version: server.version,
      decision, offline: false,
    };
  }

  if (decision.action === "import") {
    const pushed = await pushPanePine(scope, [...localPine], server.version);
    noteImported("pine", scope);
    return {
      pine: pushed.pine as StoredPineStudy[], version: pushed.version,
      decision, offline: pushed.offline,
    };
  }

  return { pine: [...localPine], version: server.version, decision, offline: false };
}

/**
 * Save this pane's PINE studies, leaving its built-in studies alone.
 *
 * The mirror of `pushPaneStudies`, and separate for the same reason: each hook
 * writes only the half it owns.
 */
export async function pushPanePine(
  scope: string, pine: unknown[], baseVersion: number
): Promise<{
  pine: unknown[]; version: number; conflicted: boolean;
  /** The returned list is the SERVER's and replaces this device's. */
  adopted: boolean;
  offline: boolean;
}> {
  try {
    let saved = await api.putChartPaneStudies(scope, { pine, baseVersion });
    // The mirror of `pushPaneStudies`: a write refused because the BUILT-IN
    // half created the row is not a conflict about Pine studies, so it is
    // re-based and sent again — and an empty list for a half the server has
    // never written is never adopted over what this device holds.
    for (let attempt = 0;
      attempt < UNWRITTEN_HALF_ATTEMPTS && saved.conflicted && !saved.pineWritten;
      attempt += 1
    ) {
      saved = await api.putChartPaneStudies(scope, { pine, baseVersion: saved.version });
    }
    const { conflicted } = saved;
    const adopted = conflicted && saved.pineWritten;
    return {
      pine: conflicted && !adopted ? pine : saved.pine,
      version: saved.version, conflicted, adopted, offline: false,
    };
  } catch {
    return { pine, version: baseVersion, conflicted: false, adopted: false, offline: true };
  }
}
