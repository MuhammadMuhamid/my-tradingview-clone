/**
 * The chart-settings dialog's chrome, measured against the reference.
 *
 * ── What R6b measured (R6b-01…07, 15, 22, 24) ──────────────────────────────
 *
 * Six of the seven tabs matched to within a few pixels; these are the rows that
 * did not, each with the reference's own number:
 *
 *   R6b-01  rail's first tab at dialog-top + 76 (header 62 + 14) and the
 *           content column at + 84; ours were both at + 92 (`!py-[30px]`).
 *   R6b-02  footer 67px — 17 above and 16 below the 34px buttons; ours 59
 *           (`Modal`'s own `py-3`).
 *   R6b-03  `Template ▾` carries a 1px outline (edges at x=365 and 463/464).
 *   R6b-04  `Cancel` carries one too (edges at x=945 and 1017/1018) — R6 read
 *           it as a borderless ghost and wrote that down in a comment.
 *   R6b-05  rail ink one step brighter on both states: 219 / 255 against
 *           168 / 219.
 *   R6b-06  the Status tab's value column is FIXED; `max-content` let
 *           `Last day change values` push the `Title` dropdown to x=790
 *           against the reference's 714.
 *   R6b-15  the `Indicators` dropdown is 180 (`Indicators and financials`).
 *   R6b-22  `Only active alerts` is NOT indented — its checkbox is at the
 *           content edge with `Alert lines`.
 *   R6b-24  one section per chart type: the tab read `RENKO … RENKO`.
 *
 * jsdom lays nothing out, so the assertions are on the classes and inline
 * styles a browser reads rather than on measured rects — which is also what
 * makes them survive a viewport change.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart, type MountedChart } from "./harness/chart";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

async function openSettings(chart: MountedChart, tab?: string): Promise<HTMLElement> {
  const trigger = [...chart.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label") === "Chart settings");
  assert.ok(trigger, "the chart settings action is missing from the toolbar");
  fireEvent.click(trigger);
  await settle();
  if (tab) {
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    await settle();
  }
  return screen.getByRole("dialog", { name: "Chart settings" });
}

test("R6b-01/02 — the content band and the footer are the reference's", async () => {
  const chart = await mountChart();
  const dialog = await openSettings(chart);

  const body = dialog.querySelector<HTMLElement>('[class*="min-h-0"][class*="flex-1"]');
  assert.ok(body, "the dialog has no body");
  assert.match(body.className, /!pt-\[14px\]/,
    "R6b-01: the rail's first tab sits at the header + 14, not + 30");
  assert.match(body.className, /!pb-\[30px\]/);

  const panel = dialog.querySelector<HTMLElement>('[class*="border-t"][class*="justify-end"]');
  assert.ok(panel, "the dialog has no footer");
  assert.match(panel.className, /!py-4/,
    "R6b-02: 16/16 around a 34px button plus the hairline is the reference's 67");
});

test("R6b-03/04 — `Template ▾` and `Cancel` both carry the reference's outline", async () => {
  const chart = await mountChart();
  await openSettings(chart);

  const template = screen.getByRole("button", { name: "Chart settings template" });
  assert.match(template.className, /border-control-border/,
    "R6b-03: the reference's Template button has pixel edges at x=365 and 463/464");

  const cancel = screen.getByRole("button", { name: "Cancel" });
  assert.match(cancel.className, /border-control-border/,
    "R6b-04: and so does Cancel, whatever R6's comment in `ui.tsx` said");
  assert.doesNotMatch(cancel.className, /bg-accent/);
});

test("R6b-05 — the rail's ink is one step brighter on both states", async () => {
  const chart = await mountChart();
  await openSettings(chart);

  const symbol = screen.getByRole("tab", { name: "Symbol" });
  const canvas = screen.getByRole("tab", { name: "Canvas" });
  assert.equal(symbol.getAttribute("aria-selected"), "true");
  assert.match(symbol.className, /text-\[var\(--ts-menu-selected-bg\)\]/,
    "the selected label is the brightest ink the theme defines");
  assert.match(canvas.className, /text-ink\b/,
    "and the unselected one is `--ts-ink` (219), not `--ts-ink-muted` (168)");
});

test("R6b-06 — the Status tab's value column is fixed, not `max-content`", async () => {
  const chart = await mountChart();
  await openSettings(chart, "Status line");

  const panel = screen.getByRole("tabpanel");
  assert.match(panel.style.gridTemplateColumns, /^103px/,
    "`Last day change values` (179px) used to push the Title dropdown to x=790");

  // Every other tab keeps the floor-and-grow column it was measured with.
  fireEvent.click(screen.getByRole("tab", { name: "Canvas" }));
  await settle();
  assert.match(screen.getByRole("tabpanel").style.gridTemplateColumns, /^minmax\(155px/);
});

test("R6b-15/22 — the Indicators dropdown is 180 and `Only active alerts` is not indented",
  async () => {
    const chart = await mountChart();
    await openSettings(chart, "Scales and lines");
    const indicators = screen.getByRole("button", { name: "Indicator last value" });
    assert.equal(indicators.style.width, "180px",
      "the reference's row is `Indicators and financials` at 180");

    fireEvent.click(screen.getByRole("tab", { name: "Alerts" }));
    await settle();
    const onlyActive = screen.getByRole("checkbox", { name: "Only active alerts" });
    const row = onlyActive.closest("label");
    assert.ok(row);
    assert.notEqual(row.style.paddingLeft, "26px",
      "the reference draws this checkbox at the content edge with `Alert lines`");
  });

test("R6b-24 — the Symbol tab names each chart type once", async () => {
  const chart = await mountChart();
  const dialog = await openSettings(chart, "Symbol");
  const titles = [...dialog.querySelectorAll("h3")].map((h) => (h.textContent ?? "").trim());
  assert.equal(new Set(titles).size, titles.length,
    `the tab repeated a section title: ${titles.join(" · ")}`);
});
