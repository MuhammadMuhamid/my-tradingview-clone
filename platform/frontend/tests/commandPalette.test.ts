/**
 * The command palette's index and its ranking.
 *
 * TVP8. The reference has a palette — "Search tool or function", behind the
 * magnifier beside the settings gear — and the previous campaign's ledger
 * recorded it as not-applicable. It is applicable, and it matters more here
 * than there: 87 drawing tools behind eight flyouts, 57 studies behind a
 * browser, 21 chart types behind one menu.
 *
 * Ranking is the whole of whether a palette over 165 entries is usable, and it
 * is the part that cannot be checked by rendering a list and looking at it.
 * That is why `lib/commandPalette.ts` is pure and this file exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCommands, rankCommands, runCommand, scoreCommand } from "../lib/commandPalette";
import { CHART_TYPES } from "../lib/chartType";
import { NATIVE_STUDIES } from "../lib/native/catalog";
import { BINDINGS } from "../lib/shortcuts";

const ROOT = path.join(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The rail's taxonomy, read the way the component declares it.
 *
 * TVP8 round three: a group's tools sit inside `sections` — the reference's
 * own "Lines", "Channels", "Pitchforks" — and the "— click a drawing to delete
 * it" half of a label moved to a `hint`, because in a fixed-width menu it
 * rendered as an ellipsis. `buildCommands` flattens the sections and keeps the
 * hint searchable; both are asserted below.
 */
const GROUPS = [
  {
    id: "cursors",
    sections: [{ tools: [
      { tool: "cursor", label: "Cross" },
      { tool: "eraser", label: "Eraser", hint: "Click a drawing to delete it" },
    ] }],
  },
  {
    id: "trend-line",
    sections: [
      { tools: [{ tool: "trend", label: "Trendline" }] },
      { heading: "Channels", tools: [{ tool: "hline", label: "Horizontal line" }] },
    ],
  },
  {
    id: "gann-and-fibonacci",
    sections: [{ tools: [
      { tool: "fib", label: "Fib retracement" },
      { tool: "fibWedge", label: "Fib wedge" },
    ] }],
  },
];

test("the palette indexes every drawing, study, chart type and action", () => {
  const commands = buildCommands(GROUPS, true);

  const drawings = commands.filter((c) => c.kind === "drawing");
  assert.equal(drawings.length, 6, "every tool in every group, not one per group");

  const indicators = commands.filter((c) => c.kind === "indicator");
  assert.equal(indicators.length, NATIVE_STUDIES.length,
    "a study the palette cannot find is a study behind a search box inside a browser");

  const types = commands.filter((c) => c.kind === "chartType");
  assert.equal(types.length, CHART_TYPES.length);

  /*
   * Actions come from BINDINGS — the same table the keyboard handler reads —
   * minus the tool selections, which are already indexed under the tool's own
   * name. Two keys bound to one action is one command.
   */
  /*
   * TVP8 round two: a palette does not offer what cannot happen.
   *
   * It used to list the three Replay steps with no session running, the
   * drawing commands with nothing selected, and ITSELF — a row that answers a
   * search, gets chosen, and closes the palette. Every one of those is a
   * promise the product cannot keep at the moment it is made.
   */
  const actions = commands.filter((c) => c.kind === "action");
  const alwaysAvailable = new Set(
    BINDINGS
      .filter((b) => !b.action.startsWith("tool:"))
      .filter((b) => !b.replayOnly)
      .filter((b) => b.action !== "command-palette")
      .filter((b) => !["delete", "clone", "copy", "paste", "bring-forward", "send-backward"]
        .includes(b.action))
      .map((b) => b.action));
  assert.equal(actions.length, alwaysAvailable.size);
  assert.equal(actions.some((c) => c.id === "action:command-palette"), false,
    "the palette does not offer to open itself");
  assert.equal(actions.some((c) => c.id === "action:replay-step-forward"), false,
    "a Replay step with no session is a row that does nothing");

  // And with a session and a selection, they come back.
  const live = buildCommands(GROUPS, true, { replayActive: true, drawingSelected: true });
  assert.ok(live.some((c) => c.id === "action:replay-step-forward"));
  assert.ok(live.some((c) => c.id === "action:clone"));

  // Every id is unique, or favouriting one favourites two.
  assert.equal(new Set(commands.map((c) => c.id)).size, commands.length);
});

test("a rail label's trailing explanation is a keyword, not part of the name", () => {
  const commands = buildCommands(GROUPS, true);
  const eraser = commands.find((c) => c.id === "drawing:eraser");
  assert.equal(eraser?.label, "Eraser",
    "the palette shows the name; the rail's tooltip sentence is not a name");
  // But it is still findable by what it does.
  assert.ok(scoreCommand(eraser!, "delete") !== null);
});

test("an exact name outranks a prefix, and a prefix outranks a substring", () => {
  const commands = buildCommands(GROUPS, true);
  const byLabel = (label: string) => commands.find((c) => c.label === label)!;

  assert.equal(scoreCommand(byLabel("Trendline"), "trendline"), 4);
  assert.equal(scoreCommand(byLabel("Trendline"), "trend"), 3);
  assert.equal(scoreCommand(byLabel("Fib retracement"), "retracement"), 2);
  assert.equal(scoreCommand(byLabel("Fib wedge"), "edge"), 1);
  assert.equal(scoreCommand(byLabel("Fib wedge"), "gann"), 0, "its group is a keyword");
  assert.equal(scoreCommand(byLabel("Fib wedge"), "zzz"), null);
});

test("equal matches keep the order the menu curated", () => {
  /*
   * Every "Line…" chart type starts with "line", so they all score the same
   * and the tie-break decides. It is the chart-type menu's own order, which
   * puts Line before Line with markers before Line break.
   *
   * The first version of this broke ties on label LENGTH, which looked
   * reasonable and was wrong the moment it met real data: "fib" answered with
   * Fib wedge above Fib retracement, six characters being the whole argument.
   * The curated order is somebody's judgement about which of ten Fibonacci
   * tools people reach for, and discarding it made the palette argue with the
   * menu next to it.
   */
  const ranked = rankCommands(buildCommands([], true), "line");
  const labels = ranked.filter((c) => c.kind === "chartType").map((c) => c.label);
  // "Step line" and "Baseline" match too, lower down: a word-start and a
  // substring respectively. The three that all START with it come first, in
  // the menu's order.
  assert.deepEqual(labels.slice(0, 3), ["Line", "Line with markers", "Line break"]);
  assert.deepEqual(labels.slice(3), ["Step line", "Baseline"]);
});

test("the curated order decides between two equally good Fibonacci matches", () => {
  const groups = [{
    id: "gann-and-fibonacci",
    tools: [
      { tool: "fib", label: "Fib retracement" },
      { tool: "fibWedge", label: "Fib wedge" },
    ],
  }];
  const ranked = rankCommands(buildCommands(groups, true), "fib");
  assert.equal(ranked[0]?.id, "drawing:fib",
    "the rail lists Fib retracement first, and so must the palette");
});

test("an exact acronym wins outright", () => {
  const ranked = rankCommands(buildCommands([], true), "macd");
  assert.equal(ranked[0]?.label, "MACD",
    "typing a study's exact name must not return something else first");
});

test("a favourite is lifted above everything it would otherwise lose to", () => {
  const commands = buildCommands(GROUPS, true);
  // Untouched, the registry order wins the tie: both start with "fib".
  const plain = rankCommands(commands, "fib");
  assert.equal(plain[0]?.id, "drawing:fib");

  const starred = rankCommands(commands, "fib", ["drawing:fibWedge"]);
  assert.equal(starred[0]?.id, "drawing:fibWedge",
    "a star is the user saying 'this one, every time'");

  // And a favourite that does not match the query stays out of the results.
  assert.equal(rankCommands(commands, "macd", ["drawing:fibWedge"])
    .some((c) => c.id === "drawing:fibWedge"), false);
});

test("an empty query lists everything, favourites first", () => {
  const commands = buildCommands(GROUPS, true);
  const ranked = rankCommands(commands, "", ["chartType:kagi"]);
  assert.equal(ranked.length, commands.length,
    "a palette that lists nothing until you type makes you guess what it covers");
  assert.equal(ranked[0]?.id, "chartType:kagi");
});

test("a command runs through the handler for its kind, with its own value", () => {
  const seen: string[] = [];
  const handlers = {
    drawing: (t: string) => seen.push(`drawing=${t}`),
    indicator: (i: string) => seen.push(`indicator=${i}`),
    chartType: (t: string) => seen.push(`chartType=${t}`),
    action: (a: string) => seen.push(`action=${a}`),
  } as unknown as Parameters<typeof runCommand>[1];

  const commands = buildCommands(GROUPS, true);
  for (const id of ["drawing:fib", "indicator:rsi", "chartType:kagi", "action:undo"]) {
    const command = commands.find((c) => c.id === id);
    assert.ok(command, `${id} is not in the index`);
    runCommand(command, handlers);
  }
  assert.deepEqual(seen,
    ["drawing=fib", "indicator=rsi", "chartType=kagi", "action=undo"]);
});

test("the modifier is written in the platform's own hand", () => {
  const mac = buildCommands([], true).find((c) => c.id === "action:undo");
  const pc = buildCommands([], false).find((c) => c.id === "action:undo");
  assert.equal(mac?.shortcut, "⌘Z");
  assert.equal(pc?.shortcut, "Ctrl+Z");
});

test("THE PALETTE IS REACHABLE, AND REACHES THE SAME HANDLERS AS EVERYTHING ELSE", () => {
  /*
   * A palette wired to its own copies of "add this study" and "arm this tool"
   * would be a second way for the two to disagree — the defect this campaign
   * keeps finding in other forms. So: the page dispatches actions through the
   * SAME function the keyboard does, and the study/tool/type handlers are the
   * ones the browser, rail and menu already call.
   */
  const page = read("app/chart/page.tsx");
  assert.match(page, /shortcutActionRef\.current = runShortcutAction/,
    "the palette's actions must run the keyboard's dispatcher, not a copy");
  assert.match(page, /onAction: runShortcutAction/);
  assert.match(page, /drawing: \(next: DrawingTool\) => setTool\(next\)/);
  assert.match(page, /chartType: \(next: ChartType\) => changeChartType\(next\)/);

  // And there are two ways in, as there are in the reference: the magnifier
  // and a key.
  assert.match(read("components/tv/ChartToolbar.tsx"), /onOpenCommandPalette/);
  assert.ok(BINDINGS.some((b) => b.action === "command-palette"),
    "the palette needs a keyboard route or it is only a button");
  assert.match(page, /case "command-palette": setPaletteOpen\(true\)/);
});
