/**
 * A price alert is armed at a level you chose, not at the one the market
 * happened to be at when you stopped typing.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * `PriceAlertModal` seeds its draft — the level, the gates, the note, the
 * frequency, whether it is armed, the cooldown — in one effect, and that
 * effect listed `lastPrice` among its dependencies. `lastPrice` is the LIVE
 * quote. So the "seed the dialog when it opens" effect re-ran on every tick
 * and re-seeded a dialog the user was in the middle of filling in.
 *
 * Measured on the running build: typing 95000 into the level and waiting
 * showed 81,024.01 three seconds later, with the caret still in the field.
 * Adding a gate showed the row for about 1.4 seconds before it vanished —
 * `setFilters(emptyFilters())` firing on the next tick. Every other field went
 * the same way. The dialog could only produce the alert it had already
 * pre-filled, which made the multi-gate model — the whole point of the gate
 * work — unreachable from the UI it shipped with.
 *
 * The effect's own comment is about making sure it resets EVERYTHING on
 * reopen, and it does. The defect is the word "reopen": with the live quote in
 * the dependency list, "reopen" happened several times a second.
 *
 * ── What these tests pin ──────────────────────────────────────────────────
 *
 * That a tick is not a reopen. The dialog seeds once per opening, and after
 * that the draft belongs to the person typing it.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { PriceAlertModal } from "@/components/tv/PriceAlertModal";
import type { Interval } from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);

/** The dialog, at one quote. Re-render with another to simulate a tick. */
const dialog = (lastPrice: number) => (
  <PriceAlertModal
    open
    onClose={() => undefined}
    symbol="SOLUSDT"
    chartTimeframe={"15m" as Interval}
    resolutionNotice={null}
    initialPrice={null}
    lastPrice={lastPrice}
    lastPriceNotice={null}
    existing={[]}
    onPickFromChart={() => undefined}
    onSaved={() => undefined}
  />
);

const level = (): HTMLInputElement =>
  screen.getByLabelText("Alert price level") as HTMLInputElement;

test("a quote tick does not overwrite the level the user typed", async () => {
  const view = render(dialog(100));
  await settle();

  // It seeds from the quote, which is right, and is why the bug was invisible
  // until someone typed.
  assert.equal(level().value, "100");

  fireEvent.change(level(), { target: { value: "95000" } });
  await settle();
  assert.equal(level().value, "95000");

  // Three ticks, as the market moves. None of them is a reopen.
  for (const quote of [101, 102.5, 103]) {
    view.rerender(dialog(quote));
    await settle();
  }

  assert.equal(level().value, "95000",
    "the live quote was written back over the level the user chose");
});

test("a quote tick does not delete a gate the user added", async () => {
  const view = render(dialog(100));
  await settle();

  // Three steps, because the gates are off by default and say so twice: the
  // dialog reveals the field, the field offers to start a list, the list adds
  // a row.
  fireEvent.click(screen.getByRole("button", { name: /Add condition/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Add a condition \(optional\)/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
  await settle();

  // One gate row, named for the row it belongs to.
  assert.ok(screen.queryByRole("button", { name: "Gate 1 kind" }),
    "the gate row was not added at all");

  view.rerender(dialog(101));
  await settle();

  assert.ok(screen.queryByRole("button", { name: "Gate 1 kind" }),
    "a quote tick emptied the gate list the user had just built");
});

test("a quote tick does not reset the note or the cooldown", async () => {
  const view = render(dialog(100));
  await settle();

  // The note lives behind the Message disclosure.
  fireEvent.click(screen.getByRole("button", { name: /Message/ }));
  await settle();
  const note = screen.getByLabelText("Alert note") as HTMLTextAreaElement;
  fireEvent.change(note, { target: { value: "watch the open" } });
  await settle();

  view.rerender(dialog(101));
  await settle();

  assert.equal((screen.getByLabelText("Alert note") as HTMLTextAreaElement).value,
    "watch the open", "a quote tick cleared the note");
});

test("reopening the dialog DOES reseed it, which is what the effect is for", async () => {
  const view = render(dialog(100));
  await settle();
  fireEvent.change(level(), { target: { value: "95000" } });
  await settle();

  // Close, then open again on a new quote. The previous level must not carry.
  view.rerender(
    <PriceAlertModal
      open={false} onClose={() => undefined} symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval} resolutionNotice={null}
      initialPrice={null} lastPrice={100} lastPriceNotice={null} existing={[]}
      onPickFromChart={() => undefined} onSaved={() => undefined}
    />,
  );
  await settle();
  view.rerender(dialog(250));
  await settle();

  assert.equal(level().value, "250",
    "reopening must seed from the quote it opened on, not keep the last level");
});
