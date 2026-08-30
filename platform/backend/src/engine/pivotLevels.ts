/**
 * Pivot point levels from a completed period's high, low, close and open.
 *
 * Shared by the built-in "Pivot Points Standard" indicator and by pivot alerts,
 * so a level an alert fires on is by construction the level the chart drew —
 * two implementations of the same arithmetic would eventually disagree, and the
 * user would be told price reached a line that is not where they can see it.
 *
 * Fibonacci is the type the user works from. It defines P and three levels
 * either side; S4/S5 and R4/R5 do not exist for it, which is why the level list
 * is per-type rather than a fixed eleven.
 */

export const PIVOT_TYPES = [
  "Traditional", "Fibonacci", "Woodie", "Classic", "Camarilla",
] as const;
export type PivotType = (typeof PIVOT_TYPES)[number];

export const isPivotType = (v: string): v is PivotType =>
  (PIVOT_TYPES as readonly string[]).includes(v);

/** A completed period. */
export interface Period {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PivotLevel {
  /** "P", "S1"…"S5", "R1"…"R5". */
  name: string;
  price: number;
}

/**
 * The levels for one completed period, in the order a chart lists them.
 * Levels a type does not define are simply absent.
 */
export function pivotLevels(period: Period, type: PivotType): PivotLevel[] {
  const { open: o, high: h, low: l, close: c } = period;
  if (![o, h, l, c].every((v) => Number.isFinite(v))) return [];
  const range = h - l;

  const p = type === "Woodie" ? (h + l + 2 * o) / 4 : (h + l + c) / 3;
  const out: PivotLevel[] = [{ name: "P", price: p }];
  const add = (name: string, price: number): void => { out.push({ name, price }); };

  switch (type) {
    case "Fibonacci":
      // Retracements of the period's range around the pivot. No 4th or 5th.
      add("R1", p + 0.382 * range); add("S1", p - 0.382 * range);
      add("R2", p + 0.618 * range); add("S2", p - 0.618 * range);
      add("R3", p + 1.000 * range); add("S3", p - 1.000 * range);
      break;
    case "Camarilla":
      // Anchored on the close rather than the pivot.
      add("R1", c + range * 1.1 / 12); add("S1", c - range * 1.1 / 12);
      add("R2", c + range * 1.1 / 6);  add("S2", c - range * 1.1 / 6);
      add("R3", c + range * 1.1 / 4);  add("S3", c - range * 1.1 / 4);
      add("R4", c + range * 1.1 / 2);  add("S4", c - range * 1.1 / 2);
      break;
    case "Classic":
      add("R1", 2 * p - l);       add("S1", 2 * p - h);
      add("R2", p + range);       add("S2", p - range);
      add("R3", p + 2 * range);   add("S3", p - 2 * range);
      add("R4", p + 3 * range);   add("S4", p - 3 * range);
      break;
    default:
      // Traditional, and Woodie which differs only in how P is anchored.
      add("R1", 2 * p - l);               add("S1", 2 * p - h);
      add("R2", p + range);               add("S2", p - range);
      add("R3", h + 2 * (p - l));         add("S3", l - 2 * (h - p));
      add("R4", h + 3 * (p - l));         add("S4", l - 3 * (h - p));
      if (type === "Traditional") {
        add("R5", h + 4 * (p - l));       add("S5", l - 4 * (h - p));
      }
      break;
  }
  return out;
}

/** The level closest to `price`, or null when the period yields none. */
export function nearestLevel(levels: PivotLevel[], price: number): PivotLevel | null {
  let best: PivotLevel | null = null;
  let bestDist = Infinity;
  for (const lv of levels) {
    if (!Number.isFinite(lv.price)) continue;
    const d = Math.abs(lv.price - price);
    if (d < bestDist) { bestDist = d; best = lv; }
  }
  return best;
}

/** Look one level up by name, e.g. "S1". Names are case-insensitive. */
export function levelByName(levels: PivotLevel[], name: string): PivotLevel | null {
  const want = name.trim().toUpperCase();
  return levels.find((lv) => lv.name.toUpperCase() === want) ?? null;
}
