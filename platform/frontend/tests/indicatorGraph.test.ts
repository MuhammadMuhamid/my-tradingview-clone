/**
 * One study reading another: the ordering, the refusals and the ids.
 *
 * A chain of studies is the first thing in this catalog where the ANSWER
 * depends on something other than the bars — it depends on what else is
 * applied, and on the order that is computed in. Every case below is one of
 * the ways that can go quietly wrong: a dependent computed before its source,
 * a cycle, a dangling reference silently becoming an average of price, or a
 * chain whose window grows without limit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { studyById } from "../lib/native/catalog";
import { defaultParams, isStudySourceToken, normalizeParams } from "../lib/native/registry";
import { newNativeStudy, type AppliedNativeStudy } from "../lib/native/compute";
import {
  MAX_SOURCE_DEPTH, buildStudyGraph, describeSource, parseStudySource, plotIsSourceable,
  sourceIssueMessage, sourceLabels, sourceOptionsFor, studyDependencies, studySourceToken,
} from "../lib/native/graph";
import { resolveSource } from "../lib/native/shared";
import type { Candle } from "../lib/types";

const T0 = 1_700_000_000_000;

function bars(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: T0 + i * 60_000, closeTime: T0 + (i + 1) * 60_000 - 1,
    open: 100 + Math.sin(i / 7) * 5, high: 103 + Math.sin(i / 7) * 5,
    low: 97 + Math.sin(i / 7) * 5, close: 100 + Math.sin(i / 5) * 6,
    volume: 20 + (i % 11),
  })) as Candle[];
}

/** An applied instance with a fixed key, so the tests can name it. */
function applied(defId: string, key: string, params: Record<string, unknown> = {}): AppliedNativeStudy {
  const def = studyById(defId)!;
  const study = newNativeStudy(def, key);
  study.params = normalizeParams(def, { ...defaultParams(def), ...params } as never);
  return study;
}

const warmupOf = (s: AppliedNativeStudy, def: ReturnType<typeof studyById>) =>
  def!.warmup(normalizeParams(def!, s.params));

const graphOf = (list: AppliedNativeStudy[]) =>
  buildStudyGraph(list, studyById, (s, def) => warmupOf(s, def));

test("a source token is one shape, and both modules agree on it", () => {
  const token = studySourceToken("nat_abc", "rsi");
  assert.equal(token, "study:nat_abc:rsi");
  assert.deepEqual(parseStudySource(token), { key: "nat_abc", plotId: "rsi" });
  assert.equal(parseStudySource("close"), null);
  assert.equal(parseStudySource(""), null);
  assert.equal(parseStudySource(42), null);
  assert.equal(parseStudySource("study:with spaces:x"), null);
  // The registry's own shape check, which cannot import the graph, must accept
  // exactly what the graph produces and reject exactly what it rejects.
  for (const value of [token, "study:a:b", "close", "study:", "study:a", 7, null, "study:a:b:c"]) {
    assert.equal(
      isStudySourceToken(value), parseStudySource(value) !== null,
      `disagreement on ${String(value)}`);
  }
});

test("a stored study source survives normalisation instead of reverting to close", () => {
  const ma = studyById("ma")!;
  const params = normalizeParams(ma, { source: "study:nat_x1:rsi" } as never);
  assert.equal(params.source, "study:nat_x1:rsi");
  // Junk still falls back, as it always did.
  assert.equal(normalizeParams(ma, { source: "sideways" } as never).source, ma.inputs
    .find((i) => i.kind === "source")!.defval);
});

test("a source that is not supplied yields na, never a quiet fallback to price", () => {
  const candles = bars(20);
  const missing = resolveSource(candles, "study:nat_gone:rsi");
  assert.equal(missing.length, 20);
  assert.ok(missing.every(Number.isNaN));
  const supplied = resolveSource(candles, "study:nat_here:rsi", {
    "study:nat_here:rsi": candles.map((_, i) => i),
  });
  assert.deepEqual(supplied, candles.map((_, i) => i));
  // Prices still resolve exactly as before.
  assert.deepEqual(resolveSource(candles, "high"), candles.map((c) => c.high));
});

test("a dependent is computed after its source whatever the list order says", () => {
  const rsi = applied("rsi", "s_rsi");
  const ma = applied("ma", "s_ma", { source: studySourceToken("s_rsi", "rsi") });
  // The moving average sits ABOVE the RSI in the list — layering order, which
  // has nothing to do with what has to be computed first.
  const graph = graphOf([ma, rsi]);
  assert.deepEqual(graph.order, ["s_rsi", "s_ma"]);
  assert.equal(graph.issues.size, 0);
  assert.equal(graph.depth.get("s_ma"), 1);
  assert.equal(graph.depth.get("s_rsi"), 0);
  // One group, so both are evaluated over one window.
  assert.equal(graph.component.get("s_ma"), graph.component.get("s_rsi"));
  assert.equal(graph.componentSize[graph.component.get("s_ma")!], 2);
});

test("a group's lead-in is the whole chain's, not the deepest single study's", () => {
  const rsi = applied("rsi", "a");
  const ma = applied("ma", "b", { source: studySourceToken("a", "rsi") });
  const graph = graphOf([rsi, ma]);
  const index = graph.component.get("b")!;
  const rsiWarmup = warmupOf(rsi, studyById("rsi"));
  const maWarmup = warmupOf(ma, studyById("ma"));
  assert.equal(graph.componentWarmup[index], rsiWarmup + maWarmup);
  assert.ok(graph.componentWarmup[index]! > Math.max(rsiWarmup, maWarmup),
    "an average of an RSI needs the RSI to have converged before it starts");
});

test("an unrelated study keeps its own window and its own group", () => {
  const rsi = applied("rsi", "a");
  const ma = applied("ma", "b", { source: studySourceToken("a", "rsi") });
  const lonely = applied("cci", "c");
  const graph = graphOf([rsi, ma, lonely]);
  assert.notEqual(graph.component.get("c"), graph.component.get("a"));
  assert.equal(graph.componentSize[graph.component.get("c")!], 1);
  assert.equal(
    graph.componentWarmup[graph.component.get("c")!],
    warmupOf(lonely, studyById("cci")));
});

test("a two-study cycle is refused rather than computed", () => {
  const a = applied("ma", "a", { source: studySourceToken("b", "ma") });
  const b = applied("ma", "b", { source: studySourceToken("a", "ma") });
  const graph = graphOf([a, b]);
  assert.equal(graph.issues.get("a"), "cycle");
  assert.equal(graph.issues.get("b"), "cycle");
  // Both still appear, so the panel can say why rather than losing them.
  assert.deepEqual([...graph.order].sort(), ["a", "b"]);
});

test("a longer cycle, and everything downstream of it, is refused too", () => {
  const a = applied("ma", "a", { source: studySourceToken("c", "ma") });
  const b = applied("ma", "b", { source: studySourceToken("a", "ma") });
  const c = applied("ma", "c", { source: studySourceToken("b", "ma") });
  const reader = applied("cci", "d", { source: studySourceToken("a", "ma") });
  const graph = graphOf([a, b, c, reader]);
  for (const key of ["a", "b", "c", "d"]) {
    assert.ok(graph.issues.has(key), `${key} should be refused`);
  }
});

test("a source that has been deleted is reported, not silently repointed at price", () => {
  const orphan = applied("ma", "a", { source: studySourceToken("gone", "rsi") });
  const graph = graphOf([orphan]);
  assert.equal(graph.issues.get("a"), "missing");
  assert.match(sourceIssueMessage("missing"), /removed/);
  // The parameter is untouched, so restoring the source restores the chain.
  assert.equal(orphan.params.source, "study:gone:rsi");
});

test("a chain longer than the limit is refused, and the picker never offers one", () => {
  const chain: AppliedNativeStudy[] = [applied("rsi", "k0")];
  for (let i = 1; i <= MAX_SOURCE_DEPTH + 1; i++) {
    chain.push(applied("ma", `k${i}`, {
      source: studySourceToken(`k${i - 1}`, i === 1 ? "rsi" : "ma"),
    }));
  }
  const graph = graphOf(chain);
  assert.equal(graph.depth.get(`k${MAX_SOURCE_DEPTH}`), MAX_SOURCE_DEPTH);
  assert.ok(!graph.issues.has(`k${MAX_SOURCE_DEPTH}`));
  assert.equal(graph.issues.get(`k${MAX_SOURCE_DEPTH + 1}`), "depth");

  // And the option that would have created that last link is not offered.
  const legal = sourceOptionsFor(chain.slice(0, MAX_SOURCE_DEPTH + 1), studyById, "new");
  assert.ok(!legal.some((o) => o.value.startsWith(`study:k${MAX_SOURCE_DEPTH}:`)));
});

test("the picker offers prices always and only sources that cannot close a loop", () => {
  const rsi = applied("rsi", "a");
  const ma = applied("ma", "b", { source: studySourceToken("a", "rsi") });
  const options = sourceOptionsFor([rsi, ma], studyById, "a");
  assert.ok(options.some((o) => o.value === "close" && o.group === "price"));
  assert.ok(options.some((o) => o.value === "hlc3"));
  // The RSI may not read the average that already reads it, nor itself.
  assert.ok(!options.some((o) => o.value.startsWith("study:b:")));
  assert.ok(!options.some((o) => o.value.startsWith("study:a:")));

  // The other way round, the average may read the RSI — that is the chain it
  // already has, offered so it can be re-chosen.
  const forMa = sourceOptionsFor([rsi, ma], studyById, "b");
  assert.ok(forMa.some((o) => o.value === studySourceToken("a", "rsi")));
});

test("a study with no source input is never offered a study source", () => {
  const atr = studyById("atr")!;
  assert.ok(!atr.inputs.some((i) => i.kind === "source"),
    "ATR reads highs and lows, so it has no single source to replace");
  const options = sourceOptionsFor(
    [applied("rsi", "a"), applied("atr", "b")], studyById, "b");
  assert.ok(options.every((o) => o.group === "price"));
});

test("a viewport-dependent study's output is not offered as anybody's source", () => {
  const vrvp = studyById("vrvp")!;
  assert.equal(plotIsSourceable(vrvp, "poc"), false);
  const options = sourceOptionsFor(
    [applied("vrvp", "a"), applied("ma", "b")], studyById, "b");
  assert.ok(!options.some((o) => o.value.startsWith("study:a:")),
    "an average that changed when you scrolled would not be an average");
});

test("a displaced plot is not offered, because it is drawn at other bars", () => {
  const ichimoku = studyById("ichimoku");
  if (!ichimoku) return;
  for (const plot of ichimoku.plots) {
    if ((plot.offset ?? 0) !== 0) {
      assert.equal(plotIsSourceable(ichimoku, plot.id), false, `${plot.id} is displaced`);
    }
  }
});

test("every offered option resolves to a plot that exists", () => {
  const list = [applied("rsi", "a"), applied("macd", "b"), applied("ma", "c")];
  for (const option of sourceOptionsFor(list, studyById, "c")) {
    if (option.group !== "study") continue;
    const parsed = parseStudySource(option.value)!;
    const source = list.find((s) => s.key === parsed.key)!;
    const def = studyById(source.defId)!;
    assert.ok(def.plots.some((p) => p.id === parsed.plotId), option.value);
    assert.ok(option.label.includes(def.name));
  }
});

test("two instances of one study are told apart in the picker", () => {
  const list = [applied("rsi", "a"), applied("rsi", "b"), applied("ma", "c")];
  const labels = sourceOptionsFor(list, studyById, "c")
    .filter((o) => o.group === "study").map((o) => o.label);
  assert.equal(new Set(labels).size, labels.length, `ambiguous labels: ${labels.join(", ")}`);
});

test("a source reads as what it is, in the legend and in the dialog", () => {
  const list = [applied("rsi", "a"), applied("ma", "b", { source: studySourceToken("a", "rsi") })];
  assert.equal(
    describeSource(studySourceToken("a", "rsi"), list, studyById),
    "Relative Strength Index · RSI");
  assert.equal(describeSource("close", list, studyById), "Close");
  assert.equal(describeSource(studySourceToken("gone", "rsi"), list, studyById),
    "a study that is gone");
  assert.deepEqual(sourceLabels(list, studyById),
    { [studySourceToken("a", "rsi")]: "Relative Strength Index · RSI" });
});

test("dependencies are read from the parameters, so they persist with them", () => {
  const ma = applied("ma", "b", { source: studySourceToken("a", "rsi") });
  const edges = studyDependencies(ma, studyById("ma")!);
  assert.deepEqual(edges, [{
    inputKey: "source", key: "a", plotId: "rsi", token: "study:a:rsi",
  }]);
  // A round trip through the storage shape keeps them.
  const stored = JSON.parse(JSON.stringify({
    key: ma.key, defId: ma.defId, params: ma.params, visible: true, styles: {},
  })) as AppliedNativeStudy;
  assert.deepEqual(
    studyDependencies(stored, studyById("ma")!).map((e) => e.token), ["study:a:rsi"]);
});

test("an empty pane and a pane of one study both produce a usable graph", () => {
  const empty = graphOf([]);
  assert.deepEqual(empty.order, []);
  assert.equal(empty.issues.size, 0);
  const one = graphOf([applied("rsi", "a")]);
  assert.deepEqual(one.order, ["a"]);
  assert.equal(one.componentSize[0], 1);
});

test("an average of an RSI is actually an average of the RSI's numbers", () => {
  /*
   * The end-to-end claim, checked against arithmetic done here rather than
   * against the implementation: compute the RSI, average it by hand, and the
   * chained study must agree bar for bar.
   */
  const candles = bars(600);
  const rsiDef = studyById("rsi")!;
  const maDef = studyById("ma")!;
  const rsiParams = normalizeParams(rsiDef, defaultParams(rsiDef));
  const rsi = rsiDef.compute({ candles, params: rsiParams, interval: "1m" }).plots.rsi!;

  const maParams = normalizeParams(maDef, {
    ...defaultParams(maDef), source: studySourceToken("a", "rsi"), length: 5, maType: "SMA",
  } as never);
  const chained = maDef.compute({
    candles, params: maParams, interval: "1m",
    sources: { [studySourceToken("a", "rsi")]: rsi },
  }).plots;
  const line = Object.values(chained)[0]!;

  for (let i = 20; i < candles.length; i++) {
    const window = rsi.slice(i - 4, i + 1);
    if (window.some((v) => !Number.isFinite(v))) continue;
    const mean = window.reduce((n, v) => n + v, 0) / 5;
    assert.ok(Math.abs(line[i]! - mean) < 1e-9,
      `bar ${i}: ${line[i]} is not the mean of the RSI's last five values (${mean})`);
  }
  // And it is genuinely different from the same average taken on price.
  const onPrice = maDef.compute({
    candles,
    params: normalizeParams(maDef, {
      ...defaultParams(maDef), source: "close", length: 5, maType: "SMA",
    } as never),
    interval: "1m",
  }).plots;
  assert.notDeepEqual(Object.values(onPrice)[0], line);
});
