/**
 * Accessibility and small-screen regressions that are cheap to reintroduce.
 *
 * These are static checks over the source, not a rendered-DOM audit — there is
 * no browser in this test environment and claiming otherwise would be worse
 * than checking less. What they cover is the specific set of defects Phase 6
 * fixed, each of which is invisible in review and silent at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

function sourceFiles(dir: string, ext = /\.tsx$/): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, ext));
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

const allTsx = (): string[] =>
  [...sourceFiles(path.join(ROOT, "app")), ...sourceFiles(path.join(ROOT, "components"))];

const rel = (f: string): string => path.relative(ROOT, f);

// ── Error boundaries ────────────────────────────────────────────────────────

test("FE-08: the route, root and not-found boundaries all exist", () => {
  for (const file of ["error.tsx", "global-error.tsx", "not-found.tsx"]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, "app", file)),
      `app/${file} is missing — a render error would blank the page again`
    );
  }
});

test("the route boundary offers recovery rather than only reporting", () => {
  const source = fs.readFileSync(path.join(ROOT, "app", "error.tsx"), "utf8");
  assert.match(source, /reset/, "no way to re-render without a full reload");
  // A user of a trading system asks one question first when a page breaks.
  assert.match(source, /no orders were affected|nothing was sent/i);
});

// ── Keyboard ────────────────────────────────────────────────────────────────

test("KEYBOARD FOCUS IS VISIBLE", () => {
  // Tailwind's preflight removes the browser outline. Without a replacement,
  // tabbing moves an invisible cursor across controls, one of which starts
  // live trading.
  const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
  assert.doesNotMatch(
    css, /^\s*\*\s*\{\s*outline:\s*none/m,
    "a blanket outline reset would undo this"
  );
});

test("a skip link exists and points at a real target", () => {
  const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  const layout = fs.readFileSync(path.join(ROOT, "app", "layout.tsx"), "utf8");
  assert.match(css, /\.skip-link/);
  assert.match(css, /\.skip-link:focus/, "a skip link that never becomes visible is not one");
  assert.match(layout, /className="skip-link"/);
  const target = layout.match(/href="#([\w-]+)"/)?.[1];
  assert.ok(target, "the skip link has no fragment target");
  assert.match(layout, new RegExp(`id="${target}"`), `nothing on the page has id="${target}"`);
});

test("the dialog component keeps its keyboard and screen-reader contract", () => {
  const modal = fs.readFileSync(path.join(ROOT, "components", "Modal.tsx"), "utf8");
  for (const required of [/role="dialog"/, /aria-modal="true"/, /aria-labelledby/, /"Escape"/, /"Tab"/]) {
    assert.match(modal, required, `Modal.tsx no longer has ${required}`);
  }
  // Every dialog in the application renders through this one component, so a
  // second hand-rolled overlay would silently miss all of the above.
  const rogue = allTsx().filter((f) =>
    !f.endsWith("Modal.tsx") &&
    /className="fixed inset-0 z-50/.test(fs.readFileSync(f, "utf8"))
  );
  assert.deepEqual(rogue.map(rel), [], "a dialog is being built outside Modal.tsx");
});

test("reduced motion is respected", () => {
  const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

// ── Small screens ───────────────────────────────────────────────────────────

test("EVERY WIDE TABLE SCROLLS IN ITS OWN CONTAINER, NOT THE PAGE", () => {
  // `w-full` inside `overflow-x-auto` is not enough: the table shrinks to the
  // viewport and wraps every cell instead of scrolling. The minimum width is
  // what makes the container do its job.
  const problems: string[] = [];
  for (const file of allTsx()) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/<table\b[^>]*className="([^"]*)"/g)) {
      const classes = m[1]!;
      const line = source.slice(0, m.index).split("\n").length;
      const before = source.slice(Math.max(0, m.index - 400), m.index);
      // An absolutely-positioned overlay is not in page flow and cannot make
      // the page scroll sideways; it is capped by max-width instead.
      if (/\babsolute\b/.test(before) && /max-w-/.test(before)) continue;
      if (!/overflow-x-auto/.test(before)) {
        problems.push(`${rel(file)}:${line} is not inside an overflow-x-auto container`);
      } else if (/w-full/.test(classes) && !/min-w-/.test(classes)) {
        problems.push(`${rel(file)}:${line} is w-full with no min-w — it will squash, not scroll`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the viewport allows pinch-zoom", () => {
  // Locking zoom on a chart application takes away the only way to read a
  // dense axis on a phone, and it is a WCAG failure besides.
  const layout = fs.readFileSync(path.join(ROOT, "app", "layout.tsx"), "utf8");
  assert.match(layout, /width:\s*"device-width"/);
  const max = layout.match(/maximumScale:\s*(\d+)/);
  assert.ok(max && Number(max[1]) >= 2, "maximumScale must allow real zoom");
  assert.doesNotMatch(layout, /userScalable:\s*false/);
});

test("THE iOS ZOOM RULE IS SPECIFIC ENOUGH TO ACTUALLY APPLY", () => {
  // Safari zooms any focused input whose text is under 16px and never zooms
  // back out, leaving the page scrolled sideways with the toolbar off-screen.
  //
  // This assertion is about SPECIFICITY, not presence, because the rule was
  // present and did nothing: `input, select, textarea` is (0,0,1) and loses to
  // Tailwind's `.text-sm` at (0,1,0) on every field in the application. It
  // measured 14px on an iPhone 13 viewport while this file happily asserted the
  // rule existed. Two `:not()` clauses raise it to (0,2,1), which wins.
  //
  // The real check is `qa/viewports.mjs`, which measures the computed size in a
  // browser. This one exists so a future edit back to the weak form fails here
  // rather than silently on someone's phone.
  const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  const block = css.match(/@media \(max-width: 640px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(block, /font-size: 16px/, "the rule is gone");
  const selector = block.slice(0, block.indexOf("font-size: 16px"));
  const notCount = (selector.match(/:not\(/g) ?? []).length;
  assert.ok(
    notCount >= 2,
    `the selector has ${notCount} :not() clauses; it needs at least two to outrank a utility class`
  );
  assert.match(selector, /input:not/, "inputs are what Safari zooms for");
});

// ── Names ───────────────────────────────────────────────────────────────────

test("a control with no text has an accessible name", () => {
  const problems: string[] = [];
  for (const file of allTsx()) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/<button\b([\s\S]*?)>([\s\S]*?)<\/button>/g)) {
      const [, attrs, body] = m;
      if (/aria-label|aria-labelledby|title=/.test(attrs!)) continue;
      const text = body!
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/<svg[\s\S]*?<\/svg>/g, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      // A `{expression}` child may well render text; this check only catches
      // buttons whose visible content is literally nothing but an icon.
      if (text.length > 0) continue;
      problems.push(`${rel(file)}:${source.slice(0, m.index).split("\n").length}`);
    }
  }
  assert.deepEqual(problems, [], "icon-only buttons with no aria-label or title");
});
