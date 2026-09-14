/**
 * Everything on the workstation that can be reached by typing its name.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * TVP8: the reference has a command palette, and the previous campaign's
 * ledger recorded it as not-applicable. It is applicable — it is the magnifier
 * beside the chart-settings gear, it opens a dialog titled "Search tool or
 * function", it prompts "Type to search for drawings, functions and settings",
 * and its rows carry a favourite star on the left and the tool's keyboard
 * shortcut on the right.
 *
 * It matters more here than it would in a smaller product. There are 87
 * drawing tools behind eight flyouts, 57 built-in studies behind a browser
 * with its own search, 21 chart types behind one menu, and about forty
 * keyboard actions. Knowing that Fib wedge exists is not the same as knowing
 * which of eight flyouts it is in, and the palette is the answer to that for
 * every one of those at once.
 *
 * ── What this file is, and is not ──────────────────────────────────────────
 *
 * It is the INDEX, not the dialog: pure, no React, no chart. The dialog
 * renders what `buildCommands` returns and calls `run`. That split is what
 * lets the ranking be tested directly — ranking is the whole of whether a
 * palette is useful, and it is untestable through a rendered list.
 */

import { CHART_TYPES, type ChartType } from "./chartType";
import { NATIVE_STUDIES } from "./native/catalog";
import { BINDINGS, type Binding, type ShortcutAction } from "./shortcuts";
import type { DrawingTool } from "./drawings";

export type CommandKind = "drawing" | "indicator" | "chartType" | "action";

export interface Command {
  /** Stable across sessions: it is the favourites key. */
  id: string;
  /**
   * Where this sits in the registry it came from — the rail's flyout order,
   * the study catalogue's order, the chart-type menu's order.
   *
   * It is the tie-break, and it is the curated one. Breaking ties on label
   * LENGTH looked reasonable and was wrong the first time it met real data:
   * typing "fib" put Fib wedge above Fib retracement, because "Fib wedge" is
   * six characters shorter. The reference's own palette answers "fib" with
   * Fib retracement first, which is the order its menu has always had — that
   * order is somebody's judgement about which of ten Fibonacci tools people
   * actually reach for, and there is no reason to discard it here.
   */
  order: number;
  kind: CommandKind;
  label: string;
  /** The section heading this sits under. */
  group: string;
  /** Other words that should find it — an alias, a category, an abbreviation. */
  keywords?: readonly string[];
  /** Rendered right-aligned, as the reference does. */
  shortcut?: string;
}

export interface CommandContext {
  /** A Replay session is running, so its step and play commands can act. */
  replayActive: boolean;
  /** A drawing is selected, so the commands that act on one can act. */
  drawingSelected: boolean;
}

export interface CommandHandlers {
  drawing: (tool: DrawingTool) => void;
  indicator: (studyId: string) => void;
  chartType: (type: ChartType) => void;
  action: (action: ShortcutAction) => void;
}

/** How one binding is written on a key cap. Mirrors `ShortcutsSheet`. */
function keyCap(binding: Binding, mac: boolean): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) parts.push(mac ? "⌥" : "Alt");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join(mac ? "" : "+");
}

/** One row of the rail, as much of it as the index needs. */
export interface CommandToolLike {
  tool: string;
  label: string;
  /** "Click points, double-click to finish" — searchable, never the name. */
  hint?: string;
}

/**
 * A rail group, in either shape.
 *
 * TVP8 round three gave the rail SECTIONS — the reference's own "Lines",
 * "Channels", "Pitchforks" — so a group's tools are one level deeper than they
 * were. Both are accepted rather than one, because this module is the seam
 * between a pure index and a React component, and a seam that only speaks the
 * newest shape makes every test of the index carry the component's current
 * nesting.
 */
export interface CommandGroupLike {
  id: string;
  tools?: readonly CommandToolLike[];
  sections?: readonly { heading?: string; tools: readonly CommandToolLike[] }[];
}

const toolsOf = (group: CommandGroupLike): readonly CommandToolLike[] =>
  group.sections ? group.sections.flatMap((section) => [...section.tools]) : group.tools ?? [];

/**
 * The whole index.
 *
 * `drawingGroups` is passed in rather than imported so this stays free of
 * React — `DrawingToolbar` owns the rail's taxonomy and exports it, and a
 * module that imported a `.tsx` could not be unit-tested without a DOM.
 */
export function buildCommands(
  drawingGroups: readonly CommandGroupLike[],
  mac: boolean,
  context: CommandContext = { replayActive: false, drawingSelected: false },
): Command[] {
  const commands: Command[] = [];
  let order = 0;

  const shortcutFor = (action: string): string | undefined => {
    const binding = BINDINGS.find((b) => b.action === action);
    if (!binding || binding.chordless) return undefined;
    return keyCap(binding, mac);
  };

  for (const group of drawingGroups) {
    for (const tool of toolsOf(group)) {
      commands.push({
        id: `drawing:${tool.tool}`,
        order: order++,
        kind: "drawing",
        // TVP8 round three: the rail's own labels are now the reference's
        // wording with the "how to use it" half moved to a `hint`, so the
        // split is a safety net for a label that still carries one. The hint
        // stays searchable either way.
        label: tool.label.split(" — ")[0]!,
        group: "Drawings",
        keywords: [group.id.replace(/-/g, " "), tool.label, ...(tool.hint ? [tool.hint] : [])],
        shortcut: shortcutFor(`tool:${tool.tool}`),
      });
    }
  }

  for (const study of NATIVE_STUDIES) {
    commands.push({
      id: `indicator:${study.id}`,
      order: order++,
      kind: "indicator",
      label: study.name,
      group: "Indicators",
      keywords: [...(study.aliases ?? []), study.category],
    });
  }

  for (const type of CHART_TYPES) {
    commands.push({
      id: `chartType:${type.value}`,
      order: order++,
      kind: "chartType",
      label: type.label,
      group: "Chart types",
      keywords: ["chart type", type.group],
    });
  }

  /*
   * Actions come from `BINDINGS`, which is the table the keyboard handler
   * itself reads. A hand-written list here would advertise commands that do
   * nothing the moment one is renamed — the exact failure `ShortcutsSheet`'s
   * docstring describes and solves the same way.
   *
   * Tool selections are excluded: they are already in the Drawings section
   * above, under the name of the tool rather than "Trend line" twice.
   */
  /*
   * TVP8 round two: a palette does not offer what cannot happen.
   *
   * It listed the three Replay steps with no session running — `replayOnly`
   * exists on the binding and the palette ignored it — the drawing commands
   * with nothing selected, and ITSELF, whose row closed the palette and did
   * nothing else. Every one of those is a row that answers a search, gets
   * chosen, and produces silence.
   */
  const DRAWING_ACTIONS = new Set([
    "delete", "clone", "copy", "paste", "bring-forward", "send-backward",
  ]);
  const seen = new Set<string>();
  for (const binding of BINDINGS) {
    if (binding.action.startsWith("tool:")) continue;
    if (binding.action === "command-palette") continue;
    if (binding.replayOnly && !context.replayActive) continue;
    if (DRAWING_ACTIONS.has(binding.action) && !context.drawingSelected) continue;
    if (seen.has(binding.action)) continue;   // two keys, one action
    seen.add(binding.action);
    commands.push({
      id: `action:${binding.action}`,
      order: order++,
      kind: "action",
      label: binding.label,
      group: binding.group,
      keywords: [binding.action.replace(/[:-]/g, " ")],
      shortcut: binding.chordless ? undefined : keyCap(binding, mac),
    });
  }

  return commands;
}

/**
 * Rank one command against a query, or null when it does not match.
 *
 * Higher is better. The ordering this produces is the only thing that makes a
 * palette over 165 commands usable, so it is deliberately explicit rather than
 * a fuzzy-match library's opinion:
 *
 *   4  the label IS the query          "rsi" → Relative Strength Index? no.
 *                                      "macd" → MACD, first, always.
 *   3  the label STARTS with it        "fib" → Fib retracement before
 *                                      Trend-based fib extension.
 *   2  a word in the label starts with it
 *   1  the label contains it anywhere
 *   0  only a keyword matches          an alias or a category
 *
 * Ties break on registry order — see `Command.order`.
 */
export function scoreCommand(command: Command, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const label = command.label.toLowerCase();
  if (label === q) return 4;
  if (label.startsWith(q)) return 3;
  if (label.split(/[\s—·/-]+/).some((word) => word.startsWith(q))) return 2;
  if (label.includes(q)) return 1;
  if ((command.keywords ?? []).some((k) => k.toLowerCase().includes(q))) return 0;
  return null;
}

export interface RankedCommand extends Command { score: number }

/**
 * The commands to show, best first.
 *
 * An empty query returns favourites first and then everything, because an
 * empty palette that says "type to search" and lists nothing makes the user
 * guess what it even covers — the reference lists as you type, and the
 * favourites are what a returning user opened it for.
 */
export function rankCommands(
  commands: readonly Command[], query: string, favourites: readonly string[] = [],
): RankedCommand[] {
  const favourite = new Set(favourites);
  const ranked: RankedCommand[] = [];
  for (const command of commands) {
    const score = scoreCommand(command, query);
    if (score === null) continue;
    ranked.push({ ...command, score: score + (favourite.has(command.id) ? 5 : 0) });
  }
  return ranked.sort((a, b) => b.score - a.score || a.order - b.order);
}

/** Dispatch a command to the handler for its kind. */
export function runCommand(command: Command, handlers: CommandHandlers): void {
  const value = command.id.slice(command.id.indexOf(":") + 1);
  if (command.kind === "drawing") handlers.drawing(value as DrawingTool);
  else if (command.kind === "indicator") handlers.indicator(value);
  else if (command.kind === "chartType") handlers.chartType(value as ChartType);
  else handlers.action(value as ShortcutAction);
}
