/**
 * A thrown cause is never rendered as page copy. (REV-UX-01, tree-wide.)
 *
 * ── What this test is, honestly ───────────────────────────────────────────
 *
 * A SOURCE SCANNER, with the limits that implies. It cannot see a rendered
 * page, and it cannot follow a cause through a helper. The rule's behavioural
 * coverage is `tests/dom/providerFailureCopy.test.tsx`, which mounts the chart
 * against a refusing provider and reads the DOM.
 *
 * What it CAN do, and what the behavioural test cannot, is cover the whole
 * tree at once. REV-UX-01 was found on the chart; the sweep that followed
 * found the same shape in eleven more places — a Trading-page `Notice`, an
 * Alerts banner, the system-health menu, five layout failures, a correlation
 * row, the symbol search, two forms and an alert modal. Every one of them was
 * written by somebody who had not read the chart's rule. A scanner is the only
 * thing that makes the twelfth one fail in CI rather than in front of a user.
 *
 * ── The shape it looks for ────────────────────────────────────────────────
 *
 * A JSX child that is a bare error-state identifier — `>{err}<` — on an
 * element that does not also carry `title=`, IN A FILE THAT ALSO ASSIGNS A
 * THROWN CAUSE to that state. That is exactly the shape every site in the
 * sweep had, and the repaired form (headline visible, cause in `title`) is
 * exactly what clears it.
 *
 * The last clause is what keeps this honest in the other direction, and it
 * took two goes. A component whose error state only ever holds sentences it
 * wrote itself — `CompareControl`'s "Enter a symbol like BTCUSDT." — has
 * nothing to hide and is not a finding; flagging it would have forced a
 * `title` with nothing to put in it, which is how a rule stops meaning
 * anything. Nor is a per-field validation PROP named `error`, which is why the
 * name must be one this file declares with `useState`: `ManualTradingPanel`
 * has both, twelve hundred lines apart, and only one of them is a cause.
 *
 * A site that is safe BY CONSTRUCTION is allowlisted below with the reason,
 * because a scanner with no exits gets disabled the first time it is wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];
const SKIP = new Set(["node_modules", ".next", "tests"]);

/** State names that, across this tree, hold a thrown cause. */
const CAUSE_NAMES = /^(err|error|actionError|lastError|shariahError|treesError|loadError)$/;

/**
 * Sites where the value is provably NOT a raw cause. Each needs a reason; a
 * site is not allowlisted because repairing it was inconvenient.
 */
const ALLOWED = new Map<string, string>([
  ["app/login/page.tsx",
    "throws `body.error ?? \"Sign-in failed\"` from its own fetch — never a status line"],
  ["app/error.tsx",
    "the framework's own error boundary; the message is all the reader has"],
  ["app/global-error.tsx",
    "the framework's own error boundary; the message is all the reader has"],
  ["components/tv/PineEditor.tsx",
    "a compile diagnostic about the reader's OWN script — their content, not our plumbing"],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/** The opening tag this JSX child sits inside, or "" if none is near. */
function enclosingTag(text: string, at: number): string {
  const open = text.lastIndexOf("<", at);
  if (open < 0) return "";
  const close = text.indexOf(">", open);
  if (close < 0 || close > at) return text.slice(open, at);
  return text.slice(open, close + 1);
}

test("REV-UX-01 — no thrown cause is rendered as a bare JSX child", () => {
  const offenders: string[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");

      /* Does anything in this file put a thrown cause into a state at all? */
      const carriesCause = /\((?:e|err|error|cause|reason) as Error\)\.message|instanceof Error \? \w+\.message/
        .test(text);
      if (!carriesCause) continue;

      /* The names this file actually holds state under — not its props. */
      const stateNames = new Set(
        [...text.matchAll(/const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*set[\w$]*\s*\]\s*=\s*useState/g)]
          .map((d) => d[1]!));

      for (const m of text.matchAll(/>\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*</g)) {
        const name = m[1]!;
        if (!CAUSE_NAMES.test(name) || !stateNames.has(name)) continue;
        const tag = enclosingTag(text, m.index!);
        if (/\btitle=/.test(tag)) continue;
        const line = text.slice(0, m.index!).split("\n").length;
        offenders.push(`${rel}:${line} renders {${name}} with no title= on its element`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    `a thrown cause is being shown to a reader as prose:\n  ${offenders.join("\n  ")}`);
});

test("REV-UX-01 — the scanner still reaches the tree it claims to scan", () => {
  /*
   * The tripwire on the tripwire. A scan that walks an empty list, or whose
   * pattern has stopped matching the way this tree writes JSX, passes the test
   * above for the one reason that proves nothing.
   */
  let files = 0;
  let jsxChildren = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      files += 1;
      jsxChildren += [...readFileSync(file, "utf8")
        .matchAll(/>\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*</g)].length;
    }
  }
  assert.ok(files >= 100, `only ${files} .tsx files scanned — the walk has stopped reading`);
  assert.ok(jsxChildren >= 50,
    `only ${jsxChildren} bare JSX identifier children matched — the pattern has stopped reading`);
});
