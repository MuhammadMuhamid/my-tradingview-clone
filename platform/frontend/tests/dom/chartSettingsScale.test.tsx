/*
 * B-07 — the chart settings dialog writes the price scale only when a SCALE
 * control is used, and Cancel undoes only what the visit wrote.
 *
 * Measured: on a fresh session the dialog showed `Auto scale` unchecked while
 * the chart was auto-fitting, and after `High and low = Value → Ok` the axis
 * stayed frozen across a revert and a reload until `Auto scale` was ticked by
 * hand. The scale is not the dialog's alone — the chart reconciles `autoScale`
 * with the library on pointer activity — so the dialog must mirror the live
 * value it is handed and never put a stale one back.
 *
 * Mounted on its own with a parent that owns the state, as the page does.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, settle } from "./harness/env";
import { ChartSettingsModal } from "@/components/tv/ChartSettingsModal";
import { DEFAULT_CHART_SETTINGS, type ChartSettings } from "@/lib/chartSettings";
import { DEFAULT_PRICE_SCALE, type PriceScaleState } from "@/lib/priceScale";

beforeEach(resetBrowser);
after(closeBrowser);

const scaleWrites: PriceScaleState[] = [];
let setLiveScale: (next: PriceScaleState) => void = () => {};

function Page({ initial }: { initial: PriceScaleState }) {
  const [open, setOpen] = useState(true);
  const [scale, setScale] = useState(initial);
  const [settings, setSettings] = useState<ChartSettings>(DEFAULT_CHART_SETTINGS);
  setLiveScale = setScale;
  return (
    <ChartSettingsModal open={open} onClose={() => setOpen(false)} symbol="BTCUSDT" interval="1h"
      chartType="candles" scale={scale}
      onScale={(next) => { scaleWrites.push(next); setScale(next); }}
      onReset={() => {}} settings={settings} onSettings={setSettings} />
  );
}

async function scalesTab(): Promise<void> {
  fireEvent.click(screen.getByRole("tab", { name: /Scales and lines/ }));
  await settle();
}

const autoScaleBox = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: "Auto scale" }) as HTMLInputElement;

test("the dialog mirrors the live Auto scale, including a change made while it is open", async () => {
  scaleWrites.length = 0;
  render(<Page initial={{ ...DEFAULT_PRICE_SCALE, autoScale: false }} />);
  await settle();
  await scalesTab();
  assert.equal(autoScaleBox().checked, false);
  // The chart's reconcile turns it back on (an axis double-click, say).
  await act(async () => { setLiveScale({ ...DEFAULT_PRICE_SCALE, autoScale: true }); });
  assert.equal(autoScaleBox().checked, true, "the checkbox shows the scale as it is now");
  assert.deepEqual(scaleWrites, [], "and showing it writes nothing");
});

test("High and low never writes the price scale, and Cancel does not put a stale one back", async () => {
  scaleWrites.length = 0;
  render(<Page initial={{ ...DEFAULT_PRICE_SCALE, autoScale: false }} />);
  await settle();
  await scalesTab();
  fireEvent.click(screen.getByRole("button", { name: "High and low" }));
  await settle();
  fireEvent.click(screen.getByRole("option", { name: "Value" }));
  await settle();
  assert.deepEqual(scaleWrites, [], "a label setting must not touch the scale");

  // The live scale moves on while the dialog is open…
  await act(async () => { setLiveScale({ ...DEFAULT_PRICE_SCALE, autoScale: true }); });
  // …and Cancel, having changed no scale control, must not undo that.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle();
  assert.deepEqual(scaleWrites, [],
    "Cancel re-imposed the scale captured on entry, freezing an axis the chart had re-fitted");
});

test("a scale control writes only its own field, and Cancel undoes exactly that", async () => {
  scaleWrites.length = 0;
  render(<Page initial={{ ...DEFAULT_PRICE_SCALE, autoScale: true }} />);
  await settle();
  await scalesTab();
  fireEvent.click(screen.getByRole("checkbox", { name: "Invert scale" }));
  await settle();
  assert.deepEqual(scaleWrites, [{ ...DEFAULT_PRICE_SCALE, autoScale: true, invert: true }]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle();
  assert.equal(scaleWrites.length, 2, "the visit touched the scale, so Cancel restores it");
  assert.deepEqual(scaleWrites[1], { ...DEFAULT_PRICE_SCALE, autoScale: true });
});
