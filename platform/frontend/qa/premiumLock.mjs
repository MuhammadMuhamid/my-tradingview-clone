/**
 * The Premium-parity regression lock.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The workstation's chrome has been brought to measured parity with live
 * TradingView Premium more than once, and more than once a later pass changed
 * the same surface for an unrelated reason and quietly undid it: an icon
 * redrawn, a menu re-widened, a hover cluster that stopped appearing. This
 * script pins the ACCEPTED state of those surfaces as assertions on geometry
 * and behaviour — sizes, presence, stacking, dismissal — rather than on
 * pixels, so candles, prices and antialiasing can change freely while the
 * things a reviewer signed off cannot.
 *
 * Each check names the surface and the acceptance it protects. A failure is
 * not automatically a bug: it means an accepted surface changed, and the
 * change needs a reason and a fresh Premium comparison (see
 * docs/TRADING_SCENE_UI_UX_CONTRACT.md and the golden evidence index in
 * docs/PREMIUM_GOLDEN_EVIDENCE.md).
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 *
 * Needs a running frontend WITH a live backend (real candles), and Playwright
 * installed outside the repository, exactly as `qa/README.md` describes:
 *
 *     QA_PLAYWRIGHT_FROM=/tmp/qa/ QA_BASE=http://localhost:3000 node qa/premiumLock.mjs
 *
 * `QA_PLAYWRIGHT_FROM` is a directory whose `node_modules` holds Playwright.
 * An ES module ignores `NODE_PATH`, so the package is resolved from there
 * explicitly rather than from this repository, which does not depend on it.
 *
 * It changes nothing persistent: it opens menus and dialogs and closes them,
 * hovers and pans the chart, and resets the side-panel preference it found.
 */
import { createRequire } from "node:module";

const { chromium } = createRequire(process.env.QA_PLAYWRIGHT_FROM ?? import.meta.url)("playwright");

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const results = [];
const check = (surface, name, ok, detail = "") => {
  results.push({ surface, name, ok: Boolean(ok), detail });
};

// `QA_CHANNEL=chrome` uses an installed Chrome instead of Playwright's own build.
const browser = await chromium.launch(process.env.QA_CHANNEL ? { channel: process.env.QA_CHANNEL } : {});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const depthErrors = [];
page.on("console", (m) => { if (m.type() === "error" && /Maximum update depth/.test(m.text())) depthErrors.push(m.text()); });

async function load() {
  await page.goto(`${BASE}/chart`, { waitUntil: "load" });
  await page.waitForFunction(() => /O[\d,.]+/.test(document.body.innerText), null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
}

await load();
check("runtime", "real price history loads", !(await page.evaluate(() => /could not be loaded/i.test(document.body.innerText))));

// ── Top toolbar: one 38px row, nothing off-screen, More reachable ──────────
// 1200 and 768 since A13 / B-05: overflow is progressive, and at 768 the row
// used to run Undo, Redo and ⋯ off the edge.
for (const width of [1440, 1200, 1100, 1000, 768]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(600);
  const bar = await page.evaluate(() => {
    const row = document.querySelector("[data-toolbar-row]");
    if (!row) return null;
    const box = row.getBoundingClientRect();
    const controls = [...row.querySelectorAll("button")].filter((b) => b.offsetParent);
    const off = controls.filter((b) => b.getBoundingClientRect().right > innerWidth + 0.5)
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    return { h: Math.round(box.height), off };
  });
  check("toolbar", `${width}px: row is 38px`, bar && bar.h === 38, JSON.stringify(bar));
  check("toolbar", `${width}px: no control off-screen`, bar && bar.off.length === 0, JSON.stringify(bar?.off));
  // ⋯ is the way in to everything the row has no room for: on screen, and it
  // opens a dropdown (not a second row) whose every row is on screen too.
  const more = page.locator('[data-toolbar-row="primary"] button[aria-label="More controls"]');
  const moreBox = await more.boundingBox();
  check("toolbar", `${width}px: ⋯ is on screen`, moreBox && moreBox.x + moreBox.width <= width + 0.5, JSON.stringify(moreBox));
  if (moreBox) {
    await more.click();
    await page.waitForTimeout(300);
    const drop = await page.evaluate(() => {
      const d = document.querySelector("#chart-toolbar-overflow");
      if (!d) return null;
      const b = d.getBoundingClientRect();
      return { left: b.left, right: b.right, bottom: b.bottom, strip: !!document.querySelector("#chart-toolbar-more") };
    });
    check("toolbar", `${width}px: ⋯ opens an on-screen dropdown, not the strip`,
      drop && drop.left >= -0.5 && drop.right <= width + 0.5 && !drop.strip, JSON.stringify(drop));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(600);

// ── Left drawing rail: 52x38 cells ─────────────────────────────────────────
const rail = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('[data-drawing-rail="true"] .tvc-control')].filter((b) => b.offsetParent);
  return cells.map((c) => { const b = c.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; });
});
check("drawing rail", "at least 14 cells", rail.length >= 14, `${rail.length}`);
check("drawing rail", "cells are 52x38", rail.every(([w, h]) => w === 52 && h === 38), JSON.stringify(rail.slice(0, 4)));

// ── Icons: the settings glyph is a gear, never the eight-ray sun ───────────
const sun = await page.evaluate(() => [...document.querySelectorAll("svg")].some((svg) => {
  const lines = svg.querySelectorAll("line").length;
  return svg.querySelector("circle") && lines >= 8;
}));
check("icons", "no eight-ray sun glyph anywhere", !sun);
const clipped = await page.evaluate(() => [...document.querySelectorAll("button svg")].filter((svg) => {
  const s = svg.getBoundingClientRect(); const b = svg.closest("button").getBoundingClientRect();
  return s.width > 0 && (s.left < b.left - 0.5 || s.right > b.right + 0.5 || s.top < b.top - 0.5 || s.bottom > b.bottom + 0.5);
}).length);
check("icons", "no glyph overflows its own button", clipped === 0, `${clipped}`);

// ── Chart context menu ─────────────────────────────────────────────────────
const plot = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")].map((x) => x.getBoundingClientRect())
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return { x: c.x + c.width * 0.45, y: c.y + c.height * 0.5 };
});
await page.mouse.click(plot.x, plot.y, { button: "right" });
await page.waitForTimeout(500);
const chartMenu = await page.evaluate(() => {
  const m = document.querySelector('[role="menu"]');
  if (!m) return null;
  const b = m.getBoundingClientRect();
  const rows = [...m.querySelectorAll(".tvc-menu-row")].filter((r) => r.tagName === "BUTTON");
  return {
    w: Math.round(b.width),
    rowH: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    outline: getComputedStyle(m).outlineStyle === "none" || getComputedStyle(m).outlineColor === "rgba(0, 0, 0, 0)",
    highlighted: m.querySelectorAll('[data-highlighted="true"]').length,
    portalled: m.closest("[data-context-menu-root]")?.parentElement === document.body,
    // W2A-07: 18px glyph, 28px box, the row's own ink (Premium 2026-10-11).
    glyphs: [...m.querySelectorAll("[data-menu-mark] svg[data-menu-glyph]")].map((s) => Math.round(s.getBoundingClientRect().width)),
    boxes: [...m.querySelectorAll("[data-menu-mark]")].map((s) => Math.round(s.getBoundingClientRect().width)),
    markInk: [...m.querySelectorAll("[data-menu-mark]")].every((s) =>
      getComputedStyle(s).color === getComputedStyle(s.closest(".tvc-menu-row")).color),
  };
});
check("context menu", "opens on right-click", chartMenu !== null);
check("context menu", "is 325px wide", chartMenu?.w === 325, `${chartMenu?.w}`);
check("context menu", "rows are 32px", chartMenu?.rowH.every((h) => h === 32), JSON.stringify(chartMenu?.rowH));
check("context menu", "wears no focus ring", chartMenu?.outline);
check("context menu", "opens with no row highlighted", chartMenu?.highlighted === 0, `${chartMenu?.highlighted}`);
check("context menu", "is portalled to <body>", chartMenu?.portalled);
check("context menu", "row glyphs are 18px in a 28px box", chartMenu?.glyphs.length > 0
  && chartMenu.glyphs.every((w) => w === 18) && chartMenu.boxes.every((w) => w === 28),
  JSON.stringify({ glyphs: chartMenu?.glyphs, boxes: chartMenu?.boxes }));
check("context menu", "row glyphs are in the row's own ink", chartMenu?.markInk);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("context menu", "Escape dismisses", !(await page.$('[role="menu"]')));

// ── Study legend: zero-width cluster at rest, 28x22 actions on hover ───────
const study = await page.evaluate(() => {
  const cluster = document.querySelector("[data-study-actions]");
  if (!cluster) return null;
  const row = cluster.closest(".group\\/study");
  const title = row.querySelector("span").getBoundingClientRect();
  const value = [...row.children].find((c) => c.classList.contains("tabular"))?.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  return { rest: Math.round(cluster.getBoundingClientRect().width), gap: value ? Math.round(value.left - title.right) : null,
    hover: { x: r.x + 12, y: r.y + r.height / 2 } };
});
check("study legend", "a study row exists", study !== null);
if (study) {
  check("study legend", "cluster takes no room at rest", study.rest === 0, `${study.rest}px`);
  check("study legend", "value sits within 8px of the title", study.gap !== null && study.gap <= 8, `${study.gap}px`);
  await page.mouse.move(study.hover.x, study.hover.y);
  await page.waitForTimeout(400);
  const buttons = await page.evaluate(() => [...document.querySelector("[data-study-actions]").querySelectorAll("button")]
    .map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), b.getAttribute("aria-label"), getComputedStyle(b).color]; }));
  check("study legend", "hover reveals >=4 actions at 28x22", buttons.length >= 4 && buttons.every(([w, h]) => w === 28 && h === 22),
    JSON.stringify(buttons));
  // W2A-07: revealed in the full ink rgb(219), as Premium's are, not faint.
  check("study legend", "revealed actions are in ink", buttons.every((b) => b[3] === "rgb(219, 219, 219)"),
    JSON.stringify(buttons.map((b) => b[3])));
  const more = buttons.find((b) => /^More for/.test(b[2]));
  if (more) {
    const box = await page.locator(`[data-study-actions] button[aria-label="${more[2]}"]`).first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const menu = await page.evaluate(() => {
      const m = document.querySelector('[role="menu"]');
      if (!m) return null;
      const b = m.getBoundingClientRect();
      const top = document.elementFromPoint(b.x + b.width / 2, b.bottom - 6);
      const remove = [...m.querySelectorAll("button")].find((x) => /Remove/.test(x.innerText));
      return { rows: [...m.querySelectorAll("button")].map((x) => x.innerText.trim()), onTop: m.contains(top),
        removeInk: remove ? getComputedStyle(remove).color : null, x: Math.round(b.x) };
    });
    check("study ⋯ menu", "opens", menu !== null);
    check("study ⋯ menu", "paints above the next pane", menu?.onTop);
    check("study ⋯ menu", "Remove is not tinted red", menu?.removeInk && !/rgb\(2[0-9]{2}, [0-9]{1,2}, [0-9]{1,2}\)/.test(menu.removeInk)
      && menu.removeInk !== "rgb(247, 82, 95)", `${menu?.removeInk}`);
    check("study ⋯ menu", "anchored at the button", menu && Math.abs(menu.x - Math.round(box.x)) <= 8, `${menu?.x} vs ${Math.round(box.x)}`);
    await page.keyboard.press("Escape");
    await page.mouse.move(5, 880);
    await page.waitForTimeout(300);
  }
}

// ── Series legend: Flag symbol + More, More is the chart's menu ────────────
const readoutX = () => page.evaluate(() => {
  const o = [...document.querySelectorAll("span")].find((s) => (s.childNodes[0]?.nodeValue ?? "").trim() === "O");
  return o ? Math.round(o.getBoundingClientRect().x) : null;
});
const readoutBefore = await readoutX();
const title = await page.locator('button[aria-label^="Change symbol for the"]').first().boundingBox();
await page.mouse.move(title.x + 30, title.y + title.height / 2);
await page.waitForTimeout(400);
check("series legend", "hovering the title moves nothing after it (the cluster overlays)",
  readoutBefore !== null && readoutBefore === await readoutX(), `${readoutBefore} → ${await readoutX()}`);
const series = await page.evaluate(() => [...(document.querySelector("[data-series-actions]")?.querySelectorAll("button") ?? [])]
  .map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), b.getAttribute("aria-label")]; }));
check("series legend", "hover reveals Flag and More at 28x22",
  series.length === 2 && series.every(([w, h]) => w === 28 && h === 22) && /^(Un)?[Ff]lag/.test(series[0][2]), JSON.stringify(series));

// ── Status line: one row at 1440 with the side panel open ──────────────────
const panelBefore = await page.evaluate(() => localStorage.getItem("tv.sidePanel.v1"));
await page.evaluate(() => localStorage.setItem("tv.sidePanel.v1", "watchlist"));
await load();
const statusH = await page.evaluate(() => {
  const o = [...document.querySelectorAll("span")].find((s) => (s.childNodes[0]?.nodeValue ?? "").trim() === "O");
  return o ? Math.round(o.parentElement.parentElement.getBoundingClientRect().height) : null;
});
check("status line", "one row at 1440 with the side panel open", statusH !== null && statusH <= 26, `${statusH}px`);

// ── Status line follows the crosshair ──────────────────────────────────────
const readOhlc = () => page.evaluate(() => document.body.innerText.match(/O[\d,.]+\s*H[\d,.]+\s*L[\d,.]+\s*C[\d,.]+/)?.[0]);
const off = await readOhlc();
await page.mouse.move(plot.x - 300, plot.y);
await page.waitForTimeout(1500);
const hovered = await readOhlc();
check("status line", "O H L C follows the crosshair", off && hovered && off !== hovered, `${off} | ${hovered}`);

// ── Price axis: no tick label half-covered by a pill ───────────────────────
async function truncatedTicks() {
  return page.evaluate(() => {
    let total = 0;
    for (const td of document.querySelectorAll("td")) {
      const canvases = td.querySelectorAll("canvas");
      if (canvases.length !== 2) continue;
      const main = canvases[0]; const r = main.getBoundingClientRect();
      if (r.width > 120 || r.width < 30 || r.height < 40) continue;
      const w = main.width, h = main.height, d = main.getContext("2d").getImageData(0, 0, w, h).data;
      const gi = (Math.floor(h / 2) * w + w - 1) * 4; const g = [d[gi], d[gi + 1], d[gi + 2], d[gi + 3]];
      const ratio = w / r.width, probe = Math.round(7.5 * ratio), tx = Math.round(10 * ratio);
      const ink = (y, x) => { const i = (y * w + x) * 4; return Math.abs(d[i + 3] - g[3]) > 24
        || (d[i + 3] > 0 && (Math.abs(d[i] - g[0]) > 24 || Math.abs(d[i + 1] - g[1]) > 24 || Math.abs(d[i + 2] - g[2]) > 24)); };
      const rows = [];
      for (let y = 0; y < h; y++) { if (ink(y, probe)) { rows.push("L"); continue; } let a = false; for (let x = tx; x < w && !a; x++) a = ink(y, x); rows.push(a ? "i" : "e"); }
      for (let y = 0; y < h;) { if (rows[y] !== "i") { y++; continue; } const s = y; while (y < h && rows[y] === "i") y++; if (rows[s - 1] === "L" || rows[y] === "L") total++; }
    }
    return total;
  });
}
let worst = 0;
for (let k = 0; k < 8; k++) {
  await page.mouse.move(plot.x, plot.y);
  await page.mouse.wheel(0, k % 2 ? 130 : -90);
  await page.waitForTimeout(350);
  await page.mouse.move(5, 880);
  await page.waitForTimeout(250);
  worst = Math.max(worst, await truncatedTicks());
}
check("price scale", "no tick label half-covered by a pill (8 zoom states)", worst === 0, `${worst}`);

// ── Pane sync: panning never trips React's update-depth guard ──────────────
await page.mouse.move(plot.x + 200, plot.y);
await page.mouse.down();
await page.mouse.move(plot.x - 200, plot.y, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(1500);
check("panes", "a pan raises no 'Maximum update depth' error", depthErrors.length === 0, `${depthErrors.length}`);

// ── Compare: opens on a starting list, immediately ─────────────────────────
await page.getByRole("button", { name: "Compare with another instrument" }).first().click();
await page.waitForTimeout(900);
const compare = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  return d ? { rows: d.querySelectorAll("[data-idx]").length, first: d.querySelector("[data-idx]")?.innerText.split("\n")[1] } : null;
});
check("compare", "opens with rows within 900ms", compare && compare.rows > 0, JSON.stringify(compare));
check("compare", "does not open on the alphabetical catalogue", compare && !/^0/.test(compare.first ?? ""), `${compare?.first}`);
await page.keyboard.press("Escape");

// ── No uncaught errors through all of the above ───────────────────────────
check("runtime", "no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

await page.evaluate((v) => { if (v === null) localStorage.removeItem("tv.sidePanel.v1"); else localStorage.setItem("tv.sidePanel.v1", v); }, panelBefore);
await browser.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  [${r.surface}] ${r.name}${r.ok ? "" : `  — ${r.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
