import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePaneCandleOverlays } from "@/lib/useCandleOverlay";
import { usePaneClassicalOverlays } from "@/lib/useClassicalPatterns";

afterEach(cleanup);

function Harness() {
  const candles = usePaneCandleOverlays(["left", "right"]);
  const classical = usePaneClassicalOverlays(["left", "right"]);
  return <>
    <button onClick={() => candles.left!.setDirection("bull")}>Left candles</button>
    <button onClick={() => classical.left!.setStatus("failed")}>Left classical</button>
    <output aria-label="left settings">{candles.left!.direction}:{classical.left!.status}</output>
    <output aria-label="right settings">{candles.right!.direction}:{classical.right!.status}</output>
  </>;
}

test("two panes keep P2 and P3 settings independent", () => {
  render(<Harness />);
  assert.equal(screen.getByLabelText("left settings").textContent, "both:awaiting");
  assert.equal(screen.getByLabelText("right settings").textContent, "both:awaiting");
  fireEvent.click(screen.getByRole("button", { name: "Left candles" }));
  fireEvent.click(screen.getByRole("button", { name: "Left classical" }));
  assert.equal(screen.getByLabelText("left settings").textContent, "bull:failed");
  assert.equal(screen.getByLabelText("right settings").textContent, "both:awaiting");
});
