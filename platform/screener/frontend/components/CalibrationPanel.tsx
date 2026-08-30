"use client";

import { useState } from "react";

import { api } from "@/lib/api";
import { fmtTime } from "@/lib/format";
import type { Calibration, EmpiricalLookup } from "@/lib/types";

/**
 * §6.2 — the only place the word "probability" is allowed, and only once a
 * forward-return sample stands behind it.
 *
 * Every display rule the spec lists is enforced server-side in
 * `app/calibration.py`; this component renders what it is given and never
 * synthesises a number of its own. In particular the `display` string is used
 * verbatim, so a decile the backend refused to publish cannot be turned back
 * into a percentage here.
 */
export function CalibrationPanel({
  symbol,
  empirical,
}: {
  symbol: string;
  empirical: EmpiricalLookup | null;
}) {
  const [data, setData] = useState<Calibration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<Calibration>) => {
    setBusy(true);
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
        Empirical calibration
      </h3>

      {empirical && (
        <p className="mb-1 text-xs">
          Live:{" "}
          <span className={empirical.hit_rate === null ? "text-[var(--color-ink-dim)]" : ""}>
            {empirical.display}
          </span>
        </p>
      )}

      <div className="mb-2 flex gap-2">
        <button
          disabled={busy}
          onClick={() => run(() => api.calibrate(symbol))}
          className="rounded border border-[var(--color-line)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-50"
          title="Walks the cached history bar by bar. Takes several seconds."
        >
          {busy ? "Running…" : "Run calibration"}
        </button>
        <button
          disabled={busy}
          onClick={() => run(() => api.calibration(symbol))}
          className="rounded border border-[var(--color-line)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)] disabled:opacity-50"
        >
          Load stored
        </button>
      </div>

      {error && <p className="text-xs text-[var(--color-neg)]">{error}</p>}

      {data && (
        <>
          {!data.available && (
            <p className="mb-1 text-xs text-[var(--color-neg)]">
              Not usable: {data.reason}
            </p>
          )}

          {data.window && (
            <p className="mb-1 text-[11px] text-[var(--color-ink-dim)]">
              {data.samples} labelled bars over {data.window.days} days (
              {fmtTime(data.window.start_ts)} → {fmtTime(data.window.end_ts)}). Base rate{" "}
              {data.base_rate !== undefined ? `${(data.base_rate * 100).toFixed(1)}%` : "—"}.{" "}
              {data.unresolved} unresolved, {data.ambiguous} ambiguous.
            </p>
          )}

          <table className="text-[11px]">
            <thead>
              <tr className="text-[var(--color-ink-dim)]">
                <th className="pr-2 text-left">Decile</th>
                <th className="pr-2 text-left">Score range</th>
                <th className="text-left">Hit rate</th>
              </tr>
            </thead>
            <tbody>
              {data.deciles.map((d) => (
                <tr key={d.index}>
                  <td className="pr-2 num">{d.index}</td>
                  <td className="pr-2 num text-[var(--color-ink-dim)]">
                    {d.score_lo.toFixed(1)}–{d.score_hi.toFixed(1)}
                  </td>
                  <td className={d.sufficient ? "" : "text-[var(--color-ink-dim)]"}>
                    {d.display}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[10px] leading-tight text-[var(--color-neg)]">
              {data.warnings.map((w) => (
                <li key={w}>! {w}</li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-[10px] leading-tight text-[var(--color-ink-dim)]">
            In-sample. No fees, funding, spread or slippage are modelled. A flattering hit rate
            on lagging indicators is the single most overfittable result in retail trading —
            read the README before acting on any of this.
          </p>
        </>
      )}
    </div>
  );
}
