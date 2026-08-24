/**
 * Optimizer tree registry.
 *
 * Finding `X-04`: the routes used to resolve a tree through a hardcoded name
 * map (`optimizer`, `optimizer1h`, `optimizer5m`, `sr_optimizer1h`) rooted at
 * `process.cwd()`. All four of those directories are absent, nine of the
 * thirteen trees on disk had no route at all, and `fs.existsSync` guards turned
 * the missing dependency into an **empty leaderboard with HTTP 200**.
 *
 * The map is replaced by a registry each tree owns: every tree carries a
 * `tree.json` naming its strategy, timeframe, system, kind and status. This
 * module discovers them under a root that comes from `OPTIMIZER_ROOT` — or,
 * unset, from this file's own location rather than the working directory, so
 * resolution no longer depends on where the process was started.
 *
 * Callers get one of three honest answers, never an empty success:
 *   - a tree,
 *   - `null` with the list of ids that do exist (the route answers 404), or
 *   - a tree whose `results/` is empty, reported as such by `treeResults`.
 */
import fs from "node:fs";
import path from "node:path";

export type TreeKind = "search" | "walk-forward" | "holdout" | "replay";
export type TreeStatus = "current" | "historical" | "not-comparable";

export interface OptimizerTree {
  id: string;
  strategy: string;
  timeframe: string;
  system: string;
  kind: TreeKind;
  status: TreeStatus;
  label: string;
  note?: string;
  /** Absolute path to the tree directory. */
  dir: string;
  /** Cost model, read from the tree's own config.json (see docs/COST-MODELS.md). */
  cost: {
    initialCapital: number | null;
    commissionPct: number | null;
    slippageTicks: number | null;
    range: unknown;
    hasSplit: boolean;
  };
}

const KINDS: readonly TreeKind[] = ["search", "walk-forward", "holdout", "replay"];
const STATUSES: readonly TreeStatus[] = ["current", "historical", "not-comparable"];

/**
 * Where the trees live. `OPTIMIZER_ROOT` wins so a container can mount them
 * outside the source tree; otherwise this resolves from the compiled/loaded
 * module path (`<backend>/src/optimizer` or `<backend>/dist/optimizer`), which
 * is stable regardless of the process working directory.
 */
export function optimizerRoot(): string {
  const fromEnv = process.env.OPTIMIZER_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(__dirname, "..", "..");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface RawTree {
  id?: string; strategy?: string; timeframe?: string; system?: string;
  kind?: string; status?: string; label?: string; note?: string;
}

/**
 * A `tree.json` that is missing a required field, or names a kind/status this
 * code does not understand, is a registry defect — surface it rather than
 * silently dropping the tree, which is the failure mode X-04 describes.
 */
export class TreeRegistryError extends Error {}

function parseTree(dir: string, raw: RawTree): OptimizerTree {
  const id = path.basename(dir);
  const need = (field: keyof RawTree): string => {
    const v = raw[field];
    if (typeof v !== "string" || !v.trim()) {
      throw new TreeRegistryError(`${id}/tree.json: '${field}' is required`);
    }
    return v.trim();
  };
  if (raw.id && raw.id !== id) {
    throw new TreeRegistryError(`${id}/tree.json: id '${raw.id}' does not match its directory`);
  }
  const kind = need("kind") as TreeKind;
  if (!KINDS.includes(kind)) {
    throw new TreeRegistryError(`${id}/tree.json: unknown kind '${kind}'`);
  }
  const status = need("status") as TreeStatus;
  if (!STATUSES.includes(status)) {
    throw new TreeRegistryError(`${id}/tree.json: unknown status '${status}'`);
  }
  const cfg = readJson<{
    initialCapital?: number; commissionPct?: number; slippageTicks?: number;
    range?: { split?: string };
  }>(path.join(dir, "config.json"));
  return {
    id,
    strategy: need("strategy"),
    timeframe: need("timeframe"),
    system: need("system"),
    kind,
    status,
    label: need("label"),
    ...(raw.note ? { note: raw.note } : {}),
    dir,
    cost: {
      initialCapital: cfg?.initialCapital ?? null,
      commissionPct: cfg?.commissionPct ?? null,
      slippageTicks: cfg?.slippageTicks ?? null,
      range: cfg?.range ?? null,
      hasSplit: Boolean(cfg?.range?.split),
    },
  };
}

let cache: { root: string; trees: OptimizerTree[] } | null = null;

/** Every tree that owns a `tree.json` under the root, id-sorted. */
export function listTrees(root = optimizerRoot()): OptimizerTree[] {
  if (cache && cache.root === root) return cache.trees;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const trees: OptimizerTree[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const raw = readJson<RawTree>(path.join(dir, "tree.json"));
    if (!raw) continue;
    trees.push(parseTree(dir, raw));
  }
  trees.sort((a, b) => a.id.localeCompare(b.id));
  cache = { root, trees };
  return trees;
}

/** Drop the discovery cache. Tests and the dashboard exporter use this. */
export function resetRegistryCache(): void {
  cache = null;
}

export function treeById(id: string, root = optimizerRoot()): OptimizerTree | null {
  return listTrees(root).find((t) => t.id === id) ?? null;
}

export interface TreeQuery {
  tree?: string;
  strategy?: string;
  timeframe?: string;
  system?: string;
}

export interface Resolution {
  tree: OptimizerTree | null;
  /** Why nothing matched, phrased for an API response. Empty when `tree` is set. */
  reason: string;
  /** Ids the caller could have asked for, so a 404 is actionable. */
  candidates: string[];
}

/**
 * Resolve a query to exactly one tree.
 *
 * An explicit `tree` id is authoritative. Otherwise the strategy/timeframe/
 * system triple selects among the trees that serve a leaderboard (`kind:
 * "search"`); walk-forward, holdout and replay trees are reachable only by id
 * because they publish fold reports, not a `best/` leaderboard, and returning
 * one here is what made the UI look empty.
 */
export function resolveTree(q: TreeQuery, root = optimizerRoot()): Resolution {
  const trees = listTrees(root);
  const ids = trees.map((t) => t.id);
  if (q.tree) {
    const hit = trees.find((t) => t.id === q.tree);
    return hit
      ? { tree: hit, reason: "", candidates: ids }
      : { tree: null, reason: `no optimizer tree '${q.tree}' under ${root}`, candidates: ids };
  }
  const strategy = q.strategy ?? "ma_rr_v9";
  const timeframe = q.timeframe ?? "15m";
  const searchable = trees.filter((t) => t.kind === "search");
  let matches = searchable.filter((t) => t.strategy === strategy && t.timeframe === timeframe);
  if (q.system) matches = matches.filter((t) => t.system === q.system);
  if (matches.length === 1) return { tree: matches[0]!, reason: "", candidates: ids };
  if (matches.length === 0) {
    const forStrategy = searchable.filter((t) => t.strategy === strategy);
    const reason = forStrategy.length === 0
      ? `no optimizer tree is registered for strategy '${strategy}'`
      : `no optimizer tree is registered for strategy '${strategy}' at ${timeframe}` +
        (q.system ? ` in system '${q.system}'` : "");
    return {
      tree: null,
      reason,
      candidates: (forStrategy.length ? forStrategy : searchable).map((t) => t.id),
    };
  }
  return {
    tree: null,
    reason: `'${strategy}' at ${timeframe} matches ${matches.length} trees; ask for one by id`,
    candidates: matches.map((t) => t.id),
  };
}

export interface TreeResults {
  /** `best/` and `results/` both exist and `best/` holds at least one record. */
  hasResults: boolean;
  bestDir: string;
  resultsDir: string;
  /** Result files present, `.jsonl` only. Empty when the directory is absent. */
  resultFiles: string[];
}

/**
 * What a tree actually has on disk. The generated data is gitignored, so a
 * fresh checkout legitimately has none — that is reported as a tree with no
 * results yet, which is a different answer from "no such tree".
 */
export function treeResults(tree: OptimizerTree): TreeResults {
  const bestDir = path.join(tree.dir, "best");
  const resultsDir = path.join(tree.dir, "results");
  let resultFiles: string[] = [];
  try {
    resultFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    resultFiles = [];
  }
  let bestCount = 0;
  try {
    bestCount = fs.readdirSync(bestDir).filter((f) => f.endsWith(".json")).length;
  } catch {
    bestCount = 0;
  }
  return { hasResults: bestCount > 0, bestDir, resultsDir, resultFiles };
}
