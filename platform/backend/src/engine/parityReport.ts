/**
 * Backtest-versus-live parity.
 *
 * The audit's live-versus-backtest findings — `BE-01` (a staler MTF feed live),
 * `BE-03` (inverted exit precedence), `BE-15` (a gross win/loss flag live
 * against a net one in the backtest) — were all found by reading code. Each
 * changes which trades are taken, not just how they are reported, and none of
 * them would show up in a metric: the two sides simply take different trades
 * and each looks internally consistent.
 *
 * What catches that is a comparison of the two trade lists, signal by signal.
 * This module is that comparison, and it is a pure function of two lists so it
 * can run on fixtures, in a test, or against real data — the harness that
 * fetches the data is a separate concern (`scripts/parity_harness.ts`).
 *
 * It compares SIGNALS, not fills. The live side has no fill price: the payload
 * carries no price at all and the receiver places a market order (`BE-02`), so
 * a price comparison would be comparing a decision against an outcome. What is
 * comparable is: did both sides act, on the same bar, in the same direction,
 * for the same reason.
 */

export interface ParitySignal {
  /** Open time of the bar that produced the signal, ms. */
  barTime: number;
  action: "buy" | "sell";
  /** The rule that fired: `entry`, `tp`, `sl`, `hl_break`, … */
  reason: string | null;
  /** Decision price. Present on the backtest side; often absent live. */
  price?: number | null;
  /** Which exit leg, when the exit is a partial. */
  exitLeg?: string | null;
}

export type DivergenceKind =
  /** The backtest took a signal the live side never produced. */
  | "missing_live"
  /** The live side produced a signal the backtest never took. */
  | "extra_live"
  /** Both acted on the bar, in opposite directions. */
  | "action_mismatch"
  /** Both acted the same way, for different stated reasons. */
  | "reason_mismatch";

export interface Divergence {
  kind: DivergenceKind;
  barTime: number;
  backtest: ParitySignal | null;
  live: ParitySignal | null;
  detail: string;
}

export interface ParityReport {
  barsCompared: number;
  backtestSignals: number;
  liveSignals: number;
  matched: number;
  divergences: Divergence[];
  /** Matched signals as a share of the larger side, 0..1. Null when both empty. */
  agreement: number | null;
  /** True only when the two lists agree signal for signal. */
  identical: boolean;
  summary: string;
  /** Window actually compared, so a partial overlap cannot be read as a full one. */
  window: { startMs: number; endMs: number } | null;
}

const key = (s: ParitySignal): string => `${s.barTime}|${s.exitLeg ?? ""}`;

/**
 * Compare two signal lists over their overlapping window.
 *
 * The window matters: the live side starts when the deployment was armed, and
 * comparing a backtest that begins a year earlier would report the whole first
 * year as `missing_live`. Only the overlap is compared, and the report says
 * which window that was.
 */
export function compareParity(
  backtest: readonly ParitySignal[],
  live: readonly ParitySignal[],
  opts: { window?: { startMs: number; endMs: number } } = {}
): ParityReport {
  const window = opts.window ?? overlapWindow(backtest, live);
  const inWindow = (s: ParitySignal): boolean =>
    window === null || (s.barTime >= window.startMs && s.barTime <= window.endMs);

  const bt = backtest.filter(inWindow);
  const lv = live.filter(inWindow);
  const liveByKey = new Map(lv.map((s) => [key(s), s]));
  const btByKey = new Map(bt.map((s) => [key(s), s]));

  const divergences: Divergence[] = [];
  let matched = 0;

  for (const b of bt) {
    const l = liveByKey.get(key(b));
    if (!l) {
      divergences.push({
        kind: "missing_live", barTime: b.barTime, backtest: b, live: null,
        detail: `the backtest ${b.action}s here (${b.reason ?? "no reason recorded"}) and the live side did not act`,
      });
      continue;
    }
    if (l.action !== b.action) {
      divergences.push({
        kind: "action_mismatch", barTime: b.barTime, backtest: b, live: l,
        detail: `backtest ${b.action}, live ${l.action} — the two sides are taking opposite trades`,
      });
      continue;
    }
    if (normaliseReason(b.reason) !== normaliseReason(l.reason)) {
      divergences.push({
        kind: "reason_mismatch", barTime: b.barTime, backtest: b, live: l,
        detail: `both ${b.action}, but the backtest says "${b.reason ?? "—"}" and live says "${l.reason ?? "—"}"`
          + " — the same trade for a different reason means the exit precedence differs (BE-03)",
      });
      continue;
    }
    matched += 1;
  }

  for (const l of lv) {
    if (btByKey.has(key(l))) continue;
    divergences.push({
      kind: "extra_live", barTime: l.barTime, backtest: null, live: l,
      detail: `the live side ${l.action}s here (${l.reason ?? "no reason recorded"}) and the backtest did not`,
    });
  }

  divergences.sort((a, b) => a.barTime - b.barTime);
  const larger = Math.max(bt.length, lv.length);
  const agreement = larger === 0 ? null : matched / larger;
  const identical = divergences.length === 0 && bt.length === lv.length;

  return {
    barsCompared: new Set([...bt, ...lv].map((s) => s.barTime)).size,
    backtestSignals: bt.length,
    liveSignals: lv.length,
    matched,
    divergences,
    agreement,
    identical,
    window,
    summary: identical
      ? `identical: ${matched} signal(s) agree over the compared window, with none on either side alone.`
      : larger === 0
        ? "nothing to compare: neither side produced a signal in the overlapping window."
        : `${matched} of ${larger} signal(s) agree (${Math.round((agreement ?? 0) * 100)}%). `
          + summariseKinds(divergences),
  };
}

function summariseKinds(divergences: readonly Divergence[]): string {
  const counts = new Map<DivergenceKind, number>();
  for (const d of divergences) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  const label: Record<DivergenceKind, string> = {
    missing_live: "taken by the backtest only",
    extra_live: "taken live only",
    action_mismatch: "opposite directions",
    reason_mismatch: "same trade, different reason",
  };
  return [...counts.entries()].map(([k, n]) => `${n} ${label[k]}`).join(", ") + ".";
}

/**
 * Reasons are compared case- and separator-insensitively.
 *
 * The backtest records `HL Break` and the live path records `hl_break` for the
 * same rule; reporting that as a divergence would bury the real ones.
 */
function normaliseReason(reason: string | null | undefined): string {
  return (reason ?? "").toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * The window both sides actually cover, inferred from the signals themselves.
 *
 * A HEURISTIC, and a caller with the real windows should pass them instead: a
 * quiet backtest that produced its last signal early makes this window end
 * early too, hiding live-only signals after it. `compareParity`'s `window`
 * option exists for that, and the report always states the window it used.
 */
export function overlapWindow(
  a: readonly ParitySignal[],
  b: readonly ParitySignal[]
): { startMs: number; endMs: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  const start = Math.max(minBar(a), minBar(b));
  const end = Math.min(maxBar(a), maxBar(b));
  return end >= start ? { startMs: start, endMs: end } : null;
}

const minBar = (s: readonly ParitySignal[]): number => Math.min(...s.map((x) => x.barTime));
const maxBar = (s: readonly ParitySignal[]): number => Math.max(...s.map((x) => x.barTime));
