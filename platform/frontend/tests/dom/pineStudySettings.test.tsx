/**
 * A Pine study's settings are a dialog, like every other study's.
 *
 * Premium opens one modal for every study. Here a built-in's gear opened
 * `NativeStudySettings` while a Pine study's gear swapped the right rail to
 * the Indicator library and unfolded a form of native controls inside its
 * card, and the card itself was titled `My Strategy · peefk` — five
 * characters of the instance's storage key. These mount the dialog and the
 * panel and read back what a user would see and what the study is told.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { PineStudySettings } from "@/components/tv/NativeStudySettings";
import { IndicatorsPanel } from "@/components/tv/IndicatorsPanel";
import { NO_DRAWINGS, type AppliedIndicator } from "@/lib/indicators";
import type { IndicatorsApi } from "@/lib/useIndicators";

beforeEach(resetBrowser);
after(closeBrowser);

function pine(over: Partial<AppliedIndicator> = {}): AppliedIndicator {
  return {
    key: "ind_k3x9qpeefk",
    scriptId: "script-1",
    name: "My Strategy",
    kind: "strategy",
    shortTitle: "",
    overlay: true,
    precision: null,
    source: "//@version=5\nstrategy(\"My Strategy\")",
    inputs: [
      { key: "len", title: "Length", type: "int", defval: 14, minval: 1, maxval: 500 },
      { key: "src", title: "Source", type: "source", defval: "close" },
      { key: "kind", title: "MA type", type: "string", defval: "EMA", options: ["EMA", "SMA"], group: "Trend" },
      { key: "show", title: "Show signals", type: "bool", defval: true, group: "Trend" },
    ],
    params: { len: 21 },
    visible: true,
    loading: false,
    error: null,
    warnings: [],
    overlays: [], decorations: [], barColors: [], markers: [], drawings: NO_DRAWINGS, trades: [],
    ...over,
  };
}

test("the dialog edits the script's own inputs, live, under the study's name", async () => {
  const calls: string[] = [];
  render(
    <PineStudySettings
      study={pine()}
      onClose={() => calls.push("close")}
      onParam={(key, param, value) => calls.push(`${key}:${param}=${JSON.stringify(value)}`)}
      onReset={(key) => calls.push(`${key}:reset`)}
    />);
  await settle();

  const dialog = screen.getByRole("dialog");
  assert.match(dialog.textContent ?? "", /My Strategy/, "titled with the study's own name");
  assert.doesNotMatch(dialog.textContent ?? "", /peefk/, "never the instance's storage key");

  /*
   * One tab. Style and Visibility are absent rather than greyed: a Pine
   * study's plots are what the script returns, and nothing in `useIndicators`
   * stores a per-plot override or a timeframe allow-list to write to.
   */
  const tabs = within(dialog).getAllByRole("tab").map((t) => t.textContent);
  assert.deepEqual(tabs, ["Inputs"]);

  // The `group=` the script declared is a heading, as the reference prints it.
  assert.match(dialog.textContent ?? "", /Trend/);

  // A number is the shared 70×28 field and reaches the study AS a number.
  const length = within(dialog).getByRole("spinbutton", { name: "Length" }) as HTMLInputElement;
  assert.equal(length.value, "21", "the field shows the override, not the declared default");
  fireEvent.change(length, { target: { value: "30" } });
  assert.deepEqual(calls.slice(-1), ['ind_k3x9qpeefk:len=30']);

  // A bool is the product's own Checkbox, not a native accent-coloured box.
  const show = within(dialog).getByRole("checkbox", { name: "Show signals" });
  fireEvent.click(show);
  assert.deepEqual(calls.slice(-1), ['ind_k3x9qpeefk:show=false']);

  // No native <select> anywhere in a dialog (contract §3).
  assert.equal(dialog.querySelectorAll("select").length, 0, "a native select is in the dialog");
});

test("W2D-09 — the Pine dialog takes the built-in dialog's one fixed box", async () => {
  render(<PineStudySettings study={pine()} onClose={() => {}} onParam={() => {}} onReset={() => {}} />);
  await settle();
  const dialog = screen.getByRole("dialog");
  assert.match(dialog.className, /!max-w-\[550px\]/);
  assert.match(dialog.className, /!h-\[min\(489px,calc\(100vh-40px\)\)\]/,
    "the same fixed height as every other study's dialog");
  assert.match(within(dialog).getByRole("tabpanel").className, /overflow-y-auto/,
    "the inputs scroll inside the box rather than growing it");
});

test("Cancel puts back exactly the overrides the study had when the dialog opened", async () => {
  const calls: string[] = [];
  render(
    <PineStudySettings
      study={pine()}
      onClose={() => calls.push("close")}
      onParam={(key, param, value) => calls.push(`${param}=${JSON.stringify(value)}`)}
      onReset={() => calls.push("reset")}
    />);
  await settle();
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Length" }), { target: { value: "30" } });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Show signals" }));
  calls.length = 0;

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  /*
   * Reset first, then the entry overrides: `show` was not overridden on
   * entry, so it must go back to its default rather than keep the new value.
   */
  assert.deepEqual(calls, ["reset", "len=21", "close"]);
});

test("Ok submits the whole draft, not only whatever live write happened to stick", async () => {
  const calls: string[] = [];
  render(
    <PineStudySettings
      study={pine()}
      onClose={() => calls.push("close")}
      onParam={(key, param, value) => calls.push(`${param}=${JSON.stringify(value)}`)}
      onReset={() => calls.push("reset")}
    />);
  await settle();
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Length" }), { target: { value: "30" } });
  calls.length = 0;
  fireEvent.click(within(dialog).getByRole("button", { name: "Ok" }));
  // B-06: the study is put exactly at the draft, whatever the live path did.
  assert.deepEqual(calls, ["reset", "len=30", "close"]);
});

function fakeIndicators(list: AppliedIndicator[], log: string[]): IndicatorsApi {
  const noop = (name: string) => (key: string) => { log.push(`${name}:${key}`); };
  return {
    list,
    add: () => "", remove: noop("remove"), clear: () => {}, toggleVisible: noop("toggle"),
    setParam: () => {}, resetParams: noop("reset"), updateSource: () => {}, rerun: noop("rerun"),
    rerunAll: () => {}, overlays: [], decorations: [], barColors: [], markers: [],
    drawings: NO_DRAWINGS, trades: null,
  } as unknown as IndicatorsApi;
}

test("the ON CHART card names the study, never its storage key", async () => {
  const log: string[] = [];
  const view = render(
    <IndicatorsPanel
      indicators={fakeIndicators([
        pine(),
        pine({ key: "ind_aaaaaqzzzz" }),
        pine({ key: "ind_bbbbbwxyz1", params: { len: 50 } }),
      ], log)}
      nativeStudies={null}
      onOpenInEditor={() => {}}
      onEditIndicator={() => log.push("editor")}
      onEditNative={() => {}}
      onEditPine={(key) => log.push(`dialog:${key}`)}
    />);
  await settle();

  const text = view.container.textContent ?? "";
  for (const fragment of ["peefk", "qzzzz", "wxyz1"]) {
    assert.ok(!text.includes(fragment), `the card printed the storage-key fragment ${fragment}`);
  }
  /*
   * Two instances with the same title AND the same inputs are told apart by
   * the legend's own ordinal; the third has different inputs and needs none.
   */
  assert.match(text, /My Strategy \(1\)/);
  assert.match(text, /My Strategy \(2\)/);
  assert.equal((text.match(/My Strategy(?! \()/g) ?? []).length >= 1, true,
    "an instance with its own inputs is just its title");

  // The card's menu `Settings…` opens the dialog, not the Pine editor.
  const card = screen.getByText("My Strategy (1)").closest("div.mb-1") as HTMLElement;
  fireEvent.contextMenu(card, { clientX: 20, clientY: 20 });
  await settle();
  fireEvent.click(screen.getByRole("menuitem", { name: /Settings/ }));
  await settle();
  assert.deepEqual(log.filter((l) => l.startsWith("dialog") || l === "editor"),
    ["dialog:ind_k3x9qpeefk"], "Settings… opened the editor, which is what Open source is for");
});
