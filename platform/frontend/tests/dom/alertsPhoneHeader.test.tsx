/**
 * V4 release polish — the "Active alerts" card header at phone width.
 *
 * Measured on /alerts at 390px (Experience-Finish-V4 screenshot
 * `ui-alerts-admin-dark-390.png`): the header could not wrap, so the title
 * folded into three lines and the 84px symbol field clipped "SOLUSDT" to
 * "SOLUSD". The contract is now that `CardHeader` wraps and the field keeps
 * its 110px at every width. jsdom measures no layout, so the classes ARE the
 * contract here; the browser measurement is the lead's.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import AlertsPage from "@/app/alerts/page";
import type { MaAlert } from "@/lib/api";

beforeEach(resetBrowser);
after(closeBrowser);

const ALERT: MaAlert = {
  id: "a1", symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
  maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
  targetPrice: 100, priceDirection: "either",
  filters: null,
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  rsiLength: null, rsiLevel: null, rsiMaLength: null,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: null,
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null, filterStAtrMethod: null, filterStSide: null,
  nearMinPct: 0.2, nearMaxPct: 0.5,
  enabled: true, frequency: "once_per_bar_close", cooldownMin: 60, note: null,
  lastSide: null, lastBarTime: null, lastFiredAt: null, lastFiredBarTime: null, completedAt: null,
  patternId: null,
  canonicalInstrumentId: null, providerId: null, priceBasis: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
} as MaAlert;

const OPTIONS = {
  maTypes: ["sma", "ema"], maLengths: [20, 50], modes: ["cross"], conditionKinds: ["price"],
  priceDirections: ["either"], noteMaxLength: 280, defaultFrequency: "once_per_bar_close",
  intrabarWarning: "", frequencies: [],
  evaluation: { enabled: true, reason: null },
};

function alertsServer(): void {
  server.routes.set("GET /api/ma-alerts", () => [ALERT]);
  server.routes.set("/api/ma-alerts/events", () => []);
  server.routes.set("/api/ma-alerts/options", () => OPTIONS);
}

const classes = (el: Element): string[] => (el.getAttribute("class") ?? "").split(/\s+/);

/** Walks up from a node to the card header: the first ancestor with a bottom hairline. */
function headerOf(el: Element): Element {
  let node: Element | null = el.parentElement;
  while (node && !classes(node).includes("border-b")) node = node.parentElement;
  assert.ok(node, "the button is not inside a card header");
  return node!;
}

test("the symbol field keeps its full width at every size, so the default ticker is whole", async () => {
  alertsServer();
  render(<AlertsPage />);
  await settle(6);

  const field = screen.getByRole("textbox", { name: "Symbol for a new level alert" }) as HTMLInputElement;
  const cls = classes(field);
  assert.equal(cls.includes("w-[110px]"), true, `field classes: ${cls.join(" ")}`);
  assert.equal(cls.includes("w-[84px]"), false, "the phone width that clipped SOLUSDT is back");
  assert.equal(cls.some((c) => c.startsWith("sm:w-")), false, "the field still changes width per breakpoint");
  assert.equal(field.value, "SOLUSDT");
});

test("the card header wraps, so the add block drops under the title instead of squeezing it", async () => {
  alertsServer();
  render(<AlertsPage />);
  await settle(6);

  const add = screen.getByRole("button", { name: "Add level alert" });
  assert.equal(classes(add).includes("whitespace-nowrap"), true, "the button may break into two lines");

  const header = headerOf(add);
  const cls = classes(header);
  assert.equal(cls.includes("flex-wrap"), true, `header classes: ${cls.join(" ")}`);
  assert.equal(cls.includes("flex"), true);
  // The title is the header's h2, in the same wrapping row as the add block.
  const h2 = header.querySelector("h2");
  assert.equal((h2?.textContent ?? "").includes("alert"), true, `h2: ${JSON.stringify(h2?.textContent)}`);
  // The old wrapper margin is gone; the header's own gap spaces the block.
  const wrapper = add.parentElement!;
  assert.equal(classes(wrapper).includes("ml-3"), false, "the wrapper still carries ml-3");
  assert.equal(classes(wrapper).includes("shrink-0"), true);
});
