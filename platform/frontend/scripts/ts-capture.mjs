#!/usr/bin/env node
/**
 * Trading Scene live capture — the local half of the parity pair.
 *
 * Opens the REAL running product (default http://127.0.0.1:3000) in a
 * dedicated, persistent Chrome profile — the same profile the project's
 * `playwright-ts` MCP target uses, and never the TradingView one — at a fixed
 * viewport and theme, optionally performs a scripted interaction, then writes
 * a screenshot and, if asked, measured geometry for a list of selectors.
 *
 *   node scripts/ts-capture.mjs --out shell.png
 *   node scripts/ts-capture.mjs --route /chart --theme light --viewport 390x844 --out phone.png
 *   node scripts/ts-capture.mjs --click 'button[aria-label="Indicators"]' --out indicators.png
 *   node scripts/ts-capture.mjs --press / --out symbol-search.png
 *   node scripts/ts-capture.mjs --measure '[role="toolbar"]' --measure '[data-drawing-rail]' --json geometry.json
 *   node scripts/ts-capture.mjs --script ./actions.mjs --out after.png   # export default async (page) => {...}
 *
 * Every option is repeatable where it makes sense (`--click`, `--hover`,
 * `--press`, `--type sel=text`, `--wait ms`, `--measure`), applied in the
 * order given. Nothing here reaches the internet; the profile is created on
 * first use under ~/Library/Caches/ms-playwright/trading-scene.
 */
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const PROFILE = resolve(homedir(), "Library/Caches/ms-playwright/trading-scene");
const HERE = dirname(fileURLToPath(import.meta.url));
/** `.next/BUILD_ID` beside this script — what `next start` in this checkout serves. */
const readBuildId = () => { try { return readFileSync(resolve(HERE, "../.next/BUILD_ID"), "utf8").trim(); } catch { return null; } };
const args = process.argv.slice(2);
const opt = { base: "http://127.0.0.1:3000", route: "/chart", theme: "dark", viewport: "1440x900",
  out: null, json: null, script: null, steps: [], measure: [], settle: 1500, head: process.env.HEADED === "1", full: false };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i]; const v = () => args[++i];
  if (a === "--base") opt.base = v();
  else if (a === "--route") opt.route = v();
  else if (a === "--url") { const u = new URL(v()); opt.base = u.origin; opt.route = u.pathname + u.search; }
  else if (a === "--theme") opt.theme = v();
  else if (a === "--viewport") opt.viewport = v();
  else if (a === "--out") opt.out = v();
  else if (a === "--json") opt.json = v();
  else if (a === "--script") opt.script = v();
  else if (a === "--settle") opt.settle = Number(v());
  else if (a === "--full") opt.full = true;
  else if (a === "--headed") opt.head = true;
  else if (a === "--click") opt.steps.push({ kind: "click", target: v() });
  else if (a === "--right-click") opt.steps.push({ kind: "rightclick", target: v() });
  else if (a === "--hover") opt.steps.push({ kind: "hover", target: v() });
  else if (a === "--press") opt.steps.push({ kind: "press", key: v() });
  else if (a === "--type") { const [sel, ...rest] = v().split("="); opt.steps.push({ kind: "type", target: sel, text: rest.join("=") }); }
  else if (a === "--wait") opt.steps.push({ kind: "wait", ms: Number(v()) });
  else if (a === "--measure") opt.measure.push(v());
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
const [width, height] = opt.viewport.split("x").map(Number);

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome", headless: !opt.head, viewport: { width, height }, deviceScaleFactor: 1,
  colorScheme: opt.theme === "light" ? "light" : "dark",
  args: ["--hide-scrollbars"],
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  // The product persists its theme choice; state it explicitly so a capture is
  // never on whatever the last run left behind.
  await page.addInitScript((theme) => { try { localStorage.setItem("trading-scene-theme", theme); } catch {} }, opt.theme);
  await page.goto(opt.base + opt.route, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(opt.settle);
  if (opt.script) {
    const mod = await import(resolve(opt.script));
    await mod.default(page);
  }
  for (const step of opt.steps) {
    if (step.kind === "click") await page.locator(step.target).first().click();
    else if (step.kind === "rightclick") await page.locator(step.target).first().click({ button: "right" });
    else if (step.kind === "hover") await page.locator(step.target).first().hover();
    else if (step.kind === "press") await page.keyboard.press(step.key);
    else if (step.kind === "type") await page.locator(step.target).first().fill(step.text);
    else if (step.kind === "wait") await page.waitForTimeout(step.ms);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400);
  const result = {
    head: null, url: page.url(), viewport: { width, height }, theme: opt.theme, capturedAt: new Date().toISOString(),
    // The build the SERVER is running, not the one on disk: a production
    // `next start` serves `/_next/static/<BUILD_ID>/_buildManifest.js`.
    buildId: await page.evaluate(() => [...document.scripts].map((s) => s.src.match(/\/_next\/static\/([^/]+)\/_(?:build|ssg)Manifest\.js/)?.[1]).find(Boolean)
      ?? null),
    diskBuildId: readBuildId(),
    measured: {},
  };
  for (const sel of opt.measure) {
    result.measured[sel] = await page.evaluate((s) => [...document.querySelectorAll(s)].slice(0, 40).map((el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), name: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (el.textContent ?? "").trim().slice(0, 40),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        font: `${cs.fontSize}/${cs.fontWeight}`, color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor };
    }), sel);
  }
  if (opt.out) { mkdirSync(dirname(resolve(opt.out)), { recursive: true }); await page.screenshot({ path: opt.out, fullPage: opt.full }); }
  if (opt.json) { mkdirSync(dirname(resolve(opt.json)), { recursive: true }); writeFileSync(opt.json, JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify({ out: opt.out, json: opt.json, url: result.url, buildId: result.buildId }));
} finally {
  await context.close();
}
