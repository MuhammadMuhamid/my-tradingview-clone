/**
 * Every refusal at a series seam must be handed a repaint that redraws.
 *
 * ── Why this is a source test ─────────────────────────────────────────────
 *
 * `tests/dom/studyWindowZoom.test.tsx` drives the seam FUNCTIONS against real
 * lightweight-charts series, and that is the right test for what they do. It
 * cannot say anything about what their CALLERS pass, because the callers live
 * inside `CandleChart`'s effects and nothing renders them with a backwards row.
 *
 * A read-only reviewer proved that gap by turning all three repaint thunks
 * into `() => {}` and watching all 1,228 tests stay green — structurally the
 * same defect as the one before it, where the regression test re-implemented
 * the seam instead of calling it. A guard is only pinned by something that
 * fails when it is removed, and for a caller-supplied argument that something
 * has to read the call site.
 *
 * ── Why it reads the AST and not the text ─────────────────────────────────
 *
 * The first version scanned characters, and its prose claimed CLASSES —
 * "an `[]` repaint", "a new call site added without one" — while the code
 * matched TOKENS. The same reviewer broke three of those claims with one-token
 * variants: `([])` rather than `[]`, `[...[]]`, a `const NO_ROWS = []` passed
 * by name, a decoy declaration earlier in the file that the identifier
 * resolver reached first, a guard rebuilt out of string literals, and a fifth
 * unguarded call site hidden between two strings that looked like comment
 * delimiters.
 *
 * Every one of those is a way to write something that LOOKS different and
 * PARSES the same, so the parser is the answer. `typescript` is already a
 * devDependency; `ts.createSourceFile` gives the real tree, and comments,
 * string literals, parentheses and scope stop being things to defend against.
 *
 * ── What this still cannot prove ──────────────────────────────────────────
 *
 * That the repaint draws the same CONTENT the refused row belonged to. A
 * repaint can call the right writer with a shortened list, or behind a
 * condition that is never true, and this file will pass it. That is not a
 * property of the syntax, and claiming it would be another round of evidence
 * reading stronger than it is. The behavioural half lives in
 * `tests/dom/studyWindowZoom.test.tsx`, against real series.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const FILE = join(ROOT, "components/CandleChart.tsx");
const SOURCE = ts.createSourceFile(
  FILE, readFileSync(FILE, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

/** `(x)`, `((x))`, `x as T` and `x!` all denote `x`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else return current;
  }
}

/** Every call to `name`, however it is spelled — `name?.()` and `(name)()` included. */
function callsTo(name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === name) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(SOURCE);
  return found;
}

/**
 * The initialiser `name` is bound to, searched outwards from `from`.
 *
 * Nearest enclosing scope first, which is what makes a decoy declaration
 * elsewhere in the file harmless: a `const` at the call site shadows it, and
 * that is the one a reader — and the runtime — would take.
 */
function resolve(name: string, from: ts.Node): ts.Expression | null {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isCaseClause(scope)
      ? scope.statements : undefined;
    if (!statements) continue;
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name
          && declaration.initializer) {
          return declaration.initializer;
        }
      }
    }
  }
  return null;
}

/** An expression that denotes no rows: `[]`, `([])`, `[...[]]`, or a name for one. */
function isEmptyRows(expression: ts.Expression, at: ts.Node): boolean {
  const value = unwrap(expression);
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.every((element) =>
      ts.isSpreadElement(element) && isEmptyRows(element.expression, at));
  }
  if (ts.isIdentifier(value)) {
    const declared = resolve(value.text, at);
    return declared !== null && isEmptyRows(declared, at);
  }
  return false;
}

/** Whether `node` sits anywhere inside `ancestor`. */
function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at; at = at.parent) if (at === ancestor) return true;
  return false;
}

/**
 * Whether an argument is a repaint that will actually redraw something.
 *
 * An identifier is followed to its declaration, because hoisting a thunk to a
 * `const` is an ordinary refactor and a test that forbids it is a test
 * somebody deletes. An empty row list is refused: `setData([])` satisfies every
 * name check and BLANKS the series, which is worse than the silent drop this
 * whole rule exists to replace.
 */
function isRealRepaint(argument: ts.Expression | undefined, writer: string): boolean {
  if (!argument) return false;
  let body: ts.Expression = unwrap(argument);
  if (ts.isIdentifier(body)) {
    const declared = resolve(body.text, argument);
    if (!declared) return false;
    body = unwrap(declared);
  }
  if (!ts.isArrowFunction(body) && !ts.isFunctionExpression(body)) return false;
  const writes = callsTo(writer).filter((call) => within(call, body));
  return writes.some((call) => !call.arguments.some((arg) => isEmptyRows(arg, call)));
}

/** A call, flattened, for the message when one is wrong. */
const shape = (call: ts.CallExpression): string =>
  call.getText(SOURCE).replace(/\s+/g, " ").slice(0, 110);

test("EVERY MAIN-SERIES WRITE THAT CAN REFUSE IS GIVEN A REPAINT", () => {
  const calls = callsTo("updateMainSeries");
  assert.ok(calls.length >= 4,
    `expected at least 4 updateMainSeries call sites, found ${calls.length}. A call moved out of `
    + "this file is a call this test can no longer see");

  for (const call of calls) {
    assert.equal(call.arguments.length, 5,
      `updateMainSeries passes ${call.arguments.length} arguments at «${shape(call)}» — a writer `
      + "that can refuse a row must be handed the replacement for the content that row belonged "
      + "to, or the refusal is a silent drop and `displayRef`/`candlesRef` go on claiming a bar "
      + "the series never got");
    assert.ok(isRealRepaint(call.arguments[4], "setMainSeriesData"),
      `the repaint at «${shape(call)}» does not call \`setMainSeriesData\` with rows. An empty `
      + "thunk satisfies the signature and loses the bar; `setData([])` satisfies it and blanks "
      + "the series");
  }
});

test("THE VOLUME HISTOGRAM REPAINTS IN THE DATA EFFECT AND DROPS ON THE LIVE PATH", () => {
  const calls = callsTo("updateVolumeSeries");
  assert.ok(calls.length >= 2,
    `expected at least 2 updateVolumeSeries call sites, found ${calls.length}`);

  const withRepaint = calls.filter((call) => call.arguments.length === 4);
  const without = calls.filter((call) => call.arguments.length === 3);
  assert.equal(withRepaint.length + without.length, calls.length,
    "an updateVolumeSeries call takes either 3 arguments (a documented drop) or 4 (a repaint)");
  assert.equal(withRepaint.length, 1,
    "exactly one volume write repaints — the data effect's, whose window can move backwards, and "
    + "where a dropped bar is a histogram that disagrees with the candles above it");
  assert.equal(without.length, 1,
    "exactly one volume write drops — the live tick's. Giving it a repaint would silently invert "
    + "the policy this test exists to state, and `>= 1` could not tell the difference");
  assert.ok(isRealRepaint(withRepaint[0]!.arguments[3], "setVolumeData"),
    "the volume repaint must call `setVolumeData` with rows");
});

test("THE LIVE VOLUME WRITE IS STILL SKIPPED WHERE THE HISTOGRAM IS DELIBERATELY EMPTY", () => {
  /*
   * Kagi, Point & Figure and Line Break are not drawn on a time axis, so the
   * data effect clears volume under them. The tick handler used to write one
   * stray bar back into that empty histogram; it knew only about Renko.
   *
   * Read off the `if` that encloses the call, as a tree. A reviewer defeated
   * the text version twice — once by commenting the condition out and writing
   * `if (true)` under it, once by rebuilding both halves out of string
   * literals — and neither is expressible here, because a condition that is
   * not the condition is simply a different node.
   */
  const live = callsTo("updateVolumeSeries").find((call) => call.arguments.length === 3);
  assert.ok(live, "the live-tick volume write is gone; this test no longer reads anything");

  let guard: ts.IfStatement | null = null;
  for (let node: ts.Node | undefined = live; node && !guard; node = node.parent) {
    if (ts.isIfStatement(node)) guard = node;
  }
  assert.ok(guard, "the live-tick volume write is no longer guarded by anything");

  let renko = false;
  let drawn = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      const right = unwrap(node.right);
      if (ts.isStringLiteral(right) && right.text === "renko") renko = true;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "current") {
      const target = unwrap(node.expression);
      if (ts.isIdentifier(target) && target.text === "volumeDrawnRef") drawn = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(guard.expression);

  assert.ok(renko,
    "a Renko brick is not a time bar, so no honest volume can be drawn under it");
  assert.ok(drawn,
    "under Kagi, Point & Figure and Line Break the data effect empties the histogram; without this "
    + "condition the tick handler puts one stray bar back into a chart that is showing none");
});
