/**
 * Pine Script v5 parser → AST.
 *
 * Covers the statement and expression forms this engine executes: declarations
 * (`var`/`varip`, optional type keyword, tuple destructuring), reassignment,
 * if/else (statement *and* expression form), bounded for/while loops, user
 * functions (single-line `=>` and indented bodies), and the full expression
 * grammar including history access `x[n]` and named call arguments.
 *
 * Every call node carries a stable `id`, which the interpreter uses to key
 * per-call-site state (a `ta.sma` on one line is a different accumulator from
 * a `ta.sma` on another, exactly like Pine).
 */
import { PineSyntaxError, tokenize, type Token } from "./lexer";

export interface Arg { name?: string; value: Expr }

/** One field of a user-declared `type`, with its optional default. */
export interface TypeField { name: string; type: string; def: Expr | null }

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "color"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "na" }
  | { k: "ident"; name: string; line: number }
  | { k: "member"; obj: Expr; name: string; line: number }
  | { k: "call"; callee: Expr; args: Arg[]; id: number; line: number; typeArg?: string | null }
  | { k: "hist"; base: Expr; offset: Expr; line: number }
  | { k: "un"; op: string; arg: Expr; line: number }
  | { k: "bin"; op: string; l: Expr; r: Expr; line: number }
  | { k: "cond"; c: Expr; t: Expr; f: Expr; line: number }
  | { k: "tuple"; items: Expr[]; line: number }
  | { k: "ifexpr"; cond: Expr; then: Stmt[]; else: Stmt[] | null; line: number }
  /** `switch subject` / bare `switch`; a case with `match: null` is the default arm */
  | { k: "switch"; subject: Expr | null; cases: { match: Expr | null; body: Stmt[] }[]; line: number };

export type Stmt =
  | { k: "decl"; mode: "var" | "varip" | "none"; names: string[]; value: Expr; line: number }
  | { k: "assign"; name: string; op: string; value: Expr; line: number }
  /** `obj.field := v` — a reassignment whose target is a UDT field */
  | { k: "massign"; target: Expr; op: string; value: Expr; line: number }
  /** `type Name` with its field list */
  | { k: "typedef"; name: string; fields: TypeField[]; line: number }
  | { k: "if"; cond: Expr; then: Stmt[]; else: Stmt[] | null; line: number }
  | { k: "for"; name: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; line: number }
  | { k: "while"; cond: Expr; body: Stmt[]; line: number }
  /** `for v in xs` / `for [i, v] in xs` */
  | { k: "forin"; names: string[]; iter: Expr; body: Stmt[]; line: number }
  | { k: "func"; name: string; params: { name: string; def: Expr | null }[]; body: Stmt[]; line: number;
      /** `method f(T self, …)` — dispatched on the receiver's type */
      isMethod?: boolean; selfType?: string }
  | { k: "expr"; value: Expr; line: number }
  | { k: "break"; line: number }
  | { k: "continue"; line: number };

/** Type keywords that may prefix a declaration (`float x = 1`). */
const TYPE_KEYWORDS = new Set([
  "int", "float", "bool", "string", "color", "line", "label", "box", "table", "series", "simple", "const",
  // collection types, which take a generic argument: `array<float> xs`
  "array", "matrix", "map",
]);

/**
 * Recursive-descent bottoms out on the JS call stack, so a pathological input
 * like 20 000 nested parentheses would raise an unrecoverable RangeError
 * instead of a diagnostic. Cap the nesting well below the stack limit.
 */
const MAX_EXPR_DEPTH = 200;
/** Type qualifiers that may precede a declaration's type. */
const QUALIFIERS = new Set(["const", "simple", "series"]);

/** Operators that reassign an existing variable or field. */
const ASSIGN_OPS = [":=", "+=", "-=", "*=", "/=", "%="];
/** Guards against pathologically large sources reaching the parser at all. */
const MAX_TOKENS = 200_000;

class Parser {
  private t: Token[];
  private p = 0;
  private callId = 0;
  private depth = 0;

  constructor(tokens: Token[]) {
    if (tokens.length > MAX_TOKENS) {
      throw new PineSyntaxError(
        `script is too large (${tokens.length.toLocaleString()} tokens, limit ${MAX_TOKENS.toLocaleString()})`,
        1, 1
      );
    }
    this.t = tokens;
  }

  private enter(): void {
    if (++this.depth > MAX_EXPR_DEPTH) {
      throw new PineSyntaxError(
        `expression nested too deeply (limit ${MAX_EXPR_DEPTH})`, this.cur.line, this.cur.col
      );
    }
  }

  private exit(): void { this.depth--; }

  private peek(o = 0): Token { return this.t[Math.min(this.p + o, this.t.length - 1)]!; }
  private get cur(): Token { return this.peek(); }

  private at(type: Token["type"], value?: string): boolean {
    const tk = this.cur;
    return tk.type === type && (value === undefined || tk.value === value);
  }

  private eat(type: Token["type"], value?: string): Token | null {
    if (!this.at(type, value)) return null;
    return this.t[this.p++]!;
  }

  private expect(type: Token["type"], value?: string): Token {
    const tk = this.eat(type, value);
    if (!tk) {
      const got = this.cur.type === "newline" ? "end of line" : `'${this.cur.value || this.cur.type}'`;
      throw new PineSyntaxError(`expected ${value ?? type} but found ${got}`, this.cur.line, this.cur.col);
    }
    return tk;
  }

  private skipNewlines(): void {
    while (this.at("newline")) this.p++;
  }

  // ── program ──────────────────────────────────────────────────────────────
  parseProgram(): Stmt[] {
    const out: Stmt[] = [];
    this.skipNewlines();
    while (!this.at("eof")) {
      // Stray dedents at top level (after a block) are harmless.
      if (this.at("dedent") || this.at("indent")) { this.p++; continue; }
      out.push(...this.parseStatementLine());
      this.skipNewlines();
    }
    return out;
  }

  /** An indented block, or a single statement on the same line. */
  private parseBlock(): Stmt[] {
    // Statement nesting consumes stack too (if inside if inside for …).
    if (this.depth > MAX_EXPR_DEPTH) {
      throw new PineSyntaxError(
        `blocks nested too deeply (limit ${MAX_EXPR_DEPTH})`, this.cur.line, this.cur.col
      );
    }
    this.depth++;
    try {
      return this.parseBlockInner();
    } finally {
      this.depth--;
    }
  }

  private parseBlockInner(): Stmt[] {
    // `indent` without a preceding newline happens when a continuation rule
    // swallowed it; treat it as the start of a block either way.
    if (this.at("newline") || this.at("indent")) {
      this.skipNewlines();
      if (!this.at("indent")) {
        throw new PineSyntaxError("expected an indented block", this.cur.line, this.cur.col);
      }
      this.p++; // indent
      const out: Stmt[] = [];
      this.skipNewlines();
      while (!this.at("dedent") && !this.at("eof")) {
        out.push(...this.parseStatementLine());
        this.skipNewlines();
      }
      this.eat("dedent");
      return out;
    }
    return this.parseStatementLine();
  }

  /**
   * One source line's worth of statements. Pine lets a line hold several
   * comma-separated statements — `var int a = na, var int b = na` — which is
   * common in dense indicator code.
   */
  private parseStatementLine(): Stmt[] {
    const out = [this.parseStatement()];
    while (this.at("op", ",")) {
      this.p++;
      this.skipNewlines();
      out.push(this.parseStatement());
    }
    return out;
  }

  private parseStatement(): Stmt {
    const line = this.cur.line;

    if (this.at("kw", "if")) return this.parseIf();
    if (this.at("kw", "for")) return this.parseFor();
    if (this.at("kw", "while")) return this.parseWhile();
    if (this.at("kw", "break")) { this.p++; return { k: "break", line }; }
    if (this.at("kw", "continue")) { this.p++; return { k: "continue", line }; }
    if (this.at("kw", "type")) return this.parseTypeDef();
    if (this.at("kw", "method")) return this.parseMethod();
    if (this.at("kw", "import") || this.at("kw", "export") || this.at("kw", "enum")) {
      throw new PineSyntaxError(`'${this.cur.value}' is not supported by this engine`, line, this.cur.col);
    }

    // user function: name(params) =>
    if (this.at("ident") && this.peek(1).type === "op" && this.peek(1).value === "(") {
      const save = this.p;
      const name = this.cur.value;
      this.p += 2;
      // A parameter list is (optionally typed) identifiers with optional
      // defaults; if it isn't, this is a call expression, so rewind.
      let params: { name: string; def: Expr | null }[] = [];
      let ok = true;
      try {
        params = this.parseParamList();
      } catch {
        ok = false;
      }
      if (ok && this.eat("op", ")") && this.at("op", "=>")) {
        this.p++; // =>
        const body = this.parseBlock();
        return { k: "func", name, params, body, line };
      }
      this.p = save;
    }

    // declaration: [var|varip] [type] name = expr   |   [a, b] = expr
    const declStart = this.p;
    let mode: "var" | "varip" | "none" = "none";
    if (this.at("kw", "var")) { mode = "var"; this.p++; }
    else if (this.at("kw", "varip")) { mode = "varip"; this.p++; }
    // Qualifiers sit between the declaration mode and the type — `const int x`.
    // They constrain when a value may be computed, which this engine does not
    // need to enforce, so they are consumed and dropped.
    while (this.at("kw") && QUALIFIERS.has(this.cur.value)) this.p++;
    // optional type prefix: `float x = 1`, `array<SV_Sw> sw = …`, `BSL_ZZ z = …`
    this.tryTypePrefix();
    if (this.at("op", "[")) {
      // tuple destructuring: [macdLine, signalLine, hist] = ta.macd(...)
      const save = this.p;
      this.p++;
      const names: string[] = [];
      let ok = true;
      while (!this.at("op", "]") && !this.at("eof")) {
        if (!this.at("ident")) { ok = false; break; }
        names.push(this.cur.value);
        this.p++;
        if (!this.eat("op", ",")) break;
      }
      if (ok && this.eat("op", "]") && this.at("op", "=")) {
        this.p++;
        const value = this.parseExprOrIf();
        return { k: "decl", mode, names, value, line };
      }
      this.p = save;
    }
    if (this.at("ident") && this.peek(1).type === "op" && this.peek(1).value === "=") {
      const name = this.cur.value;
      this.p += 2;
      const value = this.parseExprOrIf();
      return { k: "decl", mode, names: [name], value, line };
    }
    if (mode !== "none") {
      throw new PineSyntaxError("expected a variable name after 'var'", line, this.cur.col);
    }
    this.p = declStart;

    // reassignment: name := expr  /  name += expr
    if (this.at("ident") && this.peek(1).type === "op" &&
        ASSIGN_OPS.includes(this.peek(1).value)) {
      const name = this.cur.value;
      const op = this.peek(1).value;
      this.p += 2;
      const value = this.parseExprOrIf();
      return { k: "assign", name, op, value, line };
    }

    // field reassignment: obj.field := expr, zz.d.x := expr
    if (this.at("ident") && this.peek(1).type === "op" && this.peek(1).value === ".") {
      const save = this.p;
      let target: Expr | null = null;
      try {
        target = this.parsePostfix();
      } catch {
        this.p = save;
      }
      if (target && target.k === "member" && this.at("op") && ASSIGN_OPS.includes(this.cur.value)) {
        const op = this.cur.value;
        this.p++;
        const value = this.parseExprOrIf();
        return { k: "massign", target, op, value, line };
      }
      this.p = save;
    }

    return { k: "expr", value: this.parseExprOrIf(), line };
  }

  /**
   * ```
   * type LP_data
   *     float h
   *     int   bi = 0
   * ```
   */
  private parseTypeDef(): Stmt {
    const line = this.cur.line;
    this.expect("kw", "type");
    const name = this.expect("ident").value;
    this.skipNewlines();
    if (!this.at("indent")) {
      throw new PineSyntaxError(`type '${name}' has no fields`, this.cur.line, this.cur.col);
    }
    this.p++;
    const fields: TypeField[] = [];
    this.skipNewlines();
    while (!this.at("dedent") && !this.at("eof")) {
      const fType = this.isTypeStart() ? this.parseTypeName() : "float";
      const fName = this.expect("ident").value;
      const def = this.eat("op", "=") ? this.parseExpr() : null;
      fields.push({ name: fName, type: fType, def });
      this.skipNewlines();
    }
    this.eat("dedent");
    return { k: "typedef", name, fields, line };
  }

  /** `method f(T self, …) => …` — a function dispatched on its first argument. */
  private parseMethod(): Stmt {
    const line = this.cur.line;
    this.expect("kw", "method");
    const name = this.expect("ident").value;
    this.expect("op", "(");
    const params = this.parseParamList();
    this.expect("op", ")");
    this.expect("op", "=>");
    const body = this.parseBlock();
    return { k: "func", name, params, body, line, isMethod: true, selfType: params[0]?.type ?? "" };
  }

  /** Parameter list with optional type prefixes and defaults. */
  private parseParamList(): { name: string; def: Expr | null; type?: string }[] {
    const params: { name: string; def: Expr | null; type?: string }[] = [];
    while (!this.at("op", ")") && !this.at("eof")) {
      let type: string | undefined;
      // A type prefix is only a type when an identifier follows it.
      if (this.isTypeStart() && (this.peek(1).type === "ident" || this.peek(1).value === "<" ||
          (this.peek(1).value === "[" && this.peek(2).value === "]"))) {
        const save = this.p;
        const parsed = this.parseTypeName();
        if (this.at("ident")) type = parsed;
        else this.p = save;
      }
      if (!this.at("ident")) break;
      const pName = this.cur.value;
      this.p++;
      let def: Expr | null = null;
      if (this.eat("op", "=")) def = this.parseExpr();
      params.push({ name: pName, def, type });
      if (!this.eat("op", ",")) break;
    }
    return params;
  }

  private parseIf(): Stmt {
    const line = this.cur.line;
    this.expect("kw", "if");
    const cond = this.parseExpr();
    const then = this.parseBlock();
    // `else` may sit on its own line after the block's dedent.
    const save = this.p;
    this.skipNewlines();
    let elseBlock: Stmt[] | null = null;
    if (this.at("kw", "else")) {
      this.p++;
      elseBlock = this.at("kw", "if") ? [this.parseIf()] : this.parseBlock();
    } else {
      this.p = save;
    }
    return { k: "if", cond, then, else: elseBlock, line };
  }

  private parseFor(): Stmt {
    const line = this.cur.line;
    this.expect("kw", "for");

    // `for [i, v] in xs` / `for v in xs` — iteration over a collection.
    if (this.at("op", "[")) {
      this.p++;
      const names: string[] = [];
      while (!this.at("op", "]") && !this.at("eof")) {
        names.push(this.expect("ident").value);
        if (!this.eat("op", ",")) break;
      }
      this.expect("op", "]");
      this.expectIn();
      const iter = this.parseExpr();
      return { k: "forin", names, iter, body: this.parseBlock(), line };
    }
    if (this.at("ident") && this.peek(1).value === "in") {
      const names = [this.cur.value];
      this.p++;
      this.expectIn();
      const iter = this.parseExpr();
      return { k: "forin", names, iter, body: this.parseBlock(), line };
    }

    const name = this.expect("ident").value;
    this.expect("op", "=");
    const from = this.parseExpr();
    this.expect("kw", "to");
    const to = this.parseExpr();
    let step: Expr | null = null;
    if (this.eat("kw", "by")) step = this.parseExpr();
    const body = this.parseBlock();
    return { k: "for", name, from, to, step, body, line };
  }

  /** `in` is not a reserved word in the lexer, so accept it either way. */
  private expectIn(): void {
    if (this.eat("ident", "in") || this.eat("kw", "in")) return;
    throw new PineSyntaxError("expected 'in' in a for-in loop", this.cur.line, this.cur.col);
  }

  private parseWhile(): Stmt {
    const line = this.cur.line;
    this.expect("kw", "while");
    const cond = this.parseExpr();
    const body = this.parseBlock();
    return { k: "while", cond, body, line };
  }

  /** Expression position that also accepts the `if` and `switch` forms. */
  private parseExprOrIf(): Expr {
    if (this.at("kw", "if")) {
      const stmt = this.parseIf() as Extract<Stmt, { k: "if" }>;
      return { k: "ifexpr", cond: stmt.cond, then: stmt.then, else: stmt.else, line: stmt.line };
    }
    if (this.at("kw", "switch")) return this.parseSwitch();
    return this.parseExpr();
  }

  /**
   * `switch` in both Pine forms: with a subject (arms match it by equality)
   * and without (arms are boolean conditions, first true wins). An arm with no
   * match expression — `=> value` — is the default.
   */
  private parseSwitch(): Expr {
    const line = this.cur.line;
    this.expect("kw", "switch");
    // A subject sits on the same line; a bare `switch` is followed by the block.
    const subject = this.at("newline") || this.at("indent") ? null : this.parseExpr();

    this.skipNewlines();
    if (!this.at("indent")) {
      throw new PineSyntaxError("expected an indented block of switch cases", this.cur.line, this.cur.col);
    }
    this.p++;
    const cases: { match: Expr | null; body: Stmt[] }[] = [];
    this.skipNewlines();
    while (!this.at("dedent") && !this.at("eof")) {
      const match = this.at("op", "=>") ? null : this.parseExpr();
      this.expect("op", "=>");
      cases.push({ match, body: this.parseBlock() });
      this.skipNewlines();
    }
    this.eat("dedent");
    return { k: "switch", subject, cases, line };
  }

  // ── type names ───────────────────────────────────────────────────────────
  /** Could the current token begin a type name (builtin, or a user type)? */
  private isTypeStart(): boolean {
    return (this.at("kw") && TYPE_KEYWORDS.has(this.cur.value)) || this.at("ident");
  }

  /**
   * Consume a type name: `float`, `BSL_liq`, `array<SV_Sw>`, `float[]`,
   * `matrix<float>`. Returned as a flat string tag — the engine is dynamically
   * typed, so a type only ever picks defaults and names errors.
   */
  private parseTypeName(): string {
    let name = this.cur.value;
    this.p++;
    if (this.at("op", "<") && this.hasCloingAngleOnLine()) {
      this.p++;
      const inner: string[] = [];
      let depth = 1;
      while (!this.at("eof")) {
        if (this.at("op", "<")) depth++;
        if (this.at("op", ">")) { if (--depth === 0) break; }
        inner.push(this.cur.value);
        this.p++;
      }
      this.expect("op", ">");
      name += `<${inner.join("")}>`;
    }
    while (this.at("op", "[") && this.peek(1).type === "op" && this.peek(1).value === "]") {
      this.p += 2;
      name += "[]";
    }
    return name;
  }

  /**
   * Distinguish `array<int>` from the comparison `a < b`. Only a `>` reached
   * before the line ends, through tokens that can appear inside a type
   * argument, counts as a generic.
   */
  private hasCloingAngleOnLine(): boolean {
    for (let o = 1; o < 24; o++) {
      const tk = this.peek(o);
      if (tk.type === "newline" || tk.type === "eof" || tk.type === "indent") return false;
      if (tk.type === "op" && tk.value === ">") return true;
      const ok = tk.type === "ident" || tk.type === "kw" ||
        (tk.type === "op" && (tk.value === "," || tk.value === "." || tk.value === "<"));
      if (!ok) return false;
    }
    return false;
  }

  /**
   * Consume a type that prefixes a declaration (`matrix<float> cf = …`), but
   * only when what follows really is `name =`. Anything else rewinds, so an
   * expression statement starting with an identifier is untouched.
   */
  private tryTypePrefix(): boolean {
    if (!this.isTypeStart()) return false;
    const save = this.p;
    try {
      this.parseTypeName();
    } catch {
      this.p = save;
      return false;
    }
    if (this.at("ident") && this.peek(1).type === "op" && this.peek(1).value === "=") return true;
    // `var Foo f = …` with no initialiser value is not valid Pine, so a type
    // that isn't followed by `name =` was never a type.
    this.p = save;
    return false;
  }

  // ── expressions ──────────────────────────────────────────────────────────
  parseExpr(): Expr {
    this.enter();
    try {
      return this.parseTernary();
    } finally {
      this.exit();
    }
  }

  private parseTernary(): Expr {
    const c = this.parseOr();
    if (this.at("op", "?")) {
      const line = this.cur.line;
      this.p++;
      const t = this.parseTernary();
      this.expect("op", ":");
      const f = this.parseTernary();
      return { k: "cond", c, t, f, line };
    }
    return c;
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.at("kw", "or")) {
      const line = this.cur.line;
      this.p++;
      l = { k: "bin", op: "or", l, r: this.parseAnd(), line };
    }
    return l;
  }

  private parseAnd(): Expr {
    let l = this.parseEquality();
    while (this.at("kw", "and")) {
      const line = this.cur.line;
      this.p++;
      l = { k: "bin", op: "and", l, r: this.parseEquality(), line };
    }
    return l;
  }

  private parseEquality(): Expr {
    let l = this.parseComparison();
    while (this.at("op", "==") || this.at("op", "!=")) {
      const op = this.cur.value;
      const line = this.cur.line;
      this.p++;
      l = { k: "bin", op, l, r: this.parseComparison(), line };
    }
    return l;
  }

  private parseComparison(): Expr {
    let l = this.parseAdditive();
    while (this.at("op", "<") || this.at("op", ">") || this.at("op", "<=") || this.at("op", ">=")) {
      const op = this.cur.value;
      const line = this.cur.line;
      this.p++;
      l = { k: "bin", op, l, r: this.parseAdditive(), line };
    }
    return l;
  }

  private parseAdditive(): Expr {
    let l = this.parseMultiplicative();
    while (this.at("op", "+") || this.at("op", "-")) {
      const op = this.cur.value;
      const line = this.cur.line;
      this.p++;
      l = { k: "bin", op, l, r: this.parseMultiplicative(), line };
    }
    return l;
  }

  private parseMultiplicative(): Expr {
    let l = this.parseUnary();
    while (this.at("op", "*") || this.at("op", "/") || this.at("op", "%")) {
      const op = this.cur.value;
      const line = this.cur.line;
      this.p++;
      l = { k: "bin", op, l, r: this.parseUnary(), line };
    }
    return l;
  }

  private parseUnary(): Expr {
    if (this.at("op", "-") || this.at("op", "+") || this.at("kw", "not")) {
      const op = this.cur.value;
      const line = this.cur.line;
      this.p++;
      return { k: "un", op, arg: this.parseUnary(), line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.at("op", ".")) {
        const line = this.cur.line;
        this.p++;
        const name = this.at("kw") ? this.t[this.p++]!.value : this.expect("ident").value;
        e = { k: "member", obj: e, name, line };
      } else if (this.at("op", "<") && this.isGenericCall()) {
        // `array.new<int>(…)` — the type argument picks the element default.
        const typeArg = this.parseGenericArg();
        const line = this.cur.line;
        this.expect("op", "(");
        const args = this.parseArgs();
        this.expect("op", ")");
        e = { k: "call", callee: e, args, id: this.callId++, line, typeArg };
      } else if (this.at("op", "(")) {
        const line = this.cur.line;
        this.p++;
        const args = this.parseArgs();
        this.expect("op", ")");
        e = { k: "call", callee: e, args, id: this.callId++, line };
      } else if (this.at("op", "[")) {
        const line = this.cur.line;
        this.p++;
        const offset = this.parseExpr();
        this.expect("op", "]");
        e = { k: "hist", base: e, offset, line };
      } else {
        return e;
      }
    }
  }

  /**
   * `<` here is a generic type argument only when a `>` immediately followed
   * by `(` closes it — otherwise it is a comparison and must stay one.
   */
  private isGenericCall(): boolean {
    for (let o = 1; o < 24; o++) {
      const tk = this.peek(o);
      if (tk.type === "op" && tk.value === ">") {
        const next = this.peek(o + 1);
        return next.type === "op" && next.value === "(";
      }
      const ok = tk.type === "ident" || tk.type === "kw" ||
        (tk.type === "op" && (tk.value === "." || tk.value === ","));
      if (!ok) return false;
    }
    return false;
  }

  private parseGenericArg(): string {
    this.expect("op", "<");
    const parts: string[] = [];
    while (!this.at("op", ">") && !this.at("eof")) {
      parts.push(this.cur.value);
      this.p++;
    }
    this.expect("op", ">");
    return parts.join("");
  }

  private parseArgs(): Arg[] {
    const args: Arg[] = [];
    this.skipNewlines();
    while (!this.at("op", ")") && !this.at("eof")) {
      this.skipNewlines();
      // named argument: `title = "x"` (an identifier followed by a single '=')
      if ((this.at("ident") || this.at("kw")) && this.peek(1).type === "op" && this.peek(1).value === "=") {
        const name = this.cur.value;
        this.p += 2;
        args.push({ name, value: this.parseExpr() });
      } else {
        args.push({ value: this.parseExpr() });
      }
      this.skipNewlines();
      if (!this.eat("op", ",")) break;
      this.skipNewlines();
    }
    this.skipNewlines();
    return args;
  }

  private parsePrimary(): Expr {
    const tk = this.cur;
    switch (tk.type) {
      case "num": this.p++; return { k: "num", v: Number(tk.value) };
      case "str": this.p++; return { k: "str", v: tk.value };
      case "color": this.p++; return { k: "color", v: tk.value };
      case "ident": this.p++; return { k: "ident", name: tk.value, line: tk.line };
      case "kw":
        if (tk.value === "true") { this.p++; return { k: "bool", v: true }; }
        if (tk.value === "false") { this.p++; return { k: "bool", v: false }; }
        // `box(na)`, `float(x)` — a type keyword in call position is a cast.
        if (TYPE_KEYWORDS.has(tk.value) && this.peek(1).type === "op" && this.peek(1).value === "(") {
          this.p++;
          return { k: "ident", name: tk.value, line: tk.line };
        }
        if (tk.value === "na") {
          this.p++;
          // `na` is both the literal and the test function `na(x)`; only the
          // call form has an argument list, and it resolves as a builtin.
          if (this.at("op", "(")) return { k: "ident", name: "na", line: tk.line };
          return { k: "na" };
        }
        if (tk.value === "not") return this.parseUnary();
        if (tk.value === "if" || tk.value === "switch") return this.parseExprOrIf();
        // Namespaces such as `input`, `color`, `int` are ordinary identifiers
        // once they appear in expression position (`input.int(...)`).
        this.p++;
        return { k: "ident", name: tk.value, line: tk.line };
      case "op":
        if (tk.value === "(") {
          this.p++;
          const e = this.parseExpr();
          this.expect("op", ")");
          return e;
        }
        if (tk.value === "[") {
          // tuple literal, e.g. the return of `[a, b]`
          const line = tk.line;
          this.p++;
          const items: Expr[] = [];
          while (!this.at("op", "]") && !this.at("eof")) {
            items.push(this.parseExpr());
            if (!this.eat("op", ",")) break;
          }
          this.expect("op", "]");
          return { k: "tuple", items, line };
        }
        break;
      default:
        break;
    }
    const got = tk.type === "newline" ? "end of line" : `'${tk.value || tk.type}'`;
    throw new PineSyntaxError(`unexpected ${got}`, tk.line, tk.col);
  }
}

export function parse(source: string): Stmt[] {
  return new Parser(tokenize(source)).parseProgram();
}
