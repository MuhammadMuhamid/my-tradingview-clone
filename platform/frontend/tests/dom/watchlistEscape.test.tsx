/**
 * Escape closes the INNERMOST open thing.
 *
 * ── TVP8 R7b-06 ────────────────────────────────────────────────────────────
 *
 * `ChartSidePanel` listens for Escape on `window` and closes the whole 300px
 * column. `ContextMenu` stops propagation, so the row menu was unaffected —
 * but the watchlist's list dropdown was a plain `div[role=menu]` with no key
 * handling at all, and the add-symbol field handled Escape without stopping
 * it. So dismissing either ALSO closed the panel they live in.
 *
 * That is not a cosmetic slip. It is what killed the reviewer's temp-list
 * step: they opened the list menu, pressed Escape to back out, and the panel
 * went with it — `finalRows: []`, and `final-state-1440.png` shows no panel at
 * all. Every measurement that step was meant to produce was lost.
 *
 * ── Why all three cases ────────────────────────────────────────────────────
 *
 * Because the repair has to be a rule and not two patches. The third case is
 * the one that proves the fix did not simply disable the panel's Escape: with
 * nothing open, Escape must STILL close the panel, which is the behaviour the
 * rail's own toggle mirrors and which `sidePanelDefault` depends on.
 *
 * Run against the repair reverted, (i) and (ii) fail on their second
 * assertion — the menu or the field is gone, and so is `[data-watchlist]`.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { assertAbsent, assertPresent, closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { CANONICAL } from "./harness/market";

beforeEach(() => {
  resetBrowser();
  server.setCandles("SOLUSDT", "15m", compactSeries(300));
  server.seedWatchlist([CANONICAL.SOLUSDT!, CANONICAL.BTCUSDT!]);
});
after(closeBrowser);

const panel = (container: HTMLElement): Element | null =>
  container.querySelector("[data-watchlist]");

test("R7b-06 — Escape in the list menu closes the MENU, and leaves the panel open", async () => {
  const chart = await mountChart();
  await settle();
  assertPresent(panel(chart.container), "the watchlist panel is not open to begin with");

  const name = [...chart.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.getAttribute("aria-haspopup") === "menu"
      && (b.textContent ?? "").includes("Main Watchlist"));
  assert.ok(name, "the header has no list-name button to open the list menu from");
  fireEvent.click(name);
  await settle();

  const menu = screen.getByRole("menu", { name: "My watchlists" });
  fireEvent.keyDown(menu, { key: "Escape", bubbles: true });
  await settle();

  assertAbsent(screen.queryByRole("menu", { name: "My watchlists" }),
    "Escape did not close the list menu");
  assertPresent(panel(chart.container),
    "Escape closed the whole watchlist column as well as the menu it was aimed at");
});

test("R7b-06 — Escape in the add field closes the FIELD, and leaves the panel open", async () => {
  const chart = await mountChart();
  await settle();

  const open = chart.container.querySelector<HTMLElement>(
    'button[aria-label="Add a symbol to this list"]');
  assert.ok(open, "the watchlist offers no way to add a symbol");
  fireEvent.click(open);
  await settle();

  const box = screen.getByRole("textbox", { name: "Add a symbol to this watchlist" });
  fireEvent.keyDown(box, { key: "Escape", bubbles: true });
  await settle();

  assertAbsent(screen.queryByRole("textbox", { name: "Add a symbol to this watchlist" }),
    "Escape did not close the add field");
  assertPresent(panel(chart.container),
    "Escape closed the whole watchlist column as well as the field it was aimed at");
});

test("R7b-06 — and with nothing open, Escape still closes the panel", async () => {
  /*
   * The guard against over-correcting. A repair that simply removed the
   * panel's window-level Escape would pass both tests above and break the
   * behaviour the rail's toggle mirrors.
   */
  const chart = await mountChart();
  await settle();
  assertPresent(panel(chart.container), "the watchlist panel is not open to begin with");

  fireEvent.keyDown(window, { key: "Escape" });
  await settle();

  assertAbsent(panel(chart.container),
    "Escape with nothing open must still close the panel");
});

/**
 * ── TVP8 R7b-15: the accent came back through the focus ring ───────────────
 *
 * R7-12 replaced a 29px input with a 2px ACCENT border and a filled-blue `Add`
 * button with a neutral 34px search row — and the accent returned the moment
 * the field opened, because the field AUTOFOCUSES and the global
 * `:focus-visible` rule paints a 2px rgb(79,140,255) outline on anything that
 * holds keyboard focus. The contract reserves that colour for meaning;
 * "this field is where you are typing" is state, and state in this product is
 * a neutral chip.
 *
 * Asserted as classes because jsdom applies no stylesheet: `getComputedStyle`
 * here returns the empty default for every element on the page, so a computed
 * assertion would pass with the repair deleted.
 */
test("R7b-15 — the autofocused add field wears a neutral focus, not the accent outline", async () => {
  const chart = await mountChart();
  await settle();

  const open = chart.container.querySelector<HTMLElement>(
    'button[aria-label="Add a symbol to this list"]');
  assert.ok(open, "the watchlist offers no way to add a symbol");
  fireEvent.click(open);
  await settle();

  const box = screen.getByRole("textbox", { name: "Add a symbol to this watchlist" });
  assert.equal(box.className.includes("focus-visible:outline-none"), true,
    "the global focus ring is the accent, and this field opens already focused");
  const wrapper = box.parentElement;
  assert.ok(wrapper, "the field has no wrapper to carry its focus state");
  assert.equal(wrapper.className.includes("focus-within:border-[color:var(--ts-control-border-strong)]"),
    true, "focus has to be visible — as the strong NEUTRAL, which is the grammar every other chip uses");
});
