/**
 * Undo and redo for drawings, bounded and scoped to one instrument.
 *
 * ── Why per symbol ─────────────────────────────────────────────────────────
 *
 * Drawings are keyed by symbol (`lib/drawingStore`), so history must be too.
 * A single global stack would let Cmd+Z on an ETHUSDT chart restore a
 * trendline the user deleted on BTCUSDT ten minutes ago — an edit to a chart
 * they are not looking at, with no visible feedback that anything happened.
 * That is worse than having no undo.
 *
 * ── Why snapshots and not a command log ────────────────────────────────────
 *
 * A drawing list is small — tens of objects of a few fields each — and the
 * operations on it are heterogeneous: create, move a single anchor, restyle,
 * lock, delete, paste. An inverse-operation log would need one inverse per
 * operation and would be wrong the first time an operation was added without
 * one. A snapshot is always its own inverse, and the memory cost is bounded by
 * construction below.
 *
 * ── Coalescing ─────────────────────────────────────────────────────────────
 *
 * Dragging an anchor emits a change per pointer sample. Recording each would
 * make one drag cost the entire undo depth, so undo would rewind a few pixels.
 * Consecutive changes tagged with the same `gesture` collapse into one entry:
 * the drag is one undo step, which is what the user means by "undo that".
 *
 * ── Replay ─────────────────────────────────────────────────────────────────
 *
 * Replay drawings are session-scoped and are never persisted, so they get
 * their own history scope rather than sharing the instrument's. Undoing inside
 * a Replay must not reach back into the real chart's drawings.
 */
import type { Drawing } from "./drawings";

/** How many steps one instrument remembers. */
export const MAX_HISTORY = 50;

interface Entry {
  drawings: Drawing[];
  /** Consecutive entries with the same non-null gesture collapse into one. */
  gesture: string | null;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Steps recorded, for the tests and for a diagnostic readout. */
  depth: number;
}

/**
 * One instrument's stack.
 *
 * `past` holds states BEFORE each recorded change, newest last. `present` is
 * what is on screen. `future` holds states undone from, newest first.
 */
class SymbolHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private present: Entry;

  constructor(initial: Drawing[]) {
    this.present = { drawings: initial, gesture: null };
  }

  get state(): HistoryState {
    return {
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      depth: this.past.length,
    };
  }

  get current(): Drawing[] { return this.present.drawings; }

  /**
   * Record a new state.
   *
   * A change that is identical to what is already present records nothing: a
   * pointer sample that moved an anchor by zero pixels is not an edit, and
   * letting it in would fill the stack with no-ops that undo does nothing to.
   */
  record(next: Drawing[], gesture: string | null): void {
    if (sameDrawings(this.present.drawings, next)) return;
    // A new edit invalidates the redo branch: there is no tree here, and a
    // redo that jumped to a state the current one did not come from would be
    // a different document.
    this.future = [];
    const coalesce = gesture !== null && this.present.gesture === gesture;
    if (!coalesce) {
      this.past.push(this.present);
      if (this.past.length > MAX_HISTORY) this.past.shift();
    } else {
      /*
       * M1 / F-01: a gesture that ends where it began is no step at all.
       *
       * Placing a text drawing opens its inline editor and records the empty
       * drawing under one gesture; Escape removes it under the same one. The
       * two collapse into a single entry whose before and after are the same
       * list — an undo that would do nothing, and that the user never made.
       */
      const before = this.past[this.past.length - 1];
      if (before && sameDrawings(before.drawings, next)) {
        this.past.pop();
        this.present = { drawings: next, gesture: null };
        return;
      }
    }
    this.present = { drawings: next, gesture };
  }

  /**
   * Adopt a state that did NOT come from an edit — a symbol's drawings loaded
   * from storage, or a server sync landing. It becomes the present without
   * being undoable, because undoing "the data arrived" is meaningless.
   */
  reset(drawings: Drawing[]): void {
    this.past = [];
    this.future = [];
    this.present = { drawings, gesture: null };
  }

  undo(): Drawing[] | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.unshift(this.present);
    if (this.future.length > MAX_HISTORY) this.future.pop();
    this.present = previous;
    return previous.drawings;
  }

  redo(): Drawing[] | null {
    const next = this.future.shift();
    if (!next) return null;
    this.past.push(this.present);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.present = next;
    return next.drawings;
  }
}

/**
 * Every instrument's history, bounded in BOTH directions.
 *
 * Fifty steps per instrument is the depth; sixteen instruments is the breadth.
 * A session that visits forty symbols must not hold forty stacks of fifty
 * drawing lists, so the least-recently-touched scope is dropped — which loses
 * an undo history for a chart the user left long ago, and never loses a
 * drawing, because the drawings themselves live in the store.
 */
export const MAX_SCOPES = 16;

export class DrawingHistory {
  private readonly scopes = new Map<string, SymbolHistory>();

  private touch(scope: string, initial: Drawing[]): SymbolHistory {
    const existing = this.scopes.get(scope);
    if (existing) {
      // Re-insert so insertion order stays recency order.
      this.scopes.delete(scope);
      this.scopes.set(scope, existing);
      return existing;
    }
    const created = new SymbolHistory(initial);
    this.scopes.set(scope, created);
    while (this.scopes.size > MAX_SCOPES) {
      const oldest = this.scopes.keys().next();
      if (oldest.done) break;
      this.scopes.delete(oldest.value);
    }
    return created;
  }

  record(scope: string, next: Drawing[], gesture: string | null = null): void {
    this.touch(scope, next).record(next, gesture);
  }

  /** Seed or re-seed a scope without making the change undoable. */
  reset(scope: string, drawings: Drawing[]): void {
    this.touch(scope, drawings).reset(drawings);
  }

  undo(scope: string): Drawing[] | null {
    return this.scopes.get(scope)?.undo() ?? null;
  }

  redo(scope: string): Drawing[] | null {
    return this.scopes.get(scope)?.redo() ?? null;
  }

  state(scope: string): HistoryState {
    return this.scopes.get(scope)?.state ?? { canUndo: false, canRedo: false, depth: 0 };
  }

  get scopeCount(): number { return this.scopes.size; }

  clear(): void { this.scopes.clear(); }
}

/**
 * The scope key for a chart.
 *
 * Replay is its own scope, so an undo inside a Replay session cannot reach the
 * instrument's persisted drawings — and leaving Replay leaves that history
 * behind rather than merging it into the real chart's.
 */
export function historyScope(symbol: string, replayActive: boolean): string {
  return replayActive ? `replay|${symbol.toUpperCase()}` : symbol.toUpperCase();
}

/**
 * Structural equality of two drawing lists.
 *
 * Compared field by field rather than by JSON, because a JSON comparison
 * depends on key insertion order and would report two identical lists as
 * different after a round trip through storage.
 */
export function sameDrawings(a: readonly Drawing[], b: readonly Drawing[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (x.id !== y.id || x.tool !== y.tool || !!x.locked !== !!y.locked
      || !!x.hidden !== !!y.hidden) return false;
    const vx = x.visibleOn ?? [], vy = y.visibleOn ?? [];
    if (vx.length !== vy.length || [...vx].sort().some((v, i) => v !== [...vy].sort()[i])) return false;
    if (x.points.length !== y.points.length) return false;
    for (let k = 0; k < x.points.length; k++) {
      if (x.points[k]!.time !== y.points[k]!.time) return false;
      if (x.points[k]!.price !== y.points[k]!.price) return false;
    }
    if (x.style.color !== y.style.color || x.style.width !== y.style.width) return false;
    if ((x.style.dashed ?? false) !== (y.style.dashed ?? false)) return false;
    if ((x.style.filled ?? false) !== (y.style.filled ?? false)) return false;
    if ((x.style.text ?? "") !== (y.style.text ?? "")) return false;
    if ((x.style.bands ?? 0) !== (y.style.bands ?? 0)) return false;
    const px = x.style.profile ?? {}, py = y.style.profile ?? {};
    const profileKeys = ["layout", "rowSize", "valueAreaPercent", "allocation", "split", "side", "widthPercent", "showValueArea", "showPoc"] as const;
    for (const key of profileKeys) if (px[key] !== py[key]) return false;
    if (!sameRemainingStyle(x.style, y.style)) return false;
  }
  return true;
}

/** The style keys `sameDrawings` already compares, with their own defaults. */
const COMPARED_STYLE_KEYS = new Set(["color", "width", "dashed", "filled", "text", "bands", "profile"]);

/**
 * M1 / F-10: every OTHER style key, compared by value.
 *
 * The list above predates the Text tab and the toolbar's font-size and text
 * colour widgets, so a change to `fontSize`, `textColor`, `lineStyle` or any
 * other later key compared as "nothing changed": the history recorded no step,
 * and undo skipped straight past the edit to the one before it. An unset key
 * and an `undefined` one are the same; anything else is compared exactly
 * (these are numbers, strings and booleans, or arrays of them).
 */
function sameRemainingStyle(a: Drawing["style"], b: Drawing["style"]): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (COMPARED_STYLE_KEYS.has(key)) continue;
    const va = (a as unknown as Record<string, unknown>)[key];
    const vb = (b as unknown as Record<string, unknown>)[key];
    if (va === vb) continue;
    if (Array.isArray(va) && Array.isArray(vb)
      && va.length === vb.length && va.every((v, i) => v === vb[i])) continue;
    return false;
  }
  return true;
}

/**
 * A copy of a drawing with a new identity, offset so it is visibly a copy.
 *
 * A clone that landed exactly on top of its original would look like nothing
 * happened, and the user would drag the original away believing it was the
 * copy. The offset is in BARS and PRICE PERCENT rather than pixels, because
 * the anchors are in chart units and a pixel offset would mean a different
 * distance at every zoom level.
 */
export function cloneDrawing(
  drawing: Drawing, newId: () => string, barSeconds: number, offsetBars = 2
): Drawing {
  const shiftTime = barSeconds * offsetBars;
  return {
    ...drawing,
    id: newId(),
    locked: false,
    points: drawing.points.map((p) => ({ time: p.time + shiftTime, price: p.price })),
    style: { ...drawing.style },
  };
}
