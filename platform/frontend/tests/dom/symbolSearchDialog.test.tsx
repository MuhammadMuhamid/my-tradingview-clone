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
import { fireEvent, within } from "@testing-library/react";
import { advance, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { CANONICAL, searchResponse } from "./harness/market";
import { SymbolSearch } from "@/components/tv/SymbolSearch";

/** The chart's instrument, and the one the box must open on. */
const CURRENT = CANONICAL.SOLUSDT!;

/**
 * What the running installation's `errors` array looks like today.
 *
 * The equities provider is in it, because that is what makes `Stocks` and
 * `Funds` a truthful disabled capability rather than a hidden one.
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

test("a class whose only provider is down is offered, disabled, and says why", async () => {
  const { dialog } = await openDialog();
  for (const name of ["Stocks", "Funds"]) {
    const control = chip(dialog, name);
    assert.equal(control.getAttribute("aria-disabled"), "true",
      `${name} must be present and disabled — hiding it makes a capability blink out of existence`);
    const why = control.getAttribute("title") ?? "";
    assert.match(why, /unavailable/);
    assert.ok(!why.includes("alpaca-us-equities"), "the reason is a sentence, not a provider id");
  }
  // And a class many venues carry is untouched by one of them failing.
  assert.equal(chip(dialog, "Crypto").getAttribute("aria-disabled"), null);
  assert.equal(chip(dialog, "Crypto").getAttribute("aria-pressed"), "true",
    "the dialog opens on the class of the instrument the chart is showing");
});

test("the footer counts the failing sources and names them by venue, on demand", async () => {
  const { dialog } = await openDialog();
  const indicator = within(dialog).getByRole("status", { name: "3 sources unavailable" });
  assert.match(indicator.textContent ?? "", /3 sources unavailable/);

  fireEvent.click(indicator);
  await settle();
  const popover = (dialog.textContent ?? "").replace(/\s+/g, " ");
  for (const label of ["Alpaca U.S. Equities", "Bybit", "Binance derivatives"]) {
    assert.ok(popover.includes(label), `${label} is not named in the popover`);
  }
  for (const failure of FAILURES) {
    assert.ok(!popover.includes(failure.providerId), "the popover names venues, not provider ids");
  }
});

test("the rows are buttons that carry the ticker, with the chart's instrument first", async () => {
  const { dialog } = await openDialog();
  const rows = rowsOf(dialog);
  const first = rows[0]!;

  // `scripts/ts-state-btc1h.mjs` and the keyboard both depend on this shape.
  for (const row of rows) assert.equal(row.tagName, "BUTTON");
  assert.match(first.textContent ?? "", /SOLUSDT/);
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
