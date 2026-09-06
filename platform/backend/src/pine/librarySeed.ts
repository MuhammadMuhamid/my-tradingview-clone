/**
 * Installing the shipped Pine library, without overwriting anyone's work.
 *
 * ── What was wrong with the old seed ───────────────────────────────────────
 *
 * It was idempotent — `ON CONFLICT (lower(name)) DO UPDATE SET source = …` —
 * and that is exactly what made it destructive. A user who tuned "Bollinger
 * Bands", changed a default or added a plot, lost that work the next time the
 * library was seeded. Silently, with nothing to say it had happened.
 *
 * ── The rule now ───────────────────────────────────────────────────────────
 *
 * A shipped script is installed only when the stored copy is still the one
 * this platform put there:
 *
 *   absent                                     → install
 *   present, origin 'builtin', source == hash  → update (a version bump)
 *   present, origin 'builtin', source != hash  → SKIP; the user edited it
 *   present, origin 'user'                     → SKIP; it is not ours
 *
 * The hash is the source AS SHIPPED, stored alongside the row, so "has the
 * user edited this" is a comparison rather than a guess. A timestamp could not
 * answer it: a re-seed would look exactly like an edit.
 *
 * ── Where it runs ──────────────────────────────────────────────────────────
 *
 * `seedIndicatorLibrary()` is safe to call on every boot and does nothing on
 * the second and subsequent calls, which is what makes it appropriate for a
 * startup path rather than a manual step somebody has to remember after a
 * deploy. It compiles every script before writing it, because a library entry
 * that does not parse would otherwise sit in the picker and fail only when
 * someone puts it on a chart.
 */
import { createHash } from "node:crypto";
import { INDICATOR_LIBRARY } from "./library";
import { PineInterpreter } from "./interpreter";
import * as scripts from "../repositories/pineScripts";

/**
 * The library's version.
 *
 * Bumped by hand when a shipped script changes. It is recorded on every row
 * this seed writes, so a later build can say what an installation is running
 * rather than only that it differs.
 */
export const LIBRARY_VERSION = "1";

/** The identity of a source, for "is this still what we shipped". */
export function sourceHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 32);
}

export type SeedOutcome =
  | "installed"
  | "updated"
  | "unchanged"
  | "kept-user-edit"
  | "kept-user-script"
  | "compile-failed";

export interface SeedResult {
  name: string;
  outcome: SeedOutcome;
  detail?: string;
}

export interface SeedSummary {
  results: SeedResult[];
  installed: number;
  updated: number;
  unchanged: number;
  /** Scripts left alone because somebody had changed or authored them. */
  kept: number;
  failed: string[];
}

/**
 * Install or refresh the shipped library.
 *
 * Total: a script that fails to compile is reported and skipped rather than
 * aborting the run, because one bad entry must not stop the other twenty being
 * available — and on a startup path it must not stop the backend booting.
 */
export async function seedIndicatorLibrary(options: {
  dryRun?: boolean;
  log?: (message: string) => void;
} = {}): Promise<SeedSummary> {
  const log = options.log ?? (() => {});
  const existing = await scripts.listScripts();
  const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s]));

  const summary: SeedSummary = {
    results: [], installed: 0, updated: 0, unchanged: 0, kept: 0, failed: [],
  };

  for (const entry of INDICATOR_LIBRARY) {
    const { meta, errors } = PineInterpreter.compile(entry.source);
    if (errors.length > 0) {
      const detail = errors[0]!.message;
      summary.results.push({ name: entry.name, outcome: "compile-failed", detail });
      summary.failed.push(`${entry.name}: ${detail}`);
      log(`  SKIP  ${entry.name} — ${detail}`);
      continue;
    }

    const hash = sourceHash(entry.source);
    const stored = byName.get(entry.name.trim().toLowerCase());

    if (!stored) {
      if (!options.dryRun) {
        await scripts.upsertBuiltinScript({
          name: entry.name, source: entry.source, kind: meta.kind,
          builtinVersion: LIBRARY_VERSION, builtinHash: hash,
        });
      }
      summary.installed += 1;
      summary.results.push({ name: entry.name, outcome: "installed" });
      log(`  new   ${entry.name}`);
      continue;
    }

    if (stored.origin !== "builtin") {
      // Somebody wrote or imported a script under this name. It is theirs.
      summary.kept += 1;
      summary.results.push({
        name: entry.name, outcome: "kept-user-script",
        detail: "a script of this name was written or imported here",
      });
      log(`  keep  ${entry.name} — not installed by the library`);
      continue;
    }

    if (stored.builtinHash !== null && sourceHash(stored.source) !== stored.builtinHash) {
      // The stored source is no longer what we put there.
      summary.kept += 1;
      summary.results.push({
        name: entry.name, outcome: "kept-user-edit",
        detail: `edited since it was installed by library version ${stored.builtinVersion ?? "?"}`,
      });
      log(`  keep  ${entry.name} — edited since install`);
      continue;
    }

    if (stored.builtinHash === hash && stored.builtinVersion === LIBRARY_VERSION) {
      summary.unchanged += 1;
      summary.results.push({ name: entry.name, outcome: "unchanged" });
      continue;
    }

    if (!options.dryRun) {
      await scripts.upsertBuiltinScript({
        name: entry.name, source: entry.source, kind: meta.kind,
        builtinVersion: LIBRARY_VERSION, builtinHash: hash,
      });
    }
    summary.updated += 1;
    summary.results.push({ name: entry.name, outcome: "updated" });
    log(`  up    ${entry.name} → library ${LIBRARY_VERSION}`);
  }

  return summary;
}
