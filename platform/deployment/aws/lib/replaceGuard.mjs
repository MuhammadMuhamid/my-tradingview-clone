/**
 * Shared guards for the scripts that rewrite the production deployment table.
 *
 * `OPT-27`: `replace_*.mjs` issue `DELETE FROM deployments` and re-create every
 * row with a flat runtime state. That discards the live position, entry price,
 * saved stop and target of anything currently open. One of the four refused to
 * run while a locally tracked position was open; the other three did not, and
 * all four wrote by default with `--dry` as the opt-in.
 *
 * Both properties are now shared and mandatory:
 *   - writing requires an explicit `--apply`; with neither flag the script
 *     reports and exits without touching anything;
 *   - no script may delete a deployment row while its runtime state says the
 *     position is long.
 */

/**
 * Decide whether this invocation may write.
 *
 * `--dry` is kept because every runbook and remote wrapper passes it for the
 * preview pass. It now means the same thing as passing nothing at all.
 */
export function parseWriteIntent(argv, script) {
  const apply = argv.includes("--apply");
  const dry = argv.includes("--dry");
  if (apply && dry) {
    throw new Error(`${script}: --apply and --dry contradict each other`);
  }
  return {
    apply,
    explain() {
      if (apply) return `${script}: APPLYING — this rewrites the deployment table.`;
      return `${script}: preview only. Nothing was written. Re-run with --apply to write.`;
    },
  };
}

/**
 * Refuse to proceed while the database believes a position is open.
 *
 * Re-creating a row flat while the exchange holds coin leaves the platform
 * unable to sell it: it no longer knows the entry price, the stop or the
 * target, and inventing them would put real money behind a guess.
 */
export async function assertNoOpenPositions(pool, script) {
  const open = await pool.query(
    "SELECT symbol FROM deployments WHERE runtime_state->>'position'='long' ORDER BY symbol"
  );
  if (open.rows.length) {
    throw new Error(
      `${script}: refusing to replace while locally tracked positions are open: ` +
      `${open.rows.map((r) => r.symbol).join(", ")}. ` +
      `Close or reconcile them first — a rewritten row starts flat and loses the entry, stop and target.`
    );
  }
}
