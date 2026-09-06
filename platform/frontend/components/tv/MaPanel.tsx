"use client";
import { useMemo } from "react";
import { type Resolution } from "@/lib/resolution";
import type { MaAlert } from "@/lib/api";
import {
  MA_LENGTHS, maColor, maId, maLabel, type MaLine, type MaType,
} from "@/lib/movingAverages";
import {
  alertColor, alertInactiveReason, alertLineLabel, describeAlert,
  FREQUENCY_LABELS, isAlertActive,
} from "@/lib/alerts";
import { DEFAULT_ALERT_FREQUENCY } from "@/lib/api";
import { fmtPrice } from "@/lib/format";

type LevelKind = "sr_zone" | "pivot_level";
/** The families the indicator dialog arms. Mirrors `IndicatorKind`. */
type IndicatorRowKind =
  | "rsi" | "macd" | "supertrend" | "bollinger" | "stochastic" | "adx";

/**
 * The families whose subject is price or trend, rather than a bounded
 * oscillator in a pane below the chart.
 *
 * Supertrend and Bollinger are overlays ON price: their events are a direction
 * change and price meeting a moving line. ADX is drawn in a pane but is not a
 * position-in-range oscillator either — it measures strength and has no
 * direction of its own. Filing any of the three under "Oscillators" would put
 * rows there that behave unlike their neighbours.
 */
const TREND_ROWS: {
  kind: IndicatorRowKind; label: string; hint: string; color: string;
}[] = [
  {
    kind: "supertrend",
    label: "Supertrend",
    hint: "Alert when the Supertrend flips direction",
    color: "#089981",
  },
  {
    kind: "bollinger",
    label: "Bollinger band",
    hint: "Alert when price touches or crosses a band",
    color: "#4f8cff",
  },
  {
    kind: "adx",
    label: "ADX",
    hint: "Alert when trend strength crosses a threshold",
    color: "#9b7cf5",
  },
];

/**
 * Oscillators, given rows for the same reason the level families have them:
 * arming RSI for the coin on screen should be one click here, not a trip to
 * another page. Like the level rows they show an armed count rather than a
 * value — RSI has a reading, but MACD's is a price-scale number that would
 * mean nothing in a column of prices.
 */
const OSCILLATOR_ROWS: {
  kind: IndicatorRowKind; label: string; hint: string; color: string;
}[] = [
  { kind: "rsi", label: "RSI", hint: "Alert on an RSI cross", color: "#7e57c2" },
  { kind: "macd", label: "MACD", hint: "Alert on a MACD cross", color: "#2962ff" },
  {
    kind: "stochastic",
    label: "Stochastic",
    hint: "Alert when %K crosses its %D or a level",
    color: "#f0b90b",
  },
];

/**
 * The two level families get rows of their own rather than a single "+ Level"
 * button, so arming one reads the same as arming an SMA: find the row, click
 * its bell. Unlike a moving average these have no single current value — a
 * symbol has many zones and eleven pivots at once — so the value column shows
 * how many alerts are armed instead of a price.
 */
const LEVEL_ROWS: { kind: LevelKind; label: string; hint: string; color: string }[] = [
  {
    kind: "sr_zone",
    label: "Support / resistance",
    hint: "Alert when price nears a swing zone",
    color: "#22c55e",
  },
  {
    kind: "pivot_level",
    label: "Pivot points",
    hint: "Alert when price nears a pivot level",
    color: "#f59e0b",
  },
];

/**
 * The alert bell.
 *
 * An SVG rather than the 🔔 emoji it replaced: an emoji renders at whatever
 * size and hue the platform font decides, so the rail's controls were three
 * different sizes on macOS, Windows and Android, and none of them inherited
 * the disabled or accent colour the row was trying to express.
 */
const BellIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M7 1.5a3.5 3.5 0 0 0-3.5 3.5v2.2L2.4 9.1a.5.5 0 0 0 .43.76h8.34a.5.5 0 0 0 .43-.76L10.5 7.2V5A3.5 3.5 0 0 0 7 1.5Z"
      stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"
    />
    <path d="M5.6 11.2a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

/**
 * One non-MA family row: swatch, name, armed count, bell.
 *
 * Shared by the Levels and Oscillators sections so the two cannot drift into
 * looking like different kinds of control — they are the same affordance.
 */
function FamilyRow({
  label, hint, color, count, onArm, disabled = false,
}: {
  label: string;
  hint: string;
  color: string;
  count: number;
  onArm: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="group grid grid-cols-[16px_1fr_auto_auto] items-center gap-x-2 px-3 py-[6px] text-[13px] hover:bg-surface-2/60">
      <span className="flex h-4 w-4 items-center justify-center">
        <span
          className="inline-block h-[3px] w-4 rounded-full"
          style={{ background: color, opacity: count ? 1 : 0.5 }}
        />
      </span>
      <span className="truncate text-ink">{label}</span>
      <span className="text-right text-[11px] text-ink-faint">
        {count ? `${count} armed` : "—"}
      </span>
      <button
        onClick={onArm}
        disabled={disabled}
        title={disabled ? "Exit Replay to create live alerts" : count ? `${count} alert(s) — click to add another` : hint}
        aria-label={count ? `Add another ${label} alert (${count} armed)` : hint}
        className={`flex h-6 w-7 items-center justify-center gap-0.5 rounded disabled:cursor-not-allowed disabled:opacity-30 ${
          count ? "text-accent" : "text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        }`}
      >
        <BellIcon />
        {count > 1 && <span className="text-[10px] tabular leading-none">{count}</span>}
      </button>
    </div>
  );
}

/**
 * The moving-average rail: every SMA/EMA the chart can draw, one row each,
 * with its own visibility toggle and its own alert bell. One row = one line =
 * one thing you can arm, which is the whole reason these are not bundled into
 * a single "MA ribbon" indicator.
 */
export function MaPanel({
  lines, values, alerts, timeframe, onToggle, onToggleAll, onArm, onArmPrice,
  onArmLevel, onArmOscillator, onOpenAlert, push, liveActionsDisabled = false,
}: {
  lines: MaLine[];
  /** Latest value per line id, for the price column. */
  values: Record<string, number | null>;
  alerts: MaAlert[];
  timeframe: Resolution;
  onToggle: (type: MaType, length: number) => void;
  onToggleAll: (visible: boolean) => void;
  onArm: (type: MaType, length: number) => void;
  /** Open the price-alert dialog with no level pre-filled. */
  onArmPrice: () => void;
  /** Open the level dialog on one of the two families. */
  onArmLevel: (kind: LevelKind) => void;
  /** Open the indicator dialog on RSI, MACD or Supertrend. */
  onArmOscillator: (kind: IndicatorRowKind) => void;
  onOpenAlert: (alert: MaAlert) => void;
  push: React.ReactNode;
  liveActionsDisabled?: boolean;
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

  /**
   * How many alerts each non-MA family currently has, across all timeframes.
   * One pass for both sections: the rows differ only in what they are named.
   */
  const byKind = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of alerts) {
      map.set(a.conditionKind, (map.get(a.conditionKind) ?? 0) + 1);
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
          aria-label={`${line.visible ? "Hide" : "Show"} ${maLabel(line.type, line.length)}`}
          aria-pressed={line.visible}
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-surface-2"
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
          disabled={liveActionsDisabled}
          title={liveActionsDisabled ? "Exit Replay to create live alerts" : armed.length ? `${armed.length} alert(s) — click to add another` : "Add alert on this line"}
          aria-label={
            armed.length
              ? `Add another alert on ${maLabel(line.type, line.length)} (${armed.length} armed)`
              : `Add alert on ${maLabel(line.type, line.length)}`
          }
          className={`flex h-6 w-7 items-center justify-center gap-0.5 rounded disabled:cursor-not-allowed disabled:opacity-30 ${
            armed.length
              ? "text-accent"
              : "text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          }`}
        >
          <BellIcon />
          {armed.length > 1 && (
            <span className="text-[10px] tabular leading-none">{armed.length}</span>
          )}
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
          className="flex h-6 items-center rounded px-2 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          {allVisible ? "Hide all" : "Show all"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {liveActionsDisabled && (
          <div className="border-b border-accent/30 bg-accent/10 px-3 py-2 text-[11px] text-accent">
            Exit Replay to create or edit live alerts. Historical MA values remain available.
          </div>
        )}
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

        <div className="border-y border-border/60 bg-surface-2/40 px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
          Levels
        </div>
        {LEVEL_ROWS.map((row) => (
          <FamilyRow
            key={row.kind}
            label={row.label}
            hint={row.hint}
            color={row.color}
            count={byKind.get(row.kind) ?? 0}
            onArm={() => onArmLevel(row.kind)}
            disabled={liveActionsDisabled}
          />
        ))}

        <div className="border-y border-border/60 bg-surface-2/40 px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
          Trend
        </div>
        {TREND_ROWS.map((row) => (
          <FamilyRow
            key={row.kind}
            label={row.label}
            hint={row.hint}
            color={row.color}
            count={byKind.get(row.kind) ?? 0}
            onArm={() => onArmOscillator(row.kind)}
            disabled={liveActionsDisabled}
          />
        ))}

        <div className="border-y border-border/60 bg-surface-2/40 px-3 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
          Oscillators
        </div>
        {OSCILLATOR_ROWS.map((row) => (
          <FamilyRow
            key={row.kind}
            label={row.label}
            hint={row.hint}
            color={row.color}
            count={byKind.get(row.kind) ?? 0}
            onArm={() => onArmOscillator(row.kind)}
            disabled={liveActionsDisabled}
          />
        ))}

        <div className="flex items-center justify-between border-y border-border bg-surface-2/40 px-3 py-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
            Armed alerts <span className="normal-case tracking-normal">— click to edit</span>
          </span>
          <button
            onClick={onArmPrice}
            disabled={liveActionsDisabled}
            title="Alert on a price level"
            className="flex h-6 items-center rounded px-1.5 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
          >
            + Price
          </button>
        </div>
        {armedList.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-ink-faint">
            No alerts on this symbol yet.
            <br />
            Use the bell on a line or a level, or + Price.
          </div>
        ) : (
          armedList.map((a) => (
            <button
              key={a.id}
              onClick={() => onOpenAlert(a)}
              disabled={liveActionsDisabled}
              title={`Edit — ${describeAlert(a)} · ${FREQUENCY_LABELS[a.frequency]}`}
              aria-label={`Edit alert — ${alertLineLabel(a)}, ${describeAlert(a)}, ${a.timeframe}`}
              className="flex w-full items-center gap-2 px-3 py-[7px] text-left text-xs hover:bg-surface-2/60 disabled:cursor-not-allowed disabled:opacity-40"
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

      {!liveActionsDisabled && <div className="shrink-0 border-t border-border p-3">{push}</div>}
    </div>
  );
}
