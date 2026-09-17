/**
 * The symbol dialog, mounted, against a fixture whose providers are failing.
 *
 * ── Why this file exists (TVP8 R4) ────────────────────────────────────────
 *
 * Every defect R4 found in this dialog was invisible to the suite that
 * covered it. `tests/symbolSearch.test.ts` asserted the reducer directly —
 * correctly, and it still does — and then asserted the RENDERED dialog by
 * grepping its source for uppercase words. So a 50px amber banner listing
 * `bybit-spot, robinhood-crypto, binance-derivatives…` above the first
 * result, a 24-chip grid of quote currencies as the primary filter, and a
 * keyboard cursor that opened on a DIFFERENT instrument from the one on the
 * chart were all green: none of them is a string.
 *
 * This mounts the real component against the DOM harness's own market and
 * reads what a user would be looking at.
 *
 * ── What it cannot do ─────────────────────────────────────────────────────
 *
 * jsdom has no layout engine and the harness serves no stylesheet, so the
 * geometry half of R4 — panel `[300,110,840,680]`, 40px rows, bands that do
 * not overlap — is not checkable here and is not faked here. That half is
 * the scripted capture (`scripts/ts-capture.mjs --measure`) paired against
 * `tradingview/symbol-search-*-1440-dark.png`. What IS checkable without
 * pixels is the structure and the words: how many control bands exist, what
 * they are named, what is said above the first row, and which symbol the
 * fastest gesture in the dialog selects.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fireEvent, within } from "@testing-library/react";
import { advance, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { CANONICAL, searchResponse } from "./harness/market";
import { SymbolSearch } from "@/components/tv/SymbolSearch";

/** The chart's instrument, and the one the box must open on. */
const CURRENT = CANONICAL.SOLUSDT!;

/**
 * What the running installation's `errors` array looks like today.
 *
 * The equities provider is in it so Stocks and Funds can retain a truthful
 * hover reason while remaining normal, usable filters.
 */
const FAILURES = [
  { providerId: "alpaca-us-equities", error: "HTTP 403 unverified credential" },
  { providerId: "bybit-spot", error: "HTTP 403" },
  { providerId: "binance-derivatives", error: "HTTP 451" },
];

let answered = 0;
/** Every search the dialog actually issued, so a chip's query is checkable. */
let asked: URL[] = [];

beforeEach(() => {
  resetBrowser();
  answered = 0;
  asked = [];
  /*
   * The fixture's own search, with `errors` set. Overriding the route rather
   * than the catalogue keeps `searchResponse` the single description of what
   * this market holds — including its honouring of `assetClass`, which the
   * Crypto chip the dialog opens on actually sends.
   */
  server.routes.set("/api/market/v1/search", (_body, url: URL) => {
    answered += 1;
    asked.push(url);
    return new Response(JSON.stringify({ ...searchResponse(url), errors: FAILURES }),
      { status: 200, headers: { "content-type": "application/json" } });
  });
});
after(closeBrowser);

interface Mounted { dialog: HTMLElement; selected: string[] }

/** Open the dialog for the chart's instrument and let its first answer land. */
async function openDialog(): Promise<Mounted> {
  const selected: string[] = [];
  const view = render(
    <SymbolSearch open current={CURRENT} onClose={() => {}} onSelect={(s) => selected.push(s)} />
  );
  await settle();
  // Past the 180 ms debounce, then let the response render.
  await advance(220);
  const dialog = view.baseElement.querySelector<HTMLElement>('[role="dialog"][aria-label="Symbol search"]');
  assert.ok(dialog, "the dialog did not render");
  assert.ok(answered > 0, "the dialog never asked the search route — this test reached nothing");
  return { dialog, selected };
}

const rowsOf = (dialog: HTMLElement): HTMLElement[] =>
  [...dialog.querySelectorAll<HTMLElement>("[data-idx]")];

const chip = (dialog: HTMLElement, name: string): HTMLElement => {
  const group = within(dialog).getByRole("group", { name: "Asset class" });
  const found = within(group).getByRole("button", { name });
  return found;
};

test("one control band stands between the box and the rows, and it is the asset class", async () => {
  const { dialog } = await openDialog();
  assert.ok(rowsOf(dialog).length > 0, "the fixture answered with no rows at all");

  /*
   * The quote-currency grid, the venue chip row and the type tab row were
   * three `[role=group]`s stacked above the results — 267px of the dialog's
   * height before the first answer. Exactly one survives.
   */
  const groups = [...dialog.querySelectorAll<HTMLElement>('[role="group"]')];
  assert.deepEqual(groups.map((g) => g.getAttribute("aria-label")), ["Asset class"],
    "the quote grid / venue row / type tabs must not come back as control bands");

  // Their filters did not go away; they went behind the dropdown row.
  const triggers = [...dialog.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]')]
    .map((el) => el.getAttribute("aria-label"));
  for (const axis of ["Filter by venue", "Filter by instrument type", "Filter by quote asset"]) {
    assert.ok(triggers.includes(axis), `${axis} is no longer reachable at all`);
  }
});

test("nothing above the first row is a provider's own words", async () => {
  const { dialog } = await openDialog();
  const first = rowsOf(dialog)[0];
  assert.ok(first, "no result row rendered");

  /*
   * The banner was a `role="status"` element ABOVE the rows. The repaired
   * dialog has exactly one status line and one status indicator, both in the
   * footer strip below the list.
   */
  for (const status of dialog.querySelectorAll<HTMLElement>('[role="status"]')) {
    const before = (first.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    assert.equal(before, false,
      `a status band is rendered above the results again: ${status.textContent}`);
  }

  // REV-UX-01: no provider id and no thrown cause is visible copy anywhere.
  const visible = (dialog.textContent ?? "").replace(/\s+/g, " ");
  for (const failure of FAILURES) {
    assert.ok(!visible.includes(failure.providerId),
      `${failure.providerId} is being shown to a reader as prose: ${visible.slice(0, 200)}`);
    assert.ok(!visible.includes(failure.error), `${failure.error} is page copy`);
  }
  assert.ok(!visible.includes("unavailable; other venues remain searchable"),
    "the amber banner is back");
});

test("a class whose provider is down remains a normal filter and says why on hover", async () => {
  const { dialog } = await openDialog();
  assert.equal(chip(dialog, "Crypto").getAttribute("aria-pressed"), "true",
    "the dialog opens on the class of the instrument the chart is showing");
  for (const name of ["Stocks", "Funds"]) {
    const control = chip(dialog, name);
    assert.equal(control.getAttribute("aria-disabled"), null);
    assert.ok(!control.className.includes("opacity-50"), `${name} must not be visually disabled`);
    const why = control.getAttribute("title") ?? "";
    assert.match(why, /unavailable/);
    assert.ok(!why.includes("alpaca-us-equities"), "the reason is a sentence, not a provider id");
    fireEvent.click(control);
    await advance(220);
    assert.equal(control.getAttribute("aria-pressed"), "true", `${name} did not become the active filter`);
    assert.equal(rowsOf(dialog).length, 0, `${name} must truthfully filter to an empty result set`);
  }
  // And a class many venues carry is untouched by one of them failing.
  assert.equal(chip(dialog, "Crypto").getAttribute("aria-disabled"), null);
});

test("the footer is one neutral hint with no provider health or result count", async () => {
  const { dialog } = await openDialog();
  const copy = (dialog.textContent ?? "").replace(/\s+/g, " ");
  assert.match(copy, /Type a ticker or name/);
  assert.doesNotMatch(copy, /sources unavailable|market instruments/i);
  assert.equal(dialog.querySelector('[role="status"]') === null, true,
    "the neutral footer must not announce changing provider/count diagnostics");
});

test("the rows are buttons that carry the ticker, with the chart's instrument first", async () => {
  const { dialog } = await openDialog();
  const rows = rowsOf(dialog);
  const first = rows[0]!;

  // `scripts/ts-state-btc1h.mjs` and the keyboard both depend on this shape.
  for (const row of rows) assert.equal(row.tagName, "BUTTON");
  assert.match(first.textContent ?? "", /SOLUSDT/);
  assert.equal(first.querySelector(".underline") === null, true, "ticker matches must not be underlined");
  assert.equal(first.getAttribute("aria-current"), "true",
    "the chart's own instrument leads the list");

  const listed = (dialog.textContent ?? "").replace(/\s+/g, " ");
  assert.ok(!listed.includes("on this chart"),
    "'on this chart' is the row's title and its aria-current, not an accent badge");
  assert.ok(!/\bPERP\b|\bSPOT\b/.test(listed), "the shouted type badges are gone");
  assert.match(first.getAttribute("title") ?? "", /on this chart/,
    "every fact the row stopped printing is still one hover away");
});

test("a chip asks the search for the market it names, and the route answers it", async () => {
  const { dialog } = await openDialog();
  /*
   * The Crypto chip is the one axis no `type=` can express — spot, perpetual
   * and dated crypto futures are one class — so it rides the route's one
   * additive parameter. A request without it would be the whole catalogue
   * under a chip that says Crypto.
   */
  const crypto = asked.at(-1)!;
  assert.equal(crypto.searchParams.get("assetClass"), "crypto");
  assert.equal(crypto.searchParams.get("type"), "all");
  assert.equal(crypto.searchParams.get("q"), "SOLUSDT", "the box opens on the chart's ticker");

  fireEvent.click(chip(dialog, "Forex"));
  await advance(220);
  const forex = asked.at(-1)!;
  assert.equal(forex.searchParams.get("type"), "fx_pair");
  assert.equal(forex.searchParams.get("assetClass"), null,
    "a chip that IS one product type does not also need the class parameter");

  // Forex has exactly one product type, so its slot says so as text rather
  // than opening a menu with one row in it.
  const triggers = [...dialog.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]')]
    .map((el) => el.getAttribute("aria-label"));
  assert.ok(!triggers.includes("Filter by instrument type"));
  assert.match(dialog.textContent ?? "", /Forex/);
});

/**
 * The gesture the old dialog got wrong.
 *
 * Open and press Enter: the reference re-selects what is already on the
 * chart. Ours pre-filled the base asset, cursored onto row 0 of 162 answers
 * and switched the chart to a perpetual on another venue.
 */
test("open, then Enter, cannot change the symbol", async () => {
  const selected: string[] = [];
  render(<SymbolSearch open current={CURRENT} onClose={() => {}} onSelect={(s) => selected.push(s)} />);
  await settle();

  fireEvent.keyDown(window, { key: "Enter" });
  await advance(220);

  assert.ok(answered > 0, "Enter did not even reach the search — this test proved nothing");
  for (const symbol of selected) {
    assert.equal(symbol, CURRENT,
      "the fastest gesture in the dialog changed the chart's instrument");
  }
});

/* ── TVP8 R4b ─────────────────────────────────────────────────────────────
 *
 * Everything below was found on the LIVE build by the after-review and was
 * green in this file, because the defects are either a class the workstation's
 * global CSS defeats or a key handler that never asked who the target was.
 *
 * jsdom serves no stylesheet, so where a rule is defeated by `globals.css` the
 * pair is: the component's class here, AND the defeating rule's exception read
 * out of `app/globals.css` — plus a measured number in the capture report.
 * Where the defect is behaviour, the behaviour itself is asserted.
 * ──────────────────────────────────────────────────────────────────────── */

const CSS = fs.readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

test("R4b-01 the chips are pills, and the selected one is not a chrome control", async () => {
  const { dialog } = await openDialog();
  const selected = chip(dialog, "Crypto");
  const rest = chip(dialog, "Forex");

  /*
   * `.tvc-control` forces `background-color: transparent` on the ELEMENT and
   * paints state on an inset `::before`, at a specificity (0,2,0) these
   * utilities (0,1,0) cannot reach. On the live build that left every
   * unselected chip with no pill at all and painted the selected one
   * `--ts-state-active` (#3d3d3d) under `--ts-menu-selected-ink` (#0f0f0f) —
   * dark ink on dark grey, about 2.3:1.
   */
  for (const control of [selected, rest]) {
    assert.ok(!control.className.split(/\s+/).includes("tvc-control"),
      "a chip is a pill, not a chrome control: `.tvc-control` erases its ground");
  }
  assert.match(selected.className, /bg-\[var\(--ts-menu-selected-bg\)\]/);
  assert.match(selected.className, /text-\[var\(--ts-menu-selected-ink\)\]/);
  assert.match(rest.className, /bg-state-hover/);
  assert.ok(!rest.className.includes("--ts-menu-selected-bg"),
    "the pressed chip and the rest must not share a class list");

  // And the selection is still DECLARED, not only painted.
  assert.equal(selected.getAttribute("aria-pressed"), "true");
  assert.equal(rest.getAttribute("aria-pressed"), "false");
});

test("R4b-02 / R4b-10 the box is framed, not ringed, and its text is 16px", async () => {
  const { dialog } = await openDialog();
  const box = dialog.querySelector<HTMLInputElement>("input");
  assert.ok(box, "the dialog has no search box");

  /*
   * The accent ring was drawn on EVERY open, because the dialog focuses its
   * box the moment it exists. `globals.css`'s `:focus-visible` (0,1,0 plus a
   * pseudo-class) beats the element's `outline-none` utility, so the fix has
   * to be a rule in the same file — and this is the pair jsdom allows: the
   * hook the rule selects on, and the rule itself.
   */
  assert.equal(dialog.getAttribute("data-symbol-search"), "symbol",
    "the CSS exception selects on this attribute");
  assert.match(CSS,
    /\[role="dialog"\]\[data-symbol-search\] input:focus-visible \{\s*outline: none;/,
    "the accent focus ring is drawn on every open without this exception");

  /*
   * And the size: `:is(.tv-workstation,.ts-app) input { font-size: inherit }`
   * scores (0,1,1) and beat the plain `text-[16px]` utility (0,1,0), so the
   * box rendered at 14px while its class said 16.
   */
  assert.match(box.className, /!text-\[16px\]/,
    "a plain text-[16px] loses to the workstation's `input { font-size: inherit }`");
  assert.match(CSS, /:is\(\.tv-workstation, \.ts-app\) button,\n:is\(\.tv-workstation, \.ts-app\) input/,
    "the rule this `!` exists to defeat is still there — if it goes, drop the `!`");
});

test("R4b-03 the ticker column is a fixed width, so nothing is truncated to fit itself", async () => {
  const { dialog } = await openDialog();
  const rows = rowsOf(dialog);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row.className, /grid-cols-\[24px_211px_minmax\(0,1fr\)_auto_auto_20px\]/,
      "the middle column moved 89px between two queries of the same dialog");
    assert.ok(!row.className.includes("--ss-ticker"),
      "a `ch`-sized column is the width of `0`, and capitals are wider — `WBTCUSDT` printed `WBTCU…`");
  }
  const list = dialog.querySelector<HTMLElement>('[data-idx="0"]')?.parentElement;
  assert.ok(list && !(list.getAttribute("style") ?? "").includes("--ss-ticker"),
    "the list no longer publishes a ticker width for its rows to read");
});

test("R4b-04 Enter belongs to the box and the rows, not to every focused control", async () => {
  const { dialog, selected } = await openDialog();

  // A chip: Enter must press the CHIP. jsdom does not synthesise a click from
  // Enter, so the click is fired separately — what is under test is that the
  // dialog did not swallow the key and close on the cursor row.
  const forex = chip(dialog, "Forex");
  forex.focus();
  fireEvent.keyDown(forex, { key: "Enter", bubbles: true });
  await settle();
  assert.deepEqual(selected, [], "Enter on a chip selected a symbol and closed the dialog");
  fireEvent.click(forex);
  await advance(220);
  assert.equal(chip(dialog, "Forex").getAttribute("aria-pressed"), "true");

  // The Clear button.
  const clear = within(dialog).getByRole("button", { name: "Clear the search" });
  clear.focus();
  fireEvent.keyDown(clear, { key: "Enter", bubbles: true });
  await settle();
  assert.deepEqual(selected, [], "Enter on Clear selected a symbol and closed the dialog");

  // A filter trigger.
  const trigger = within(dialog).getByRole("button", { name: "Filter by venue" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", bubbles: true });
  await settle();
  assert.deepEqual(selected, [], "Enter on a filter trigger selected a symbol and closed the dialog");

  // And the box itself still owns it. Back to `All` first, because `Forex`
  // answers nothing for a crypto ticker and an empty list has no cursor row —
  // which would make this assertion pass for the wrong reason.
  fireEvent.click(chip(dialog, "All"));
  await advance(220);
  assert.ok(rowsOf(dialog).length > 0, "the fixture answered nothing — this proves nothing");
  const box = dialog.querySelector<HTMLInputElement>("input")!;
  box.focus();
  fireEvent.keyDown(box, { key: "Enter", bubbles: true });
  await advance(220);
  assert.ok(selected.length > 0, "Enter in the box must still select the cursor row");
});

test("R4b-04 ↓ on a closed filter trigger opens its menu instead of moving the rows", async () => {
  const { dialog } = await openDialog();
  const trigger = within(dialog).getByRole("button", { name: "Filter by venue" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown", bubbles: true });
  await settle();
  assert.ok(dialog.querySelector('[role="menu"]'), "↓ on a menu button opens the menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
});

test("R4b-07 Escape closes the menu, then the dialog, and no outsider gets the key", async () => {
  /*
   * The live build took THREE presses and, on the first one, moved focus to
   * the toolbar's symbol pill — outside the modal. The cause was a
   * window-level Escape listener belonging to another component
   * (`ChartSidePanel`) running alongside the dialog's own, `preventDefault`ing
   * and restoring its own focus. A dialog is modal to the keyboard layer, so
   * this asserts it against a deliberately hostile competing listener.
   *
   * The panel-side half of R4b-07 — the dialog guard inside `ChartSidePanel`
   * itself — is another implementer's; this is the dialog's half, and it holds
   * whether or not that one lands.
   */
  const outside = document.createElement("button");
  outside.textContent = "outside";
  document.body.appendChild(outside);
  let heard = 0;
  const hostile = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    heard += 1;
    e.preventDefault();
    outside.focus();
  };
  window.addEventListener("keydown", hostile);
  try {
    let closed = 0;
    const view = render(
      <SymbolSearch open current={CURRENT} onClose={() => { closed += 1; }} onSelect={() => {}} />
    );
    await settle();
    await advance(220);
    const dialog = view.baseElement.querySelector<HTMLElement>('[role="dialog"]')!;

    fireEvent.click(within(dialog).getByRole("button", { name: "Filter by venue" }));
    await settle();
    assert.ok(dialog.querySelector('[role="menu"]'), "the venue menu did not open");

    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape", bubbles: true });
    await settle();
    assert.equal(dialog.querySelector('[role="menu"]') === null, true, "Escape 1 must close the menu");
    assert.equal(closed, 0, "Escape 1 must not close the dialog under an open menu");
    assert.equal(heard, 0, "a window listener outside the modal got a key aimed at it");
    assert.ok(dialog.contains(document.activeElement),
      "focus left the modal on the first Escape");

    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape", bubbles: true });
    await settle();
    assert.equal(closed, 1, "Escape 2 must close the dialog — two presses, not three");
    assert.equal(heard, 0);
  } finally {
    window.removeEventListener("keydown", hostile);
    outside.remove();
  }
});

test("provider failure reasons remain hover-only and never instruct the reader to hover", async () => {
  const { dialog } = await openDialog();
  const said = (dialog.textContent ?? "").replace(/\s+/g, " ");
  assert.ok(!said.includes("Hover for the reason reported"),
    "provider guidance leaked into primary copy");
  for (const name of ["Stocks", "Funds"]) {
    assert.ok(!(chip(dialog, name).getAttribute("title") ?? "").includes("Hover"),
      `${name}'s reason is a sentence, not a prompt to do what the reader is already doing`);
  }
});

test("R4b-11 / R4b-12 / R4b-14 the glyphs, the hairline and the panel's edge", async () => {
  const { dialog } = await openDialog();

  // The close glyph: 18px of a 24 viewBox at full ink, not 16px at muted.
  const close = within(dialog).getByRole("button", { name: "Close" });
  const cross = close.querySelector("svg")!;
  assert.equal(cross.getAttribute("width"), "18");
  assert.match(close.className, /text-ink\b/);
  assert.ok(!close.className.includes("text-ink-muted"),
    "the reference's × is the same ink as the title beside it");

  // The magnifier: 20px, r=8.5 — the live one measured 12×12 against 19×19.
  const magnifier = dialog.querySelector<SVGElement>("svg circle")?.parentElement;
  assert.ok(magnifier, "the box has no magnifier");
  assert.equal(magnifier.getAttribute("width"), "20");
  assert.equal(magnifier.querySelector("circle")?.getAttribute("r"), "8.5");

  // The row hairline is `--ts-state-active` (#3d3d3d), not `--ts-border`.
  const row = rowsOf(dialog)[0]!;
  assert.match(row.className, /border-\[var\(--ts-state-active\)\]/);
  assert.ok(!/border-border\b/.test(row.className));

  // The type words are 13px, not `text-xs`.
  const words = [...row.querySelectorAll<HTMLElement>("span")]
    .find((el) => /^(spot|perpetual|futures|forex|index|stock|etf)/.test(el.textContent ?? ""));
  assert.ok(words, "the row no longer says what kind of instrument it is");
  assert.match(words.className, /text-\[13px\]/);

  // The panel's shadow is a STYLE: the arbitrary-value utility never resolved,
  // so the live panel read `box-shadow: none` over the backdrop.
  assert.equal(dialog.style.boxShadow, "var(--ts-popover-shadow)");
  assert.ok(!dialog.className.includes("shadow-[var(--ts-popover-shadow)]"));

  // And each filter trigger is a 28px chip with 12px of padding.
  const trigger = within(dialog).getByRole("button", { name: "Filter by venue" });
  assert.match(trigger.className, /\bh-7\b/);
  assert.match(trigger.className, /\bpx-3\b/);
});

test("R4b-13 the middle column is the instrument, not the ticker spelled again", async () => {
  const { dialog } = await openDialog();
  const row = rowsOf(dialog)[0]!;
  const said = (row.textContent ?? "").replace(/\s+/g, " ");
  assert.match(said, /SOLUSDT/, "the ticker is still the ticker");
  assert.match(said, /Solana \/ Tether/,
    "`SOLUSDT` beside `SOL / USDT` is the identity twice on one 40px row");
  assert.ok(!said.includes("SOL / USDT"));
});

test("R4b-05 a seeded box continues what the user typed, rather than selecting over it", async () => {
  /*
   * The page-level half of this — a letter over the chart opening the dialog
   * at all — is `tests/dom/keyboard.test.tsx`. This is the dialog's half: a
   * seed is a STARTING POINT. The unseeded box opens on the chart's ticker
   * with the whole of it selected, so the next keystroke replaces it; doing
   * that to a seed would delete the letter the user had just pressed.
   */
  const view = render(
    <SymbolSearch open current={CURRENT} seed="e" onClose={() => {}} onSelect={() => {}} />
  );
  await settle();
  await advance(220);
  const box = view.baseElement.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  assert.equal(box.value, "e");
  assert.equal(box.selectionStart, 1);
  assert.equal(box.selectionEnd, 1);
  assert.equal(asked.at(-1)?.searchParams.get("q"), "e",
    "the seeded term is what the dialog searched for");
});
