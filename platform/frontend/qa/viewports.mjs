/**
 * Phase 6 browser QA against a LOCAL build of the frontend.
 *
 * The backend needs PostgreSQL, which is not available here, so every page is
 * exercised with its API returning errors. That is a real and important state —
 * it is exactly what a user sees when the backend is down — but it is not a
 * substitute for QA against a populated system, and nothing here claims to be.
 */
import { chromium, devices } from "playwright";

const BASE = "http://127.0.0.1:3111";
const PAGES = ["/chart", "/alerts", "/backtests", "/deployments", "/optimizers", "/login", "/nope-404"];

const VIEWPORTS = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, isMobile: false },
  { name: "laptop-1024", viewport: { width: 1024, height: 768 }, isMobile: false },
  { name: "iphone-390-portrait", ...devices["iPhone 13"] },
  { name: "iphone-844-landscape", ...devices["iPhone 13 landscape"] },
  { name: "android-412", ...devices["Pixel 7"] },
];

const results = [];

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const { name, ...deviceOpts } = vp;
  const context = await browser.newContext({ ...deviceOpts, colorScheme: "dark" });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  for (const route of PAGES) {
    consoleErrors.length = 0;
    pageErrors.length = 0;
    const resp = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30_000 }).catch((e) => ({ err: String(e) }));
    if (resp && resp.err) { results.push({ vp: name, route, fatal: resp.err }); continue; }
    // Let client effects settle and their failed fetches resolve.
    await page.waitForTimeout(1200);

    const measured = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflowX = Math.max(0, doc.scrollWidth - doc.clientWidth);
      // Elements whose box extends past the viewport's right edge.
      const vw = doc.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.visibility === "hidden") continue;
        if (r.right > vw + 1) {
          // Inside a horizontal scroller is intended, not overflow.
          let p = el.parentElement, scroller = false;
          while (p && p !== document.body) {
            const ov = getComputedStyle(p).overflowX;
            if (ov === "auto" || ov === "scroll") { scroller = true; break; }
            p = p.parentElement;
          }
          if (!scroller) offenders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} right=${Math.round(r.right)}`);
        }
      }
      // Touch targets smaller than 32px in either dimension.
      const small = [];
      for (const el of document.querySelectorAll("button, a[href], select, input, [role=button]")) {
        // An input inside a label is toggled by pressing the label, so the
        // label is the real target. Measuring the box alone would report a
        // failure that a user never experiences.
        const target = el.tagName === "INPUT" ? (el.closest("label") ?? el) : el;
        const r = target.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 32 || r.width < 24) {
          const label = el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").trim().slice(0, 24) || el.tagName;
          small.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      // Controls with no accessible name at all.
      const unnamed = [];
      for (const el of document.querySelectorAll("button, a[href], [role=button]")) {
        const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
        if (!name) unnamed.push(el.outerHTML.slice(0, 90));
      }
      // iOS Safari zooms any focused field whose text is under 16px. Measured
      // rather than inferred from the stylesheet: the rule that was supposed to
      // prevent this lost to a utility class and did nothing for months.
      // Only where it can happen: the rule is a 640px media query and desktop
      // browsers do not zoom on focus at all.
      const zoomers = [];
      for (const el of (innerWidth <= 640 ? document.querySelectorAll("input, select, textarea") : [])) {
        if (el.type === "checkbox" || el.type === "radio" || el.type === "hidden") continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 16) zoomers.push(`${el.tagName}:${el.type || ""} ${size}px`);
      }

      return {
        zoomers: [...new Set(zoomers)].slice(0, 6),
        overflowX,
        offenders: [...new Set(offenders)].slice(0, 8),
        small: [...new Set(small)].slice(0, 12),
        unnamed: unnamed.slice(0, 6),
        title: document.title,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        h1: (document.querySelector("h1")?.textContent || "").trim().slice(0, 60),
        landmarks: {
          main: !!document.querySelector("main"),
          nav: !!document.querySelector("nav"),
          skipLink: !!document.querySelector("a.skip-link"),
        },
      };
    });

    results.push({
      vp: name, route, status: resp.status(), ...measured,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 4),
      pageErrors: pageErrors.slice(0, 3),
    });
  }
  await context.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
