/**
 * Shared guard for the `scripts/apply_*.ts` deployment helpers.
 *
 * `OPT-26`: six scripts wrote deployment rows — several of them `status:
 * 'active'` — with no dry-run flag of any kind, and between them hardcoded four
 * different order sizes (70.01, 320.01, 340.01, 800). Running one was the whole
 * interaction: there was no way to see what it would do first, and the size it
 * would use was whatever that file happened to contain. The `deployment/aws/`
 * scripts beside them are consistently guarded; these were not.
 *
 * Two rules, shared:
 *   - **preview by default.** Writing requires `--apply`.
 *   - **no silent order size.** Applying requires `--buy <usdt>`. The figure a
 *     script historically used is printed in the preview, so it is easy to pass
 *     deliberately, but never applied because it happened to be in the file.
 */

export interface ApplyIntent {
  /** True only when `--apply` was passed. */
  apply: boolean;
  /** Order size in quote currency. Always explicit when `apply` is true. */
  buyQuoteQty: number;
  /** Positional arguments with the recognised flags removed. */
  rest: string[];
  /** One line naming what will and will not happen. */
  banner(): string;
}

export class ApplyGuardError extends Error {}

function readFlagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ApplyGuardError(`${flag} needs a value`);
  }
  return value;
}

export function parseApplyIntent(
  argv: string[],
  opts: { script: string; historicalBuy: number }
): ApplyIntent {
  const apply = argv.includes("--apply");
  const buyRaw = readFlagValue(argv, "--buy");
  const flagIndices = new Set<number>();
  argv.forEach((arg, i) => {
    if (arg === "--apply") flagIndices.add(i);
    if (arg === "--buy") { flagIndices.add(i); flagIndices.add(i + 1); }
  });
  const rest = argv.filter((_, i) => !flagIndices.has(i));

  if (buyRaw !== undefined) {
    const n = Number(buyRaw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ApplyGuardError(`--buy must be a positive number, got ${buyRaw}`);
    }
    return intent(apply, n, rest, opts);
  }
  if (apply) {
    throw new ApplyGuardError(
      `${opts.script}: refusing to apply without an explicit order size. ` +
      `This script historically used ${opts.historicalBuy} USDT; pass ` +
      `--buy ${opts.historicalBuy} if that is still what you mean.`
    );
  }
  return intent(false, opts.historicalBuy, rest, opts);
}

function intent(
  apply: boolean, buyQuoteQty: number, rest: string[],
  opts: { script: string; historicalBuy: number }
): ApplyIntent {
  return {
    apply,
    buyQuoteQty,
    rest,
    banner() {
      if (apply) {
        return `${opts.script}: APPLYING with buy ${buyQuoteQty} USDT — this writes deployment rows.`;
      }
      return `${opts.script}: PREVIEW ONLY, nothing will be written. ` +
        `Order size shown is this script's historical ${opts.historicalBuy} USDT; ` +
        `re-run with --apply --buy <usdt> to write.`;
    },
  };
}

/**
 * For scripts whose order size is already an explicit argument (or comes from a
 * credentials file). They still need the preview-by-default rule; they do not
 * need `--buy`, because nothing about the size is hidden.
 */
export function requireApplyFlag(
  argv: string[], script: string
): { apply: boolean; rest: string[]; banner(): string } {
  const apply = argv.includes("--apply");
  return {
    apply,
    rest: argv.filter((a) => a !== "--apply"),
    banner() {
      return apply
        ? `${script}: APPLYING — this writes deployment rows.`
        : `${script}: PREVIEW ONLY, nothing will be written. Re-run with --apply to write.`;
    },
  };
}
