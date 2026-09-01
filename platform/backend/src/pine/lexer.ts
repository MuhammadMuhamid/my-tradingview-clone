/**
 * Pine Script v5 lexer.
 *
 * Pine is indentation-structured like Python: a block is introduced by a line
 * ending in `=>`, `if`, `else`, `for`, `while`, and continues while lines are
 * indented further than the header. The lexer emits explicit INDENT/DEDENT and
 * NEWLINE tokens so the parser never has to look at whitespace.
 *
 * Line continuation follows Pine's rule too: a line that ends on an operator,
 * an open bracket, or a comma continues onto the next line.
 */

export type TokenType =
  | "num" | "str" | "color" | "ident" | "kw" | "op"
  | "newline" | "indent" | "dedent" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;   // 1-based
  col: number;    // 1-based
}

export class PineSyntaxError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = "PineSyntaxError";
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Set([
  "if", "else", "for", "to", "by", "while", "switch", "var", "varip",
  "and", "or", "not", "true", "false", "na", "break", "continue", "return",
  "import", "export", "type", "method", "enum",
  // type keywords used in declarations: `float x = 1`
  "int", "float", "bool", "string", "color", "line", "label", "box", "table",
  "array", "matrix", "map", "series", "simple", "const", "input",
]);

// Longest-first so `:=` beats `:` and `==` beats `=`.
const OPERATORS = [
  "=>", ":=", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=",
  "(", ")", "[", "]", "{", "}", ",", ".", "?", ":", "+", "-", "*", "/", "%",
  "<", ">", "=",
];

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

export function tokenize(source: string): Token[] {
  // Normalise newlines; a trailing newline simplifies end-of-block handling.
  const text = source.replace(/\r\n?/g, "\n") + "\n";
  const tokens: Token[] = [];
  const indents: number[] = [0];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let atLineStart = true;
  /** bracket depth — newlines inside brackets are insignificant */
  let depth = 0;
  /** A depth-zero line whose final operator explicitly continues it. */
  let continuedLine = false;
  /** Unmatched conditional operators also continue onto a following `:` arm. */
  let pendingTernaries = 0;

  const col = (): number => i - lineStart + 1;
  const push = (type: TokenType, value: string, c = col()): void => {
    tokens.push({ type, value, line, col: c });
  };
  const lastReal = (): Token | undefined => {
    for (let k = tokens.length - 1; k >= 0; k--) {
      const t = tokens[k]!;
      if (t.type !== "newline" && t.type !== "indent" && t.type !== "dedent") return t;
    }
    return undefined;
  };

  while (i < text.length) {
    // ── indentation at the start of a logical line ──
    if (atLineStart && depth === 0) {
      let width = 0;
      while (i < text.length && (text[i] === " " || text[i] === "\t")) {
        width += text[i] === "\t" ? 4 : 1;
        i++;
      }
      // Blank lines and comment-only lines carry no indentation meaning.
      if (text[i] === "\n") { i++; line++; lineStart = i; continue; }
      if (text[i] === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (i >= text.length) break;

      // Continuation indentation is alignment, not a nested Pine block. This
      // matters for calls and expressions split after a comma/operator.
      if (continuedLine) {
        continuedLine = false;
        atLineStart = false;
        continue;
      }

      const top = indents[indents.length - 1]!;
      if (width > top) {
        indents.push(width);
        push("indent", "");
      } else if (width < top) {
        while (indents.length > 1 && width < indents[indents.length - 1]!) {
          indents.pop();
          push("dedent", "");
        }
        if (width !== indents[indents.length - 1]!) {
          throw new PineSyntaxError("inconsistent indentation", line, width + 1);
        }
      }
      atLineStart = false;
      continue;
    }

    // A physical line that began inside brackets is already part of the
    // current logical statement. Mark its leading position consumed before a
    // closing bracket brings depth back to zero later on the same line.
    if (atLineStart && depth > 0) atLineStart = false;

    const c = text[i]!;

    // whitespace (not line-leading)
    if (c === " " || c === "\t") { i++; continue; }

    // comments
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // newline
    if (c === "\n") {
      i++;
      const prev = tokens[tokens.length - 1];
      let next = i;
      while (text[next] === " " || text[next] === "\t") next++;
      const nextLineContinues = text[next] === "?";
      // Suppress the newline when inside brackets, or when the previous token
      // makes the line obviously incomplete (Pine's continuation rule).
      // `=>` is the exception: it ends a function header and opens an indented
      // body, so its newline must survive for the parser to see the block.
      const continues =
        depth > 0 ||
        pendingTernaries > 0 ||
        nextLineContinues ||
        (prev !== undefined && prev.type === "op" &&
          !["(", ")", "]", "}", "=>"].includes(prev.value)) ||
        (prev !== undefined && prev.type === "kw" &&
          ["and", "or", "not"].includes(prev.value));
      continuedLine = depth === 0 && continues;
      if (!continues && prev !== undefined && prev.type !== "newline") {
        push("newline", "\\n");
      }
      line++;
      lineStart = i;
      atLineStart = true;
      continue;
    }

    // numbers (including 1.5e3 and hex colors handled separately)
    if (isDigit(c) || (c === "." && isDigit(text[i + 1] ?? ""))) {
      const start = i;
      const startCol = col();
      while (i < text.length && isDigit(text[i]!)) i++;
      if (text[i] === ".") { i++; while (i < text.length && isDigit(text[i]!)) i++; }
      if (text[i] === "e" || text[i] === "E") {
        const save = i;
        i++;
        if (text[i] === "+" || text[i] === "-") i++;
        if (isDigit(text[i] ?? "")) { while (i < text.length && isDigit(text[i]!)) i++; }
        else i = save;
      }
      push("num", text.slice(start, i), startCol);
      continue;
    }

    // hex colour literal: #RRGGBB / #RRGGBBAA
    if (c === "#") {
      const start = i;
      const startCol = col();
      i++;
      while (i < text.length && /[0-9a-fA-F]/.test(text[i]!)) i++;
      push("color", text.slice(start, i), startCol);
      continue;
    }

    // strings
    if (c === '"' || c === "'") {
      const quote = c;
      const startCol = col();
      i++;
      let out = "";
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          const esc = text[i + 1];
          out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc ?? "";
          i += 2;
          continue;
        }
        if (text[i] === "\n") throw new PineSyntaxError("unterminated string", line, startCol);
        out += text[i];
        i++;
      }
      if (i >= text.length) throw new PineSyntaxError("unterminated string", line, startCol);
      i++; // closing quote
      push("str", out, startCol);
      continue;
    }

    // identifiers / keywords
    if (isIdentStart(c)) {
      const start = i;
      const startCol = col();
      while (i < text.length && isIdentPart(text[i]!)) i++;
      const word = text.slice(start, i);
      push(KEYWORDS.has(word) ? "kw" : "ident", word, startCol);
      continue;
    }

    // operators
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      const startCol = col();
      // `[` directly after a value is history access, not a tuple/array literal;
      // the parser decides, but bracket depth must track either way.
      if (op === "(" || op === "[" || op === "{") depth++;
      if (op === ")" || op === "]" || op === "}") depth = Math.max(0, depth - 1);
      if (op === "?") pendingTernaries++;
      if (op === ":" && pendingTernaries > 0) pendingTernaries--;
      i += op.length;
      push("op", op, startCol);
      continue;
    }

    throw new PineSyntaxError(`unexpected character '${c}'`, line, col());
  }

  if (lastReal() !== undefined && tokens[tokens.length - 1]?.type !== "newline") {
    push("newline", "\\n");
  }
  while (indents.length > 1) { indents.pop(); push("dedent", ""); }
  push("eof", "");
  return tokens;
}
