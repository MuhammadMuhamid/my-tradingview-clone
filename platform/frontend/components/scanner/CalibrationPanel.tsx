"use client";

import { useState } from "react";

import { api } from "@/lib/scanner/api";
import { fmtTime } from "@/lib/scanner/format";
import type { Calibration, EmpiricalLookup } from "@/lib/scanner/types";

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
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<Calibration>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await fn();
      setData(next);
      setNotice(next.current ? "Calibration loaded and matches current settings." : "Stored calibration loaded as stale.");
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
          Current score lookup:{" "}
          {empirical.available && empirical.current !== false && !empirical.stale ? (
            <span>{empirical.display}</span>
          ) : (
            <span className="text-[var(--color-ink-dim)]">
              {empirical.stale ? `stale — ${empirical.stale_reason ?? "settings changed"}` : empirical.display}
            </span>
          )}
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
      {notice && !error && <p role="status" className="text-xs text-[var(--color-ink-dim)]">{notice}</p>}

      {data && (
        <>
          <p className={`mb-1 text-xs font-medium ${
            data.current && !data.stale ? "text-[var(--color-pos)]" : "text-[var(--color-neg)]"
          }`}>
            {data.current && !data.stale ? "Current calibration" : "Stale calibration"}
            {data.stale_reason ? ` — ${data.stale_reason}` : ""}
          </p>
          {!data.available && (
            <p className="mb-1 text-xs text-[var(--color-neg)]">
              No current empirical rate: {data.reason ?? data.stale_reason ?? "calibration is unavailable"}
            </p>
          )}

          {data.window && (
            <p className="mb-1 text-[11px] text-[var(--color-ink-dim)]">
              {data.samples} labelled bars over {data.window.days} days (
              {fmtTime(data.window.start_ts)} → {fmtTime(data.window.end_ts)}). Base rate{" "}
              {data.current && data.available && data.base_rate !== undefined
                ? `${(data.base_rate * 100).toFixed(1)}%`
                : "withheld unless current and usable"}.{" "}
              {data.unresolved} unresolved, {data.ambiguous} ambiguous.
            </p>
          )}

          <div className="overflow-x-auto">
          <table className="min-w-max text-[11px]">
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
                  <td className={data.current && data.available && d.sufficient ? "" : "text-[var(--color-ink-dim)]"}>
                    {data.current && data.available ? d.display : `withheld (n=${d.n})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          {data.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[10px] leading-tight text-[var(--color-neg)]">
              {data.warnings.map((w) => (
                <li key={w}>! {w}</li>
              ))}
            </ul>
          )}

          <details className="mt-2 text-[10px] text-[var(--color-ink-dim)]">
            <summary className="cursor-pointer">Settings and provenance</summary>
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5">
              <dt>Timeframe</dt><dd>{data.timeframe}</dd>
              <dt>Generated</dt><dd>{fmtTime(data.generated_at ?? null)}</dd>
              <dt>Fingerprint</dt><dd className="break-all font-mono">{data.fingerprint ?? "legacy / absent"}</dd>
              {Object.entries(data.settings ?? {}).map(([key, value]) => (
                <span className="contents" key={key}><dt>{key}</dt><dd>{String(value)}</dd></span>
              ))}
            </dl>
          </details>

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
