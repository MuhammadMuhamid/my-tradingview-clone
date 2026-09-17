/**
 * The price-alert dialog tells the truth about what it is arming.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * `5d6c91d` rewrote `PriceAlertModal` toward a reference alert dialog's
 * grammar. The shape it arrived at looked right and four things it had been
 * saying stopped being said: the substituted evaluation resolution, that a
 * prefilled Last price was a stored close rather than the market, what the
 * chosen frequency actually promises, and what each condition evaluates. Two
 * controls arrived that could not do anything — an Expiration row the alert
 * model has no column for, and an "Alert source: Studies" option wired to
 * `onChange={() => undefined}`.
 *
 * The three sibling dialogs were not rewritten and kept all four surfaces, so
 * the regression was one file's, not the family's. These tests are on the
 * rendered dialog rather than on its source text: each one drives the control
 * a person drives and reads what the dialog then says.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import {
  assertAbsent, closeBrowser, render, resetBrowser, server, settle,
} from "./harness/env";
import { PriceAlertModal } from "@/components/tv/PriceAlertModal";
import { MaAlertModal } from "@/components/tv/MaAlertModal";
import { LevelAlertModal } from "@/components/tv/LevelAlertModal";
import { IndicatorAlertModal } from "@/components/tv/IndicatorAlertModal";
import { INTRABAR_WARNING } from "@/lib/alerts";
import type { Interval } from "@/lib/types";

beforeEach(resetBrowser);
after(closeBrowser);

/**
 * Mount the dialog open, on a chart whose resolution IS armable, with no
 * stale-price notice owed. Each test overrides only the prop it is about, so
 * a surface that appears unconditionally cannot pass by accident.
 */
async function openDialog(props: Partial<Parameters<typeof PriceAlertModal>[0]> = {}) {
  const view = render(
    <PriceAlertModal
      open
      onClose={() => undefined}
      symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval}
      resolutionNotice={null}
      initialPrice={null}
      lastPrice={100}
      lastPriceNotice={null}
      existing={[]}
      onPickFromChart={() => undefined}
      onSaved={() => undefined}
      {...props}
    />,
  );
  await settle();
  return view;
}

const body = () => document.body.textContent ?? "";

// ── 1. the substituted evaluation resolution ───────────────────────────────

test("a dialog armed off a derived chart names the resolution it will actually evaluate on", async () => {
  await openDialog({
    resolutionNotice: "45m is folded from 3 15m bars, and alerts run on stored bars",
  });

  const notice = document.querySelector<HTMLElement>('[data-resolution-notice="true"]');
  assert.ok(notice, "the dialog opened on a substituted timeframe and said nothing");
  const text = notice.textContent ?? "";
  assert.match(text, /45m is folded from 3 15m bars/, "the notice does not say why");
  assert.match(text, /This alert is set to/, "the notice does not name what it is doing instead");
  assert.match(text, /15m/, "the notice does not name the substituted resolution");

  // The control is right there, and offers only what the runner can evaluate.
  const field = screen.getByLabelText("Alert timeframe") as HTMLSelectElement;
  assert.equal(field.value, "15m", "the dialog is not on the interval its own notice named");
  assert.ok(![...field.options].some((o) => o.value === "45m"),
    "a timeframe the runner cannot evaluate must not be offered");
});

test("a chart the runner can honour says nothing, because there is nothing to say", async () => {
  await openDialog();
  assertAbsent(document.querySelector('[data-resolution-notice="true"]'),
    "a native chart invented a substitution notice");
});

test("every alert dialog renders the substituted-resolution truth it is given", async () => {
  const notice = "45m is folded from 3 15m bars, and alerts run on stored bars";
  const cases = [
    <PriceAlertModal key="price" open onClose={() => undefined} symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval} resolutionNotice={notice} initialPrice={null}
      lastPrice={100} lastPriceNotice={null} existing={[]}
      onPickFromChart={() => undefined} onSaved={() => undefined} />,
    <MaAlertModal key="ma" open onClose={() => undefined} symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval} resolutionNotice={notice}
      maType="sma" maLength={200} existing={[]} onSaved={() => undefined} />,
    <LevelAlertModal key="level" open onClose={() => undefined} symbol="SOLUSDT"
      defaultTimeframe={"15m" as Interval} resolutionNotice={notice}
      existing={[]} onSaved={() => undefined} />,
    <IndicatorAlertModal key="indicator" open onClose={() => undefined} symbol="SOLUSDT"
      defaultTimeframe={"15m" as Interval} resolutionNotice={notice}
      kind="rsi" existing={[]} onSaved={() => undefined} />,
  ];

  for (const dialog of cases) {
    const view = render(dialog);
    await settle();
    const rendered = document.querySelector<HTMLElement>('[data-resolution-notice="true"]');
    assert.ok(rendered, `${dialog.key} can open on a substituted timeframe silently`);
    assert.match(rendered.textContent ?? "", /45m is folded from 3 15m bars/);
    assert.match(rendered.textContent ?? "", /This alert is set to 15m/);
    view.unmount();
  }
});

test("the moving-average dialog creates a genuine MA-vs-MA crossover", async () => {
  render(
    <MaAlertModal open onClose={() => undefined} symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval} maType="ema" maLength={21}
      existing={[]} onSaved={() => undefined} />,
  );
  await settle();

  fireEvent.change(screen.getByLabelText("Alert condition family"), {
    target: { value: "ma_vs_ma" },
  });
  fireEvent.change(screen.getByLabelText("Second moving-average type"), {
    target: { value: "sma" },
  });
  fireEvent.change(screen.getByLabelText("Second moving-average length"), {
    target: { value: "100" },
  });
  fireEvent.change(screen.getByLabelText("Moving-average crossing direction"), {
    target: { value: "cross_down" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await settle();

  const writes = server.callsTo("/api/ma-alerts")
    .filter((call) => call.method === "POST");
  assert.equal(writes.length, 1, "creating one crossover must make one alert request");
  assert.deepEqual(writes[0]!.body, {
    symbol: "SOLUSDT",
    timeframe: "15m",
    conditionKind: "ma_vs_ma",
    maType: "ema",
    maLength: 21,
    ma2Type: "sma",
    ma2Length: 100,
    mode: "cross_down",
    nearMinPct: 0.2,
    nearMaxPct: 0.5,
    cooldownMin: 60,
    frequency: "once_per_bar_close",
    note: null,
    enabled: true,
  });
});

test("the crossover dialog says the two LINES cross, never that price does", async () => {
  const saved: string[] = [];
  render(
    <MaAlertModal open onClose={() => undefined} symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval} maType="ema" maLength={21}
      existing={[]} onSaved={(message) => saved.push(message)} />,
  );
  await settle();
  fireEvent.change(screen.getByLabelText("Alert condition family"), {
    target: { value: "ma_vs_ma" },
  });
  fireEvent.change(screen.getByLabelText("Second moving-average type"), {
    target: { value: "sma" },
  });
  fireEvent.change(screen.getByLabelText("Second moving-average length"), {
    target: { value: "100" },
  });
  await settle();

  // `ma_vs_ma` evaluates one average against another. The price wording the
  // `ma` family uses would describe an alert this dialog does not create.
  const direction = screen.getByLabelText("Moving-average crossing direction");
  assert.match(direction.textContent ?? "", /EMA 21 crosses above the SMA 100/);
  assert.match(direction.textContent ?? "", /EMA 21 crosses below the SMA 100/);
  assert.ok(!/Price crosses (above|below) the line/.test(direction.textContent ?? ""),
    "the crossover dropdown offered the price-versus-MA wording");
  assertAbsent(screen.queryByText(/Fires when a candle closes above the line/),
    "the crossover help described the close as the thing that crosses");
  assert.ok(screen.getByText(/the EMA 21 finishes above the SMA 100/));

  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await settle();
  assert.deepEqual(saved, ["Alert set — SOLUSDT 15m EMA 21 crosses above the SMA 100"]);
});

test("the price-versus-MA confirmation still names the condition it armed", async () => {
  const saved: string[] = [];
  render(
    <MaAlertModal open onClose={() => undefined} symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval} maType="ema" maLength={21}
      existing={[]} onSaved={(message) => saved.push(message)} />,
  );
  await settle();
  fireEvent.change(screen.getByLabelText("Price versus moving-average condition"), {
    target: { value: "cross_up" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await settle();
  assert.deepEqual(saved,
    ["Alert set — SOLUSDT 15m EMA 21 · price crosses above the line"]);
});

test("a crossover that cannot happen is refused before it is armed", async () => {
  render(
    <MaAlertModal open onClose={() => undefined} symbol="SOLUSDT"
      chartTimeframe={"15m" as Interval} maType="ema" maLength={21}
      existing={[]} onSaved={() => undefined} />,
  );
  await settle();
  fireEvent.change(screen.getByLabelText("Alert condition family"), {
    target: { value: "ma_vs_ma" },
  });

  // Emptying the number field reads back as 0, and the backend's range check
  // is only `Number.isInteger` — so this would arm an alert that never fires.
  fireEvent.change(screen.getByLabelText("Second moving-average length"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await settle();
  assert.ok(screen.getByText(/length between 1 and 1000/));

  // A line cannot cross itself.
  fireEvent.change(screen.getByLabelText("Second moving-average type"), {
    target: { value: "ema" },
  });
  fireEvent.change(screen.getByLabelText("Second moving-average length"), {
    target: { value: "21" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await settle();
  assert.ok(screen.getByText(/EMA 21 cannot cross itself/));

  assert.equal(
    server.callsTo("/api/ma-alerts").filter((call) => call.method === "POST").length, 0,
    "an impossible condition reached the backend",
  );
});

// ── 2. the prefilled price is not always the market ────────────────────────

test("a level prefilled from stored history is marked as stored, not presented as the market", async () => {
  await openDialog({
    lastPrice: 100,
    lastPriceNotice: "No live frame yet — this is the newest stored close.",
  });

  const notice = document.querySelector<HTMLElement>('[data-last-price-notice="true"]');
  assert.ok(notice, "a history close was prefilled and the dialog let it pass for live");
  assert.match(notice.textContent ?? "", /newest stored close/);
});

test("a live frame is not qualified, because it is the market", async () => {
  await openDialog({ lastPrice: 100, lastPriceNotice: null });
  assert.match(body(), /Last price/, "the dialog does not show what Last is");
  assertAbsent(document.querySelector('[data-last-price-notice="true"]'),
    "a live price was labelled stale");
});

// ── 3. what the frequency promises ─────────────────────────────────────────

test("the frequency explains what it evaluates, and warns when it stops waiting for the close", async () => {
  await openDialog();

  const frequency = screen.getByLabelText("Frequency") as HTMLSelectElement;
  assert.equal(frequency.value, "once_per_bar_close", "the default frequency moved");
  assert.match(body(), /Evaluates only completed candles/,
    "the default frequency is not explained");
  // "each candle" needs a length, and the length is this alert's timeframe.
  assert.match(body(), /Candles here are 15m/);
  assertAbsent(document.querySelector('[role="note"]'),
    "a bar-close frequency was given an intrabar warning");

  // An intrabar mode is not a mistake — it is a different promise, and the
  // dialog has to state it before the user accepts it.
  fireEvent.change(frequency, { target: { value: "once_per_bar" } });
  await settle();
  assert.match(body(), /Triggers the first moment the condition becomes true inside each candle/);
  const warning = document.querySelector<HTMLElement>('[role="note"]');
  assert.ok(warning, "an intrabar frequency carried no warning");
  assert.equal(warning.textContent?.trim(), INTRABAR_WARNING,
    "the intrabar warning is not the shared sentence every dialog says");
});

// ── 4. what the condition evaluates ────────────────────────────────────────

test("each condition explains what it evaluates, and offers only conditions that exist", async () => {
  await openDialog();

  const condition = screen.getByLabelText("Alert condition") as HTMLSelectElement;
  /*
   * Three options because `PriceDirection` has three values. The rewrite
   * offered five — "Crossing", "Greater than" and "Less than" alongside the
   * two cross directions — and folded three of them onto `either`, so a user
   * who chose "Greater than" was armed on a condition that fires on a wick
   * from below as well.
   */
  assert.deepEqual([...condition.options].map((o) => o.value),
    ["either", "cross_up", "cross_down"],
    "the dialog offers a condition the runner cannot evaluate");

  assert.match(body(), /a wick is enough/, "the reach condition is not explained");

  fireEvent.change(condition, { target: { value: "cross_up" } });
  await settle();
  assert.match(body(), /closes above the level after closing below it/,
    "the cross-up condition is not explained");

  fireEvent.change(condition, { target: { value: "cross_down" } });
  await settle();
  assert.match(body(), /closes below the level after closing above it/,
    "the cross-down condition is not explained");
});

test("a cross armed on the side price is already on says so, in visible copy", async () => {
  // Price is 100 and the level is 90: a cross UP through 90 cannot happen
  // until price first travels back below it.
  await openDialog({ lastPrice: 100, initialPrice: 90 });
  fireEvent.change(screen.getByLabelText("Alert condition"), { target: { value: "cross_up" } });
  await settle();

  const warned = [...document.querySelectorAll("p")].some(
    (p) => /Price is already above this level/.test(p.textContent ?? "")
      && !p.className.includes("sr-only"));
  assert.equal(warned, true,
    "an alert that cannot fire yet said so only to a screen reader, or not at all");
});

// ── 5 and 6. controls that cannot do anything ──────────────────────────────

test("no Expiration control, because no alert in this product has ever expired", async () => {
  await openDialog();
  /*
   * `ma_alerts` has no expiry column, the create route takes no expiry field
   * and the runner reads none — checked across `src/types/maAlerts.ts`,
   * `src/api/routes/maAlerts.ts`, `src/engine/maAlertRunner.ts` and every
   * migration. The row that shipped cycled Never → 1 day → 1 week → At date
   * in local state and sent nothing, so an alert a user believed would stop
   * after a day kept firing.
   */
  assert.equal(/Expiration/.test(body()), false,
    "the dialog offers an expiration the alert model cannot honour");
});

test("no alert-source control, because this dialog can only arm a price", async () => {
  await openDialog();
  assertAbsent(screen.queryByLabelText("Alert source"),
    "the inert Price/Studies source control is still there");
  /*
   * Studies alerts are real — rsi, macd, supertrend, bollinger, stochastic and
   * adx are all condition kinds — but they are armed from the indicator
   * dialog. Nothing in this file could ever have created one; the option was
   * wired to `onChange={() => undefined}` and existed to look like it could.
   */
  assert.equal(/Studies/.test(body()), false,
    "the dialog still advertises a source it cannot arm");
});

// ── the dialog still arms an alert ─────────────────────────────────────────

test("the restored dialog still creates the alert it describes", async () => {
  let saved: string | null = null;
  await openDialog({ initialPrice: 123.5, onSaved: (m: string) => { saved = m; } });

  const level = screen.getByLabelText("Alert price level") as HTMLInputElement;
  assert.equal(level.value, "123.5", "the clicked level was not prefilled");

  fireEvent.change(screen.getByLabelText("Alert condition"), { target: { value: "cross_up" } });
  fireEvent.change(screen.getByLabelText("Alert timeframe"), { target: { value: "1h" } });
  await settle();

  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await settle();

  assert.notEqual(saved, null, "Create did not reach the server");
  assert.match(saved ?? "", /Alert set/);
});
