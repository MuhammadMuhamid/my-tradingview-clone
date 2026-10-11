/**
 * W2D-05: the Data window lists every study on the pane, not only Pine's.
 *
 * Object tree & Data window → Data window, hover a bar: it showed the date,
 * the OHLC and a flat `STUDY PLOTS` list built from the page's two study
 * lists — the Pine overlays, and the built-in list's overlays as they stood
 * when a study was ADDED, before it had computed anything. Volume, the bar's
 * change, the moving-average set, RSI, ATR and the comparison pane were on the
 * chart and absent from the window. The reference lists every study in every
 * pane, plus Change and Vol.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { closeBrowser, compactSeries, resetBrowser, server, settle } from "./harness/env";
import { mountChart } from "./harness/chart";
import { createWorkspace, WORKSPACE_STORAGE_KEY } from "@/lib/workspace";
import { dataWindowSeriesRows, dataWindowStudies } from "@/lib/dataWindow";
import type { Candle } from "@/lib/types";

const HOUR = 3_600_000;

beforeEach(() => {
  resetBrowser();
  const bars = compactSeries(300, { intervalMs: HOUR });
  server.setCandles("SOLUSDT", "1h", bars);
  server.setCandles("ETHUSDT", "1h", compactSeries(300, { intervalMs: HOUR, base: 2000 }));
});
after(closeBrowser);

function seed(): void {
  const ws = createWorkspace({ symbol: "SOLUSDT", interval: "1h" });
  ws.panes[0] = { ...ws.panes[0]!, compare: { symbol: "ETHUSDT", mode: "percent", length: 60 } };
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(ws));
  window.localStorage.setItem("tv.nativeStudies.v1", JSON.stringify([
    { key: "rsi-1", defId: "rsi", params: { length: 14, source: "close" }, visible: true, styles: {} },
    { key: "atr-1", defId: "atr", params: { length: 14 }, visible: true, styles: {} },
  ]));
}

async function openDataWindow(container: HTMLElement): Promise<HTMLElement> {
  const rail = [...container.querySelectorAll<HTMLButtonElement>(
    '[data-side-rail="true"] button[aria-pressed]')]
    .find((b) => b.getAttribute("aria-label") === "Object tree and Data window");
  assert.ok(rail, "no Object tree and Data window rail button");
  fireEvent.click(rail);
  await settle(2);
  const panel = screen.getByRole("region", { name: "objects panel" });
  fireEvent.click(within(panel).getByRole("tab", { name: "Data window" }));
  await settle(2);
  const data = panel.querySelector<HTMLElement>("[data-data-window]");
  assert.ok(data, "the Data window tab has no value surface");
  return data;
}

const studyTitles = (data: HTMLElement): string[] =>
  [...data.querySelectorAll<HTMLElement>("[data-data-window-study]")]
    .map((section) => section.getAttribute("aria-label") ?? "");

test("W2D-05 — the Data window lists Change, Volume and every study in every pane", async () => {
  seed();
  const { container, plot } = await mountChart();
  await settle(6);
  const data = await openDataWindow(container);

  for (const id of ["change", "volume"]) {
    const row = data.querySelector<HTMLElement>(`[data-data-window-series="${id}"]`);
    assert.ok(row, `the bar's ${id} is absent from the Data window`);
    assert.notEqual(row.querySelector("dd")?.textContent, "—", `${id} has no value for a loaded bar`);
  }
  assert.match(data.querySelector('[data-data-window-series="change"] dd')?.textContent ?? "",
    /^[+−][\d,.]+ \([+−]\d+\.\d{2}%\)$/, "Change is the signed delta with its percentage");

  const titles = studyTitles(data);
  for (const expected of [
    "Moving averages",
    "Relative Strength Index",
    "Average True Range",
    "Percent change vs ETHUSDT",
  ]) {
    assert.ok(titles.includes(expected),
      `${expected} is on the chart and absent from the Data window: ${JSON.stringify(titles)}`);
  }

  // Each study's plots are under its own title, with a reading.
  const rsi = data.querySelector<HTMLElement>('[data-data-window-study][aria-label="Relative Strength Index"]')!;
  const rsiRows = [...rsi.querySelectorAll("dt")].map((dt) => dt.textContent);
  assert.deepEqual(rsiRows, ["RSI"], "RSI's reading, and none of its constant 70 / 50 / 30 levels");
  assert.match(rsi.querySelector("dd")?.textContent ?? "", /^\d+(\.\d+)?$/, "RSI has a value");
  const compare = data.querySelector<HTMLElement>(
    '[data-data-window-study][aria-label="Percent change vs ETHUSDT"]')!;
  assert.deepEqual([...compare.querySelectorAll("dt")].map((dt) => dt.textContent),
    ["SOLUSDT %", "ETHUSDT %"], "both rebased series of the comparison pane");

  // And the window follows the crosshair.
  fireEvent.mouseMove(plot, { clientX: 300, clientY: 200, bubbles: true });
  await settle(2);
  assert.ok(studyTitles(data).includes("Relative Strength Index"),
    "the studies left the window when the crosshair moved");
  assert.notEqual(data.firstElementChild?.textContent, undefined);
});

const bar = (i: number, close: number, volume = 1000): Candle => ({
  symbol: "SOLUSDT", interval: "1h", openTime: i * HOUR, closeTime: (i + 1) * HOUR - 1,
  open: close - 1, high: close + 1, low: close - 2, close, volume,
});

test("W2D-05 — a study's plots are read at the hovered bar, grouped by study", () => {
  const groups = dataWindowStudies([
    { id: "a:fast", title: "Fast", color: "#fff", instanceId: "a", instanceTitle: "Cross",
      instanceParams: "9 21", data: [{ time: 10, value: 1.5 }, { time: 20, value: 2.5 }] },
    { id: "a:slow", title: "Slow", color: "#fff", instanceId: "a", instanceTitle: "Cross",
      data: [{ time: 10, value: 3 }, { time: 20, value: 4 }] },
    { id: "lvl", title: "70", color: "#fff", instanceId: "b", instanceTitle: "RSI",
      constantValue: 70, data: [{ time: 10, value: 70 }, { time: 20, value: 70 }] },
    { id: "status", title: "", color: "#fff", instanceId: "c", instanceTitle: "Broken", data: [] },
  ], 10);
  assert.deepEqual(groups.map((g) => [g.title, g.params, g.rows.map((r) => `${r.label}=${r.value}`)]), [
    ["Cross", "9 21", ["Fast=1.5", "Slow=3"]],
  ], "a constant level and an empty status row are not readings");
});

test("W2D-05 — Change is against the previous close; Volume is the bar's own", () => {
  const candles = [bar(0, 100, 10), bar(1, 99, 1234.5)];
  const rows = dataWindowSeriesRows(candles, candles[1]!);
  assert.deepEqual(rows.map((r) => r.label), ["Change", "Volume"]);
  assert.match(rows[0]!.value, /^−1\.0000 \(−1\.00%\)$/);
  assert.equal(rows[1]!.value, (1234.5).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  assert.deepEqual(dataWindowSeriesRows(candles, null).map((r) => r.value), ["—", "—"]);
});
