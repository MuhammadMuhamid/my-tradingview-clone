"use client";
import { useMemo } from "react";
import type { MaAlert } from "@/lib/api";
import type { Interval } from "@/lib/types";
import {
  MA_LENGTHS, maColor, maId, maLabel, type MaLine, type MaType,
} from "@/lib/movingAverages";
import {
  alertColor, alertInactiveReason, alertLineLabel, describeAlert,
  FREQUENCY_LABELS, isAlertActive,
} from "@/lib/alerts";
import { DEFAULT_ALERT_FREQUENCY } from "@/lib/api";
import { fmtPrice } from "@/lib/format";

/**
 * The moving-average rail: every SMA/EMA the chart can draw, one row each,
 * with its own visibility toggle and its own alert bell. One row = one line =
 * one thing you can arm, which is the whole reason these are not bundled into
 * a single "MA ribbon" indicator.
 */
export function MaPanel({
  lines, values, alerts, timeframe, onToggle, onToggleAll, onArm, onArmPrice,
  onOpenAlert, push,
}: {
  lines: MaLine[];
  /** Latest value per line id, for the price column. */
  values: Record<string, number | null>;
  alerts: MaAlert[];
  timeframe: Interval;
  onToggle: (type: MaType, length: number) => void;
  onToggleAll: (visible: boolean) => void;
  onArm: (type: MaType, length: number) => void;
  /** Open the price-alert dialog with no level pre-filled. */
  onArmPrice: () => void;
  onOpenAlert: (alert: MaAlert) => void;
  push: React.ReactNode;
}) {
  /**
   * Alerts grouped by the line they watch, across all timeframes. Only the `ma`
   * kind belongs to a line — a price alert sits on no moving average, and a
   * cross alert belongs to a pair rather than to either half.
   */
  const byLine = useMemo(() => {
    const map = new Map<string, MaAlert[]>();
    for (const a of alerts) {
      if (a.conditionKind !== "ma" || a.maType === null || a.maLength === null) continue;
      const key = maId(a.maType, a.maLength);
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    return map;
  }, [alerts]);

  const allVisible = lines.every((l) => l.visible);

  const Row = ({ line }: { line: MaLine }) => {
    const id = maId(line.type, line.length);
    const value = values[id];
    const armed = byLine.get(id) ?? [];
    return (
      <div className="group grid grid-cols-[16px_1fr_auto_auto] items-center gap-x-2 px-3 py-[6px] text-[13px] hover:bg-surface-2/60">
        <button
          onClick={() => onToggle(line.type, line.length)}
          title={line.visible ? "Hide line" : "Show line"}
          className="flex h-4 w-4 items-center justify-center"
        >
          <span
            className="inline-block h-[3px] w-4 rounded-full"
            style={{
              background: line.visible ? maColor(line.length) : "transparent",
              border: line.visible ? "none" : `1px dashed ${maColor(line.length)}`,
              opacity: line.visible ? 1 : 0.5,
            }}
          />
        </button>
        <span className={line.visible ? "text-ink" : "text-ink-faint"}>
          {maLabel(line.type, line.length)}
        </span>
        <span className="tabular text-right text-ink-muted">
          {value != null ? fmtPrice(value) : "—"}
        </span>
        <button
          onClick={() => onArm(line.type, line.length)}
          title={armed.length ? `${armed.length} alert(s) — click to add or edit` : "Add alert on this line"}
          className={`w-6 text-center ${armed.length ? "text-accent" : "invisible text-ink-faint group-hover:visible hover:text-ink"}`}
        >
          {armed.length ? `🔔${armed.length > 1 ? armed.length : ""}` : "🔔"}
        </button>
      </div>
    );
  };

  // Price alerts first — they are the ones a user arms in the middle of
  // watching a move, and burying them under ten moving averages hides the ones
  // most likely to matter right now.
  const armedList = alerts.slice().sort((a, b) =>
    (a.conditionKind === "price" ? 0 : 1) - (b.conditionKind === "price" ? 0 : 1) ||
    (b.maLength ?? 0) - (a.maLength ?? 0) ||
    (a.maType ?? "").localeCompare(b.maType ?? "") ||
    (a.targetPrice ?? 0) - (b.targetPrice ?? 0)
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Moving averages</span>
        <button
          onClick={() => onToggleAll(!allVisible)}
          className="rounded px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          {allVisible ? "Hide all" : "Show all"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {(["sma", "ema"] as MaType[]).map((type) => (
          <div key={type}>
            <div className="border-b border-border/60 bg-surface-2/40 px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
              {type === "sma" ? "Simple" : "Exponential"}
            </div>
            {MA_LENGTHS.map((length) => {
              const line = lines.find((l) => l.type === type && l.length === length);
              return line ? <Row key={`${type}${length}`} line={line} /> : null;
            })}
          </div>
        ))}

        <div className="flex items-center justify-between border-y border-border bg-surface-2/40 px-3 py-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">Armed alerts</span>
          <button
            onClick={onArmPrice}
            title="Alert on a price level"
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            + Price
          </button>
        </div>
        {armedList.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-ink-faint">
            No alerts on this symbol yet.
            <br />
            Click the 🔔 on a line, or + Price for a level.
          </div>
        ) : (
          armedList.map((a) => (
            <button
              key={a.id}
              onClick={() => onOpenAlert(a)}
              title={`${describeAlert(a)} · ${FREQUENCY_LABELS[a.frequency]}`}
              className="flex w-full items-center gap-2 px-3 py-[7px] text-left text-xs hover:bg-surface-2/60"
            >
              <span
                className="inline-block h-[3px] w-3 shrink-0 rounded-full"
                style={{ background: alertColor(a), opacity: isAlertActive(a) ? 1 : 0.35 }}
              />
              <span className={`flex-1 truncate ${isAlertActive(a) ? "text-ink" : "text-ink-faint line-through"}`}>
                {alertLineLabel(a)} · {describeAlert(a)}
              </span>
              {/* Only a non-default cadence is worth the space; every alert
                  being labelled "once per bar close" would be noise. */}
              {a.frequency !== DEFAULT_ALERT_FREQUENCY && (
                <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-ink-muted">
                  {FREQUENCY_LABELS[a.frequency]}
                </span>
              )}
              {alertInactiveReason(a) && (
                <span className="shrink-0 text-[10px] text-ink-faint">{alertInactiveReason(a)}</span>
              )}
              <span className={`shrink-0 text-[10px] ${a.timeframe === timeframe ? "text-accent" : "text-ink-faint"}`}>
                {a.timeframe}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">{push}</div>
    </div>
  );
}
