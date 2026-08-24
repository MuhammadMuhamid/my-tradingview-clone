/**
 * The frontend's XSS posture rests on having no HTML or script sinks at all —
 * the audit recorded zero `dangerouslySetInnerHTML`, `innerHTML`, `eval` and
 * `new Function` across the tree, and the CSP in `next.config.mjs` documents
 * that as the actual control, because Next's inline bootstrap forces
 * `'unsafe-inline'` on script-src.
 *
 * This test makes that an enforced invariant rather than a snapshot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCAN_DIRS = ["app", "components", "lib", "public"];
const SKIP = new Set(["node_modules", ".next", "tests"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped first. Two files legitimately name `javascript:` in
 * prose — the redirect validator that rejects it and the login page that
 * explains why — and a scanner that cannot tell code from a comment would
 * force those explanations to be deleted.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /dangerouslySetInnerHTML/, why: "renders unescaped HTML" },
  { pattern: /\.innerHTML\s*=/, why: "renders unescaped HTML" },
  { pattern: /\.outerHTML\s*=/, why: "renders unescaped HTML" },
  { pattern: /\beval\s*\(/, why: "executes a string as code" },
  { pattern: /new\s+Function\s*\(/, why: "executes a string as code" },
  { pattern: /document\.write\s*\(/, why: "renders unescaped HTML" },
  { pattern: /\bjavascript:/, why: "a script-scheme URL is a script sink" },
];

test("no HTML or script sink exists anywhere in the frontend", () => {
  const files = SCAN_DIRS.flatMap((d) => {
    try { return walk(join(ROOT, d)); } catch { return []; }
  });
  assert.ok(files.length > 20, `expected to scan the tree, found ${files.length} files`);

  const hits: string[] = [];
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(text)) {
        hits.push(`${file.slice(ROOT.length + 1)} matches ${pattern} — ${why}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("no NEXT_PUBLIC_ variable is introduced — nothing from the server belongs in the bundle", () => {
  const files = SCAN_DIRS.flatMap((d) => {
    try { return walk(join(ROOT, d)); } catch { return []; }
  });
  const hits = files.filter((f) => /NEXT_PUBLIC_/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => f.slice(ROOT.length + 1)), []);
});
