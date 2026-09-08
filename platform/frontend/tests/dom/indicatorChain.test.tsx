/**
 * A study reading another study, in a mounted pane.
 *
 * `tests/indicatorGraph.test.ts` proves the graph's rules in isolation. What
 * cannot be proved there is everything that only exists once the hook is
 * running: whether a chain survives a live tick, whether hiding a source
 * breaks what reads it, whether deleting one leaves a silent average of price
 * behind, and whether any of it is still there after a reload.
 *
 * Those are precisely the failures a pure test cannot see — the previous
 * campaign lost user data four times to defects of exactly this shape — so
 * they are checked against the real hook, with effects running.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { act, render } from "@testing-library/react";
import { advance, closeBrowser, resetBrowser, settle } from "./harness/env";
import { useNativeStudies, type NativeStudiesApi } from "@/lib/useNativeStudies";
import { loadStoredNative } from "@/lib/native/storage";
import { MAX_SOURCE_DEPTH, studySourceToken } from "@/lib/native/graph";
import type { Candle } from "@/lib/types";

const SCOPE = "p1";
const START = Date.UTC(2026, 0, 1);

function candles(count: number, drift = 0): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: "SOLUSDT", interval: "15m" as const,
    openTime: START + i * 900_000,
    closeTime: START + (i + 1) * 900_000 - 1,
    open: 100 + Math.sin(i / 9) * 4,
    high: 103 + Math.sin(i / 9) * 4,
    low: 97 + Math.sin(i / 9) * 4,
    close: 100 + Math.sin(i / 6) * 5 + (i === count - 1 ? drift : 0),
    volume: 1_000 + (i % 7),
  })) as Candle[];
}

const BASE = candles(400);

interface Handle {
  api: NativeStudiesApi;
  setBars: (bars: Candle[]) => void;
}

function Pane({ onReady, bars }: { onReady: (h: Handle) => void; bars: Candle[] }) {
  const [current, setCurrent] = useState(bars);
  const api = useNativeStudies({ candles: current, interval: "15m", scope: SCOPE });
  onReady({ api, setBars: setCurrent });
  return <div data-count={api.list.length} />;
}

async function mountPane(bars: Candle[] = BASE) {
  let latest: Handle | null = null;
  const view = render(<Pane bars={bars} onReady={(h) => { latest = h; }} />);
  await settle();
  return {
    handle: (): Handle => {
      assert.ok(latest, "the pane never rendered");
      return latest;
    },
    unmount: () => view.unmount(),
  };
}

/** The overlay a study instance draws, or null when it draws nothing. */
function overlayOf(api: NativeStudiesApi, key: string, plotId: string) {
  return api.overlays.find((o) => o.id === `${key}:${plotId}`) ?? null;
}

function finiteValues(points: { value: number | null }[]): number[] {
  return points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
}

/** Apply an RSI, then a moving average that reads it. Returns both keys. */
async function chain(pane: Awaited<ReturnType<typeof mountPane>>) {
  let rsi = "";
  let ma = "";
  await act(async () => { rsi = pane.handle().api.add("rsi") ?? ""; });
  await act(async () => { ma = pane.handle().api.add("ma") ?? ""; });
  await act(async () => {
    pane.handle().api.setParam(ma, "source", studySourceToken(rsi, "rsi"));
  });
  await settle();
  return { rsi, ma };
}

beforeEach(resetBrowser);
after(closeBrowser);

test("an average of an RSI is drawn from the RSI, not from price", async () => {
  const pane = await mountPane();
  const { rsi, ma } = await chain(pane);

  const rsiLine = overlayOf(pane.handle().api, rsi, "rsi");
  const maLine = overlayOf(pane.handle().api, ma, "ma");
  assert.ok(rsiLine, "the RSI is on the chart");
  assert.ok(maLine, "and so is the average of it");

  const values = finiteValues(maLine.data);
  assert.ok(values.length > 100, "the chained average has values");
  /*
   * The RSI is bounded to 0–100 and this instrument trades near 100, so a
   * value range alone could not tell the two apart. What can: an average OF
   * the RSI stays inside the RSI's own range at every bar, and an average of
   * price does not, because price here swings either side of it.
   */
  const low = Math.min(...finiteValues(rsiLine.data));
  const high = Math.max(...finiteValues(rsiLine.data));
  for (const value of values) {
    assert.ok(value >= low - 1e-9 && value <= high + 1e-9,
      `${value} is outside the RSI's own range of ${low}–${high}`);
  }

  // And the average lands on the PRICE pane, where a moving average belongs,
  // while the RSI keeps its own — chaining does not move either of them.
  assert.equal(maLine.paneId, "price");
  assert.equal(rsiLine.paneId, `indicator:${rsi}`);

  // The legend says what it reads, by name rather than by token.
  assert.ok(maLine.instanceParams?.includes("Relative Strength Index"),
    `legend reads "${maLine.instanceParams}"`);
  assert.ok(!maLine.instanceParams?.includes("study:"));
  pane.unmount();
});

test("a live tick propagates along the chain rather than stopping at the source", async () => {
  const pane = await mountPane();
  const { rsi, ma } = await chain(pane);

  const before = {
    rsi: overlayOf(pane.handle().api, rsi, "rsi")!.data.at(-1)!.value,
    ma: overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value,
  };

  // The forming bar is revised, exactly as a tick revises it.
  await act(async () => { pane.handle().setBars(candles(400, 9)); });
  await settle();

  const after = {
    rsi: overlayOf(pane.handle().api, rsi, "rsi")!.data.at(-1)!.value,
    ma: overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value,
  };
  assert.notEqual(after.rsi, before.rsi, "the RSI followed the tick");
  assert.notEqual(after.ma, before.ma,
    "and so did the average of it — a chain that updates only its source is a stale chain");
  pane.unmount();
});

test("hiding a source hides its line and leaves what reads it working", async () => {
  const pane = await mountPane();
  const { rsi, ma } = await chain(pane);
  const before = overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value;

  await act(async () => { pane.handle().api.toggleVisible(rsi); });
  await settle();

  assert.equal(overlayOf(pane.handle().api, rsi, "rsi"), null, "the RSI's line is gone");
  const line = overlayOf(pane.handle().api, ma, "ma");
  assert.ok(line, "the average of it is not");
  assert.equal(line.data.at(-1)!.value, before, "and it says exactly what it said before");
  assert.equal(pane.handle().api.issues.size, 0);
  pane.unmount();
});

test("deleting a source is reported, and never becomes an average of price", async () => {
  const pane = await mountPane();
  const { rsi, ma } = await chain(pane);
  const chained = overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value;
  let downstream = "";
  await act(async () => { downstream = pane.handle().api.add("ma") ?? ""; });
  await act(async () => {
    pane.handle().api.setParam(downstream, "source", studySourceToken(ma, "ma"));
  });
  await settle();
  assert.ok(overlayOf(pane.handle().api, downstream, "ma"));

  await act(async () => { pane.handle().api.remove(rsi); });
  await settle();

  assert.equal(pane.handle().api.issues.get(ma), "missing");
  assert.equal(pane.handle().api.issues.get(downstream), "missing",
    "the diagnostic propagates beyond the direct orphan");
  assert.equal(overlayOf(pane.handle().api, ma, "ma"), null,
    "a study that cannot compute draws nothing");
  const row = pane.handle().api.rows.find((r) => r.study.key === ma)!;
  const downstreamRow = pane.handle().api.rows.find((r) => r.study.key === downstream)!;
  assert.equal(row.sourceIssue, "missing");
  assert.equal(row.insufficient, false, "more history would not help, so it must not say that");
  assert.equal(downstreamRow.sourceIssue, "missing");
  assert.equal(downstreamRow.insufficient, false);
  assert.equal(overlayOf(pane.handle().api, downstream, "ma"), null);

  // The parameter is untouched, so the chain is repairable rather than lost.
  assert.equal(row.study.params.source, studySourceToken(rsi, "rsi"));

  // Re-pointing it at a price gives a DIFFERENT line — proof the chained one
  // was never quietly an average of close.
  await act(async () => { pane.handle().api.setParam(ma, "source", "close"); });
  await settle();
  const onPrice = overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value;
  assert.notEqual(onPrice, chained);
  pane.unmount();
});

test("reordering changes layering and not what anything computes", async () => {
  const pane = await mountPane();
  const { rsi, ma } = await chain(pane);
  const before = overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value;

  // Move the dependent ABOVE its source in the list.
  await act(async () => { pane.handle().api.move(ma, -1); });
  await settle();

  assert.deepEqual(pane.handle().api.list.map((s) => s.key), [ma, rsi]);
  assert.equal(pane.handle().api.issues.size, 0);
  assert.equal(overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value, before);
  pane.unmount();
});

test("a chain survives a reload, because it is stored in the parameters", async () => {
  const pane = await mountPane();
  const { rsi, ma } = await chain(pane);
  await advance(1_400);
  await settle();

  const stored = loadStoredNative(SCOPE);
  assert.equal(stored.length, 2);
  assert.equal(stored.find((s) => s.key === ma)!.params.source, studySourceToken(rsi, "rsi"));
  const drawn = overlayOf(pane.handle().api, ma, "ma")!.data.at(-1)!.value;
  pane.unmount();

  const reopened = await mountPane();
  await settle();
  assert.equal(reopened.handle().api.list.length, 2);
  assert.equal(reopened.handle().api.issues.size, 0);
  assert.equal(overlayOf(reopened.handle().api, ma, "ma")!.data.at(-1)!.value, drawn,
    "the reopened chain draws the same line, not a fresh average of price");
  reopened.unmount();
});

test("the picker never offers a choice that would close a loop", async () => {
  const pane = await mountPane();
  const { rsi, ma } = await chain(pane);

  const forRsi = pane.handle().api.sourceOptions(rsi).map((o) => o.value);
  assert.ok(forRsi.includes("close"), "the prices are always available");
  assert.ok(!forRsi.some((v) => v.startsWith(`study:${ma}:`)),
    "the RSI may not read the average that already reads it");
  assert.ok(!forRsi.some((v) => v.startsWith(`study:${rsi}:`)),
    "nor itself");

  const forMa = pane.handle().api.sourceOptions(ma).map((o) => o.value);
  assert.ok(forMa.includes(studySourceToken(rsi, "rsi")));
  pane.unmount();
});

test("four study-to-study links compute, and the fifth link is refused", async () => {
  const pane = await mountPane();
  let previous = "";
  await act(async () => { previous = pane.handle().api.add("rsi") ?? ""; });
  for (let edge = 1; edge <= MAX_SOURCE_DEPTH + 1; edge++) {
    let next = "";
    await act(async () => { next = pane.handle().api.add("ma") ?? ""; });
    await act(async () => {
      pane.handle().api.setParam(
        next, "source", studySourceToken(previous, edge === 1 ? "rsi" : "ma"));
    });
    await settle();
    if (edge <= MAX_SOURCE_DEPTH) {
      assert.equal(pane.handle().api.issues.get(next), undefined, `edge ${edge} is allowed`);
      assert.ok(overlayOf(pane.handle().api, next, "ma"), `edge ${edge} computes`);
    } else {
      assert.equal(pane.handle().api.issues.get(next), "depth", `edge ${edge} is refused`);
      assert.equal(overlayOf(pane.handle().api, next, "ma"), null);
    }
    previous = next;
  }
  assert.equal(pane.handle().api.list.length, MAX_SOURCE_DEPTH + 2,
    "the refused study stays visible so the panel can diagnose it");
  pane.unmount();
});
