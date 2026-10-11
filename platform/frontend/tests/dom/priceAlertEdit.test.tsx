/**
 * Editing a price alert is the dialog that armed it (C14).
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * Creating a price alert and editing one were two different products. Create
 * was `PriceAlertModal` — "Price alert TICKER", one Condition row with
 * pick-from-chart, the gate list, Message and Notifications, shared
 * Dropdowns. Edit was `AlertEditor` — "Edit alert" and a family badge, a
 * free-text Symbol row, separate Price and Direction rows on native
 * `<select>`s, and the three-checkbox gate model that cannot show a second
 * gate of one kind or a gate on its own timeframe.
 *
 * Now the edit opens `PriceAlertModal` with `editing` set. These tests drive
 * it the way a person does and read what reaches the server, because the four
 * things that matter are all about the row: it opens on what the alert holds,
 * it saves by PATCH onto that row (never a POST, never an upsert twin — the
 * 38fd478 defect), the gate list survives, and the live quote never writes
 * itself over the level being retyped (the 8446608 defect, in the dialog's
 * second mode).
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fireEvent, screen, within } from "@testing-library/react";
import { chooseInDropdown } from "./harness/chart";
import { assertAbsent, closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { PriceAlertModal } from "@/components/tv/PriceAlertModal";
import type { AlertGate, MaAlert } from "@/lib/api";
import type { Interval } from "@/lib/types";

const GATES: AlertGate[] = [
  { kind: "rsi", side: "above", length: 14, level: 55 },
  { kind: "ma", side: "above", type: "ema", length: 50, timeframe: "4h" },
];

const ALERT = (over: Partial<MaAlert> = {}): MaAlert => ({
  id: "p1", symbol: "SOLUSDT", timeframe: "1h", conditionKind: "price",
  maType: null, maLength: null, mode: null, ma2Type: null, ma2Length: null,
  targetPrice: 142.5, priceDirection: "cross_up",
  filters: GATES,
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
  enabled: true, frequency: "once_per_bar_close", cooldownMin: 45, note: "breakout watch",
  lastSide: null, lastBarTime: null, lastFiredAt: null, completedAt: null,
  patternId: null, patternDetectorId: null, patternDetectorVersion: null,
  patternSettingsHash: null, patternSettings: null,
  canonicalInstrumentId: null, providerId: null, priceBasis: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
} as MaAlert);

beforeEach(() => {
  resetBrowser();
  // The server's answer is the row with the patch applied, as the real route's is.
  server.routes.set("PATCH /api/ma-alerts/p1", (body) => ({ ...ALERT(), ...(body as object) }));
});
after(closeBrowser);

/** The edit dialog, at one quote. Re-render with another to simulate a tick. */
const editDialog = (
  lastPrice: number,
  over: Partial<Parameters<typeof PriceAlertModal>[0]> = {},
) => (
  <PriceAlertModal
    open
    onClose={() => undefined}
    editing={ALERT()}
    symbol="SOLUSDT"
    chartTimeframe={"15m" as Interval}
    initialPrice={null}
    lastPrice={lastPrice}
    onPickFromChart={() => undefined}
    onSaved={() => undefined}
    {...over}
  />
);

const level = (): HTMLInputElement =>
  screen.getByLabelText("Alert price level") as HTMLInputElement;
const writes = () => server.callsTo("/api/ma-alerts")
  .filter((call) => call.method === "POST" || call.method === "PATCH" || call.method === "PUT");

test("edit opens on what the alert holds, under the create dialog's own grammar", async () => {
  render(editDialog(150));
  await settle();

  const dialog = screen.getByRole("dialog");
  // Edit, then the ticker — the create dialog's title shape, not a family badge.
  assert.match(within(dialog).getByRole("heading").textContent ?? "", /^Edit alert\s*SOLUSDT$/);

  // The alert's level, not the live quote of 150.
  assert.equal(level().value, "142.5", "the edit seeded the market price instead of the alert's level");
  assert.match(screen.getByRole("button", { name: "Alert condition" }).textContent ?? "",
    /Price crosses up through the level/);
  assert.match(screen.getByRole("button", { name: "Alert timeframe" }).textContent ?? "", /^1h/);

  // The gate LIST, both rows, the second on its own timeframe — which the
  // three-checkbox editor could not show at all.
  assert.ok(screen.getByRole("button", { name: "Gate 1 kind" }));
  assert.ok(screen.getByRole("button", { name: "Gate 2 kind" }));
  assert.match(screen.getByRole("button", { name: "Gate 2 timeframe" }).textContent ?? "", /4h/);

  // Message and Notifications are the create dialog's sections, holding the alert's values.
  fireEvent.click(screen.getByRole("button", { name: /Message/ }));
  await settle();
  assert.equal((screen.getByLabelText("Alert note") as HTMLTextAreaElement).value, "breakout watch");
  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  await settle();
  assert.equal((screen.getByLabelText("Cooldown in minutes") as HTMLInputElement).value, "45");

  // Not the other product: no free-text symbol, no separate Price/Direction
  // selects. The one native select left is the shared `FrequencyField`, which
  // every create dialog carries too — the edit has nothing the create lacks.
  assertAbsent(screen.queryByLabelText("Alert symbol"), "the free-text symbol row came back");
  assertAbsent(screen.queryByLabelText("Price direction"), "the native direction select came back");
  assert.deepEqual([...dialog.querySelectorAll("select")].map((s) => s.id),
    ["alert-frequency"], "a native <select> the create dialog does not have is in the edit dialog");
  assert.ok(screen.getByRole("button", { name: "Pick" }), "the edit lost pick-from-chart");
  assert.ok(screen.getByRole("button", { name: "Save" }));
});

test("saving an edit is a PATCH onto the same row, carrying only what changed", async () => {
  const saved: { message: string; row?: MaAlert }[] = [];
  render(editDialog(150, { onSaved: (message, row) => saved.push({ message, row }) }));
  await settle();

  fireEvent.change(level(), { target: { value: "160" } });
  await chooseInDropdown("Alert timeframe", "4h");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();

  const sent = writes();
  assert.equal(sent.length, 1, "one edit must make exactly one request");
  assert.equal(sent[0]!.method, "PATCH", "an edit created a new alert instead of changing this one");
  assert.match(sent[0]!.path, /\/api\/ma-alerts\/p1$/);
  // The gates were not touched, so they are not restated — the row keeps its
  // own list, and nothing else is rewritten behind the user's back.
  assert.deepEqual(sent[0]!.body, { conditionKind: "price", targetPrice: 160, timeframe: "4h" });

  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.row?.id, "p1", "the caller was not handed the server's row");
  assert.match(saved[0]!.message, /^Updated — SOLUSDT 4h/);
});

test("the gate list survives an edit, and an added gate joins it rather than replacing it", async () => {
  render(editDialog(150));
  await settle();

  fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
  await settle();
  assert.ok(screen.getByRole("button", { name: "Gate 3 kind" }), "the added gate row did not appear");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();

  const sent = writes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "PATCH");
  const filters = (sent[0]!.body as { filters?: AlertGate[] }).filters;
  assert.ok(filters, "a changed gate list was not sent");
  assert.equal(filters.length, 3, "the edit dropped the alert's own gates");
  assert.deepEqual(filters.slice(0, 2), GATES, "the existing gates were rewritten");
});

test("a live tick never writes the quote over a retyped level, nor removes an added gate", async () => {
  const view = render(editDialog(150));
  await settle();

  fireEvent.change(level(), { target: { value: "171.25" } });
  fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
  await settle();

  for (const quote of [151, 152.5, 149]) {
    view.rerender(editDialog(quote));
    await settle();
  }

  assert.equal(level().value, "171.25", "the live quote was written over the level being edited");
  assert.ok(screen.queryByRole("button", { name: "Gate 3 kind" }),
    "a quote tick emptied the gate row the user had just added");
});

test("an untouched Save writes nothing", async () => {
  let closed = 0;
  render(editDialog(150, { onClose: () => { closed += 1; } }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.equal(writes().length, 0, "saving an unchanged alert still sent a request");
  assert.equal(closed, 1);
});

test("a spent once-only alert opens paused, and only an explicit re-arm re-arms it", async () => {
  const spent = ALERT({ frequency: "once_only", completedAt: "2026-02-01T00:00:00.000Z" });
  const view = render(editDialog(150, { editing: spent }));
  await settle();

  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  await settle();
  const armed = screen.getByRole("checkbox", { name: /Armed/ }) as HTMLInputElement;
  // `enabled` is still true on a fired once-only row; saying "Armed" would be
  // a claim about something the alert is not doing.
  assert.equal(armed.checked, false, "a fired once-only alert was shown as armed");
  assert.ok(screen.getByText(/has already fired/));

  // Changing something else must not send `enabled: true`, which the server
  // reads as "watch this again".
  fireEvent.change(level(), { target: { value: "150" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.equal("enabled" in (writes()[0]!.body as object), false,
    "an unrelated edit re-armed a spent alert");

  view.unmount();
  render(editDialog(150, { editing: spent }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  await settle();
  fireEvent.click(screen.getByRole("checkbox", { name: /Armed/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.equal((writes().at(-1)!.body as { enabled?: boolean }).enabled, true,
    "ticking Armed on a spent alert did not re-arm it");
});

test("a level picked off the chart for the edit is the level the edit opens on", async () => {
  render(editDialog(150, { initialPrice: 133.333333333 }));
  await settle();
  assert.equal(level().value, "133.33333");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await settle();
  assert.deepEqual(writes()[0]!.body, { conditionKind: "price", targetPrice: 133.33333 });
});

test("Delete asks first, as the shared editor did, and then removes that row", async () => {
  server.routes.set("DELETE /api/ma-alerts/p1", () => ({}));
  const saved: string[] = [];
  render(editDialog(150, { onSaved: (m) => saved.push(m) }));
  await settle();

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await settle();
  assert.equal(server.callsTo("/api/ma-alerts/p1").filter((c) => c.method === "DELETE").length, 0,
    "the alert was deleted before anyone confirmed it");
  // The confirmation is the product's own dialog, stacked over the edit.
  const confirm = screen.getAllByRole("dialog")
    .find((d) => /Delete this alert on SOLUSDT\?/.test(d.textContent ?? ""));
  assert.ok(confirm, "Delete did not ask before deleting");
  assert.match(confirm.textContent ?? "", /Delete this alert on SOLUSDT\?/);
  fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  await settle();

  assert.equal(server.callsTo("/api/ma-alerts/p1").filter((c) => c.method === "DELETE").length, 1);
  assert.deepEqual(saved, ["Alert removed — SOLUSDT 142.50"]);
});

test("with no chart to pick from, the edit offers no Pick", async () => {
  render(editDialog(150, { onPickFromChart: undefined, lastPrice: null, onChart: false }));
  await settle();
  assertAbsent(screen.queryByRole("button", { name: "Pick" }),
    "the Alerts page offered to pick a level from a chart it does not have");
  fireEvent.click(screen.getByRole("button", { name: "Alert timeframe" }));
  await settle();
  const offered = within(screen.getByRole("listbox", { name: "Alert timeframe" }))
    .getAllByRole("option").map((o) => o.textContent ?? "");
  assert.ok(!offered.some((t) => t.includes("same as chart")),
    "a page with no chart labelled a timeframe 'same as chart'");
});

test("both entry points route a price alert into this dialog, and every other family to the editor", () => {
  const ROOT = path.join(__dirname, "..", "..");
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const file of ["app/alerts/page.tsx", "components/tv/ChartDialogs.tsx"]) {
    const source = read(file);
    assert.match(source, /<PriceAlertModal[\s\S]*?editing=\{/, `${file} does not open price edits in the create dialog`);
    assert.match(source, /editsInPriceDialog\(/, `${file} decides the routing on its own`);
    assert.match(source, /<AlertEditor[\s\S]*?alert=\{[^}]*\? null : /,
      `${file} still opens price alerts in the shared editor as well`);
  }
});
