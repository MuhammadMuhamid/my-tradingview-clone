/** Focused acceptance coverage for TVP8 Fable repair Wave C. */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { FAVOURITES_KEY } from "@/lib/native/catalog";
import { loadStoredNative, saveStoredNative } from "@/lib/native/storage";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

async function openIndicators(): Promise<HTMLElement> {
  fireEvent.click(screen.getAllByRole("button", { name: "Indicators" })[0]!);
  await settle();
  return screen.getByRole("dialog", { name: "Indicators, metrics, and strategies" });
}

test("C-01/C-02 — a starred built-in persists, appears in Favorites, and inserts from the toolbar", async () => {
  const chart = await mountChart();
  let dialog = await openIndicators();

  fireEvent.click(within(dialog).getByRole("button", {
    name: "Favourite Relative Strength Index",
  }));
  await settle();
  assert.deepEqual(JSON.parse(window.localStorage.getItem(FAVOURITES_KEY) ?? "[]"), ["rsi"]);

  fireEvent.click(within(dialog).getByRole("button", { name: "Favorites" }));
  await settle();
  assert.ok(within(dialog).getByRole("button", { name: "Relative Strength Index" }));

  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Favorite indicators" }));
  await settle();
  const menu = screen.getByRole("menu", { name: "Favorite indicators" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Relative Strength Index" }));
  await settle();
  assert.ok(chart.container.querySelector("section[aria-label='Relative Strength Index indicator pane']"),
    "the toolbar favourite must call the real study insertion path");

  dialog = await openIndicators();
  fireEvent.click(within(dialog).getByRole("button", { name: "Favorites" }));
  await settle();
  fireEvent.click(within(dialog).getByRole("button", {
    name: "Unfavourite Relative Strength Index",
  }));
  await settle();
  assert.equal(within(dialog).queryByRole("button", { name: "Relative Strength Index" }) === null, true);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(FAVOURITES_KEY) ?? "[]"), []);
});

test("C-07 — per-study display settings survive the native-study storage round trip", () => {
  saveStoredNative([{
    key: "rsi-display", defId: "rsi", params: { length: 14, source: "close" },
    visible: true, styles: {}, precision: 3, labelsOnPriceScale: false,
    valuesInStatusLine: false, inputsInStatusLine: false,
  }]);
  const restored = loadStoredNative()[0]!;
  assert.equal(restored.precision, 3);
  assert.equal(restored.labelsOnPriceScale, false);
  assert.equal(restored.valuesInStatusLine, false);
  assert.equal(restored.inputsInStatusLine, false);
});
