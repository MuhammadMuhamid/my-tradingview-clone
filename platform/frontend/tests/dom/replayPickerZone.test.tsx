/**
 * ── W2D-08: the replay picker reads the CHART's zone, not the browser's ────
 *
 * Measured in America/New_York on a UTC chart: the picker's field said
 * `Oct 10, 2026, 03:59 AM` for the bar the replay clock printed as
 * `2026-10-10 07:59:59`, and a time typed into it was read as New York time —
 * four hours from the bar the user meant. The browser's zone is pinned to New
 * York here so a picker that still reads it cannot pass by being in UTC.
 */
process.env.TZ = "America/New_York";

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { ReplayControls } from "@/components/tv/ReplayControls";
import type { Candle } from "@/lib/types";

const MINUTE = 60_000;
/** The replay point the reviewer stood on: 07:59:59 UTC is 03:59 in New York. */
const CLOSE = Date.UTC(2026, 9, 10, 7, 59, 59, 999);

function ladder(count: number, endCloseTime: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const closeTime = endCloseTime - (count - 1 - i) * MINUTE;
    return {
      symbol: "SOLUSDT", interval: "1m", openTime: closeTime - MINUTE + 1, closeTime,
      open: 100, high: 101, low: 99, close: 100, volume: 1,
    } as Candle;
  });
}

const NOOP = {
  onCancel: () => {}, onPrevious: () => {}, onNext: () => {}, onPlaying: () => {},
  onSpeed: () => {}, onDeepen: () => {}, onRepick: () => {}, onExit: () => {},
};

const trigger = (): HTMLElement =>
  screen.getByRole("button", { name: /Historical replay date and time/i });

test("W2D-08 — the browser here really is New York", () => {
  assert.equal(new Date(CLOSE).getHours(), 3, "the TZ pin did not take; this file proves nothing");
});

test("W2D-08 — the picker shows the replay point in the chart's zone", () => {
  // 99 bars after the point, so the seed (`len - 100`) is exactly CLOSE.
  const bars = ladder(400, CLOSE + 99 * MINUTE);
  render(<ReplayControls candles={bars} interval="1m" bars={400} session={null} pickerOpen
    onStart={() => {}} {...NOOP} timeZone="UTC" />);
  assert.equal((trigger().textContent ?? "").trim(), "2026-10-10 07:59",
    "the picker read the browser's zone beside a UTC clock and axis");
  cleanup();

  render(<ReplayControls candles={bars} interval="1m" bars={400} session={null} pickerOpen
    onStart={() => {}} {...NOOP} timeZone="Asia/Tokyo" />);
  assert.equal((trigger().textContent ?? "").trim(), "2026-10-10 16:59",
    "a chart in Tokyo time must be picked in Tokyo time");
  cleanup();
});

test("W2D-08 — a typed time and a picked day are read in the chart's zone", () => {
  const bars = ladder(400, CLOSE + 99 * MINUTE);
  let started: number | null = null;
  render(<ReplayControls candles={bars} interval="1m" bars={400} session={null} pickerOpen
    onStart={(t) => { started = t; }} {...NOOP} timeZone="UTC" />);

  fireEvent.click(trigger());
  const time = document.querySelector<HTMLInputElement>('input[type="time"]');
  assert.ok(time, "the calendar has no time field");
  assert.equal(time.value, "07:59", "the time field shows the browser's hour, not the chart's");
  fireEvent.change(time, { target: { value: "06:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Start Replay" }));
  assert.equal(started, Date.UTC(2026, 9, 10, 6, 30),
    "06:30 typed on a UTC chart was not read as 06:30 UTC");

  // The day grid is UTC's too: picking the 10th keeps the chosen time, in UTC.
  if (trigger().getAttribute("aria-expanded") !== "true") fireEvent.click(trigger());
  const tenth = [...document.querySelectorAll<HTMLButtonElement>('[role="gridcell"]')]
    .find((cell) => cell.textContent === "10" && !cell.disabled);
  assert.ok(tenth, "the 10th is not pickable");
  fireEvent.click(tenth);
  fireEvent.click(screen.getByRole("button", { name: "Start Replay" }));
  assert.equal(started, Date.UTC(2026, 9, 10, 6, 30));
  cleanup();
});
