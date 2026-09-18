/**
 * Editing many alerts at once, driven the way a person drives it.
 *
 * The property worth a DOM test is that the dialog sends ONLY what was ticked.
 * A form pre-filled from "the first selected alert" and posted whole would
 * quietly push that alert's cadence, note and gates onto every other one —
 * the user asked to change the cooldown, not to make twenty alerts identical
 * to one of them. That is a data-loss bug with a perfectly reassuring UI, so
 * it is asserted against the real dialog rather than the function behind it.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { BulkEditAlertsModal } from "@/components/tv/BulkEditAlertsModal";
import type { MaAlert } from "@/lib/api";

const ALERT = (id: string, over: Partial<MaAlert> = {}): MaAlert => ({
  id, symbol: "BTCUSDT", timeframe: "1h", conditionKind: "price",
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
  lastSide: null, lastBarTime: null, lastFiredAt: null, completedAt: null,
  patternId: null, patternDetectorId: null, patternDetectorVersion: null,
  patternSettingsHash: null, patternSettings: null,
  canonicalInstrumentId: null, providerId: null, priceBasis: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
} as MaAlert);

const SELECTED = [ALERT("a1"), ALERT("a2", { timeframe: "4h" })];

let sent: Record<string, unknown> | null = null;

beforeEach(() => {
  resetBrowser();
  sent = null;
  server.routes.set("POST /api/ma-alerts/bulk-edit", (body) => {
    sent = body as Record<string, unknown>;
    return { updated: SELECTED, missingIds: [] };
  });
});
after(() => {
  server.routes.delete("POST /api/ma-alerts/bulk-edit");
  closeBrowser();
});

const open = () => render(
  <BulkEditAlertsModal
    alerts={SELECTED} open onClose={() => undefined} onSaved={() => undefined}
  />
);

test("nothing can be applied until a setting is ticked", async () => {
  open();
  const apply = screen.getByRole("button", { name: /Apply to selected/ });
  assert.equal((apply as HTMLButtonElement).disabled, true);
  assert.equal(sent, null);
});

test("only the ticked setting is sent, and nothing else is touched", async () => {
  open();
  fireEvent.click(screen.getByLabelText(/Cooldown \(minutes\)/));
  fireEvent.change(screen.getByLabelText("Bulk cooldown minutes"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: /Apply to selected/ }));
  await settle();

  assert.ok(sent, "the request was sent");
  assert.deepEqual(sent!.ids, ["a1", "a2"]);
  // The whole point: frequency, note and filters are ABSENT, not defaulted.
  assert.deepEqual(sent!.patch, { cooldownMin: 5 });
});

test("the gate list is sent only when its own box is ticked, and it replaces", async () => {
  open();
  // Ticking the gates box with an empty list is a real instruction — "remove
  // the conditions from every selected alert" — so it must send [], not omit.
  fireEvent.click(screen.getByLabelText(/Conditions \(replaces/));
  fireEvent.click(screen.getByRole("button", { name: /Apply to selected/ }));
  await settle();

  assert.deepEqual(sent!.patch, { filters: [] });
});

test("the dialog says the conditions replace rather than merge", () => {
  open();
  fireEvent.click(screen.getByLabelText(/Conditions \(replaces/));
  // A user who reads "add a condition" and gets a replacement has lost gates
  // they cannot recover, so the word is on screen and not only in the API.
  assert.ok(
    screen.getByText(/REPLACE whatever each selected alert carries/),
    "the replacement is stated in words"
  );
});

test("two settings tick independently and arrive together", async () => {
  open();
  fireEvent.click(screen.getByLabelText(/How often it may notify/));
  fireEvent.click(screen.getByLabelText(/Note/));
  fireEvent.change(screen.getByLabelText("Bulk note"), { target: { value: " desk review " } });
  fireEvent.click(screen.getByRole("button", { name: /Apply to selected/ }));
  await settle();

  assert.deepEqual(sent!.patch, {
    frequency: "once_per_bar_close",
    note: "desk review",
  });
});
