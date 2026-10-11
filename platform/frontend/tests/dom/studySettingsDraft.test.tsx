/**
 * A study dialog's edits survive every tab, and Ok applies all of them.
 *
 * B-06: ATR settings → Length 30 → the Style tab → Ok left the legend and the
 * plot at the OLD length (and so did tabbing to `Defaults`), while Inputs → Ok
 * applied. Premium applies every tab's edits on Ok. Driven through the whole
 * workspace, because the defect is in what reaches the pane, not in what the
 * dialog draws.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { advance, closeBrowser, compactSeries, render, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { NativeStudySettings } from "@/components/tv/NativeStudySettings";
import {
  DEFAULT_PROPERTIES, StrategySettingsModal, type StrategyProperties,
} from "@/components/tv/StrategySettingsModal";
import type { AppliedNativeStudy, PlotStyleOverride } from "@/lib/native/compute";
import type { NativeInputValue } from "@/lib/native/registry";
import type { Resolution } from "@/lib/resolution";

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(600));
});
after(closeBrowser);

async function openAtrSettings(): Promise<HTMLElement> {
  window.localStorage.setItem("tv.nativeStudies.v1", JSON.stringify([{
    key: "atr-1", defId: "atr", params: { length: 14 }, visible: true, styles: {},
  }]));
  await mountChart();
  await settle();
  const gear = screen.getAllByRole("button", { name: /Average True Range settings$/ })[0];
  assert.ok(gear, "the ATR legend offers no settings gear");
  fireEvent.click(gear);
  await settle();
  return screen.getByRole("dialog");
}

/** What the pane's legend says the study's inputs are. */
function legendParams(): string {
  const title = [...document.querySelectorAll<HTMLElement>("[title]")]
    .find((el) => /^Average True Range\b/.test(el.getAttribute("title") ?? ""));
  return title?.getAttribute("title") ?? "";
}

for (const route of ["the Style tab", "the Visibility tab"] as const) {
  test(`B-06 — a Length typed on Inputs survives ${route} and lands on Ok`, async () => {
    const dialog = await openAtrSettings();
    const length = within(dialog).getByRole("spinbutton", { name: /Length/ });
    fireEvent.change(length, { target: { value: "30" } });
    await settle();
    fireEvent.click(within(dialog).getByRole("tab", { name: route === "the Style tab" ? "Style" : "Visibility" }));
    await settle();
    fireEvent.click(within(dialog).getByRole("button", { name: "Ok" }));
    await settle();
    await advance(1000);
    assert.match(legendParams(), /30/, `the legend still reads ${JSON.stringify(legendParams())}`);
    const stored = JSON.parse(window.localStorage.getItem("tv.nativeStudies.v1") ?? "[]");
    assert.equal(stored[0]?.params?.length, 30, "the pane kept the old length");
  });
}

test("B-06 — a Length typed and then left for the footer still lands on Ok", async () => {
  const dialog = await openAtrSettings();
  const length = within(dialog).getByRole("spinbutton", { name: /Length/ });
  fireEvent.change(length, { target: { value: "30" } });
  fireEvent.blur(length);
  within(dialog).getByRole("button", { name: "Study defaults" }).focus();
  await settle();
  fireEvent.click(within(dialog).getByRole("button", { name: "Ok" }));
  await settle();
  await advance(1000);
  assert.match(legendParams(), /30/, `the legend still reads ${JSON.stringify(legendParams())}`);
});

/*
 * The mechanism, isolated. The workspace tests above pass in jsdom whether or
 * not the dialog keeps a draft, because there every live write sticks. Live,
 * one did not: something re-delivered the study at its OLD params between the
 * keystroke and Ok, and the dialog — which drew each tab from the prop and
 * submitted nothing on Ok — then showed and kept the old length. This store
 * does exactly that: it applies every write, and the test re-delivers the
 * entry state underneath the open dialog.
 */
function LossyHarness({ onRead, revert }: {
  onRead: (s: AppliedNativeStudy) => void;
  revert: (fn: () => void) => void;
}) {
  const [study, setStudy] = useState<AppliedNativeStudy>(ATR);
  onRead(study);
  revert(() => setStudy((s) => ({ ...s, params: { ...ATR.params } })));
  return (
    <NativeStudySettings
      study={study}
      onClose={() => {}}
      onParam={(_k, param, value: NativeInputValue) =>
        setStudy((s) => ({ ...s, params: { ...s.params, [param]: value } }))}
      onStyle={(_k, plotId, style: PlotStyleOverride) =>
        setStudy((s) => ({ ...s, styles: { ...s.styles, [plotId]: { ...s.styles[plotId], ...style } } }))}
      onDisplay={(_k, patch) => setStudy((s) => ({ ...s, ...patch }))}
      onReset={() => setStudy(ATR)}
      onVisibleOn={(_k, visibleOn: Resolution[] | undefined) => setStudy((s) => ({ ...s, visibleOn }))}
    />
  );
}

const ATR: AppliedNativeStudy = {
  key: "atr-1", defId: "atr", params: { length: 14 }, visible: true, styles: {},
};

test("B-06 — the draft outlives a re-delivered study, and Ok submits all of it", async () => {
  let latest = ATR;
  let revert = (): void => {};
  render(<LossyHarness onRead={(s) => { latest = s; }} revert={(fn) => { revert = fn; }} />);
  await settle();
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: /Length/ }), { target: { value: "30" } });
  await settle();
  fireEvent.click(within(dialog).getByRole("tab", { name: "Style" }));
  await settle();
  act(() => revert());
  await settle();
  fireEvent.click(within(dialog).getByRole("tab", { name: "Inputs" }));
  await settle();
  assert.equal((within(dialog).getByRole("spinbutton", { name: /Length/ }) as HTMLInputElement).value,
    "30", "the Inputs tab forgot what was typed on it");
  fireEvent.click(within(dialog).getByRole("button", { name: "Ok" }));
  await settle();
  assert.equal(latest.params.length, 30, "Ok left the study at the old length");
  assert.deepEqual(latest.styles, {}, "Ok on untouched plots must not invent overrides");
});

test("B-06 — Cancel after visiting every tab still puts the study back", async () => {
  const dialog = await openAtrSettings();
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: /Length/ }), { target: { value: "30" } });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Style" }));
  await settle();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await settle();
  await advance(1000);
  assert.doesNotMatch(legendParams(), /30/);
  assert.match(legendParams(), /14/);
});

test("B-06 — the strategy dialog's draft survives the page re-rendering it", async () => {
  /*
   * It re-seeded its draft whenever `params` or `properties` changed IDENTITY,
   * so a page re-render with an equal-but-new object while the dialog was open
   * discarded every tab's edits and Ok applied the old values.
   */
  const applied: StrategyProperties[] = [];
  const dialog = (params: Record<string, number>) => (
    <StrategySettingsModal open onClose={() => {}} strategyName="Test" strategyKey="no-schema"
      params={params} properties={{ ...DEFAULT_PROPERTIES }}
      onApply={(_p, props) => applied.push(props)} />
  );
  const view = render(dialog({}));
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: /properties/i }));
  await settle();
  const capital = screen.getByRole("dialog").querySelector<HTMLInputElement>('input[type="number"]');
  assert.ok(capital, "the Properties tab has no capital field");
  fireEvent.change(capital, { target: { value: "5000" } });
  fireEvent.click(screen.getByRole("tab", { name: /inputs/i }));
  view.rerender(dialog({}));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Ok" }));
  assert.equal(applied[0]?.initialCapital, 5000, "Ok applied the values from before the edit");
});
