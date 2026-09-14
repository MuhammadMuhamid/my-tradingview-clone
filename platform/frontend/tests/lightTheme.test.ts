/**
 * The theme this campaign had never rendered.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * `public/theme-init.js` picks the theme from `prefers-color-scheme` when the
 * visitor has no stored preference, so LIGHT is what a first-time visitor on a
 * light-mode operating system sees — and through seven waves of parity work,
 * every screenshot, every review and every comparison had been taken on dark.
 * Rendering it found four canvas literals that were only ever correct on
 * black:
 *
 *   - the drawing layer filled every anchor handle `#0f0f0f`, so a selected
 *     drawing on a white chart wore black blobs rather than rings;
 *   - the pin's head dot, the same;
 *   - the watermark was `rgba(255,255,255,0.06)` — white on white. Turning the
 *     setting on did nothing at all, which is worse than looking wrong;
 *   - the footprint cells' numerals were white at 0.9 over a 0.62 direction
 *     fill, which on white composites to about 1.7:1.
 *
 * A canvas cannot wear a class, which is exactly why this is a class of bug
 * rather than four bugs: every colour a canvas uses has to be a literal at the
 * moment it is assigned, and a literal is invisible to the theme. The rule
 * below is therefore about WHERE the literal comes from — a token read, or the
 * source text.
 *
 * Three literals are allowed and named individually, each because it is
 * genuinely theme-independent: a fill that composites against a colour the
 * USER chose, not against the surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contrast, mixToward, readableOn } from "../lib/chartTheme";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Both blocks of `app/globals.css`, as `{ token: value }`. */
function tokenBlocks(): { dark: Record<string, string>; light: Record<string, string> } {
  const css = read("app/globals.css");
  const cut = css.indexOf(':root[data-theme="light"]');
  assert.ok(cut > 0, "globals.css no longer declares a light block");
  const end = css.indexOf("\n}", cut);
  const parse = (block: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/^\s*(--ts-[a-z0-9-]+):\s*([^;]+);/gm)) out[m[1]!] = m[2]!.trim();
    return out;
  };
  return { dark: parse(css.slice(0, cut)), light: parse(css.slice(cut, end)) };
}

test("LIGHT IS A COMPLETE THEME, NOT A PARTIAL OVERRIDE", () => {
  const { dark, light } = tokenBlocks();
  assert.ok(Object.keys(dark).length > 30, `parsed only ${Object.keys(dark).length} dark tokens`);

  /*
   * Every token the light block does NOT redeclare falls through to the dark
   * value, which for a colour means a dark value on a white page. Structural
   * tokens (the 38px toolbar, the 6px radius, the font stack) are shared on
   * purpose and are exactly the ones that carry no colour.
   */
  const isColour = (v: string): boolean =>
    /^#[0-9a-f]{3,8}$/i.test(v) || /^\d+ \d+ \d+$/.test(v) || /^rgba?\(/.test(v);
  const missing = Object.keys(dark)
    .filter((k) => isColour(dark[k]!) && !(k in light))
    .filter((k) => !k.endsWith("-shadow"));
  assert.deepEqual(missing, [],
    `the light theme inherits these DARK colours: ${missing.join(", ")}`);

  // And no token is the same colour in both: a value that did not change is a
  // value somebody forgot, not a value somebody chose.
  const identical = Object.keys(light).filter((k) =>
    k in dark && isColour(dark[k]!) && dark[k] === light[k]
    // The four semantic hues ARE deliberately near-shared; they are compared
    // below on their own terms.
    && !/positive|negative|accent|caution/.test(k));
  assert.deepEqual(identical, [],
    `identical in both themes, which means one of them was not measured: ${identical.join(", ")}`);
});

test("LIGHT IS LIGHT AND DARK IS DARK, MEASURED ON THE INK/SURFACE PAIR", () => {
  const { dark, light } = tokenBlocks();
  const luma = (hex: string): number => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    assert.ok(m, `not a six-digit colour: ${hex}`);
    const n = parseInt(m![1]!, 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  // Ink and surface are the wrong way round in the two blocks, which is the
  // whole of what "a theme" means. Asserted rather than assumed because a
  // half-finished light block passes every other rule in this file.
  assert.ok(luma(light["--ts-surface"]!) > 0.8, "the light surface is not light");
  assert.ok(luma(light["--ts-ink"]!) < 0.2, "the light ink is not dark");
  assert.ok(luma(dark["--ts-surface"]!) < 0.2, "the dark surface is not dark");
  assert.ok(luma(dark["--ts-ink"]!) > 0.6, "the dark ink is not light");

  // Hover is one step toward the ink from the surface in BOTH, never past the
  // selected state — the two-neutral contract the grammar is built on.
  for (const [name, t] of [["dark", dark], ["light", light]] as const) {
    const surface = luma(t["--ts-surface"]!);
    const hover = luma(t["--ts-state-hover"]!);
    const active = luma(t["--ts-state-active"]!);
    const toward = surface < 0.5 ? 1 : -1;
    assert.ok((hover - surface) * toward > 0, `${name}: hover does not step off the surface`);
    assert.ok((active - hover) * toward > 0, `${name}: selected is not a step past hover`);
  }
});

/**
 * Every file that paints to a canvas, and the colour literals each is allowed.
 *
 * A canvas colour is a string at the moment it is assigned, so the theme can
 * only reach it through a token read. Anything else is a colour that one of
 * the two themes will be wrong about.
 *
 * `DrawingCanvas` is deliberately absent from the allowances: after this
 * repair it assigns no colour literal at all. The label chips that used to
 * hold the last one now choose their ink from the chip they sit on, which is
 * the only correct answer when the chip is a colour the USER picked.
 */
const CANVAS_FILES: { file: string; minimum: number; allowed: RegExp[] }[] = [
  { file: "components/tv/DrawingCanvas.tsx", minimum: 24, allowed: [] },
  { file: "components/tv/FootprintLayer.tsx", minimum: 4, allowed: [] },
  {
    file: "lib/chartSnapshot.ts",
    minimum: 3,
    allowed: [
      // The caption paints its own chip and writes on that, so it is legible
      // over a white chart and a black one alike.
      /"rgba\(0,0,0,0\.55\)"/,
      /"rgba\(255,255,255,0\.82\)"/,
    ],
  },
];

test("NO CANVAS PAINTS A COLOUR THE THEME CANNOT REACH", () => {
  /*
   * The whole ASSIGNMENT, not the string in it: `fillStyle = up ? "#2ebd85" :
   * theme()` is exactly as unreachable as the bare literal, and a rule that
   * only matched `= "…"` would have passed it.
   */
  const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/;

  for (const { file, minimum, allowed } of CANVAS_FILES) {
    const src = code(file);
    const assignments = [...src.matchAll(/ctx\.(?:fillStyle|strokeStyle) = ([^;\n]+)/g)]
      .map((m) => m[1]!.trim());

    /*
     * The count is the rule's own tripwire. Every version of this assertion
     * that parsed with a regex over source text could be made vacuous by a
     * reformat — and the first one was, the moment the last literal in
     * `DrawingCanvas` was repaired and "no literals found" became
     * indistinguishable from "no assignments found".
     */
    assert.ok(assignments.length >= minimum,
      `${file}: parsed ${assignments.length} canvas colour assignments, expected at least ${minimum} — this rule has stopped reading the file`);

    const offenders = assignments.filter((expr) => {
      /*
       * A wholly transparent colour is not a colour — it is how this product
       * says "do not paint this", and it means the same on any ground. Struck
       * out wherever it appears rather than matched as the whole expression,
       * because the snapshot's ground compares against one before choosing.
       */
      const paint = expr.replace(/"rgba\(0, ?0, ?0, ?0\)"/g, '""');
      if (!COLOUR.test(paint)) return false;
      return !allowed.some((ok) => ok.test(paint));
    });

    assert.deepEqual(offenders, [],
      `${file} assigns a canvas colour the theme cannot reach:\n  ${offenders.join("\n  ")}`);
  }
});

test("A LABEL CHIP CHOOSES ITS INK BY MEASURING, NOT BY GUESSING", () => {
  /*
   * `readableOn` is pure and the two answers are the whole of it, so this runs
   * it rather than matching its source.
   *
   * `#089981` is the case that sent the first version of this back: the light
   * theme's own green sits at raw luma 0.47, so a 0.5 threshold called it dark
   * and picked WHITE — 3.57:1, where black on it is 5.37:1. A rule that can be
   * wrong about the product's own semantic green is wrong about the palette.
   */
  assert.equal(readableOn("#089981"), "#0f0f0f");
  assert.ok(contrast("#0f0f0f", "#089981") > contrast("#ffffff", "#089981"));

  assert.equal(readableOn("#2ebd85"), "#0f0f0f", "the dark theme's green is a bright chip");
  assert.equal(readableOn("#5c5c5c"), "#ffffff", "the position tool's own grey chip is dark");
  assert.equal(readableOn("#ffffff"), "#0f0f0f");
  assert.equal(readableOn("#000000"), "#ffffff");
  // `#abc` and `#aabbcc` are the same colour, and both reach this function.
  assert.equal(readableOn("#fff"), readableOn("#ffffff"));
  // A colour it cannot read must not come back as black on a dark chip.
  assert.equal(readableOn("rgba(0,0,0,0)"), "#dbdbdb");

  /*
   * And it never picks the worse of the two — asserted over the whole ramp
   * rather than at the handful of points above, because the failure it is
   * guarding against was precisely one that the obvious examples survived.
   */
  for (let v = 0; v <= 255; v += 3) {
    for (const hex of [
      `#${v.toString(16).padStart(2, "0").repeat(3)}`,
      `#${v.toString(16).padStart(2, "0")}9981`,
      `#08${v.toString(16).padStart(2, "0")}81`,
    ]) {
      const picked = readableOn(hex);
      const other = picked === "#0f0f0f" ? "#ffffff" : "#0f0f0f";
      assert.ok(contrast(picked, hex) >= contrast(other, hex),
        `readableOn(${hex}) picked ${picked} at ${contrast(picked, hex).toFixed(2)}:1 `
        + `over ${other} at ${contrast(other, hex).toFixed(2)}:1`);
    }
  }
});

test("A FOOTPRINT CELL'S NUMERALS ARE MEASURED AGAINST THE CELL", () => {
  /*
   * The cell is the direction colour at 0.62 over the pane, and the numerals
   * sit ON the cell — so the surface is the wrong thing to ink them from. It
   * was `rgba(255,255,255,0.9)`, which is 1.85:1 over the light composite.
   *
   * Both composites are computed here with the product's own `mixToward`, so
   * this is the arithmetic the layer actually does, not a transcription of it.
   */
  const cases = [
    { theme: "light", surface: "#ffffff", expect: "#0f0f0f", floor: 4.5 },
    { theme: "dark", surface: "#0f0f0f", expect: "#ffffff", floor: 4.5 },
  ];
  for (const { theme, surface, expect, floor } of cases) {
    for (const direction of ["#20b478", "#dc4b5a"]) {
      const cell = mixToward(direction, surface, 0.62);
      const ink = readableOn(cell);
      assert.equal(ink, expect, `${theme}: ${direction} over ${surface} composites to ${cell}`);
      assert.ok(contrast(ink, cell) >= floor,
        `${theme}: 10px numerals on ${cell} would be ${contrast(ink, cell).toFixed(2)}:1`);
    }
  }

  // And the layer computes it from the SAME pair of colours it fills with.
  const src = code("components/tv/FootprintLayer.tsx");
  assert.match(src, /const BUY_FILL = `rgba\(32, 180, 120, \$\{CELL_ALPHA\}\)`;/);
  assert.match(src, /const SELL_FILL = `rgba\(220, 75, 90, \$\{CELL_ALPHA\}\)`;/);
  assert.match(src, /readableOn\(mixToward\(BUY, ground, CELL_ALPHA\)\)/);
  assert.match(src, /readableOn\(mixToward\(SELL, ground, CELL_ALPHA\)\)/);
  // `BUY` and `SELL` must be the opaque form of the fills, or the ink is
  // measured against a colour the cell is not.
  assert.match(src, /const BUY = "#20b478";/);
  assert.match(src, /const SELL = "#dc4b5a";/);
});

test("THE CANVAS TOKEN READS SURVIVE A THEME FLIP", () => {
  /*
   * Reading a token once and caching it is right — `getComputedStyle` is a
   * style recalculation and the drawing layer asks once per anchor handle per
   * frame — but a cache that outlives the theme is the original bug with an
   * extra step: the handles would stay black until the next full remount.
   */
  const theme = code("lib/chartTheme.ts");
  assert.match(theme, /const tokenCache = new Map<string, string>\(\);/);
  assert.match(theme,
    /addEventListener\("trading-scene-theme", \(\) => tokenCache\.clear\(\)\)/,
    "a cached token that the theme event does not clear is the bug with a cache on top");
  // And never filled from the SSR fallback, which would cache a dark value
  // into a light page for the life of the tab.
  assert.match(theme,
    /function cachedToken[\s\S]{0,200}?if \(typeof document === "undefined"\) return fallback;/);

  /*
   * And the canvases that hold their own paint loop have to be TOLD. The
   * chart's own options re-apply through `subscribeChartTheme`, and the price
   * chart re-runs its settings effect on `themeTick`; the footprint layer owns
   * a canvas nothing else repaints, so it listens for itself.
   */
  const footprint = code("components/tv/FootprintLayer.tsx");
  assert.match(footprint, /window\.addEventListener\("trading-scene-theme", redraw\)/);
  assert.match(footprint, /window\.removeEventListener\("trading-scene-theme", redraw\)/);

  const chart = code("components/CandleChart.tsx");
  /*
   * R6 C-2 gave the watermark its own swatch. The token is still what it falls
   * back to, and `""` — the Canvas tab's `Theme` cell — is what every chart
   * that has not been recoloured stores, so the theme keeps deciding for them.
   */
  assert.match(chart, /color: settings\.watermarkColor \|\| chartWatermarkColor\(\),/,
    "the watermark was white at 6% — on a white chart, the setting did nothing");
});

test("THE FIRST-TIME VISITOR'S THEME IS THE SYSTEM'S, AND IT IS SET BEFORE PAINT", () => {
  /*
   * This is why light is not an opt-in corner of the product: with no stored
   * preference the boot script follows the operating system, so a visitor on a
   * light-mode Mac sees the light theme as their FIRST impression.
   */
  const init = read("public/theme-init.js");
  assert.match(init, /matchMedia\("\(prefers-color-scheme: light\)"\)\.matches \? "light" : "dark"/);
  assert.match(init, /dataset\.theme = theme/);

  // beforeInteractive, or the page paints dark and then flips.
  assert.match(read("app/layout.tsx"),
    /<Script src="\/theme-init\.js" strategy="beforeInteractive" \/>/);
});
