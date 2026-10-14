/**
 * Typing into an alert dialog's number box keeps the caret in that box.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * Typing "30" into a length took two clicks: the "3" landed, the box lost
 * focus, and the "0" went nowhere. Every number box in the indicator, level
 * and MA alert dialogs did it, and so did both automation dialogs.
 *
 * Each of those dialogs declared its layout wrapper INSIDE its own render:
 *
 *     const Row = ({ label, children }) => <div>…{children}</div>;
 *
 * A function created during render is a new component TYPE on every render.
 * React compares element types by identity, so after the first keystroke's
 * state update it saw a different `Row`, unmounted the old subtree — the
 * focused <input> included — and mounted a fresh one. The DOM node holding
 * the caret was gone; the new one had never been focused.
 *
 * ── What these tests pin ──────────────────────────────────────────────────
 *
 * For every number box in each dialog: after a keystroke, the SAME node is
 * still in the document and still has focus. Checking the value alone would
 * pass on the broken code — React re-renders the new node with the new value —
 * which is why this bug survived every test that only read values back.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { IndicatorAlertModal } from "@/components/tv/IndicatorAlertModal";
import { LevelAlertModal } from "@/components/tv/LevelAlertModal";
import { MaAlertModal } from "@/components/tv/MaAlertModal";
import type { Interval } from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);

const noop = () => undefined;
const TF = "15m" as Interval;

/** Type one more character into every number box and check none is replaced. */
async function eachNumberBoxKeepsFocus(dialogName: string): Promise<void> {
  const boxes = screen.getAllByRole("spinbutton") as HTMLInputElement[];
  assert.ok(boxes.length > 0, `${dialogName}: no number boxes rendered`);
  for (const box of boxes) {
    const label = box.getAttribute("aria-label") ?? box.closest("div")?.textContent?.trim() ?? "?";
    box.focus();
    assert.equal(document.activeElement, box, `${dialogName}: could not focus "${label}"`);
    fireEvent.change(box, { target: { value: `${box.value}1` } });
    await settle();
    assert.ok(box.isConnected,
      `${dialogName}: typing into "${label}" REPLACED the box — the caret was lost`);
    assert.equal(document.activeElement, box,
      `${dialogName}: typing into "${label}" took focus away from it`);
  }
}

for (const kind of ["rsi", "macd", "supertrend", "bollinger", "stochastic", "adx"] as const) {
  test(`indicator alert (${kind}): every number box keeps focus while typing`, async () => {
    render(
      <IndicatorAlertModal open onClose={noop} symbol="SOLUSDT" defaultTimeframe={TF}
        kind={kind} existing={[]} onSaved={noop} />,
    );
    await settle();
    await eachNumberBoxKeepsFocus(`IndicatorAlertModal/${kind}`);
  });
}

for (const initialKind of ["sr_zone", "pivot_level"] as const) {
  test(`level alert (${initialKind}): every number box keeps focus while typing`, async () => {
    render(
      <LevelAlertModal open onClose={noop} symbol="SOLUSDT" defaultTimeframe={TF}
        initialKind={initialKind} existing={[]} onSaved={noop} />,
    );
    await settle();
    await eachNumberBoxKeepsFocus(`LevelAlertModal/${initialKind}`);
  });
}

test("moving-average alert: every number box keeps focus while typing", async () => {
  render(
    <MaAlertModal open onClose={noop} symbol="SOLUSDT" chartTimeframe={TF}
      maType="ema" maLength={50} existing={[]} onSaved={noop} />,
  );
  await settle();
  await eachNumberBoxKeepsFocus("MaAlertModal");
});

/*
 * The cause, guarded at the source for every dialog — including the two
 * automation dialogs, which need a deployment fixture to render. A component
 * declared inside a component's body is the pattern; a plain helper that
 * returns JSX but is CALLED (`{row(...)}`) rather than rendered (`<Row/>`) is
 * fine, which is why this looks for capitalised names only.
 */
test("no alert dialog declares a component inside its own render", () => {
  const dir = path.join(process.cwd(), "components", "tv");
  const files = ["IndicatorAlertModal", "LevelAlertModal", "MaAlertModal", "PriceAlertModal",
    "AlertEditor", "AlertModal", "EditAlertModal", "AlertFiltersField", "AlertScopeField",
    "BulkEditAlertsModal"];
  const offenders: string[] = [];
  for (const name of files) {
    const src = fs.readFileSync(path.join(dir, `${name}.tsx`), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/^\s{2,}const [A-Z][A-Za-z0-9]* = \(/.test(line)) offenders.push(`${name}.tsx:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    "a component created during render is a new type each render, and remounts its inputs");
});
