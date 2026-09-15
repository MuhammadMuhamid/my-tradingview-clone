/**
 * The built-in study's settings dialog, driven the way a person drives it.
 *
 * ── What R6b measured (R6b-29), and what each test holds ───────────────────
 *
 * Against `measurements/tv-indicator-settings-20260914.md` the RSI dialog was
 * 512 wide with a 12px description PARAGRAPH the reference does not have, two
 * 28px chip tabs and no Visibility tab at all, a 310×34 native number box and
 * a 310×34 native `<select>` for `Source`, a 16px ACCENT-filled switch for the
 * plot (a second definition of "checkbox" in a product that already has one,
 * in the one use of accent the contract forbids), a ten-cell 20px palette, two
 * 22px native selects, and a `Reset to defaults` 135×30 / `Done` 67×28 footer
 * with NO Cancel — every keystroke was committed through `onParam` as it was
 * typed, so there was nothing to revert to.
 *
 * The dialog is driven directly rather than through the chart because the
 * dialog IS the subject: the real component, the real registry, the real
 * primitives, and a real applied RSI whose params and styles are held here the
 * way `useNativeStudies` holds them.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { NativeStudySettings } from "@/components/tv/NativeStudySettings";
import type { AppliedNativeStudy, PlotStyleOverride } from "@/lib/native/compute";
import type { NativeInputValue } from "@/lib/native/registry";
import type { Resolution } from "@/lib/resolution";

beforeEach(resetBrowser);
after(closeBrowser);

const RSI: AppliedNativeStudy = {
  key: "rsi-1", defId: "rsi",
  params: { length: 14, source: "close" },
  visible: true, styles: {},
};

/** The dialog with a real store behind it, as the pane gives it one. */
function Harness({ onRead }: { onRead: (study: AppliedNativeStudy) => void }) {
  const [study, setStudy] = useState<AppliedNativeStudy>(RSI);
  onRead(study);
  return (
    <NativeStudySettings
      study={study}
      onClose={() => {}}
      onParam={(_k, param, value: NativeInputValue) =>
        setStudy((s) => ({ ...s, params: { ...s.params, [param]: value } }))}
      onStyle={(_k, plotId, style: PlotStyleOverride) =>
        setStudy((s) => ({ ...s, styles: { ...s.styles, [plotId]: { ...s.styles[plotId], ...style } } }))}
      onDisplay={(_k, patch) => setStudy((s) => ({ ...s, ...patch }))}
      onReset={() => setStudy(RSI)}
      onVisibleOn={(_k, visibleOn: Resolution[] | undefined) =>
        setStudy((s) => ({ ...s, visibleOn }))}
    />
  );
}

async function openRsi(): Promise<{ dialog: HTMLElement; study: () => AppliedNativeStudy }> {
  let latest: AppliedNativeStudy = RSI;
  render(<Harness onRead={(s) => { latest = s; }} />);
  await settle();
  return { dialog: screen.getByRole("dialog"), study: () => latest };
}

test("R6b-29 — the study dialog is Inputs / Style / Visibility at 550, with no prose", async () => {
  const { dialog } = await openRsi();

  assert.deepEqual(
    [...dialog.querySelectorAll('[role="tab"]')].map((t) => (t.textContent ?? "").trim()),
    ["Inputs", "Style", "Visibility"],
    "the reference has three TEXT tabs; this had two chips and no Visibility");

  assert.match(dialog.className, /max-w-\[550px\]/, "the reference's dialog is 550 wide, not 512");

  /*
   * The description paragraph. The reference's study dialog carries no prose
   * at all, and `Average gain against average loss…` sat above the tabs.
   */
  assert.equal(dialog.querySelectorAll("p").length, 0);

  // And no operating-system controls anywhere in it.
  assert.equal(dialog.querySelectorAll("select").length, 0,
    "`Source` was a 310×34 native select — the OS popup, in this product's dialog");
});

test("R6b-29 — Length is a 70×28 number field and Source a listbox", async () => {
  const { study } = await openRsi();

  const length = screen.getByRole("spinbutton", { name: "Length" }) as HTMLInputElement;
  assert.equal(length.value, "14");
  assert.match(length.className, /h-\[28px\]/, "the reference's number fields are 70×28");
  fireEvent.change(length, { target: { value: "21" } });
  await settle();
  assert.equal(study().params.length, 21, "live apply, as the reference does");

  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  await settle();
  const list = screen.getByRole("listbox", { name: "Source" });
  assert.ok(within(list).getByRole("option", { name: "Close" }));
  fireEvent.click(within(list).getByRole("option", { name: "HLC3" }));
  await settle();
  assert.equal(study().params.source, "hlc3");
});

test("R6b-29 — the Style tab's plot checkbox is the product's, not an accent switch", async () => {
  const { study } = await openRsi();
  fireEvent.click(screen.getByRole("tab", { name: "Style" }));
  await settle();

  const box = screen.getByRole("checkbox", { name: "RSI" }) as HTMLInputElement;
  assert.equal(box.checked, true);
  /*
   * The contract's own rule, made checkable: CHECKED is the contrast fill —
   * the same inversion as `Button variant="contrast"` and the selected menu
   * row — and never `bg-accent`. One product, one checkbox.
   */
  assert.match(box.className, /checked:bg-\[var\(--ts-menu-selected-bg\)\]/);
  assert.doesNotMatch(box.className, /bg-accent/);

  // The colour and the line are one swatch and one 75×34 button, not a palette.
  assert.ok(screen.getByRole("button", { name: "RSI colour" }));
  assert.ok(screen.getByRole("button", { name: "RSI line" }));
  assert.ok(screen.getByRole("button", { name: "RSI plot style" }));

  fireEvent.click(box);
  await settle();
  assert.equal(study().styles.rsi?.visible, false);
});

test("R6b-29 — Cancel restores the study the dialog opened on; the footer has one", async () => {
  const { study } = await openRsi();
  const length = screen.getByRole("spinbutton", { name: "Length" }) as HTMLInputElement;
  fireEvent.change(length, { target: { value: "21" } });
  await settle();
  assert.equal(study().params.length, 21);

  const cancel = screen.getByRole("button", { name: "Cancel" });
  assert.ok(cancel, "there was no Cancel at all — every keystroke was committed");
  fireEvent.click(cancel);
  await settle();
  assert.equal(study().params.length, 14,
    "Cancel puts back the params the dialog opened on");
});

test("R6b-29 — Visibility writes the study's own timeframe allow-list", async () => {
  const { study } = await openRsi();
  fireEvent.click(screen.getByRole("tab", { name: "Visibility" }));
  await settle();

  for (const unit of ["Seconds", "Minutes", "Hours", "Days"]) {
    assert.ok(screen.getByRole("checkbox", { name: unit }));
    assert.ok(screen.getByRole("spinbutton", { name: `${unit} from` }));
  }
  assert.equal(study().visibleOn, undefined, "absent means every timeframe");

  fireEvent.click(screen.getByRole("checkbox", { name: "Seconds" }));
  await settle();
  const on = study().visibleOn;
  assert.ok(on && on.length > 0, "a narrowed visibility is stored on the study");
  assert.ok(!on!.includes("1s"));
  assert.ok(on!.includes("1h"));
});

test("R6b-29 — the footer's left control is `Defaults ▾`", async () => {
  await openRsi();
  const trigger = screen.getByRole("button", { name: "Study defaults" });
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu",
    "a menu, the same shape and width as Chart settings' `Template ▾` beside it");
  fireEvent.click(trigger);
  await settle();
  assert.ok(within(screen.getByRole("menu", { name: "Study defaults" }))
    .getByRole("menuitem", { name: "Reset to defaults" }));
});

test("C-07 — Style exposes persisted output/input display controls and Cancel restores them", async () => {
  const { study } = await openRsi();
  fireEvent.click(screen.getByRole("tab", { name: "Style" }));
  await settle();

  assert.ok(screen.getByText("Output values"));
  assert.ok(screen.getByText("Input values"));
  fireEvent.click(screen.getByRole("button", { name: "Precision" }));
  await settle();
  fireEvent.click(within(screen.getByRole("listbox", { name: "Precision" }))
    .getByRole("option", { name: "3" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Labels on price scale" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Values in status line" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Inputs in status line" }));
  await settle();

  assert.equal(study().precision, 3);
  assert.equal(study().labelsOnPriceScale, false);
  assert.equal(study().valuesInStatusLine, false);
  assert.equal(study().inputsInStatusLine, false);

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle();
  assert.equal(study().precision, undefined);
  assert.equal(study().labelsOnPriceScale, undefined);
  assert.equal(study().valuesInStatusLine, undefined);
  assert.equal(study().inputsInStatusLine, undefined);
});
