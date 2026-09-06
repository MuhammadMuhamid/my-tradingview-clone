/**
 * Built-in and Pine studies on one pane, and the one row they share.
 *
 * ── Why these two hooks are mounted together ───────────────────────────────
 *
 * A pane's studies live in a single server row with a single version, and the
 * two halves of it are written by two different hooks that never speak to each
 * other. That arrangement is deliberate — see `lib/useNativeStudies` — and it
 * is also exactly where the previous campaign lost user data four times: one
 * half sent `[]` for the other and deleted it; one half read the other's
 * existence as proof its own empty list was a deliberate deletion; a save that
 * ran before the restore had landed wrote an empty list over the stored one.
 *
 * None of those are visible in either hook alone, and none of them are visible
 * without effects actually running. So this mounts the two real hooks on one
 * scope, the way `ChartPane` mounts them, against a fixture origin that
 * implements the server's version rule exactly — including `pineWritten` and
 * `nativeWritten`, which is what a shared version cannot express.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, render } from "@testing-library/react";
import { advance, closeBrowser, resetBrowser, server, settle } from "./harness/env";
import { useNativeStudies, type NativeStudiesApi } from "@/lib/useNativeStudies";
import { useIndicators, type IndicatorsApi } from "@/lib/useIndicators";
import { loadStoredNative, nativeStorageKey } from "@/lib/native/storage";
import { indicatorStorageKey, loadStored } from "@/lib/indicators";
import type { Candle } from "@/lib/types";

const SCOPE = "p1";
const SOURCE = '//@version=5\nindicator("Probe")\nplot(close)';

/** A short bar series; the studies only need enough to have a value. */
const CANDLES: Candle[] = Array.from({ length: 120 }, (_, i) => ({
  symbol: "SOLUSDT", interval: "15m" as const,
  openTime: Date.UTC(2026, 0, 1) + i * 900_000,
  open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100.5 + i * 0.1,
  volume: 1_000, closeTime: Date.UTC(2026, 0, 1) + (i + 1) * 900_000 - 1,
}));

interface PaneHandle {
  native: NativeStudiesApi;
  pine: IndicatorsApi;
}

/** The two hooks, wired exactly as `ChartPane` wires them. */
function Pane({ onReady }: { onReady: (handle: PaneHandle) => void }) {
  const native = useNativeStudies({ candles: CANDLES, interval: "15m", scope: SCOPE });
  const pine = useIndicators({
    symbol: "SOLUSDT", timeframe: "15m",
    startTime: "2026-01-01T00:00:00.000Z", endTime: "2026-01-02T00:00:00.000Z",
    scope: SCOPE,
  });
  onReady({ native, pine });
  return <div data-native={native.list.length} data-pine={pine.list.length} />;
}

async function mountPane(): Promise<{ handle: () => PaneHandle; unmount: () => void }> {
  let latest: PaneHandle | null = null;
  const view = render(<Pane onReady={(h) => { latest = h; }} />);
  await settle();
  return {
    handle: () => {
      assert.ok(latest, "the pane never rendered");
      return latest;
    },
    unmount: () => view.unmount(),
  };
}

/** A compiled Pine run, in the shape the real endpoint answers with. */
function pineRun(): unknown {
  return {
    ok: true, errors: [],
    meta: {
      kind: "indicator", title: "Probe", shortTitle: "PRB", overlay: true,
      format: "price", precision: 2, inputs: [], warnings: [],
    },
    times: CANDLES.map((c) => Math.floor(c.openTime / 1000)),
    plots: [{
      id: "p0", title: "Probe", color: "#4f8cff", width: 1, style: "line",
      data: CANDLES.map((c) => c.close), renderable: true,
    }],
  };
}

beforeEach(() => {
  resetBrowser();
  server.routes.set("POST /api/pine/run", () => pineRun());
});
after(closeBrowser);

test("a pane's two kinds of study coexist, and each is stored under its own key", async () => {
  const pane = await mountPane();

  await act(async () => { pane.handle().native.add("rsi"); });
  await act(async () => { pane.handle().pine.add({ scriptId: null, name: "Probe", source: SOURCE }); });
  await settle();

  assert.equal(pane.handle().native.list.length, 1);
  assert.equal(pane.handle().pine.list.length, 1);
  assert.equal(loadStoredNative(SCOPE).length, 1, "the built-in half is in its own entry");
  assert.equal(loadStored(SCOPE).length, 1, "and the Pine half in its own");

  // Each half's local entry contains only its own kind. They used to be able
  // to see each other, which is where "one half deletes the other" begins.
  assert.equal(loadStoredNative(SCOPE)[0]!.defId, "rsi");
  assert.equal(loadStored(SCOPE)[0]!.source, SOURCE);
});

test("neither half's save deletes the other, on one shared server row", async () => {
  const pane = await mountPane();

  await act(async () => { pane.handle().pine.add({ scriptId: null, name: "Probe", source: SOURCE }); });
  await advance(1_400);
  assert.equal(server.getPane(SCOPE).pine.length, 1, "the Pine half reached the server");
  assert.equal(server.getPane(SCOPE).pineWritten, true);

  await act(async () => { pane.handle().native.add("rsi"); });
  await advance(1_400);

  const row = server.getPane(SCOPE);
  assert.equal(row.native.length, 1, "the built-in half reached the server");
  assert.equal(row.pine.length, 1,
    "a writer that sends a list it does not own deletes it — the native save " +
    "must omit the Pine column, not send an empty one");
  assert.equal(row.pineWritten, true);
  assert.equal(row.nativeWritten, true);

  // Every write to the row carried exactly one half.
  for (const call of server.calls.filter((c) => c.method === "PUT" && c.path.includes("/panes/"))) {
    const body = call.body as { pine?: unknown; native?: unknown };
    assert.notEqual(body.pine === undefined, body.native === undefined,
      `a pane write carried ${JSON.stringify(Object.keys(body))} — each hook writes only its own half`);
  }
});

test("a reload restores both halves, from the server and from storage alike", async () => {
  const first = await mountPane();
  await act(async () => { first.handle().native.add("rsi"); });
  await act(async () => { first.handle().pine.add({ scriptId: null, name: "Probe", source: SOURCE }); });
  await advance(1_400);
  first.unmount();

  // A different browser: the server has both halves, local storage has neither.
  const row = server.getPane(SCOPE);
  window.localStorage.clear();

  const second = await mountPane();
  await settle();
  assert.equal(second.handle().native.list.length, 1, "the built-in half came back");
  assert.equal(second.handle().pine.list.length, 1, "and so did the Pine half");
  assert.equal(second.handle().native.list[0]!.defId, "rsi");
  assert.equal(row.version, 2, "two halves, two writes, one row");
});

test("an empty half the server has written is a deletion, not an invitation to re-upload", async () => {
  /*
   * The sharp case. The two halves share one `version`, so once EITHER of them
   * created the row, `version > 0` was true for both — and each half read that
   * as "my half has been uploaded". One half then stopped uploading the user's
   * scripts forever; the other adopted an empty list over the top of the
   * user's studies. `pineWritten` / `nativeWritten` are what a shared version
   * cannot say, and this is the behaviour they buy.
   */
  server.seedPane(SCOPE, {
    pine: [], native: [], version: 3, pineWritten: true, nativeWritten: false,
  });
  // This browser has a built-in study that has never been uploaded.
  window.localStorage.setItem(nativeStorageKey(SCOPE), JSON.stringify([
    { key: "n1", defId: "rsi", params: {}, styles: {}, visible: true },
  ]));

  const pane = await mountPane();
  await settle();

  assert.equal(pane.handle().native.list.length, 1,
    "the row's Pine half having been written says nothing about the built-in half");
  await advance(1_400);
  assert.equal(server.getPane(SCOPE).native.length, 1,
    "so the built-in half must still be uploaded");
  assert.equal(server.getPane(SCOPE).pine.length, 0,
    "and the Pine half's recorded deletion must stay deleted");
});

test("a save refused as stale adopts the server's built-in list", async () => {
  const pane = await mountPane();
  await act(async () => { pane.handle().native.add("rsi"); });
  await advance(1_400);
  assert.equal(server.getPane(SCOPE).version, 1);

  // Another device replaces the pane's built-in studies and moves the version on.
  server.seedPane(SCOPE, {
    native: [{ key: "other", defId: "macd", params: {}, styles: {}, visible: true }],
    version: 9, nativeWritten: true,
  });

  await act(async () => { pane.handle().native.add("ma"); });
  await advance(1_400);

  const applied = pane.handle().native.list.map((s) => s.defId);
  assert.deepEqual(applied, ["macd"],
    "a refused write hands back what is stored, and the client adopts it");
  assert.equal(server.getPane(SCOPE).version, 9, "the refused write was not applied");
});

test("the restore lands before the first save, so an empty list is never written over it", async () => {
  /*
   * The ordering defect, on its own. Both hooks save `list` in an effect; on
   * mount `list` is empty while the restore is still in flight. A save on that
   * first pass wipes everything the user had, locally and then remotely.
   */
  window.localStorage.setItem(nativeStorageKey(SCOPE), JSON.stringify([
    { key: "n1", defId: "rsi", params: {}, styles: {}, visible: true },
  ]));
  window.localStorage.setItem(indicatorStorageKey(SCOPE), JSON.stringify([
    { key: "i1", scriptId: null, name: "Probe", source: SOURCE, params: {}, visible: true },
  ]));

  const pane = await mountPane();
  await advance(1_400);

  assert.equal(loadStoredNative(SCOPE).length, 1, "the stored built-in study survived the mount");
  assert.equal(loadStored(SCOPE).length, 1, "and so did the stored Pine study");
  assert.equal(pane.handle().native.list.length, 1);
  assert.equal(pane.handle().pine.list.length, 1);
  assert.equal(server.getPane(SCOPE).native.length, 1, "and both were imported once");
  assert.equal(server.getPane(SCOPE).pine.length, 1);
});

/**
 * Another device writing the pane's PINE half, immediately before each of this
 * client's own writes, `times` times.
 *
 * The row moves on, so every write this client sends is stale and is refused —
 * and because the other device only ever writes Pine, `nativeWritten` stays
 * false throughout. That is the shape of the refusal that is NOT a conflict
 * about built-in studies, sustained for longer than one round trip.
 */
function otherDeviceKeepsWriting(times: number): (call: { method: string; path: string }) => void {
  let landed = 0;
  return (call) => {
    if (call.method !== "PUT" || !call.path.includes("/panes/")) return;
    if (landed >= times) return;
    landed += 1;
    const row = server.getPane(SCOPE);
    server.seedPane(SCOPE, {
      pine: [{ key: `other-${landed}`, source: SOURCE }],
      version: row.version + 1,
      pineWritten: true,
    });
  };
}

test("a half the server has never written is never adopted, however deep the race", async () => {
  /*
   * One race deeper than the retry.
   *
   * A first write that meets a row the OTHER half has just created is refused
   * and simply re-based — that is the ordinary case, and it lands. But if a
   * writer keeps getting there first, the LAST refusal still carries an empty
   * list for a half nobody has ever written, and adopting that is the same
   * silent deletion the re-base exists to prevent. The user's studies are on
   * their chart; nothing that failed to be written may remove them.
   */
  server.interpose(otherDeviceKeepsWriting(Number.POSITIVE_INFINITY));

  const pane = await mountPane();
  await act(async () => { pane.handle().native.add("rsi"); });
  await advance(1_400);

  assert.equal(pane.handle().native.list.length, 1,
    "a write that never landed must not empty the chart it was written from");
  assert.equal(loadStoredNative(SCOPE).length, 1,
    "and must not empty this browser's own copy either");
  assert.equal(server.getPane(SCOPE).nativeWritten, false,
    "the server still holds no built-in half — which is why there was nothing to adopt");

  // And the retry is bounded: a row somebody else is writing is not a spin.
  const writes = server.calls.filter(
    (c) => c.method === "PUT" && c.path.includes("/panes/")).length;
  assert.ok(writes > 1 && writes <= 8,
    `the client sent ${writes} writes; a refusal it cannot resolve is re-tried a few times, not forever`);
});

test("a re-based write lands as soon as the other writer stops", async () => {
  // Two interlopers, then quiet: the study must reach the server by itself,
  // without the user touching the chart again.
  server.interpose(otherDeviceKeepsWriting(2));

  const pane = await mountPane();
  await act(async () => { pane.handle().native.add("rsi"); });
  await advance(1_400);

  const row = server.getPane(SCOPE);
  assert.equal(row.native.length, 1, "the built-in half is stored");
  assert.equal(row.nativeWritten, true);
  assert.equal(row.pine.length, 1, "and the other device's Pine half is untouched");
  assert.equal(pane.handle().native.list.length, 1);
});

test("an unreachable server leaves the user exactly as they were", async () => {
  window.localStorage.setItem(nativeStorageKey(SCOPE), JSON.stringify([
    { key: "n1", defId: "rsi", params: {}, styles: {}, visible: true },
  ]));
  server.offline = true;

  const pane = await mountPane();
  await advance(1_400);

  assert.equal(pane.handle().native.list.length, 1,
    "a sync that cannot reach the server must change nothing at all");
  assert.equal(loadStoredNative(SCOPE).length, 1);
});
