/**
 * `array.*` and `matrix.*` builtins.
 *
 * Split out of the interpreter because it is a wide, flat surface: ~50 small
 * functions with no interpreter state involved beyond the values handed in.
 * Errors are plain `Error`s — the interpreter catches them and re-throws as
 * `PineRuntimeError` carrying the call's line number, so every message here
 * reads as a normal script error.
 *
 * Index handling follows Pine: negative indices are an error (unlike JS), and
 * out-of-range reads are an error rather than `undefined`. Silence here would
 * surface as an unexplained `na` many bars later.
 */
import { PineArray, PineMatrix, defaultFor, isRef, type PineValue } from "./values";

function bad(msg: string): never { throw new Error(msg); }

function asArray(v: PineValue, fn: string): PineArray {
  if (v instanceof PineArray) return v;
  if (v === null) bad(`${fn}: array is na`);
  bad(`${fn}: expected an array`);
}

function asMatrix(v: PineValue, fn: string): PineMatrix {
  if (v instanceof PineMatrix) return v;
  if (v === null) bad(`${fn}: matrix is na`);
  bad(`${fn}: expected a matrix`);
}

function num(v: PineValue, fn: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined) return NaN;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  bad(`${fn}: expected a number`);
}

function idx(v: PineValue, len: number, fn: string): number {
  const i = Math.trunc(num(v, fn));
  if (!Number.isFinite(i)) bad(`${fn}: index is na`);
  if (i < 0 || i >= len) {
    bad(`${fn}: index ${i} is out of bounds for an array of size ${len}`);
  }
  return i;
}

/** Numeric view of an array, skipping na like Pine's own aggregates do. */
function finite(a: PineArray, fn: string): number[] {
  const out: number[] = [];
  for (const v of a.items) {
    const n = num(v, fn);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Total elements one script may hold, to bound memory for a runaway loop. */
const MAX_ELEMENTS = 1_000_000;

function checkSize(n: number, fn: string): number {
  const size = Math.trunc(n);
  if (!Number.isFinite(size) || size < 0) bad(`${fn}: invalid size`);
  if (size > MAX_ELEMENTS) {
    bad(`${fn}: size ${size.toLocaleString()} exceeds the ${MAX_ELEMENTS.toLocaleString()} element limit`);
  }
  return size;
}

function compare(a: PineValue, b: PineValue): number {
  if (typeof a === "string" || typeof b === "string") {
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }
  const x = typeof a === "number" ? a : Number(a);
  const y = typeof b === "number" ? b : Number(b);
  if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;   // na sorts last
  if (Number.isNaN(y)) return -1;
  return x - y;
}

/**
 * Dispatch one `array.*` call. `typeArg` is the explicit generic from
 * `array.new<T>()`; `self` is set when the call came in as a method
 * (`myArray.push(x)`), which Pine allows for every array function.
 */
export function callArray(
  fn: string,
  args: PineValue[],
  typeArg: string | null
): PineValue {
  const a0 = (): PineArray => asArray(args[0] ?? null, `array.${fn}`);
  const name = `array.${fn}`;

  switch (fn) {
    case "new": case "new_float": case "new_int": case "new_bool":
    case "new_string": case "new_color": case "new_line": case "new_label":
    case "new_box": case "new_table": case "new_linefill": {
      const type = fn === "new" ? (typeArg ?? "float") : fn.slice(4);
      const size = args.length > 0 ? checkSize(num(args[0]!, name), name) : 0;
      const init = args.length > 1 ? args[1]! : defaultFor(type);
      return new PineArray(type, new Array<PineValue>(size).fill(init));
    }
    case "from": {
      const type = typeArg ?? (typeof args[0] === "string" ? "string"
        : typeof args[0] === "boolean" ? "bool" : "float");
      return new PineArray(type, args.slice());
    }
    case "copy": return new PineArray(a0().type, a0().items.slice());

    case "size": return a0().size;
    case "get": { const a = a0(); return a.items[idx(args[1]!, a.size, name)]!; }
    case "set": {
      const a = a0();
      a.items[idx(args[1]!, a.size, name)] = args[2] ?? null;
      return NaN;
    }
    case "push": {
      const a = a0();
      if (a.size + 1 > MAX_ELEMENTS) bad(`${name}: array exceeds the element limit`);
      a.items.push(args[1] ?? null);
      return NaN;
    }
    case "unshift": { a0().items.unshift(args[1] ?? null); return NaN; }
    case "pop": {
      const a = a0();
      if (a.size === 0) bad(`${name}: array is empty`);
      return a.items.pop()!;
    }
    case "shift": {
      const a = a0();
      if (a.size === 0) bad(`${name}: array is empty`);
      return a.items.shift()!;
    }
    case "insert": {
      const a = a0();
      const at = Math.trunc(num(args[1]!, name));
      if (at < 0 || at > a.size) bad(`${name}: index ${at} is out of bounds`);
      a.items.splice(at, 0, args[2] ?? null);
      return NaN;
    }
    case "remove": {
      const a = a0();
      return a.items.splice(idx(args[1]!, a.size, name), 1)[0]!;
    }
    case "clear": { a0().items.length = 0; return NaN; }
    case "first": {
      const a = a0();
      if (a.size === 0) bad(`${name}: array is empty`);
      return a.items[0]!;
    }
    case "last": {
      const a = a0();
      if (a.size === 0) bad(`${name}: array is empty`);
      return a.items[a.size - 1]!;
    }
    case "fill": {
      const a = a0();
      const from = args.length > 2 ? Math.trunc(num(args[2]!, name)) : 0;
      const to = args.length > 3 ? Math.trunc(num(args[3]!, name)) : a.size;
      for (let i = Math.max(0, from); i < Math.min(a.size, to); i++) a.items[i] = args[1] ?? null;
      return NaN;
    }
    case "slice": {
      const a = a0();
      const from = Math.trunc(num(args[1]!, name));
      const to = args.length > 2 ? Math.trunc(num(args[2]!, name)) : a.size;
      return new PineArray(a.type, a.items.slice(from, to));
    }
    case "concat": {
      const a = a0();
      a.items.push(...asArray(args[1] ?? null, name).items);
      return a;
    }
    case "reverse": { a0().items.reverse(); return NaN; }
    case "sort": {
      const a = a0();
      const desc = String(args[1] ?? "ascending").startsWith("desc");
      a.items.sort((x, y) => (desc ? -compare(x, y) : compare(x, y)));
      return NaN;
    }
    case "sort_indices": {
      const a = a0();
      const desc = String(args[1] ?? "ascending").startsWith("desc");
      const order = a.items.map((_, i) => i)
        .sort((x, y) => {
          const c = compare(a.items[x]!, a.items[y]!);
          return desc ? -c : c;
        });
      return new PineArray("int", order);
    }
    case "includes": return a0().items.some((v) => looseEq(v, args[1] ?? null));
    case "indexof": {
      const a = a0();
      return a.items.findIndex((v) => looseEq(v, args[1] ?? null));
    }
    case "lastindexof": {
      const a = a0();
      for (let i = a.size - 1; i >= 0; i--) if (looseEq(a.items[i]!, args[1] ?? null)) return i;
      return -1;
    }
    case "join": return a0().items.map((v) => String(v ?? "")).join(String(args[1] ?? ","));

    // ── aggregates ──
    case "sum": return finite(a0(), name).reduce((s, v) => s + v, 0);
    case "avg": {
      const f = finite(a0(), name);
      return f.length === 0 ? NaN : f.reduce((s, v) => s + v, 0) / f.length;
    }
    case "min": {
      const f = finite(a0(), name);
      if (f.length === 0) return NaN;
      const nth = Math.trunc(num(args[1] ?? 0, name)) || 0;
      return f.slice().sort((x, y) => x - y)[nth] ?? NaN;
    }
    case "max": {
      const f = finite(a0(), name);
      if (f.length === 0) return NaN;
      const nth = Math.trunc(num(args[1] ?? 0, name)) || 0;
      return f.slice().sort((x, y) => y - x)[nth] ?? NaN;
    }
    case "range": {
      const f = finite(a0(), name);
      return f.length === 0 ? NaN : Math.max(...f) - Math.min(...f);
    }
    case "median": {
      const f = finite(a0(), name).sort((x, y) => x - y);
      if (f.length === 0) return NaN;
      const mid = Math.floor(f.length / 2);
      return f.length % 2 ? f[mid]! : (f[mid - 1]! + f[mid]!) / 2;
    }
    case "mode": {
      const f = finite(a0(), name);
      const counts = new Map<number, number>();
      let best = NaN;
      let bestN = 0;
      for (const v of f) {
        const c = (counts.get(v) ?? 0) + 1;
        counts.set(v, c);
        if (c > bestN) { bestN = c; best = v; }
      }
      return best;
    }
    case "stdev": case "variance": {
      const f = finite(a0(), name);
      if (f.length < 2) return NaN;
      const mean = f.reduce((s, v) => s + v, 0) / f.length;
      // Pine's array.stdev is the population form (biased), matching ta.stdev.
      const varce = f.reduce((s, v) => s + (v - mean) ** 2, 0) / f.length;
      return fn === "stdev" ? Math.sqrt(varce) : varce;
    }
    case "covariance": {
      const x = finite(a0(), name);
      const y = finite(asArray(args[1] ?? null, name), name);
      const n = Math.min(x.length, y.length);
      if (n < 2) return NaN;
      const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
      const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
      let acc = 0;
      for (let i = 0; i < n; i++) acc += (x[i]! - mx) * (y[i]! - my);
      return acc / n;
    }
    case "abs": return new PineArray("float", finite(a0(), name).map(Math.abs));
    case "standardize": {
      const f = finite(a0(), name);
      const mean = f.reduce((s, v) => s + v, 0) / (f.length || 1);
      const sd = Math.sqrt(f.reduce((s, v) => s + (v - mean) ** 2, 0) / (f.length || 1));
      return new PineArray("float", f.map((v) => (sd === 0 ? 0 : (v - mean) / sd)));
    }
    default:
      bad(`array.${fn} is not supported by this engine`);
  }
}

/** Pine equality across the value types an array can hold. */
function looseEq(a: PineValue, b: PineValue): boolean {
  if (isRef(a) || isRef(b)) return a === b;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) ? Number.isNaN(b) : a === b;
  }
  return a === b;
}

export function callMatrix(
  fn: string,
  args: PineValue[],
  typeArg: string | null
): PineValue {
  const m0 = (): PineMatrix => asMatrix(args[0] ?? null, `matrix.${fn}`);
  const name = `matrix.${fn}`;

  switch (fn) {
    case "new": {
      const type = typeArg ?? "float";
      const rows = args.length > 0 ? checkSize(num(args[0]!, name), name) : 0;
      const cols = args.length > 1 ? checkSize(num(args[1]!, name), name) : 0;
      if (rows * cols > MAX_ELEMENTS) {
        bad(`${name}: ${rows}x${cols} exceeds the ${MAX_ELEMENTS.toLocaleString()} element limit`);
      }
      const init = args.length > 2 ? args[2]! : defaultFor(type);
      const grid: PineValue[][] = [];
      for (let r = 0; r < rows; r++) grid.push(new Array<PineValue>(cols).fill(init));
      return new PineMatrix(type, grid);
    }
    case "copy": return new PineMatrix(m0().type, m0().rows.map((r) => r.slice()));
    case "rows": return m0().numRows;
    case "columns": return m0().numCols;
    case "elements_count": return m0().numRows * m0().numCols;
    case "get": {
      const m = m0();
      const r = idx(args[1]!, m.numRows, name);
      const c = idx(args[2]!, m.numCols, name);
      return m.rows[r]![c]!;
    }
    case "set": {
      const m = m0();
      const r = idx(args[1]!, m.numRows, name);
      const c = idx(args[2]!, m.numCols, name);
      m.rows[r]![c] = args[3] ?? null;
      return NaN;
    }
    case "row": {
      const m = m0();
      return new PineArray(m.type, m.rows[idx(args[1]!, m.numRows, name)]!.slice());
    }
    case "col": {
      const m = m0();
      const c = idx(args[1]!, m.numCols, name);
      return new PineArray(m.type, m.rows.map((r) => r[c]!));
    }
    case "add_row": {
      const m = m0();
      const at = args.length > 1 ? Math.trunc(num(args[1]!, name)) : m.numRows;
      const src = args[2] !== undefined ? asArray(args[2]!, name).items.slice()
        : new Array<PineValue>(m.numCols).fill(defaultFor(m.type));
      m.rows.splice(at, 0, src);
      return NaN;
    }
    case "add_col": {
      const m = m0();
      const at = args.length > 1 ? Math.trunc(num(args[1]!, name)) : m.numCols;
      const src = args[2] !== undefined ? asArray(args[2]!, name).items : null;
      m.rows.forEach((r, i) => r.splice(at, 0, src ? src[i]! : defaultFor(m.type)));
      return NaN;
    }
    case "remove_row": {
      const m = m0();
      m.rows.splice(idx(args[1] ?? m.numRows - 1, m.numRows, name), 1);
      return NaN;
    }
    case "remove_col": {
      const m = m0();
      const c = idx(args[1] ?? m.numCols - 1, m.numCols, name);
      for (const r of m.rows) r.splice(c, 1);
      return NaN;
    }
    case "fill": {
      const m = m0();
      for (const r of m.rows) r.fill(args[1] ?? null);
      return NaN;
    }
    case "transpose": {
      const m = m0();
      const out: PineValue[][] = [];
      for (let c = 0; c < m.numCols; c++) out.push(m.rows.map((r) => r[c]!));
      return new PineMatrix(m.type, out);
    }
    case "sort": {
      // Rows are reordered as units, keyed on one column — the row is the
      // record, so sorting the column alone would shear the matrix.
      const m = m0();
      const col = Math.trunc(num(args[1] ?? 0, name)) || 0;
      const desc = String(args[2] ?? "ascending").startsWith("desc");
      m.rows.sort((r1, r2) => {
        const c = compare(r1[col] ?? NaN, r2[col] ?? NaN);
        return desc ? -c : c;
      });
      return NaN;
    }
    case "sum": case "avg": case "min": case "max": {
      const flat: number[] = [];
      for (const r of m0().rows) {
        for (const v of r) {
          const n = num(v, name);
          if (Number.isFinite(n)) flat.push(n);
        }
      }
      if (flat.length === 0) return NaN;
      if (fn === "sum") return flat.reduce((s, v) => s + v, 0);
      if (fn === "avg") return flat.reduce((s, v) => s + v, 0) / flat.length;
      return fn === "min" ? Math.min(...flat) : Math.max(...flat);
    }
    default:
      bad(`matrix.${fn} is not supported by this engine`);
  }
}
