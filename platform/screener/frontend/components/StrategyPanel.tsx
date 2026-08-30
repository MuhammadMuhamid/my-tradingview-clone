"use client";

import { fmtTime } from "@/lib/format";
import type { RuleResult, StrategyResult } from "@/lib/types";

const SLOTS = ["1h", "15m", "5m"] as const;

/**
 * The MTF checklist, both scenarios side by side.
 *
 * Bull and bear are shown together rather than behind a toggle: the useful
 * reading is usually the contrast between them, and a screen that only ever
 * shows the direction you were already looking for is a confirmation-bias
 * machine.
 *
 * A rule that could not be evaluated renders as "–", never as a pass. The
 * percentages are pass counts, stated as such directly under them.
 */
function Mark({ value }: { value: boolean | null }) {
  if (value === null) {
    return <span className="text-[var(--color-ink-dim)]" title="no data">–</span>;
  }
  return value ? (
    <span style={{ color: "var(--color-pos)" }}>✓</span>
  ) : (
    <span style={{ color: "var(--color-neg)" }}>✗</span>
  );
}

function ruleOf(rules: RuleResult[], id: string): RuleResult | undefined {
  return rules.find((r) => r.id === id);
}

export function StrategyPanel({ strategy }: { strategy: StrategyResult | null }) {
  if (!strategy) {
    return (
      <p className="text-xs text-[var(--color-ink-dim)]">
        Strategy disabled, or no candles cached for its timeframes yet.
      </p>
    );
  }

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
        MTF checklist
        <span className="ml-2 font-normal normal-case text-[var(--color-ink)]">
          bull {strategy.bullish_pct ?? "—"}% · bear {strategy.bearish_pct ?? "—"}%
        </span>
        {strategy.setup && (
          <span
            className="ml-2 rounded px-1 font-normal normal-case"
            style={{
              backgroundColor:
                strategy.setup === "bull"
                  ? "rgba(13,148,136,0.3)"
                  : "rgba(190,18,60,0.3)",
            }}
          >
            {strategy.setup} setup — all rules aligned
          </span>
        )}
      </h3>

      {SLOTS.map((slot) => {
        const bull = strategy.bull.timeframes[slot];
        const bear = strategy.bear.timeframes[slot];
        if (!bull || !bear) return null;
        const series = strategy.series?.[slot];

        return (
          <div key={slot} className="mb-2">
            <div className="mb-0.5 flex items-baseline gap-2 text-[11px]">
              <span className="font-semibold">{slot}</span>
              <span style={{ color: "var(--color-pos)" }}>
                bull {bull.passed}/{bull.total}
              </span>
              <span style={{ color: "var(--color-neg)" }}>
                bear {bear.passed}/{bear.total}
              </span>
              {series && (
                <span
                  className={`text-[var(--color-ink-dim)] ${series.stale ? "stale" : ""}`}
                  title={`source bar closed ${fmtTime(series.last_close_ts)}`}
                >
                  {series.stale ? "STALE" : fmtTime(series.last_close_ts)}
                </span>
              )}
            </div>

            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[var(--color-ink-dim)]">
                  <th className="w-6 text-left">▲</th>
                  <th className="w-6 text-left">▼</th>
                  <th className="text-left">Condition</th>
                  <th className="text-left">Reading</th>
                </tr>
              </thead>
              <tbody>
                {bull.rules.map((rule) => {
                  const mirror = ruleOf(bear.rules, rule.id);
                  return (
                    <tr key={rule.id} title={rule.note ?? undefined}>
                      <td><Mark value={rule.passed} /></td>
                      <td><Mark value={mirror?.passed ?? null} /></td>
                      <td className={rule.required ? "" : "text-[var(--color-ink-dim)] italic"}>
                        {rule.label}
                        {!rule.required && " (optional)"}
                      </td>
                      <td className="text-[var(--color-ink-dim)]">{rule.detail ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      <p className="mt-1 text-[10px] leading-tight text-[var(--color-ink-dim)]">
        {strategy.note}
      </p>
    </div>
  );
}
