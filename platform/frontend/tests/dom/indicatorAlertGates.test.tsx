/**
 * B-06: an indicator alert dialog opens with only its own gates — none.
 *
 * Reproduced by an independent reviewer: Add alert on RSI → add gate
 * conditions → Create; then "Add alert on MACD…" from the MACD legend, and the
 * new dialog arrived pre-populated with the RSI dialog's gates. The dialog
 * stays mounted between opens and reset its timeframes and the study's inputs
 * (C-04) but not the gates. The study's own inputs must still seed.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { IndicatorAlertModal, type IndicatorKind } from "@/components/tv/IndicatorAlertModal";
import type { IndicatorAlertSeed } from "@/lib/studyAlertSeed";
import type { Interval } from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);

/** Expand the gate list if it is folded, then add one gate. */
function addGate(): void {
  const folded = screen.queryByRole("button", { name: /^Add a condition \(optional\)/ });
  if (folded) fireEvent.click(folded);
  fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
}

const gateRows = (): HTMLElement[] =>
  screen.queryAllByRole("button", { name: /^Remove gate \d+$/ });

function dialog(open: boolean, kind: IndicatorKind, seed: IndicatorAlertSeed | null) {
  return (
    <IndicatorAlertModal open={open} onClose={() => undefined} symbol="SOLUSDT"
      defaultTimeframe={"15m" as Interval} resolutionNotice={null}
      kind={kind} seed={seed} existing={[]} onSaved={() => undefined} />
  );
}

test("B-06 — THE MACD DIALOG DOES NOT INHERIT THE RSI DIALOG'S GATES", async () => {
  const view = render(dialog(true, "rsi", { rsiLength: 21, differs: null }));
  await settle();
  addGate();
  addGate();
  await settle();
  assert.equal(gateRows().length, 2, "the fixture needs two gates on the RSI alert");

  // Closed (as Create closes it), then opened from the MACD legend.
  view.rerender(dialog(false, "rsi", { rsiLength: 21, differs: null }));
  await settle();
  view.rerender(dialog(true, "macd", { macdFast: 8, macdSlow: 21, macdSignal: 5, differs: null }));
  await settle();

  assert.equal(gateRows().length, 0, "the RSI alert's gates arrived on the MACD alert");
  // C-04 still holds: the clicked study's own inputs seed the dialog.
  const fast = screen.getByRole("spinbutton", { name: "Fast length" }) as HTMLInputElement;
  assert.equal(fast.value, "8", "the MACD study's own inputs must still seed the dialog");
});

test("B-06 — A NEW SEED WHILE OPEN STARTS WITHOUT GATES TOO", async () => {
  const view = render(dialog(true, "macd", { macdFast: 12, differs: null }));
  await settle();
  addGate();
  await settle();
  assert.equal(gateRows().length, 1);
  view.rerender(dialog(true, "macd", { macdFast: 9, differs: null }));
  await settle();
  assert.equal(gateRows().length, 0, "a different study's seed kept the previous gates");
});
