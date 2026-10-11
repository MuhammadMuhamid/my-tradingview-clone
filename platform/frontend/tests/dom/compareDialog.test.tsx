/**
 * Compare, mounted.
 *
 * ── Why this file exists (TVP8 R4b-06, and R1c-14 from the shell review) ───
 *
 * `+` beside the symbol used to open a 512×374 form whose `<h2>` read
 *
 *     Compare instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot with
 *
 * — a canonical id as the most prominent copy in the dialog, three lines deep
 * under the close button. The contract's symbol-display rule has one absolute:
 * a symbol control shows a TICKER, never an `instrument:v1:…` id. Two separate
 * reviewers found the same line, and nothing in the suite could see it: the
 * pane passed `baseSymbol={symbol}` and the component printed what it was
 * given, so both halves were "correct".
 *
 * The reference does not have that form at all. TradingView's ⊕ opens THE
 * SYMBOL SEARCH in compare mode — the same panel, chips, dropdown row and 40px
 * rows, titled `Compare symbol` — and a row adds an overlay rather than moving
 * the chart. That is what this asserts, from the outside: what the title says,
 * what a row does, and what it does NOT do to the pane's own instrument.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  advance, assertAbsent, closeBrowser, render, resetBrowser, server, settle,
} from "./harness/env";
import { searchResponse } from "./harness/market";
import { CompareControl, CompareSettings } from "@/components/tv/CompareControl";
import type { PaneCompare } from "@/lib/workspace";

/** The canonical id a pane actually holds, and the ticker it must show. */
const CANONICAL_ID = "instrument:v1:BINANCE:spot:BTC:USDT:USDT:spot";

beforeEach(() => {
  resetBrowser();
  server.routes.set("/api/market/v1/search", (_body, url: URL) =>
    new Response(JSON.stringify(searchResponse(url)),
      { status: 200, headers: { "content-type": "application/json" } }));
});
after(closeBrowser);

test("the compare dialog is the symbol search, and says `Compare symbol`", async () => {
  const view = render(
    <CompareControl open current={null} baseTicker="BTCUSDT" onClose={() => {}} onApply={() => {}} />
  );
  await settle();
  await advance(220);

  const dialog = view.baseElement.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(dialog, "compare mode renders no dialog at all");
  assert.equal(dialog.getAttribute("aria-label"), "Compare symbol");
  assert.equal(dialog.getAttribute("data-symbol-search"), "compare");

  const heading = within(dialog).getByRole("heading");
  assert.match(heading.textContent ?? "", /^Compare symbol$/);

  // The one rule both reviews found broken, asserted on everything the dialog
  // says rather than only on the heading.
  const said = (dialog.textContent ?? "").replace(/\s+/g, " ");
  assert.ok(!said.includes("instrument:v1"),
    `a canonical id is primary copy again: ${said.slice(0, 160)}`);

  // Same panel, same bands: the chips and the dropdown row are the search's.
  assert.ok(within(dialog).getByRole("group", { name: "Asset class" }));
  assert.ok(within(dialog).getByRole("button", { name: "Filter by venue" }));
  assert.ok(dialog.querySelectorAll("[data-idx]").length > 0, "compare mode lists no instruments");

  // And it does NOT open pre-filled with the chart's own ticker: "open, then
  // Enter" must not compare an instrument with itself.
  assert.equal(dialog.querySelector<HTMLInputElement>("input")?.value, "",
    "compare mode seeded with the chart's own ticker compares it with itself");
});

test("a row ADDS a comparison and never moves the pane's own instrument", async () => {
  const applied: (PaneCompare | null)[] = [];
  const view = render(
    <CompareControl open current={null} baseTicker="BTCUSDT"
      onClose={() => {}} onApply={(next) => applied.push(next)} />
  );
  await settle();
  await advance(220);
  const dialog = view.baseElement.querySelector<HTMLElement>('[role="dialog"]')!;

  const row = dialog.querySelector<HTMLElement>('[data-idx="0"]');
  assert.ok(row, "compare mode listed no rows");
  fireEvent.click(row);
  await settle();

  assert.equal(applied.length, 1, "choosing a row must add exactly one comparison");
  const next = applied[0]!;
  assert.ok(next, "the row removed the comparison instead of adding one");
  assert.ok(!next.symbol.includes("instrument:v1"),
    "`setPaneCompare` upper-cases what it is given; a canonical id would be mangled");
  assert.match(next.symbol, /^[A-Z0-9.:]+$/);
  assert.equal(next.mode, "percent", "a first comparison is the reference's percent overlay");
});

test("an existing comparison keeps its mode, and can be removed, from the legend's own chip", async () => {
  const applied: (PaneCompare | null)[] = [];
  const current: PaneCompare = { symbol: "SOLUSDT", mode: "beta", length: 60 };
  const view = render(
    <CompareSettings open current={current} baseTicker="BTCUSDT"
      onClose={() => {}} onApply={(next) => applied.push(next)} />
  );
  await settle();
  // C15: a menu, not a dialog. The `?? view.baseElement` fallback this used
  // to carry meant the test could pass with no surface rendered at all.
  const menu = within(view.baseElement).getByRole("menu", { name: "Comparing with SOLUSDT" });
  assertAbsent(view.baseElement.querySelector('[role="dialog"], [role="alertdialog"]'),
    "managing a comparison opened a dialog again");

  // It names the comparison by TICKER, and never by a canonical id.
  const said = (menu.textContent ?? "").replace(/\s+/g, " ");
  assert.match(said, /Comparing with SOLUSDT/);
  assert.ok(!said.includes("instrument:v1"));

  // Changing the mode keeps the instrument and the window.
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Pair ratio" }));
  await settle();
  assert.deepEqual(applied.at(-1), { symbol: "SOLUSDT", mode: "ratio", length: 60 });

  // And the way out is still one click.
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove comparison" }));
  await settle();
  assert.equal(applied.at(-1), null);
});

/** The settings menu, anchored under a stand-in for the legend's chip. */
async function openSettingsMenu(over: Partial<Parameters<typeof CompareSettings>[0]> = {}) {
  const chip = document.createElement("button");
  chip.setAttribute("aria-label", "Comparing with SOLUSDT. Change or remove.");
  chip.getBoundingClientRect = () =>
    ({ left: 140, top: 60, bottom: 80, right: 200, width: 60, height: 20, x: 140, y: 60 }) as DOMRect;
  document.body.appendChild(chip);
  chip.focus();
  const closed: number[] = [];
  const view = render(
    <CompareSettings open current={{ symbol: "SOLUSDT", mode: "correlation", length: 60 }}
      baseTicker="BTCUSDT" onClose={() => closed.push(1)} onApply={() => {}}
      anchor={() => chip} {...over} />
  );
  await settle();
  return { view, chip, closed };
}

test("the settings menu hangs under the chip, portalled out of the legend", async () => {
  const { view, chip } = await openSettingsMenu();
  const menu = screen.getByRole("menu", { name: "Comparing with SOLUSDT" });

  // Out of the pane's stacking context, into its own workstation root, so a
  // neighbouring pane's legend cannot paint over it.
  assert.equal(view.container.contains(menu), false, "the menu rendered in place");
  assert.ok(menu.closest(".tv-workstation"), "the portal lost the workstation scope");
  assert.ok(menu.classList.contains("tvc-menu"), "the menu is not the shared popover grammar");

  // Under the chip's left edge, not centred on the viewport like a dialog.
  assert.equal(menu.style.left, "140px");
  assert.equal(menu.style.top, "84px");
  assert.equal(menu.style.visibility, "visible");

  // Focus starts on the mode that is on.
  assert.equal(document.activeElement?.textContent, "Rolling correlation");
  assert.equal(document.activeElement?.getAttribute("role"), "menuitemradio");
  chip.remove();
});

test("Escape closes the menu, stops there, and hands focus back to the chip", async () => {
  const seenByWindow: string[] = [];
  const listener = (e: KeyboardEvent) => seenByWindow.push(e.key);
  window.addEventListener("keydown", listener);
  const { view, chip, closed } = await openSettingsMenu();

  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await settle();
  assert.equal(closed.length, 1, "Escape did not close the menu");
  assert.deepEqual(seenByWindow, [],
    "Escape reached the chart's own handlers as well — it would also clear the selection");

  view.rerender(
    <CompareSettings open={false} current={{ symbol: "SOLUSDT", mode: "correlation", length: 60 }}
      baseTicker="BTCUSDT" onClose={() => {}} onApply={() => {}} anchor={() => chip} />
  );
  await settle();
  assert.equal(document.activeElement, chip, "closing dropped focus instead of returning it");
  window.removeEventListener("keydown", listener);
  chip.remove();
});

test("a press outside the menu closes it", async () => {
  const { closed, chip } = await openSettingsMenu();
  const catcher = document.querySelector<HTMLElement>("[data-compare-menu-root] > [aria-hidden='true']");
  assert.ok(catcher, "no outside-press catcher");
  fireEvent.pointerDown(catcher);
  assert.equal(closed.length, 1);
  chip.remove();
});

test("the window field appears for windowed modes only, and Change symbol is a row", async () => {
  const changed: number[] = [];
  const applied: (PaneCompare | null)[] = [];
  const { view, chip } = await openSettingsMenu({
    onChangeSymbol: () => changed.push(1), onApply: (next) => applied.push(next),
  });
  const menu = screen.getByRole("menu", { name: "Comparing with SOLUSDT" });

  const field = within(menu).getByRole("spinbutton", { name: "Rolling window in bars" });
  fireEvent.change(field, { target: { value: "30" } });
  assert.deepEqual(applied.at(-1), { symbol: "SOLUSDT", mode: "correlation", length: 30 });

  view.rerender(
    <CompareSettings open current={{ symbol: "SOLUSDT", mode: "ratio", length: 60 }}
      baseTicker="BTCUSDT" onClose={() => {}} onApply={() => {}}
      onChangeSymbol={() => changed.push(1)} anchor={() => chip} />
  );
  await settle();
  assertAbsent(within(menu).queryByRole("spinbutton"),
    "a pair ratio has no window, and the menu offered one");

  fireEvent.click(within(menu).getByRole("menuitem", { name: "Change symbol…" }));
  assert.equal(changed.length, 1);
  chip.remove();
});

test("the pane hands the dialog a ticker, not the canonical id it holds", async () => {
  /*
   * The defect lived in the CALL, not in the component: `PaneLegend` passed
   * `baseSymbol={symbol}`. Typing the prop `baseTicker` is what makes a
   * canonical id a type error rather than a heading; this reads the call site
   * so a future edit cannot quietly go back to the pane's raw symbol.
   */
  const pane = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../components/tv/ChartPane.tsx", import.meta.url), "utf8"));
  assert.match(pane, /baseTicker=\{displayTicker\(pane\.symbol\)\}/);
  assert.ok(!/base(Ticker|Symbol)=\{pane\.symbol\}/.test(pane),
    "the pane passed its canonical id straight into the dialog's own <h2>");
  assert.ok(!/baseSymbol=/.test(pane),
    "`baseSymbol` is the prop name that let a canonical id through; the type is a ticker now");
  // The exact string the two reviews found on screen, so this test says what
  // it is protecting against rather than only how.
  assert.ok(CANONICAL_ID.startsWith("instrument:v1:"));
});

test("a comparison RESTORED from a saved workspace is still named by ticker", async () => {
  /*
   * The test above passes `symbol: "SOLUSDT"` — already in display form —
   * because a comparison chosen through this dialog is stored that way. A
   * comparison restored from a saved pane is not: it carries the canonical id,
   * and nothing converted it at the point of display, so the dialog's heading
   * read "Comparing with instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot".
   *
   * Seen on the running build, not deduced. The existing assertion could not
   * catch it: it never supplied an id to leak.
   */
  const current: PaneCompare = {
    symbol: "instrument:v1:BINANCE:spot:ETH:USDT:USDT:spot", mode: "percent", length: 60,
  };
  const view = render(
    <CompareSettings open current={current} baseTicker="SOLUSDT"
      onClose={() => {}} onApply={() => {}} />
  );
  await settle();
  const menu = within(view.baseElement).getByRole("menu");
  const said = (menu.textContent ?? "").replace(/\s+/g, " ");

  assert.ok(!said.includes("instrument:v1"),
    "a canonical instrument id reached the menu's own heading");
  assert.ok(!(menu.getAttribute("aria-label") ?? "").includes("instrument:v1"),
    "a canonical instrument id reached the menu's accessible name");
  assert.match(said, /Comparing with ETHUSDT/);
});
