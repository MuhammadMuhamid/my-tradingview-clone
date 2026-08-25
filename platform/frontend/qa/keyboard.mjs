/** Keyboard behaviour of the skip link and the shared dialog, in a real browser. */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3111";
const out = {};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/chart`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

// ── Skip link ──
await page.keyboard.press("Tab");
// `.skip-link` animates `top` over 150ms. Measuring immediately catches it
// mid-flight and reports a negative offset for a link that does become
// visible — which is a flaky measurement, not a finding. Wait for the
// transition to settle and measure the state a user actually sees.
await page.waitForTimeout(400);
out.firstTabStop = await page.evaluate(() => {
  const a = document.activeElement;
  const r = a.getBoundingClientRect();
  return { text: a.textContent.trim(), tag: a.tagName, topPx: Math.round(r.top), visible: r.top >= 0 };
});
out.focusRing = await page.evaluate(() => {
  const s = getComputedStyle(document.activeElement);
  return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor };
});
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
out.afterSkip = await page.evaluate(() => ({
  id: document.activeElement.id || document.activeElement.tagName,
  hash: location.hash,
}));

// ── Dialog ──
const trigger = page.getByRole("button", { name: "Alert", exact: true }).first();
await trigger.click();
await page.waitForTimeout(300);
out.dialog = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return { present: false };
  const labelledBy = d.getAttribute("aria-labelledby");
  return {
    present: true,
    ariaModal: d.getAttribute("aria-modal"),
    labelText: labelledBy ? (document.getElementById(labelledBy)?.textContent || "").trim() : null,
    focusInside: d.contains(document.activeElement),
    focusedTag: document.activeElement.tagName,
    bodyOverflow: getComputedStyle(document.body).overflow,
  };
});

// Tab past the last control and confirm focus stays inside the panel.
for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
out.trapHeld = await page.evaluate(() =>
  document.querySelector('[role="dialog"]').contains(document.activeElement));

await page.keyboard.press("Escape");
await page.waitForTimeout(250);
out.afterEscape = await page.evaluate(() => ({
  dialogGone: !document.querySelector('[role="dialog"]'),
  bodyOverflow: getComputedStyle(document.body).overflow,
  focusReturnedTo: (document.activeElement.getAttribute("title")
    || document.activeElement.textContent || "").trim().slice(0, 30),
}));

await browser.close();
console.log(JSON.stringify(out, null, 1));
