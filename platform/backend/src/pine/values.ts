/**
 * Reference values for the Pine engine: arrays, matrices and user-defined
 * type instances.
 *
 * Everything the interpreter handled before this module is a *value* type —
 * a number, string or bool copied on assignment. Pine's collections and UDTs
 * are *reference* types: `arr2 = arr1` aliases one object, and an object
 * created under `var` survives across bars while the variable's series simply
 * carries the same handle forward. Modelling them as boxed handles is what
 * makes both behaviours fall out of the existing Series machinery unchanged.
 *
 * `na` for a reference is a real JS `null` handle rather than NaN, so that
 * `na(myArray)` and `array.size(na)` can be told apart from a valid empty
 * collection.
 */

/** Any value the interpreter can hold. */
export type PineValue =
  | number | string | boolean
  | PineValue[]
  | PineRef | null;

export type PineRef = PineArray | PineMatrix | PineObject | PineDrawing;

export function isRef(v: unknown): v is PineRef {
  return v instanceof PineArray || v instanceof PineMatrix ||
    v instanceof PineObject || v instanceof PineDrawing;
}

export type DrawingKind = "line" | "label" | "box" | "table" | "linefill";

/** One cell of a `table`, addressed by column/row. */
export interface TableCell {
  text: string;
  textColor: string;
  bgColor: string;
  align: string;
}

/**
 * A line/label/box/table handle.
 *
 * Drawings are mutable and long-lived: a script typically creates one and then
 * moves it with `set_*` calls on later bars, so properties live in a bag that
 * setters patch in place. `deleted` is a tombstone rather than a removal from
 * the registry, because a script may still hold (and call setters on) a handle
 * it has deleted — in Pine that is a silent no-op, not an error.
 */
export class PineDrawing {
  readonly kind: DrawingKind;
  readonly id: number;
  deleted = false;
  props: Map<string, PineValue>;
  /** table cells, keyed `${col}:${row}` */
  cells = new Map<string, TableCell>();

  constructor(kind: DrawingKind, id: number, props: Map<string, PineValue>) {
    this.kind = kind;
    this.id = id;
    this.props = props;
  }
}

/** Element type tag, kept for `array.new<T>` defaults and error messages. */
export type PineTypeTag = string;

export class PineArray {
  items: PineValue[];
  readonly type: PineTypeTag;
  constructor(type: PineTypeTag = "float", items: PineValue[] = []) {
    this.type = type;
    this.items = items;
  }
  get size(): number { return this.items.length; }
}

export class PineMatrix {
  rows: PineValue[][];
  readonly type: PineTypeTag;
  constructor(type: PineTypeTag = "float", rows: PineValue[][] = []) {
    this.type = type;
    this.rows = rows;
  }
  get numRows(): number { return this.rows.length; }
  get numCols(): number { return this.rows[0]?.length ?? 0; }
}

/** An instance of a user-declared `type`. */
export class PineObject {
  readonly type: PineTypeTag;
  fields: Map<string, PineValue>;
  constructor(type: PineTypeTag, fields: Map<string, PineValue>) {
    this.type = type;
    this.fields = fields;
  }
}

/** The zero value a freshly sized collection of `type` is filled with. */
export function defaultFor(type: PineTypeTag): PineValue {
  switch (type) {
    case "int": case "float": return NaN;
    case "bool": return false;
    case "string": return "";
    case "color": return "";
    default: return null; // object / drawing handles start as na
  }
}
