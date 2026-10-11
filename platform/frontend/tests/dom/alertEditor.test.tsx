/**
 * The shared editor speaks the create dialogs' grammar (C14).
 *
 * Price alerts edit in their own create dialog now; every other family still
 * opens `AlertEditor`. It used to be a different product from the dialogs that
 * armed those alerts: native `<select>`s (the contract forbids them inside a
 * dialog), a title without the ticker, and the three-checkbox gate model —
 * which, for a row that carries the gate LIST, showed no gates at all, because
 * it read the legacy columns the server no longer describes such a row by.
 *
 * These drive the rendered editor and read what reaches the server.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen, within } from "@testing-library/react";
import { chooseInDropdown } from "./harness/chart";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AlertEditor } from "@/components/tv/AlertEditor";
import type { AlertGate, MaAlert } from "@/lib/api";

const GATES: AlertGate[] = [
  { kind: "rsi", side: "above", length: 14, level: 55 },
  { kind: "rsi", side: "above", length: 14, level: 50, timeframe: "4h" },
];

const RSI_ALERT = (over: Partial<MaAlert> = {}): MaAlert => ({
  id: "r1", symbol: "SOLUSDT", timeframe: "1h", conditionKind: "rsi",
  maType: null, maLength: null, mode: "cross_up", ma2Type: null, ma2Length: null,
  targetPrice: null, priceDirection: null,
  filters: GATES,
  srSide: null, srPivotLength: null, srInvalidation: null,
  pivotType: null, pivotLevelName: null, pivotAnchor: null,
  // `rsiMaLength` set: a null column loads as the default and is then sent as
  // a "change" (a pre-existing quirk of `alertEditRequest`, not what this pins).
  rsiLength: 14, rsiLevel: 70, rsiMaLength: 14,
  macdFast: null, macdSlow: null, macdSignal: null, indicatorTarget: "level",
  stPeriod: null, stMultiplier: null, stAtrMethod: null,
  bbLength: null, bbMult: null, bbBand: null, bbMaType: null,
  stochKLength: null, stochKSmooth: null, stochDSmooth: null, stochLevel: null,
  adxDiLength: null, adxSmoothing: null, adxLevel: null,
  filterRsiLength: null, filterRsiLevel: null, filterRsiSide: null,
  filterMaType: null, filterMaLength: null, filterMaSide: null,
  filterStPeriod: null, filterStMultiplier: null, filterStAtrMethod: null, filterStSide: null,
  nearMinPct: 0.2, nearMaxPct: 0.5,
  enabled: true, frequency: "once_per_bar_close", cooldownMin: 60, note: null,
  lastSide: null, lastBarTime: null, lastFiredAt: null, completedAt: null,
  patternId: null, patternDetectorId: null, patternDetectorVersion: null,
  patternSettingsHash: null, patternSettings: null,
  canonicalInstrumentId: null, providerId: null, priceBasis: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
} as MaAlert);

beforeEach(() => {
  resetBrowser();
  server.routes.set("PATCH /api/ma-alerts/r1", (body) => ({ ...RSI_ALERT(), ...(body as object) }));
});
after(closeBrowser);

const open = (alert = RSI_ALERT()) => render(
  <AlertEditor alert={alert} onClose={() => undefined} onSaved={() => undefined}
    onDeleted={() => undefined} />
);
const writes = () => server.callsTo("/api/ma-alerts")
  .filter((call) => call.method === "POST" || call.method === "PATCH" || call.method === "PUT");

test("the title is the create dialogs' — Edit alert, then the ticker — and no control is a native select", async () => {
  open();
  await settle();
  const dialog = screen.getByRole("dialog");
  assert.match(within(dialog).getByRole("heading").textContent ?? "", /Edit alert\s*SOLUSDT\s*RSI/);

  // No native select at all: the shared FrequencyField is a Dropdown too.
  assert.deepEqual([...dialog.querySelectorAll("select")].map((s) => s.id), [],
    "a native <select> is back in the editor");
  assert.match(screen.getByRole("button", { name: "Alert condition" }).textContent ?? "", /Crosses above/);
  assert.match(screen.getByRole("button", { name: "What the RSI crosses" }).textContent ?? "",
    /A fixed level/);
  assert.match(screen.getByRole("button", { name: "Alert timeframe" }).textContent ?? "", /^1h/);
});

test("a list-gated alert opens with its whole list, both rows of one kind", async () => {
  open();
  await settle();
  assert.ok(screen.getByRole("button", { name: "Gate 1 kind" }),
    "a list-gated alert opened showing no gates");
  assert.ok(screen.getByRole("button", { name: "Gate 2 kind" }));
  assert.match(screen.getByRole("button", { name: "Gate 2 timeframe" }).textContent ?? "", /4h/);
});

test("changing the condition through the shared Dropdown is a PATCH of that field alone", async () => {
  open();
  await settle();
  await chooseInDropdown("Alert condition", "Crosses below");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const sent = writes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "PATCH");
  assert.match(sent[0]!.path, /\/api\/ma-alerts\/r1$/);
  assert.deepEqual(sent[0]!.body, { conditionKind: "rsi", mode: "cross_down" },
    "an untouched gate list was restated, or the change was not sent");
});

test("adding a gate sends the whole list, with the alert's own gates intact", async () => {
  open();
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  const filters = (writes()[0]!.body as { filters?: AlertGate[] }).filters;
  assert.ok(filters, "the added gate was never sent");
  assert.equal(filters.length, 3);
  assert.deepEqual(filters.slice(0, 2), GATES, "the alert's own gates were rewritten");
});
