/**
 * Every colour a component asks for must exist in the theme.
 *
 * FE-11 was one token — `warn` — used in three components and defined
 * nowhere. Tailwind emits no rule for an unknown token and no warning either,
 * so `text-warn` silently produced no colour and the OPEN TRADE badge rendered
 * as plain body text. Nothing failed; it just looked wrong, in the one place
 * that marks a position still holding risk.
 *
 * This scans the class names the components actually use rather than trusting
 * the config, because the failure is always in that direction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Colour token names declared in tailwind.config.ts. */
function themeTokens(): Set<string> {
  const config = fs.readFileSync(path.join(ROOT, "tailwind.config.ts"), "utf8");
  const block = config.slice(config.indexOf("colors: {"), config.indexOf("fontFamily"));
  const tokens = new Set<string>();
  for (const m of block.matchAll(
    /^\s*"?([a-z][a-z0-9-]*)"?:\s*(?:token\("[a-z0-9-]+"\)|"(?:#|rgb\())/gm
  )) tokens.add(m[1]!);
  return tokens;
}

/**
 * Utilities that take a colour token. `border` is excluded from the prefixes
 * because `border-2` and bare `border` are widths, and the token happens to be
 * called `border` too — it is matched explicitly instead.
 */
const PREFIXES = ["text", "bg", "border", "ring", "fill", "stroke", "divide", "from", "to", "via", "accent", "decoration", "outline", "shadow", "caret", "placeholder"];

/** Tailwind's own scales, which are always available and are not theme tokens. */
const BUILT_IN = new Set([
  "transparent", "current", "inherit", "black", "white", "auto", "none",
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow",
  "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet",
  "purple", "fuchsia", "pink", "rose",
]);

test("EVERY COLOUR TOKEN A COMPONENT USES IS DEFINED IN THE THEME", () => {
  const tokens = themeTokens();
  assert.ok(tokens.size >= 8, `expected the palette, parsed ${tokens.size} tokens`);

  const missing = new Map<string, string[]>();
  for (const file of [...sourceFiles(path.join(ROOT, "app")), ...sourceFiles(path.join(ROOT, "components"))]) {
    const source = fs.readFileSync(file, "utf8");
    for (const prefix of PREFIXES) {
      // `bg-surface-2/40`, `text-ink`, `border-down/30` — the token runs to the
      // opacity slash or the end of the class.
      const re = new RegExp(`(?:^|[\\s"'\`{])${prefix}-([a-z][a-z0-9-]*)(?:/\\d+)?(?=[\\s"'\`}]|$)`, "gm");
      for (const m of source.matchAll(re)) {
        const token = m[1]!;
        // `amber-400` is the `amber` scale at weight 400 — a built-in, not a
        // theme token. Theme tokens with a numeric suffix (`surface-2`) are
        // matched by the full name first.
        if (tokens.has(token) || BUILT_IN.has(token) || BUILT_IN.has(token.replace(/-\d+$/, ""))) continue;
        // Not a colour: sizing, layout and typography share these prefixes.
        if (/^(xs|sm|base|lg|xl|\d|left|right|center|top|bottom|clip|ellipsis|wrap|nowrap|balance|pretty|start|end|justify|solid|dashed|dotted|double|hidden|line|through|no|underline|overline|opacity|collapse|separate|spacing|1|2|4|8|0|y|x|b|t|l|r|inherit|current)/.test(token)) continue;
        const list = missing.get(token) ?? [];
        list.push(path.relative(ROOT, file));
        missing.set(token, list);
      }
    }
  }

  const report = [...missing].map(([t, files]) => `${t} (${[...new Set(files)].join(", ")})`);
  assert.deepEqual(report, [], `undefined colour tokens: ${report.join("; ")}`);
});

test("the manifest theme colour matches the page background", () => {
  // A mismatch paints mobile Safari's chrome a different near-black, so the
  // page appears to begin with a seam.
  const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
  const dark = css.match(/:root\s*\{[\s\S]*?--ts-bg:\s*(#[0-9a-f]{6})/i);
  const light = css.match(/:root\[data-theme="light"\]\s*\{[\s\S]*?--ts-bg:\s*(#[0-9a-f]{6})/i);
  const layout = fs.readFileSync(path.join(ROOT, "app", "layout.tsx"), "utf8");
  const manifest = [...layout.matchAll(/color:\s*"(#[0-9a-f]{6})"/gi)]
    .map((match) => match[1]!.toLowerCase());
  assert.ok(dark && light && manifest.length >= 2, "could not read both theme colours");
  assert.deepEqual(new Set(manifest), new Set([
    light![1]!.toLowerCase(), dark![1]!.toLowerCase(),
  ]));
});

test("warn is defined, and is neither the profit nor the loss colour", () => {
  // A position still holding risk is not a win and not a loss. Reusing either
  // hue would state an outcome that is not known yet.
  const config = fs.readFileSync(path.join(ROOT, "tailwind.config.ts"), "utf8");
  const read = (name: string): string =>
    config.match(new RegExp(`\\b${name}:\\s*token\\("([^"]+)"\\)`, "i"))![1]!.toLowerCase();
  const warn = read("warn");
  assert.notEqual(warn, read("up"));
  assert.notEqual(warn, read("down"));
});
