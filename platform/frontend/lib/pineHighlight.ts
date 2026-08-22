/**
 * Display-only Pine highlighter for the editor overlay.
 *
 * Intentionally separate from the backend lexer: this one must never throw,
 * must survive half-typed code, and only classifies spans for colouring. The
 * backend compiler remains the single source of truth for correctness.
 */

const KEYWORDS = new Set([
  "if", "else", "for", "to", "by", "while", "switch", "var", "varip",
  "and", "or", "not", "true", "false", "na", "break", "continue",
  "int", "float", "bool", "string", "color", "series", "simple", "const",
  "export", "import", "method", "type", "enum",
]);

/** Namespaces highlighted as builtins when used as `ns.member`. */
const NAMESPACES = new Set([
  "ta", "math", "str", "color", "input", "strategy", "request", "syminfo",
  "timeframe", "barstate", "plot", "shape", "location", "size", "display",
  "scale", "format", "extend", "line", "label", "box", "table", "array",
  "matrix", "map", "order", "alert", "session", "currency", "xloc", "yloc",
  "position", "text", "adjustment", "barmerge", "dayofweek", "hline",
]);

const BUILTIN_SERIES = new Set([
  "open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "hlcc4",
  "time", "time_close", "bar_index", "last_bar_index", "bar_index",
]);

const TOP_LEVEL_FUNCS = new Set([
  "indicator", "strategy", "plot", "plotshape", "plotchar", "plotcandle",
  "plotbar", "hline", "fill", "bgcolor", "barcolor", "input", "alert",
  "alertcondition", "na", "nz", "fixnan",
]);

export type PineTokenClass =
  | "comment" | "string" | "number" | "keyword" | "builtin" | "func" | "plain";

export interface PineToken { text: string; cls: PineTokenClass }

/** Tokenize one line for colouring. Never throws. */
export function highlightLine(line: string): PineToken[] {
  const out: PineToken[] = [];
  let i = 0;
  const push = (text: string, cls: PineTokenClass): void => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.cls === cls) prev.text += text;
    else out.push({ text, cls });
  };

  while (i < line.length) {
    const c = line[i]!;

    if (c === "/" && line[i + 1] === "/") {
      push(line.slice(i), "comment");
      break;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === "\\") j++;
        j++;
      }
      push(line.slice(i, Math.min(j + 1, line.length)), "string");
      i = j + 1;
      continue;
    }
    if (c === "#") {
      let j = i + 1;
      while (j < line.length && /[0-9a-fA-F]/.test(line[j]!)) j++;
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
      let j = i;
      while (j < line.length && /[0-9.eE]/.test(line[j]!)) j++;
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      const followedByDot = line[j] === ".";
      const followedByParen = line[j] === "(";
      if (KEYWORDS.has(word)) push(word, "keyword");
      else if (followedByDot && NAMESPACES.has(word)) push(word, "builtin");
      else if (BUILTIN_SERIES.has(word)) push(word, "builtin");
      else if (followedByParen && TOP_LEVEL_FUNCS.has(word)) push(word, "func");
      else if (followedByParen) push(word, "func");
      else push(word, "plain");
      i = j;
      continue;
    }
    push(c, "plain");
    i++;
  }
  return out;
}

export const TOKEN_COLOR: Record<PineTokenClass, string> = {
  comment: "#6b7486",
  string: "#2ebd85",
  number: "#f0b90b",
  keyword: "#c792ea",
  builtin: "#4f8cff",
  func: "#22d3ee",
  plain: "#e6e9ef",
};

/** Starter script offered by the editor's "New" action. */
export const PINE_TEMPLATE = `//@version=5
strategy("My Strategy", overlay=true)

fastLen = input.int(12, "Fast EMA", minval=1)
slowLen = input.int(34, "Slow EMA", minval=1)
rr      = input.float(2.0, "Risk : Reward", step=0.5)

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
atr  = ta.atr(14)

longSignal  = ta.crossover(fast, slow)
closeSignal = ta.crossunder(fast, slow)

if longSignal and strategy.position_size == 0
    strategy.entry("Long", strategy.long)

if closeSignal and strategy.position_size > 0
    strategy.close("Long")

if strategy.position_size > 0
    stopPx   = strategy.position_avg_price - atr * 2
    targetPx = strategy.position_avg_price + atr * 2 * rr
    strategy.exit("Exit", "Long", stop=stopPx, limit=targetPx)

plot(fast, "Fast", color=color.blue, linewidth=2)
plot(slow, "Slow", color=color.orange)
plotshape(longSignal, style=shape.triangleup, location=location.belowbar,
     color=color.green, text="BUY")
`;
