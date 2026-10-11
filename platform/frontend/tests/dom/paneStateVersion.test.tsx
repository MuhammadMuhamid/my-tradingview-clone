/**
 * ── B-20: `PUT /api/chart-state/panes/p1` → 409 on EVERY load ────────────
 *
 * A pane's built-in studies and its Pine studies are two halves of one server
 * row with one version, written by two hooks. Each hook kept its own copy of
 * that version. On every load both restored, both saved 1.2s later against
 * the version they had both read, and whichever landed second was refused —
 * a 409 in the console on every page load, and, outside a load, a real edit to
 * one half made within a second of an edit to the other was silently dropped.
 *
 * The version now lives with the row (`lib/chartStateSync`), the two writers
 * are queued per row, and a refusal whose body shows this half unchanged since
 * this browser last heard it is re-based and sent once more. A genuine
 * conflict — another device changed THIS half — still adopts, as before
 * (`tests/dom/studies.test.tsx` holds that).
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act } from "@testing-library/react";
import { render, advance, closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { useNativeStudies } from "@/lib/useNativeStudies";
import { useIndicators } from "@/lib/useIndicators";
import { nativeStorageKey } from "@/lib/native/storage";
import { indicatorStorageKey } from "@/lib/indicators";
import type { Candle } from "@/lib/types";

const SCOPE = "p1";
const SOURCE = '//@version=5\nindicator("Probe")\nplot(close)';
const CANDLES: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  symbol: "SOLUSDT", interval: "15m" as const,
  openTime: Date.UTC(2026, 0, 1) + i * 900_000,
  open: 100, high: 101, low: 99, close: 100.5,
  volume: 1_000, closeTime: Date.UTC(2026, 0, 1) + (i + 1) * 900_000 - 1,
}));

type Handle = { native: ReturnType<typeof useNativeStudies>; pine: ReturnType<typeof useIndicators> };

function Pane({ onReady }: { onReady: (h: Handle) => void }) {
  const native = useNativeStudies({ candles: CANDLES, interval: "15m", scope: SCOPE });
  const pine = useIndicators({
    symbol: "SOLUSDT", timeframe: "15m",
    startTime: "2026-01-01T00:00:00.000Z", endTime: "2026-01-02T00:00:00.000Z",
    scope: SCOPE,
  });
  onReady({ native, pine });
  return null;
}

/** Every pane write whose base version was not the row's — each one a 409. */
let stale: number[] = [];

beforeEach(() => {
  resetBrowser();
  stale = [];
  server.routes.set("POST /api/pine/run", () => ({
    ok: true, errors: [], times: [], plots: [],
    meta: { kind: "indicator", title: "Probe", shortTitle: "PRB", overlay: true,
      format: "price", precision: 2, inputs: [], warnings: [] },
  }));
  server.interpose((call) => {
    if (call.method !== "PUT" || !call.path.includes("/chart-state/panes/")) return;
    const base = (call.body as { baseVersion?: number }).baseVersion ?? 0;
    const current = server.getPane(SCOPE).version;
    if (base !== current) stale.push(base);
  });
});
after(closeBrowser);

const NATIVE = [{ key: "n1", defId: "rsi", params: {}, styles: {}, visible: true }];
const PINE = [{ key: "i1", scriptId: null, name: "Probe", source: SOURCE, params: {}, visible: true }];

test("B-20 — loading a pane with both halves stored writes no stale version", async () => {
  server.seedPane(SCOPE, {
    native: NATIVE, pine: PINE, version: 3, nativeWritten: true, pineWritten: true,
  });
  window.localStorage.setItem(nativeStorageKey(SCOPE), JSON.stringify(NATIVE));
  window.localStorage.setItem(indicatorStorageKey(SCOPE), JSON.stringify(PINE));

  render(<Pane onReady={() => {}} />);
  await settle();
  await advance(2_000);
  await settle();

  assert.deepEqual(stale, [],
    "a pane write went out on a version this browser had already moved past — the 409 on every load");
  const row = server.getPane(SCOPE);
  assert.equal(row.native.length, 1);
  assert.equal(row.pine.length, 1);
});

test("B-20 — an edit to each half a moment apart both land", async () => {
  let handle: Handle | null = null;
  render(<Pane onReady={(h) => { handle = h; }} />);
  await settle();
  await act(async () => { handle!.native.add("rsi"); });
  await act(async () => { handle!.pine.add({ scriptId: null, name: "Probe", source: SOURCE }); });
  await advance(2_000);
  await settle();

  const row = server.getPane(SCOPE);
  assert.equal(row.native.length, 1, "the built-in edit was lost");
  assert.equal(row.pine.length, 1, "the Pine edit was lost");
  assert.deepEqual(stale, [], "the second writer used the version the first had already spent");
});
