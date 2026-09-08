"use client";
/**
 * One study's output as another study's source.
 *
 * ── What was missing ───────────────────────────────────────────────────────
 *
 * A moving average of an RSI, a Bollinger band around a MACD histogram, an
 * RSI of a smoothed close: three of the most ordinary things a trader does on
 * a professional chart, and none of them was expressible here. Every study's
 * `source` resolved to a price array and stopped there.
 *
 * ── Why this needed a graph rather than a lookup ───────────────────────────
 *
 * Because "compute A, then B from it" is only correct if the order is right,
 * the windows agree and the whole thing is acyclic — and none of those is
 * true by accident:
 *
 *   ORDER     the list on screen is the LAYERING order the user chose. A
 *             dependent may sit above or below its source in it, so compute
 *             order is a topological sort of the dependencies, not the list.
 *
 *   WINDOWS   a study reads its source bar-for-bar, so both must have been
 *             computed over exactly the same bars. A dependent also needs more
 *             lead-in than either study alone: an EMA(50) of an RSI(14) needs
 *             the RSI to have converged before its own average starts. So a
 *             connected group of studies is evaluated over ONE window, sized
 *             by the deepest chain in it.
 *
 *   CYCLES    A sourcing B sourcing A is not a slow chart, it is an infinite
 *             recursion. It is refused twice: the picker never offers a choice
 *             that would create one, and the graph refuses to compute one that
 *             arrives anyway — from a hand-edited layout, or from a build that
 *             allowed something this one does not.
 *
 * ── Ids that survive ───────────────────────────────────────────────────────
 *
 * A source is `study:<instance key>:<plot id>`. The instance key is the same
 * `nat_…` id persistence has always used, and a plot id is fixed by its
 * definition, so a chain survives a reload, a device change and a server
 * round-trip without anything new being stored: it is a string in the
 * dependent's own parameters.
 *
 * That also means a dangling reference is possible — delete the RSI and the
 * average of it names something that is gone. It is reported and drawn as
 * nothing, never silently repointed at `close`: an average that quietly
 * becomes an average of price is a different indicator wearing the same name.
 */
import type {
  NativeInput, NativeParams, NativeStudyDef, PriceSource,
} from "./registry";
import { PRICE_SOURCES, PRICE_SOURCE_LABELS } from "./registry";
import type { AppliedNativeStudy } from "./compute";

export const STUDY_SOURCE_PREFIX = "study:";

/**
 * How long a chain may be.
 *
 * Depth means study-to-study EDGES, not study nodes: four permits five studies
 * in one chain, and a fifth link is refused. This is what bounds the cost: the
 * window a group is evaluated over grows with the chain, so an unbounded depth
 * would let a layout ask for an unbounded window. The picker stops offering
 * sources that would exceed it, so the limit is met as a missing option rather
 * than as an error after the fact.
 */
export const MAX_SOURCE_DEPTH = 4;

const TOKEN = /^study:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64})$/;

export function studySourceToken(key: string, plotId: string): string {
  return `${STUDY_SOURCE_PREFIX}${key}:${plotId}`;
}

/** `{key, plotId}` for a study source, or null for a price source or junk. */
export function parseStudySource(value: unknown): { key: string; plotId: string } | null {
  if (typeof value !== "string") return null;
  const match = TOKEN.exec(value);
  return match ? { key: match[1]!, plotId: match[2]! } : null;
}

export const isStudySource = (value: unknown): boolean => parseStudySource(value) !== null;

/**
 * Whether a study will accept another study's output where a price goes.
 *
 * Having a `source` input is the test, and it is a real one rather than a
 * convenience: a study that reads highs, lows and volume — ATR, ADX, MFI, a
 * volume profile — has no single input series, so there is nothing for a
 * source to replace and offering one would produce a plausible number computed
 * from the wrong arrays. `acceptsStudySource: false` is an explicit opt-out on
 * top of that for a study that takes a source but means it as a PRICE.
 */
export function acceptsStudySource(def: NativeStudyDef): boolean {
  return def.acceptsStudySource !== false && def.inputs.some((i) => i.kind === "source");
}

/**
 * Whether a plot is a sensible thing for another study to read.
 *
 * Three exclusions, each because the resulting number would be wrong rather
 * than merely unusual:
 *
 *   a DISPLACED plot is drawn at bars other than the ones it was computed
 *   from, so reading it bar-for-bar would silently align an average with the
 *   wrong bars;
 *
 *   a plot from a study whose answer depends on the VIEWPORT would make its
 *   dependent change when the user scrolls, which is not a property any
 *   indicator should have;
 *
 *   a plot marked `notASource` by its own definition.
 */
export function plotIsSourceable(def: NativeStudyDef, plotId: string): boolean {
  if (def.usesVisibleRange) return false;
  const plot = def.plots.find((p) => p.id === plotId);
  if (!plot) return false;
  return !plot.notASource && (plot.offset ?? 0) === 0;
}

/** The source inputs of one study that name another study. */
export function studyDependencies(
  applied: AppliedNativeStudy, def: NativeStudyDef
): { inputKey: string; key: string; plotId: string; token: string }[] {
  const out: { inputKey: string; key: string; plotId: string; token: string }[] = [];
  for (const input of def.inputs) {
    if (input.kind !== "source") continue;
    const raw = applied.params[input.key];
    const parsed = parseStudySource(raw);
    if (parsed) {
      out.push({ inputKey: input.key, ...parsed, token: String(raw) });
    }
  }
  return out;
}

/** Why a study cannot be computed. */
export type SourceIssue = "missing" | "cycle" | "depth";

export interface StudyGraph {
  /** Compute order: a study never appears before a study it reads. */
  order: string[];
  /** Instance keys that cannot be computed, and why. */
  issues: Map<string, SourceIssue>;
  /** Which connected group each study belongs to. */
  component: Map<string, number>;
  /** Bars of lead-in each group needs — the deepest chain in it. */
  componentWarmup: number[];
  /** A group containing an unbounded study is evaluated over the whole series. */
  componentUnbounded: boolean[];
  /** How many studies each group holds, so a lone study can skip the machinery. */
  componentSize: number[];
  /** Longest chain below each study. Zero for one that reads a price. */
  depth: Map<string, number>;
  /** Direct dependencies per study, already validated. */
  edges: Map<string, { inputKey: string; key: string; plotId: string; token: string }[]>;
}

/**
 * Order, group and validate a pane's studies.
 *
 * Total: an unknown definition, a dangling reference, a cycle and a chain past
 * the depth limit are all reported rather than thrown, and every study that is
 * not itself broken still computes. One bad row must not empty a pane.
 */
export function buildStudyGraph(
  list: readonly AppliedNativeStudy[],
  resolve: (defId: string) => NativeStudyDef | null,
  warmupOf: (applied: AppliedNativeStudy, def: NativeStudyDef) => number
): StudyGraph {
  const defs = new Map<string, NativeStudyDef>();
  for (const study of list) {
    const def = resolve(study.defId);
    if (def) defs.set(study.key, def);
  }

  const issues = new Map<string, SourceIssue>();
  const edges = new Map<string, { inputKey: string; key: string; plotId: string; token: string }[]>();
  const byKey = new Map(list.map((s) => [s.key, s]));

  for (const study of list) {
    const def = defs.get(study.key);
    if (!def) { edges.set(study.key, []); continue; }
    const wanted = studyDependencies(study, def);
    const kept: typeof wanted = [];
    for (const edge of wanted) {
      const sourceStudy = byKey.get(edge.key);
      const sourceDef = sourceStudy ? defs.get(edge.key) : null;
      const usable = sourceStudy !== undefined && sourceDef !== null && sourceDef !== undefined
        && acceptsStudySource(def)
        && plotIsSourceable(sourceDef, edge.plotId);
      if (!usable) { issues.set(study.key, "missing"); continue; }
      kept.push(edge);
    }
    edges.set(study.key, kept);
  }

  // ── cycles ───────────────────────────────────────────────────────────────
  //
  // Depth-first, three colours. A key that is grey when reached again is on
  // the current path, so it and everything on that path is in a cycle; a key
  // that DEPENDS on a cycle member cannot be computed either, which falls out
  // of marking on the way back up.
  const colour = new Map<string, 0 | 1 | 2>();
  const bad = new Set<string>();
  const visit = (key: string): boolean => {
    const seen = colour.get(key);
    if (seen === 1) { bad.add(key); return true; }
    if (seen === 2) return bad.has(key);
    colour.set(key, 1);
    let poisoned = false;
    for (const edge of edges.get(key) ?? []) {
      if (visit(edge.key)) poisoned = true;
    }
    colour.set(key, 2);
    if (poisoned) bad.add(key);
    return poisoned;
  };
  for (const study of list) visit(study.key);
  for (const key of bad) issues.set(key, "cycle");

  /*
   * A valid edge to a study that is itself missing or too deep is still
   * unusable. Propagate those causes downstream just as cycles are propagated;
   * otherwise a dependent receives all-NaN input and incorrectly tells the
   * user to load more history. Keep the edge and source token intact so
   * restoring the root repairs the whole chain.
   */
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const study of list) {
      if (issues.has(study.key)) continue;
      const upstream = (edges.get(study.key) ?? [])
        .map((edge) => issues.get(edge.key))
        .find((issue): issue is SourceIssue => issue === "missing" || issue === "depth");
      if (upstream) {
        issues.set(study.key, upstream);
        propagated = true;
      }
    }
  }

  // ── depth and lead-in ────────────────────────────────────────────────────
  const depth = new Map<string, number>();
  const chainWarmup = new Map<string, number>();
  const measure = (key: string): { depth: number; warmup: number } => {
    const known = depth.get(key);
    if (known !== undefined) return { depth: known, warmup: chainWarmup.get(key) ?? 0 };
    if (issues.get(key) === "cycle") {
      depth.set(key, 0); chainWarmup.set(key, 0);
      return { depth: 0, warmup: 0 };
    }
    const study = byKey.get(key);
    const def = defs.get(key);
    const own = study && def ? Math.max(0, Math.ceil(warmupOf(study, def))) : 0;
    let below = 0;
    let lead = 0;
    // Seeded before recursing so a graph that somehow still contains a loop
    // terminates rather than overflowing the stack.
    depth.set(key, 0); chainWarmup.set(key, own);
    for (const edge of edges.get(key) ?? []) {
      const child = measure(edge.key);
      below = Math.max(below, child.depth + 1);
      lead = Math.max(lead, child.warmup);
    }
    depth.set(key, below);
    chainWarmup.set(key, own + lead);
    return { depth: below, warmup: own + lead };
  };
  for (const study of list) measure(study.key);
  for (const [key, value] of depth) {
    if (value > MAX_SOURCE_DEPTH && !issues.has(key)) issues.set(key, "depth");
  }

  // Depth poisoning can only be known after measuring the graph.
  propagated = true;
  while (propagated) {
    propagated = false;
    for (const study of list) {
      if (issues.has(study.key)) continue;
      if ((edges.get(study.key) ?? []).some((edge) => issues.has(edge.key))) {
        issues.set(study.key, "depth");
        propagated = true;
      }
    }
  }

  // ── connected groups ─────────────────────────────────────────────────────
  //
  // Weakly connected: a source and everything that reads it share a window, so
  // every plot in the group is aligned bar-for-bar with every other.
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let walk = key;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) ?? root;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  for (const study of list) parent.set(study.key, study.key);
  for (const study of list) {
    for (const edge of edges.get(study.key) ?? []) {
      const a = find(study.key);
      const b = find(edge.key);
      if (a !== b) parent.set(a, b);
    }
  }

  const componentIndex = new Map<string, number>();
  const component = new Map<string, number>();
  const componentWarmup: number[] = [];
  const componentUnbounded: boolean[] = [];
  const componentSize: number[] = [];
  for (const study of list) {
    const root = find(study.key);
    let index = componentIndex.get(root);
    if (index === undefined) {
      index = componentWarmup.length;
      componentIndex.set(root, index);
      componentWarmup.push(0);
      componentUnbounded.push(false);
      componentSize.push(0);
    }
    component.set(study.key, index);
    componentSize[index]! += 1;
    componentWarmup[index] = Math.max(componentWarmup[index]!, chainWarmup.get(study.key) ?? 0);
    if (defs.get(study.key)?.unbounded === true) componentUnbounded[index] = true;
  }

  // ── order ────────────────────────────────────────────────────────────────
  //
  // Kahn over the dependency edges, seeded in LIST order so two studies that
  // do not depend on each other keep the layering the user chose. Anything a
  // cycle left unemitted is appended: it will compute nothing, but it must
  // still appear so the panel can say why.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const study of list) indegree.set(study.key, 0);
  for (const study of list) {
    for (const edge of edges.get(study.key) ?? []) {
      indegree.set(study.key, (indegree.get(study.key) ?? 0) + 1);
      dependents.set(edge.key, [...(dependents.get(edge.key) ?? []), study.key]);
    }
  }
  const order: string[] = [];
  const queue = list.filter((s) => (indegree.get(s.key) ?? 0) === 0).map((s) => s.key);
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const left = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }
  const emitted = new Set(order);
  for (const study of list) if (!emitted.has(study.key)) order.push(study.key);

  return {
    order, issues, component, componentWarmup, componentUnbounded, componentSize,
    depth, edges,
  };
}

// ── what the picker may offer ───────────────────────────────────────────────

export interface SourceOption {
  value: string;
  label: string;
  group: "price" | "study";
}

/**
 * Every source one study may legally be given.
 *
 * The prices always, then the outputs of other studies on this pane that would
 * neither create a cycle nor push the chain past its depth limit. Filtering
 * HERE rather than validating after the fact is what makes the rule
 * understandable: a combination that makes no sense is simply not in the list,
 * so nobody has to be told off for choosing it.
 */
export function sourceOptionsFor(
  list: readonly AppliedNativeStudy[],
  resolve: (defId: string) => NativeStudyDef | null,
  targetKey: string
): SourceOption[] {
  const options: SourceOption[] = PRICE_SOURCES.map((source) => ({
    value: source,
    label: PRICE_SOURCE_LABELS[source as PriceSource],
    group: "price",
  }));

  const target = list.find((s) => s.key === targetKey);
  const targetDef = target ? resolve(target.defId) : null;
  if (!target || !targetDef || !acceptsStudySource(targetDef)) return options;

  /*
   * Everything that already reads this study, however indirectly.
   *
   * Offering any of them as a source would close a loop, so the whole
   * downstream set is excluded — not merely the direct readers, which is the
   * mistake that lets A → B → C → A through.
   */
  const downstream = new Set<string>([targetKey]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const study of list) {
      if (downstream.has(study.key)) continue;
      const def = resolve(study.defId);
      if (!def) continue;
      if (studyDependencies(study, def).some((edge) => downstream.has(edge.key))) {
        downstream.add(study.key);
        grew = true;
      }
    }
  }

  const graph = buildStudyGraph(list, resolve, () => 0);
  const seen = new Map<string, number>();
  for (const study of list) {
    if (downstream.has(study.key)) continue;
    const def = resolve(study.defId);
    if (!def) continue;
    // The candidate's own chain, plus the one edge that would be added.
    if ((graph.depth.get(study.key) ?? 0) + 1 > MAX_SOURCE_DEPTH) continue;
    if (graph.issues.has(study.key)) continue;
    const ordinal = (seen.get(def.id) ?? 0) + 1;
    seen.set(def.id, ordinal);
    const duplicated = list.filter((s) => s.defId === def.id).length > 1;
    for (const plot of def.plots) {
      if (!plotIsSourceable(def, plot.id)) continue;
      options.push({
        value: studySourceToken(study.key, plot.id),
        label: `${def.name}${duplicated ? ` (${ordinal})` : ""} · ${plot.title}`,
        group: "study",
      });
    }
  }
  return options;
}

/**
 * How a source reads in a legend or a dialog.
 *
 * `study:nat_kx91:hist` is an implementation detail nobody should be shown;
 * "MACD · Histogram" is the same fact. Falls back to a plain "another study"
 * rather than to the raw token, because a token on screen looks like a bug
 * even when it is describing one.
 */
export function describeSource(
  value: unknown,
  list: readonly AppliedNativeStudy[],
  resolve: (defId: string) => NativeStudyDef | null
): string {
  const parsed = parseStudySource(value);
  if (!parsed) {
    const price = String(value) as PriceSource;
    return PRICE_SOURCE_LABELS[price] ?? String(value);
  }
  const study = list.find((s) => s.key === parsed.key);
  const def = study ? resolve(study.defId) : null;
  if (!def) return "a study that is gone";
  const plot = def.plots.find((p) => p.id === parsed.plotId);
  return plot ? `${def.name} · ${plot.title}` : def.name;
}

/** Labels for every study source a pane currently holds, keyed by token. */
export function sourceLabels(
  list: readonly AppliedNativeStudy[],
  resolve: (defId: string) => NativeStudyDef | null
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const study of list) {
    const def = resolve(study.defId);
    if (!def) continue;
    for (const edge of studyDependencies(study, def)) {
      out[edge.token] = describeSource(edge.token, list, resolve);
    }
  }
  return out;
}

/** What the panel says about a study that cannot compute. */
export function sourceIssueMessage(issue: SourceIssue): string {
  switch (issue) {
    case "missing":
      return "The study this reads has been removed, so there is nothing to compute from.";
    case "cycle":
      return "This study and the one it reads depend on each other, which has no value to compute.";
    case "depth":
      return `Studies may use at most ${MAX_SOURCE_DEPTH} study-to-study links; this chain is longer.`;
  }
}

/** True when a study's parameters name any input this build cannot resolve. */
export function hasStudySource(applied: AppliedNativeStudy, def: NativeStudyDef): boolean {
  return studyDependencies(applied, def).length > 0;
}

export type { NativeInput, NativeParams };
