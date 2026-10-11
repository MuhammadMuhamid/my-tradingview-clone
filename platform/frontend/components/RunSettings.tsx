"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Card, CardHeader, Notice } from "@/components/ui";
import {
  paramRows, refusedSettingsNotice, runSettings, strategyFor, rerunRequest,
} from "@/lib/backtestFigures";
import { ApiError } from "@/lib/api";
import { describeAction } from "@/lib/errorCopy";
import type { Backtest, Strategy } from "@/lib/types";

/**
 * Everything a result was produced under, and the way to produce it again.
 *
 * The detail page said `SOLUSDT · 1h` and two dates. The strategy, capital,
 * cost model, sizing, validation split, engine and data source were all on
 * the stored row and none of them was on the page, so the one screen that
 * reports a result was also the one screen from which it could not be
 * reproduced — or told apart from a run that differs in one setting.
 *
 * `onRerun` posts the stored snapshot unchanged (see `rerunRequest`); "Edit and
 * re-run" opens the form with it filled in, for the reader who wants to change
 * one thing. "Stress this run" hands the run to the stress page, which takes
 * its strategy and settings from it.
 */
export function RunSettings({ bt, strategies, onRerun }: {
  bt: Backtest;
  strategies: readonly Strategy[];
  /** Queue the same request; resolves with the new run's id. */
  onRerun: (body: ReturnType<typeof rerunRequest>) => Promise<string>;
}) {
  const rows = runSettings(bt, strategies);
  const params = paramRows(bt.params);
  const strategy = strategyFor(bt, strategies);
  const refused = refusedSettingsNotice(bt);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ headline: string; detail: string } | null>(null);

  const rerun = async (): Promise<void> => {
    if (!strategy || refused) return;
    setBusy(true);
    setErr(null);
    try {
      await onRerun(rerunRequest(bt, strategy.key));
    } catch (e) {
      /*
       * A 400 from this API is a sentence this product wrote about the
       * request ("Initial capital must be a number greater than 0.") and is
       * the most useful thing to say; anything else is a cause, and goes in
       * the tooltip.
       */
      setErr(e instanceof ApiError && e.status === 400
        ? { headline: `Could not queue the re-run. ${e.detail}`, detail: e.detail }
        : describeAction(e, "queue the re-run"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Run settings"
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* A stress window is already one; stressing it again means nothing. */}
            {bt.stressRunId === null && bt.status === "done" && (refused ? (
              <span aria-disabled="true" title={refused} className="cursor-not-allowed text-sm text-ink-faint">
                Stress this run
              </span>
            ) : (
              // accent-is-meaning: a link to another page, not a selection
              <Link href={`/stress?from=${encodeURIComponent(bt.id)}`}
                className="rounded text-sm text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                Stress this run
              </Link>
            ))}
            <Link href={`/research?from=${encodeURIComponent(bt.id)}`}
              className="rounded text-sm text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              Edit and re-run
            </Link>
            <Button onClick={() => void rerun()} disabled={busy || !strategy || refused !== null}
              title={refused ?? (strategy ? "Queue a new run with exactly these settings" : "This run's strategy is no longer registered")}>
              {busy ? "Queuing…" : "Re-run with these settings"}
            </Button>
          </div>
        }
      />
      {/*
        C-07: the server refuses these settings as a new request, so Re-run
        and Stress would only fail. Said here in words — a disabled control's
        tooltip is not reachable by everyone — with the way forward.
      */}
      {refused && (
        <p className="px-4 pt-3 text-sm text-ink-muted" data-refused-settings>
          Re-run and stress are unavailable: {bt.refusedSettings} Use Edit and re-run to change the settings.
        </p>
      )}
      {err && (
        <div className="px-4 pt-3">
          <Notice tone="error" role="alert"><span title={err.detail}>{err.headline}</span></Notice>
        </div>
      )}
      <dl className="grid gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-xs text-ink-muted">{r.label}</dt>
            <dd className="text-ink tabular" title={r.title}>{r.value}</dd>
          </div>
        ))}
      </dl>
      <details className="border-t border-border">
        <summary className="cursor-pointer select-none px-4 py-2 text-xs font-medium text-ink-muted hover:text-ink">
          Strategy parameters ({params.length})
        </summary>
        {params.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-ink-faint">This run used the strategy&rsquo;s defaults for every input.</p>
        ) : (
          <div className="grid gap-x-6 gap-y-1 px-4 pb-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {params.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-border/50 py-1">
                <span className="text-ink-muted">{k}</span>
                <span className="text-ink tabular">{v}</span>
              </div>
            ))}
          </div>
        )}
      </details>
    </Card>
  );
}
