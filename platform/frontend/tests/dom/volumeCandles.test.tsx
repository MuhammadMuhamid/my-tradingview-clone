/*
 * Volume candles, on the real chart (D-F6).
 *
 * `tests/volumeCandles.test.ts` drives the primitive's renderer. This holds
 * the wiring on the real workspace: choosing the type from the chart-style
 * menu attaches exactly one width-encoding primitive to the main series, the
 * OHLC legend still reads, and leaving the type detaches it again so no other
 * presentation is drawn over.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { VolumeCandlePrimitive } from "@/lib/volumeCandlePrimitive";

let attached = 0;
let detached = 0;
const original = {
  attached: VolumeCandlePrimitive.prototype.attached,
  detached: VolumeCandlePrimitive.prototype.detached,
};

beforeEach(() => {
  resetBrowser();
  server.setDefaultCandles(compactSeries(120));
  attached = 0;
  detached = 0;
  VolumeCandlePrimitive.prototype.attached = function (this: VolumeCandlePrimitive, param) {
    attached += 1;
    return original.attached.call(this, param);
  };
  VolumeCandlePrimitive.prototype.detached = function (this: VolumeCandlePrimitive) {
    detached += 1;
    return original.detached.call(this);
  };
});
after(() => {
  VolumeCandlePrimitive.prototype.attached = original.attached;
  VolumeCandlePrimitive.prototype.detached = original.detached;
  closeBrowser();
});

async function chooseStyle(container: HTMLElement, name: RegExp): Promise<void> {
  const caret = [...container.querySelectorAll<HTMLElement>("button")]
    .find((b) => b.getAttribute("aria-label") === "Chart style");
  assert.ok(caret, "the chart-style caret is missing");
  fireEvent.click(caret);
  await settle();
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Chart style"]');
  assert.ok(menu, "the chart-style menu did not open");
  const row = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    .find((el) => name.test(el.textContent ?? ""));
  assert.ok(row, `the chart-style menu has no ${name} row`);
  fireEvent.click(row);
  await settle();
}

test("choosing Volume candles attaches one width primitive, and the legend still reads OHLC", async () => {
  const chart = await mountChart();
  assert.equal(attached, 0, "a candle chart has no volume-candle primitive");
  await chooseStyle(chart.container, /^Volume candles/i);
  assert.equal(attached - detached, 1, `expected one live primitive: ${attached} attached, ${detached} detached`);
  assert.match(chart.container.textContent ?? "", /O[\d,.]+\s*H[\d,.]+\s*L[\d,.]+\s*C[\d,.]+/,
    "the OHLC legend stopped reading under volume candles");

  await chooseStyle(chart.container, /^Candles/i);
  assert.equal(attached - detached, 0, "leaving the type left its bodies drawn over the next one");
});
