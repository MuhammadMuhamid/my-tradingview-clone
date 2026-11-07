/**
 * Money for the package ledger: whole units of 10^-8, held in a bigint.
 *
 * Never a JS float. Amounts travel as decimal strings, PostgreSQL keeps them as
 * NUMERIC, and every split hands out the last unit deliberately so the parts
 * always add up to the whole exactly.
 */
export const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);

export type Units = bigint;

const DECIMAL = /^-?\d{1,20}(\.\d{1,8})?$/;

export function parseMoney(raw: string): Units {
  const text = raw.trim();
  if (!DECIMAL.test(text)) throw new RangeError(`not a money amount: ${JSON.stringify(raw)}`);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const units = BigInt(whole!) * FACTOR + BigInt(fraction.padEnd(SCALE, "0"));
  return negative ? -units : units;
}

/** Decimal string with all 8 places, as NUMERIC(38,8) prints it. */
export function formatMoney(units: Units): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const text = `${abs / FACTOR}.${(abs % FACTOR).toString().padStart(SCALE, "0")}`;
  return negative ? `-${text}` : text;
}

export const sum = (values: readonly Units[]): Units => values.reduce((a, b) => a + b, 0n);

/**
 * Split `total` in proportion to `weights`, rounding down, then give the units
 * left over one each to the largest remainders. Ties go to the earlier weight,
 * so the same inputs always give the same answer.
 */
export function allocate(total: Units, weights: readonly Units[]): Units[] {
  if (weights.some((w) => w < 0n)) throw new RangeError("weights must not be negative");
  const totalWeight = sum(weights);
  if (totalWeight === 0n) {
    if (total !== 0n) throw new RangeError("cannot allocate an amount across zero weight");
    return weights.map(() => 0n);
  }
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const parts = weights.map((w) => (magnitude * w) / totalWeight);
  const remainders = weights.map((w, i) => ({ i, r: (magnitude * w) % totalWeight }));
  let left = magnitude - sum(parts);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    parts[i]! += 1n;
    left -= 1n;
  }
  return negative ? parts.map((p) => -p) : parts;
}

/** `value × percent / 100`, rounded down to a whole cent of the quote asset. */
export function percentOf(value: Units, percent: Units): Units {
  if (value <= 0n || percent <= 0n) return 0n;
  const raw = (value * percent) / (100n * FACTOR);
  const cent = FACTOR / 100n;
  return (raw / cent) * cent;
}
