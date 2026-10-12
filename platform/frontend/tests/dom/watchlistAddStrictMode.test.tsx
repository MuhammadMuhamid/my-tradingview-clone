/**
 * The watchlist's add box answers under React StrictMode.
 *
 * Final-closure finding (Fable): the box kept a `live` flag that its effect
 * cleanup cleared and nothing ever set again. StrictMode — on in this app's
 * `next.config` — mounts, cleans up and mounts every component in dev, so
 * after the first mount the flag was false for good: every search answer was
 * discarded, "Searching…" never cleared and Enter added nothing.
 */
import { StrictMode } from "react";
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { WatchlistAddBox } from "@/components/tv/WatchlistAddBox";

beforeEach(() => resetBrowser());
after(closeBrowser);

test("search results arrive and Enter adds the top row, under StrictMode", async () => {
  const added: string[] = [];
  render(
    <StrictMode>
      <WatchlistAddBox
        onAdd={async (row) => { added.push(row.symbol); return true; }}
        onClose={() => {}} />
    </StrictMode>,
  );
  const field = screen.getByRole("textbox", { name: "Add a symbol to this watchlist" });
  fireEvent.change(field, { target: { value: "eth" } });
  for (let i = 0; i < 20 && screen.queryAllByRole("option").length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    await settle(1);
  }
  assert.ok(screen.queryAllByRole("option").length > 0, "no search result rendered under StrictMode");
  assert.equal(screen.queryByText("Searching…") === null, true, "the box is still Searching…");
  fireEvent.keyDown(field, { key: "Enter" });
  await settle(3);
  assert.equal(added.length, 1, "Enter added nothing");
});
