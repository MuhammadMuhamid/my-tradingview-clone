import Link from "next/link";
import { Button, Card, CardHeader } from "@/components/ui";
import { compareRuns, type CompareRow } from "@/lib/backtestFigures";
import type { Backtest, Strategy } from "@/lib/types";
import { fmtDate } from "@/lib/format";

function Section({ title, rows }: { title: string; rows: CompareRow[] }) {
  return (
    <>
      <tr className="border-b border-border">
        <th colSpan={3} scope="colgroup" className="px-4 pb-1 pt-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          {title}
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.label} className="border-b border-border/50" data-differs={r.differs ? "true" : "false"}>
          <th scope="row" className="px-4 py-1.5 text-left font-normal text-ink-muted">{r.label}</th>
          {/*
            A differing pair is set in full ink and the matching ones recede:
            the rows that could explain a difference in results are the ones a
            reader came here to find. Weight, not colour — neither run is "the
            good one".
          */}
          <td className={`px-4 py-1.5 text-right ${r.differs ? "font-medium text-ink" : "text-ink-faint"}`}>{r.a}</td>
          <td className={`px-4 py-1.5 text-right ${r.differs ? "font-medium text-ink" : "text-ink-faint"}`}>{r.b}</td>
        </tr>
      ))}
    </>
  );
}

/**
 * Two runs side by side.
 *
 * A reader comparing two results opened one, remembered its numbers, went
 * back, and opened the other — with nothing to say whether the two even shared
 * a cost model. This puts the settings that could explain a difference first,
 * then the headline and each window, all through the same reading rules as the
 * result page itself (`lib/backtestFigures.ts`).
 */
export function CompareRuns({ a, b, strategies, onClear }: {
  a: Backtest; b: Backtest; strategies: readonly Strategy[]; onClear: () => void;
}) {
  const cmp = compareRuns(a, b, strategies);
  // "A" and "B" are what the "only in A / only in B" rows refer to.
  const head = (bt: Backtest, letter: "A" | "B") => (
    <Link href={`/research/${bt.id}`}
      className="rounded text-ink underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      <span className="text-ink-faint">{letter} · </span>{bt.symbol} · {bt.timeframe}
      <span className="block text-xs font-normal text-ink-faint">{fmtDate(bt.createdAt)}</span>
    </Link>
  );
  return (
    <Card>
      <CardHeader title="Comparison" right={<Button variant="ghost" onClick={onClear}>Clear</Button>} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm tabular" aria-label="Two runs compared">
          <thead>
            <tr className="border-b border-border text-xs text-ink-muted">
              <th className="px-4 py-2 text-left font-medium">&nbsp;</th>
              <th className="px-4 py-2 text-right font-medium">{head(a, "A")}</th>
              <th className="px-4 py-2 text-right font-medium">{head(b, "B")}</th>
            </tr>
          </thead>
          <tbody>
            <Section title="Settings" rows={cmp.settings} />
            <Section title="Whole window (validation included)" rows={cmp.headline} />
            <Section title="By window" rows={cmp.windows} />
          </tbody>
        </table>
      </div>
    </Card>
  );
}
